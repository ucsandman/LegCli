// history — one read-only index over the conversations every coding agent on
// this machine keeps in its own store, plus the ones Leg supervised itself.
//
// Claude keeps Claude's history, Codex keeps Codex's, and so on: nothing is
// moved, copied or renamed. Leg discovers, normalises and points. What it
// writes is one file, $LEG_HOME/history/index.json: per provider, per
// transcript, the file's mtime and size and a small record (ids, cwd, repo,
// branch, times, a scrubbed title). A refresh stats every file and re-reads
// only the ones that changed; a transcript is never read whole for its
// metadata (src/history/common.mjs bounds every read), no message body is
// ever cached, and messages are read only when someone opens a conversation.
//
// A provider may be DISCOVERABLE here without being a SUPERVISED agent: the
// registry below is separate from src/adapters and src/preferences (copilot
// lists and reads here and cannot be continued). A provider that throws loses
// only its own entries for that refresh; the others still index.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep, resolve } from 'node:path'
import { home } from '../store.mjs'
import { writeJsonAtomic, withFileLock } from '../fsx.mjs'
import { scrub, redact } from '../redact.mjs'
import { listSessions, isActive } from '../sessions.mjs'
import { readAccounts, accountDir, LAYOUT } from '../accounts.mjs'
import { gitRootOf, repoNameOf, canonOrNull, line } from './common.mjs'
import * as claude from './providers/claude.mjs'
import * as codex from './providers/codex.mjs'
import * as grok from './providers/grok.mjs'
import * as agy from './providers/agy.mjs'
import * as copilot from './providers/copilot.mjs'

export const INDEX_VERSION = 1
// plain copies of the module namespaces, so a test can make one provider
// fail and prove the others still index
export const PROVIDERS = { claude: { ...claude }, codex: { ...codex }, grok: { ...grok }, agy: { ...agy }, copilot: { ...copilot } }
export const PROVIDER_NAMES = Object.keys(PROVIDERS)
// a listing refreshes on its own when the index is older than this
export const STALE_MS = 60_000
export const DEFAULT_LIMIT = 50

export class HistoryInputError extends Error {}

export function historyDir() { return join(home(), 'history') }
export function indexPath() { return join(historyDir(), 'index.json') }

// The parsed index is kept in memory until the file changes: the board asks
// for a page every few seconds and a two-megabyte parse each time is waste.
let indexCache = null
export function readIndex() {
  const f = indexPath()
  let st
  try { st = statSync(f) } catch { indexCache = null; return null }
  if (indexCache && indexCache.file === f && indexCache.mtime === st.mtimeMs && indexCache.size === st.size) return indexCache.index
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const index = j && j.version === INDEX_VERSION && j.providers ? j : null
    indexCache = index ? { file: f, mtime: st.mtimeMs, size: st.size, index } : null
    return index
  } catch { indexCache = null; return null }
}

// What each provider can do, for the docs, the CLI and the board.
export function providerSupport() {
  const probe = { native_id: '00000000-0000-0000-0000-000000000000', native: {} }
  return PROVIDER_NAMES.map((n) => ({ name: n, label: PROVIDERS[n].label, transcript: PROVIDERS[n].transcript, resume: PROVIDERS[n].resume(probe).supported ? 'supported' : 'unsupported', live: typeof PROVIDERS[n].liveIds === 'function' ? 'marker' : 'unknown' }))
}

// Every store a provider should look at: the CLI's own home, plus each extra
// account Leg made (src/accounts.mjs) that has a directory of its own.
function rootsFor(name, homes) {
  const out = [{ account: 'default', root: PROVIDERS[name].root(homes ?? {}) }]
  if (homes && Object.prototype.hasOwnProperty.call(homes, name)) return out // an explicit override is the whole answer (tests)
  if (!LAYOUT[name]?.env) return out
  for (const acc of readAccounts()[name] ?? []) {
    if (acc === 'default') continue
    const dir = accountDir(name, acc)
    if (existsSync(dir)) out.push({ account: acc, root: dir })
  }
  return out
}

const providerKey = (name, account) => (account === 'default' ? name : `${name}@${account}`)

// two comparisons of paths: `isUnder` is the strict one (symlinks and short
// names resolved through the file system; it guards reads and writes), and
// `keyPath` is the cheap one for grouping and filtering thousands of records
// (a resolved, case-folded string; no file-system call per record).
const isUnder = (child, parent) => { const c = canonOrNull(child); const p = canonOrNull(parent); return Boolean(c && p) && (c === p || c.startsWith(p + sep)) }
const keyPath = (p) => { if (!p) return null; const r = resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r }
// a UNC path (\\server\share) whose host is unreachable blocks every
// synchronous file-system call for seconds; a refresh never touches one
const isUnc = (p) => typeof p === 'string' && /^[\\/]{2}[^\\/]/.test(p)
const keyUnder = (child, parent) => { const c = keyPath(child); const p = keyPath(parent); return Boolean(c && p) && (c === p || c.startsWith(p + sep)) }

// The only place discovery may write is under Leg's own home, never inside
// the store it reads: a LEG_HOME configured inside a provider home would put
// index.json (and its lock and temp file) into that agent's directory.
function assertWriteScope(file, homes) {
  for (const name of PROVIDER_NAMES) for (const { root } of rootsFor(name, homes)) {
    if (isUnder(file, root) && !isUnder(root, home())) throw new Error(`refusing to write under a provider store: ${file} is inside ${root}`)
  }
}

// Refresh the index: stat every transcript, re-read the changed ones, resolve
// each cwd to its repo, write. `force` drops the cache first (a full re-read).
// `providers` narrows the pass; `homes` overrides a provider's home (tests).
export function refreshIndex({ homes = null, providers = PROVIDER_NAMES, force = false } = {}) {
  assertWriteScope(indexPath(), homes)
  mkdirSync(historyDir(), { recursive: true })
  // mustHold: two refreshes (the board's and a CLI's) interleaving on one
  // index would tear it; the loser waits or gives up, never writes unlocked
  return withFileLock(join(historyDir(), '.index.lock'), () => {
    const t0 = Date.now()
    const prev = (force ? null : readIndex()) ?? { version: INDEX_VERSION, providers: {} }
    const next = { version: INDEX_VERSION, refreshed_at: new Date().toISOString(), providers: { ...prev.providers } }
    const stats = []
    const want = providers.filter((n) => PROVIDERS[n])
    for (const name of want) {
      // an account removed since the last pass drops with it
      for (const k of Object.keys(next.providers)) if (next.providers[k].name === name) delete next.providers[k]
      for (const { account, root } of rootsFor(name, homes)) {
        const key = providerKey(name, account)
        const before = prev.providers[key] ?? {}
        const entry = { name, account, root, scanned_at: new Date().toISOString(), scanned: 0, parsed: 0, error: null, missing: false, entries: before.entries ?? {}, aux: before.aux ?? {} }
        if (!existsSync(root)) {
          entry.entries = {}; entry.aux = {}; entry.missing = true
        } else {
          try {
            const r = PROVIDERS[name].scan({ home: root, prev: before })
            entry.entries = r.entries ?? {}
            entry.aux = r.aux ?? {}
            entry.scanned = r.scanned ?? 0
            entry.parsed = r.parsed ?? 0
          } catch (err) {
            // keep what the last pass found; say why this one failed
            entry.error = scrub(String(err?.message ?? err)).slice(0, 300)
          }
        }
        next.providers[key] = entry
        stats.push({ provider: name, account, root, scanned: entry.scanned, parsed: entry.parsed, records: Object.keys(entry.entries).length, error: entry.error, missing: entry.missing })
      }
    }
    resolveRepos(next)
    next.elapsed_ms = Date.now() - t0
    writeJsonAtomic(indexPath(), next)
    // the parse cache takes the object just written: a second write of the
    // same size inside one mtime tick would otherwise serve the previous index
    try { const st = statSync(indexPath()); indexCache = { file: indexPath(), mtime: st.mtimeMs, size: st.size, index: next } } catch { indexCache = null }
    return { index: next, stats }
  }, { mustHold: true })
}

// cwd → { repo, worktree, exists } for every record, one lookup per distinct
// cwd. No git process: src/history/common.mjs gitRootOf walks the tree. When
// the cwd is gone, the hints the agent itself recorded (Claude's
// worktree-state, Grok's git_root_dir, Copilot's git_root) are resolved the
// same way, so a hint that names a subdirectory or a worktree still lands on
// the repository root; a hint that is gone too yields no repo.
// Every string a provider kept under `native` is scrubbed here: a remote URL
// with credentials in it is a secret whatever field it sits in.
function resolveRepos(index) {
  const cache = new Map()
  const lookup = (cwd) => {
    if (!cwd) return { repo: null, worktree: null, exists: false }
    if (cache.has(cwd)) return cache.get(cwd)
    // a network folder is listed as recorded and never resolved to a repository
    if (isUnc(cwd)) { const v = { repo: null, worktree: null, exists: null }; cache.set(cwd, v); return v }
    const exists = existsSync(cwd)
    const g = exists ? gitRootOf(cwd) : null
    const v = { repo: g?.repo ?? null, worktree: g?.worktree ?? null, exists }
    cache.set(cwd, v)
    return v
  }
  const scrubDeep = (o) => {
    if (typeof o === 'string') return scrub(o)
    if (Array.isArray(o)) return o.map(scrubDeep)
    if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = scrubDeep(o[k]); return o }
    return o
  }
  for (const p of Object.values(index.providers)) {
    for (const e of Object.values(p.entries ?? {})) {
      const r = e.record
      r.native = scrubDeep(r.native ?? {})
      const g = lookup(r.cwd)
      r.cwd_exists = g.exists
      let repo = g.repo
      let wt = g.worktree
      if (!g.exists) {
        for (const hint of [r.native?.worktree?.original_cwd, r.native?.git_root_dir, r.native?.git_root]) {
          const h = hint ? lookup(hint) : null
          if (h?.repo) { repo = h.repo; wt = wt ?? h.worktree; break }
        }
        if (r.native?.worktree?.path) wt = r.native.worktree.path
        if (!repo && r.cwd) {
          const m = /[\\/]\.(?:leg|baton)-worktrees[\\/]/i.exec(r.cwd)
          if (m) {
            const h = lookup(r.cwd.slice(0, m.index))
            if (h?.repo) { repo = h.repo; wt = wt ?? r.cwd }
          }
        }
      }
      r.repo = repo ?? null
      r.worktree = wt && (!repo || isUnc(wt) || canonOrNull(wt) !== canonOrNull(repo)) ? { path: wt, branch: r.native?.worktree?.branch ?? r.branch ?? null } : null
      r.repo_name = repoNameOf(r.repo) ?? repoNameOf(r.cwd)
      // F26: a title is a label; the prompt it came from stays under native.first
      if (r.title) r.title = line(r.title)
    }
  }
}

// The flat, normalised list the CLI and the board read. Subagent threads and
// conversations the agent itself hides are left out unless asked for.
export function recordsOf(index, { includeHidden = false } = {}) {
  const out = []
  if (!index) return out
  // one id, one row: an agent that keeps two files for one conversation (a
  // session resumed from another folder) is shown once, the newer file
  const byId = new Map()
  for (const p of Object.values(index.providers)) {
    for (const e of Object.values(p.entries ?? {})) {
      const r = e.record
      const hidden = Boolean(r.native?.subagent || r.native?.hidden)
      if (hidden && !includeHidden) continue
      const key = `${p.name}:${r.native_id}`
      const prev = byId.get(key)
      if (prev && (Date.parse(prev.record.updated_at ?? 0) || 0) >= (Date.parse(r.updated_at ?? 0) || 0)) { prev.files += 1; continue }
      byId.set(key, { p, record: r, hidden, files: (prev?.files ?? 0) + 1 })
    }
  }
  for (const { p, record: r, hidden, files } of byId.values()) {
    {
      const res = PROVIDERS[p.name]?.resume(r) ?? { supported: false, reason: 'unknown provider' }
      out.push({
        id: `${p.name}:${r.native_id}`,
        provider: p.name, account: p.account ?? 'default',
        native_id: r.native_id, leg_session_id: null, managed: false, leg_status: null, hidden,
        title: r.title ?? null,
        cwd: r.cwd ?? null, cwd_exists: r.cwd_exists ?? null, repo: r.repo ?? null, repo_name: r.repo_name ?? null, branch: r.branch ?? null, worktree: r.worktree ?? null,
        started_at: r.started_at ?? null, updated_at: r.updated_at ?? null,
        turns: r.turns ?? null, live: r.live ?? null,
        transcript_path: r.transcript_path ?? null, transcript: PROVIDERS[p.name]?.transcript ?? 'unsupported', size_bytes: r.size_bytes ?? null,
        resume: res.supported ? { supported: true } : { supported: false, reason: res.reason },
        native: { ...(r.native ?? {}), ...(files > 1 ? { files } : {}) },
      })
    }
  }
  return out
}

// A Leg session that started an agent is the same conversation as the one the
// agent's store holds: match on the agent's own id (session.json records it as
// agent_session_id, and every earlier leg's under agent_sessions), else on
// the transcript path. Matched records are marked managed; a session with no
// native match at all (starting, or an agent whose id Leg never learned)
// still lists, as a managed record of its own. Two Leg sessions on one
// conversation (a continue of a continue) are one row that names both.
export function mergeWithSessions(records, sessions = listSessions()) {
  const byNative = new Map()
  const byPath = new Map()
  for (const r of records) {
    byNative.set(`${r.provider}:${r.native_id}`, r)
    const c = keyPath(r.transcript_path)
    if (c) byPath.set(c, r)
  }
  const out = [...records]
  const legsOf = (s) => {
    const legs = [...(s.agent_sessions ?? [])]
    if (s.agent_session_id && !legs.some((x) => x.agent === s.agent && x.agent_session_id === s.agent_session_id)) legs.push({ agent: s.agent, agent_session_id: s.agent_session_id, transcript_path: s.transcript_path ?? null })
    if (!legs.length && s.transcript_path) legs.push({ agent: s.agent, agent_session_id: null, transcript_path: s.transcript_path })
    return legs
  }
  const claim = (hit, s) => {
    const newer = !hit.leg_session_id || isActive(s) || (!hit.live && (Date.parse(s.updated_at ?? 0) || 0) > (hit.leg_updated_at ?? 0))
    hit.managed = true
    hit.leg_sessions = [...new Set([...(hit.leg_sessions ?? []), s.session_id])]
    if (newer) { hit.leg_session_id = s.session_id; hit.leg_status = s.status; hit.leg_updated_at = Date.parse(s.updated_at ?? 0) || 0 }
    hit.live = isActive(s) || hit.live
    if (!hit.title && s.task) hit.title = line(s.task)
    if (s.worktree?.path && !hit.worktree) hit.worktree = { path: s.worktree.path, branch: s.worktree.branch ?? null }
  }
  for (const s of sessions) {
    let matched = 0
    for (const leg of legsOf(s)) {
      const hit = (leg.agent_session_id && byNative.get(`${leg.agent}:${leg.agent_session_id}`)) || (leg.transcript_path && byPath.get(keyPath(leg.transcript_path)))
      if (hit) { claim(hit, s); matched += 1 }
    }
    if (matched) continue
    out.push({
      id: `leg:${s.session_id}`,
      provider: s.agent, account: s.account ?? 'default',
      native_id: s.agent_session_id ?? null, leg_session_id: s.session_id, leg_sessions: [s.session_id], managed: true, leg_status: s.status, hidden: false,
      title: s.task ? line(s.task) : null,
      cwd: s.cwd ?? null, cwd_exists: s.cwd ? existsSync(s.cwd) : null, repo: s.repo ?? null, repo_name: s.repo_name ?? repoNameOf(s.cwd), branch: s.branch ?? null,
      worktree: s.worktree ? { path: s.worktree.path, branch: s.worktree.branch ?? null } : null,
      started_at: s.started_at ?? null, updated_at: s.updated_at ?? s.started_at ?? null,
      turns: s.turns ?? null, live: isActive(s),
      transcript_path: s.transcript_path ?? null, transcript: PROVIDERS[s.agent]?.transcript ?? 'unsupported', size_bytes: null,
      resume: { supported: false, reason: 'a Leg session: leg sessions show <id>' },
      native: {},
    })
  }
  return out
}

function matchesRepo(r, want) {
  if (!want) return true
  const w = String(want)
  if (!/[\\/]/.test(w)) return String(r.repo_name ?? '').toLowerCase() === w.toLowerCase()
  return keyUnder(r.repo, w) || keyUnder(r.cwd, w) || keyUnder(r.worktree?.path, w)
}

function matchesSearch(r, q) {
  if (!q) return true
  const needle = String(q).toLowerCase()
  return [r.title, r.repo_name, r.cwd, r.branch, r.native_id, r.leg_session_id, r.provider, r.worktree?.path].some((v) => v && String(v).toLowerCase().includes(needle))
}

const stamp = (r) => Date.parse(r.updated_at ?? r.started_at ?? 0) || 0

// The unified list: refreshes the index when it is stale (or missing, or
// asked), merges Leg's own sessions, filters, sorts newest first, pages. A
// refresh that cannot take the lock (another one is running) or fails leaves
// the last index in place; the listing says so in `refresh_error`.
export function listHistory({ provider = null, repo = null, search = null, limit = DEFAULT_LIMIT, offset = 0, before = null, includeSubagents = false, includeHidden = false, refresh = null, homes = null, sessions = null, managed = null, live = null } = {}) {
  const showHidden = Boolean(includeSubagents || includeHidden)
  if (limit !== null && limit !== undefined && (typeof limit === 'number' && (isNaN(limit) || limit < 0))) {
    throw new HistoryInputError('limit must be a non-negative integer')
  }
  let index = readIndex()
  const age = index?.refreshed_at ? Date.now() - Date.parse(index.refreshed_at) : Infinity
  let stats = null
  let refreshError = null
  if (refresh === true || refresh === 'full' || (refresh !== false && (!index || age > STALE_MS))) {
    try {
      const r = refreshIndex({ homes, force: refresh === 'full' })
      index = r.index; stats = r.stats
    } catch (err) {
      refreshError = scrub(String(err?.message ?? err)).slice(0, 300)
      index = index ?? readIndex()
    }
  }
  let records = mergeWithSessions(recordsOf(index, { includeHidden: showHidden }), sessions ?? listSessions())
  // how many each agent holds, before any filter: the board's one-line count
  const counts = {}
  for (const r of records) counts[r.provider] = (counts[r.provider] ?? 0) + 1
  if (provider) { const want = String(provider).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean); records = records.filter((r) => want.includes(r.provider)) }
  if (repo) records = records.filter((r) => matchesRepo(r, repo))
  if (search) records = records.filter((r) => matchesSearch(r, search))
  if (managed !== null) records = records.filter((r) => r.managed === managed)
  if (live !== null) records = records.filter((r) => Boolean(r.live) === live)
  records.sort((a, b) => stamp(b) - stamp(a))
  // the count that matches the filters, before the cursor: what "N of M
  // shown" and the board's show-more guard both mean
  const total = records.length
  if (before) {
    const bStamp = Date.parse(before) || Number(before)
    if (Number.isFinite(bStamp)) {
      records = records.filter((r) => stamp(r) < bStamp)
    } else {
      const idx = records.findIndex((r) => r.id === before || r.native_id === before)
      if (idx !== -1) records = records.slice(idx + 1)
    }
  }
  const page = limit > 0 ? records.slice(offset, offset + limit) : records.slice(offset)
  return { records: page, total, counts, offset, limit, refreshed_at: index?.refreshed_at ?? null, refresh_error: refreshError, stats, providers: providerSupport() }
}

// `claude:<id>`, `<id>`, a unique prefix of an id (4+ chars), or a Leg session id.
export function findRecord(id, opts = {}) {
  const want = String(id ?? '').trim()
  if (!want) throw new HistoryInputError('which conversation? pass an id from leg history')
  const { records } = listHistory({ ...opts, limit: 0, includeHidden: true })
  const exact = records.find((r) => r.id === want || r.leg_session_id === want || r.native_id === want || (r.leg_sessions ?? []).includes(want))
  if (exact) return exact
  const [prov, rest] = want.includes(':') ? want.split(':', 2) : [null, want]
  if (rest.length < 4) throw new HistoryInputError(`"${want}" is too short to name a conversation; give at least 4 characters of the id`)
  const hits = records.filter((r) => (!prov || r.provider === prov) && (String(r.native_id ?? '').startsWith(rest) || String(r.leg_session_id ?? '').startsWith(rest) || (r.leg_sessions ?? []).some((x) => String(x).startsWith(rest))))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new HistoryInputError(`"${want}" matches ${hits.length} conversations: ${hits.slice(0, 5).map((r) => r.id).join(', ')}${hits.length > 5 ? ', …' : ''}`)
  return null
}

// A transcript is read only from inside a store Leg knows (the provider homes
// and Leg's own session directories): the index is a plain file, and a path
// edited into it must not turn the drawer into a reader of arbitrary files.
export function insideKnownStore(path, { homes = null } = {}) {
  if (!path) return false
  for (const name of PROVIDER_NAMES) for (const { root } of rootsFor(name, homes)) if (isUnder(path, root)) return true
  return isUnder(path, join(home(), 'sessions'))
}

// The last messages of one conversation, redacted; null when Leg has no parser
// for that provider, [] when the transcript is gone or outside every store.
export function recordMessages(record, limit = 8, { homes = null } = {}) {
  if (!(limit > 0)) return []
  const p = PROVIDERS[record.provider]
  if (!p || p.transcript !== 'supported') return null
  const path = record.transcript_path
  if (!path || !insideKnownStore(path, { homes })) return []
  try { if (!statSync(path).isFile()) return [] } catch { return [] }
  let msgs
  try { msgs = p.messages(record, limit) ?? [] } catch { return [] }
  return msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: redact(String(m.text ?? '')), ts: m.ts ?? null }))
}

// How to continue a discovered conversation through `leg <agent>`: the
// provider's verified argv, in the conversation's own cwd. Never for a
// conversation Leg is already running, never in a cwd that is gone, and never
// with Leg's own home as the working directory. The id was matched against
// the provider's own shape (a UUID) before it became an argument, so it can
// never read as a flag to the child.
export function resumeSpec(record) {
  const p = PROVIDERS[record.provider]
  if (!p) return { supported: false, reason: `no provider for ${record.provider}` }
  if (record.managed && record.live) return { supported: false, reason: `Leg is already running this conversation as ${record.leg_session_id}` }
  const r = p.resume(record)
  if (!r.supported) return r
  const cwd = record.cwd
  let isDir = false
  try { isDir = Boolean(cwd) && statSync(cwd).isDirectory() } catch { isDir = false }
  if (!isDir) return { supported: false, reason: `its folder is gone: ${cwd ?? '(unknown)'}` }
  if (isUnder(cwd, home())) return { supported: false, reason: 'its folder is inside Leg\'s own home' }
  return { supported: true, agent: r.agent, args: r.args, cwd }
}

// The record the board and `history show` print: everything the list has plus
// the lazily read messages and the resume verdict.
export function recordDetail(record, { messages = 8, homes = null } = {}) {
  return { ...record, messages: recordMessages(record, messages, { homes }), resume: resumeSpec(record), ts: new Date().toISOString() }
}
