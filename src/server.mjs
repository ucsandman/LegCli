#!/usr/bin/env node
// server — the board's HTTP + SSE backend. Ledger-backed: every handler reads
// card.json / events-*.jsonl on demand (no module-level card store), so a
// restart shows the same board and a second process sees the same truth.
// LEG_BIND (127.0.0.1) + LEG_PORT (4747) + LEG_TOKEN are the
// multiplayer seams (src/auth.mjs). BATON_* names still work as fallback.
import http from 'node:http'
import https from 'node:https'
import { spawnSync, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, watch as fsWatch, mkdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join, dirname, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBind, authorize, remoteAddress, presentedToken, isLoopback, isLoopbackRequest, tokenMatches } from './auth.mjs'
import { readShare, isOn as shareIsOn, sharePath, identify, personNamed, mayUseCards, mayUseMachine, readTls } from './share.mjs'
import { auditTrail, ACTOR_KINDS } from './audit.mjs'
import { createLimiter } from './ratelimit.mjs'
import { realPath, canonPath } from './fsx.mjs'
import { listCards, readCard, readRuns, readEvents, cardDir, home, ledgerAppend, ledgerUpdate } from './store.mjs'
import { saveSessionBundle } from './bundle.mjs'
import { transcriptTail as claudeTranscriptTail } from './taps/claude.mjs'
import { humanAction } from './orchestrator.mjs'
import { createCard, CardInputError } from './cards.mjs'
import { IllegalTransition, availableActions, NON_TERMINAL, TERMINAL } from './chain.mjs'
import { held } from './leases.mjs'
import { PRESETS } from './presets.mjs'
import { names as adapterNames, get as getAdapter, isFake } from './adapters/index.mjs'
import { createScheduler, schedulerStatus, MAX_CONCURRENT } from './scheduler.mjs'
import { ensure as ensureWorktree, remove as removeWorktree, worktreeDirty } from './worktree.mjs'
import { scrub } from './runner.mjs'
import { resolveChb } from './handoff.mjs'
import { listSessions, readSession, readEvents as readSessionEvents, requestControl, removeSession, overlaps, isActive, sessionsRoot, reapLost, readLand, readLandings, readRequests, writeRequests, appendEvent as appendSessionEvent, updateSession, HANDOFF_ORDER_CAPABILITY, SUPERVISED_AGENTS } from './sessions.mjs'
import { sessionDetail, sessionDiff, DiffInputError } from './session-detail.mjs'
import { hasRecentSynthesis } from './synthesis.mjs'
import { refreshPointers } from './resume.mjs'
import { landSession, landBlocker, landingNow, pruneSessionWorktree, canLand, prepareLanding, applyLandFix } from './land.mjs'
import { readUsage, recordUsage, usageIsStale, candidates, isAvailable, fmtReset, binding, evaluateLadder, rungLabel, wallActive } from './usage.mjs'
import { readAccounts, envFor, LAYOUT } from './accounts.mjs'
import { readCodexUsage, transcriptTail as codexTranscriptTail } from './taps/codex.mjs'
import { readPreferences, writePreferences, normalizeHandoffOrder, requireHandoffOrder, ladderFor, requireHandoffLadder, requireClimbBack, requireReserve, orderFromLadder } from './preferences.mjs'
import { isDownshift } from './buckets.mjs'
import { listHistory, findRecord, recordDetail, refreshIndex, readIndex, providerSupport, HistoryInputError, PROVIDER_NAMES } from './history/index.mjs'
import { listWorktrees } from './history/worktrees.mjs'

const SELF = fileURLToPath(import.meta.url)
export function resolveBoardDir() {
  const dir = join(dirname(SELF), 'board')
  if (existsSync(dir)) return dir
  const wtMatch = /[\\/]\.(?:leg|baton)-worktrees(?:[\\/].*)?$/.exec(dirname(SELF))
  if (wtMatch) {
    const root = dirname(SELF).slice(0, wtMatch.index)
    const fallback = join(root, 'src', 'board')
    if (existsSync(fallback)) return fallback
  }
  return dir
}
const VERSION = JSON.parse(readFileSync(join(dirname(SELF), '..', 'package.json'), 'utf8')).version
const DEFAULT_ORDER = ['plan', 'build', 'review', 'test', 'land']
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' }

const log = (msg) => { const q = process.env.LEG_QUIET ?? process.env.BATON_QUIET; if (q !== '1') process.stdout.write(`[board] ${new Date().toISOString()} ${msg}\n`) }

// ---- read models ----
function lastEventOf(id) {
  const evs = readEvents(id)
  return evs.length ? evs[evs.length - 1] : null
}

export function columnsFor(cards) {
  const names = new Set()
  for (const c of cards) for (const s of c.pipeline ?? []) names.add(s.name)
  const ordered = [...DEFAULT_ORDER.filter((n) => names.has(n)), ...[...names].filter((n) => !DEFAULT_ORDER.includes(n)).sort()]
  return ['backlog', 'queued', ...ordered, 'done', 'failed']
}

export function columnOf(card) {
  if (['backlog', 'queued', 'done'].includes(card.status)) return card.status
  if (['failed', 'killed'].includes(card.status)) return 'failed'
  return card.station
}

// ---- the work stat on a live card's row (redesign C.3) --------------------
// `4 files, +212 -18`. Parsed from git's own one-line summary, never counted
// here: a part the line does not carry is left off the object, so the row can
// print only what was measured and never estimate the rest.
export function parseShortstat(line) {
  const text = String(line ?? '')
  const files = /(\d+)\s+files?\s+changed/.exec(text)
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(text)
  const del = /(\d+)\s+deletions?\(-\)/.exec(text)
  if (!files && !ins && !del) return null
  const out = {}
  if (files) out.files = parseInt(files[1], 10)
  if (ins) out.insertions = parseInt(ins[1], 10)
  if (del) out.deletions = parseInt(del[1], 10)
  return out
}

function measureWork(card) {
  if (!card.worktree || !existsSync(card.worktree)) return null
  const base = card.trunk || 'main'
  const r = spawnSync('git', ['diff', '--shortstat', `${base}..HEAD`], { cwd: card.worktree, windowsHide: true, encoding: 'utf8', timeout: 8000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) return null
  return parseShortstat(r.stdout)
}

// One `git diff` per live card per push would put a subprocess per card inside
// the board's one event loop, which is the stall canLandFor already exists to
// avoid. Keyed on the card's own revision, with the expiries spread across the
// window so twenty cards never re-read together.
const WORK_TTL = 15000
const workCache = new Map()
function workFor(card) {
  const key = `${card.card_id}|${card.updated_at ?? ''}`
  const hit = workCache.get(key)
  if (hit && Date.now() < hit.until) return hit.data
  let data = null
  try { data = measureWork(card) } catch { data = null }
  if (workCache.size > 300) workCache.clear()
  workCache.set(key, { until: Date.now() + WORK_TTL / 2 + Math.random() * WORK_TTL, data })
  return data
}

// The test and land verdicts a live card has already earned. Both are read from
// the card's own ledger, because that is where each station records its result:
// a test station writes no run.json (src/stations/test.mjs), and a landing is a
// `landed` / `bounced` / `failed` event (src/chain.mjs). Last one wins; a card
// that has run neither carries neither key.
export function cardOutcomes(events) {
  const out = {}
  for (const ev of events ?? []) {
    const summary = String(ev.summary ?? '')
    const m = /^test (green|red)\b/.exec(summary)
    if (m) out.tests = { state: m[1], at: ev.ts }
    if (ev.type === 'landed') {
      const sha = /\b([0-9a-f]{7,40})\b/.exec(summary)
      out.land = { state: 'landed', reason: null, sha: sha ? sha[1] : null }
    } else if (ev.type === 'bounced' && /^land bounced/.test(summary)) {
      out.land = { state: 'bounced', reason: ev.body ? String(ev.body).slice(0, 200) : summary, sha: null }
    } else if (ev.type === 'failed' && /\bland\b/.test(summary)) {
      out.land = { state: 'failed', reason: ev.body ? String(ev.body).slice(0, 200) : summary, sha: null }
    }
  }
  return out
}

// The last messages a hand-off bundle quotes, from the agent's own transcript.
// An agent Leg cannot read a transcript for contributes none, and the bundle is
// written from the record alone rather than with invented text.
function sessionMessages(s) {
  try {
    if (s.agent === 'claude') return claudeTranscriptTail(s.transcript_path)
    if (s.agent === 'codex') return codexTranscriptTail(s.transcript_path)
  } catch { /* an unreadable transcript is not a reason to refuse the bundle */ }
  return []
}

// This terminal's ladder from the rung it is standing on, downward. A card made
// from a terminal starts where the terminal is, not at the top: the rungs above
// it are the ones this work has already used up (redesign C.4).
export function ladderFromCurrentRung(session) {
  const ladder = ladderFor(session).filter((r) => r && r.agent)
  const exact = ladder.findIndex((r) => r.agent === session.agent && (r.account ?? 'default') === (session.account ?? 'default') && (r.model ?? null) === (session.model ?? null))
  const byAgent = exact >= 0 ? exact : ladder.findIndex((r) => r.agent === session.agent)
  return byAgent >= 0 ? ladder.slice(byAgent) : ladder
}

// ---- carrying a checkout's uncommitted work into another one --------------
// "End, and keep going as a card" on a lone terminal (the ordinary case: a
// terminal only cuts a worktree of its own when a second live session shares
// the checkout, src/attach.mjs isolate()) has to move the work the human was
// looking at, not just the branch it sits on. Captured in two halves, because
// git keeps them apart: a patch of everything it tracks, staged and unstaged
// (`git diff HEAD --binary`), and the bytes of the files it does not
// (`git ls-files --others`). The second half is the one `git stash create`
// cannot carry, and it is where a terminal's newest file always is.
const CARRY_SKIP = ['.git', '.leg-worktrees', '.baton-worktrees', '.context-handoffs', '.leg', '.baton', 'node_modules']
const CARRY_MAX_BYTES = 8 * 1024 * 1024
function gitIn(dir, args, opts = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr ?? '').trim().slice(0, 200)}`)
  return r.stdout
}

export function captureUncommitted(dir) {
  const status = gitIn(dir, ['status', '--porcelain'])
  if (!status.trim()) return null
  // --binary keeps a changed image or lockfile intact; the output is ASCII
  const patch = gitIn(dir, ['diff', 'HEAD', '--binary'])
  const files = []
  for (const rel of gitIn(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (CARRY_SKIP.includes(rel.split('/')[0])) continue
    const from = join(dir, rel)
    let st
    try { st = statSync(from) } catch { continue }
    if (!st.isFile()) continue
    // refuse loudly rather than carry half the work: the caller turns this
    // into a 409 and the terminal is left alone
    if (st.size > CARRY_MAX_BYTES) throw new Error(`${rel} is ${Math.round(st.size / 1048576)}MB, too large to carry into the card's checkout`)
    files.push({ rel, data: readFileSync(from) })
  }
  if (!patch.trim() && !files.length) return null
  const names = new Set(status.trim().split('\n').map((l) => l.slice(3).trim()).filter(Boolean))
  for (const f of files) names.add(f.rel)
  return { patch, files, names: [...names] }
}

export function carryUncommitted(dir, carried) {
  if (!carried) return 0
  if (carried.patch.trim()) {
    const r = spawnSync('git', ['-C', dir, 'apply', '--binary', '--whitespace=nowarn', '-'], { input: carried.patch, windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
    if (r.status !== 0) throw new Error(`the tracked changes did not apply: ${String(r.stderr ?? '').trim().slice(0, 200)}`)
  }
  for (const f of carried.files) {
    const to = join(dir, f.rel)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, f.data)
  }
  return (carried.names ?? []).length
}

// The cards waiting on a human, for the terminals verdict to read (redesign
// C.5): `card 3e1c has waited on you for 12 minutes.` needs the id, the title,
// the station and the moment it stopped, so a bare count cannot write the
// sentence the spec asks for. The oldest one is `first`, because that is the
// one the sentence names.
// Cached for a beat: listCards() reads one file per card, and this is computed
// on every sessions push.
const CARDS_WAITING_TTL = 5000
const WAITING_STATUSES = ['needs_approval', 'waiting_human']
let cardsWaitingCache = { at: 0, data: null }
function cardsWaiting() {
  if (cardsWaitingCache.data && Date.now() - cardsWaitingCache.at < CARDS_WAITING_TTL) return cardsWaitingCache.data
  let waiting = []
  try { waiting = listCards().filter((c) => WAITING_STATUSES.includes(c.status)) } catch { waiting = [] }
  // `updated_at` is when the card reached this state, which is what "has
  // waited on you for 12 minutes" measures from
  waiting.sort((a, b) => (String(a.updated_at ?? '') < String(b.updated_at ?? '') ? -1 : 1))
  const first = waiting[0] ?? null
  const data = {
    count: waiting.length,
    first: first ? { id: first.card_id, title: first.title ?? null, station: first.station ?? null, since: first.updated_at ?? null } : null,
  }
  cardsWaitingCache = { at: Date.now(), data }
  return data
}

// `events` is the card's ledger, already read by the caller. readEvents() does
// a readdir, a full readFileSync, a JSON.parse per line and a sort every call,
// and this function needed it three times per push (the last event, the legs
// that started at a finished station, and the test/land outcomes of a live
// card) on the one event loop the board serves every request from. Read once,
// reused; a caller that has no events passes none and pays for one read.
export function summarize(card, events = null) {
  const st = (card.pipeline ?? []).find((s) => s.name === card.station) ?? null
  // `cards.map(summarize)` would hand this the array index, so the type is
  // checked rather than the emptiness
  const evs = Array.isArray(events) ? events : readEvents(card.card_id)
  const last = evs.length ? evs[evs.length - 1] : null
  const runs = readRuns(card.card_id)
  const activeRun = runs.find((r) => ['launching', 'running'].includes(r.status)) ?? null
  // Once a station is over (done/failed) card.leg is reset, so the rail is
  // rebuilt from the legs that actually started at this station.
  const terminal = ['done', 'failed', 'killed'].includes(card.status)
  const startedLegs = terminal && st?.kind === 'agent'
    ? evs.filter((ev) => ev.type === 'leg_started' && ev.station === card.station).map((ev) => ev.leg)
    : []
  const lastLeg = startedLegs.length ? Math.max(...startedLegs) : card.leg
  // card.leg is reset when the station ends, so a finished card read its adapter
  // off chain[0] and reported the agent that STARTED the work as the one that
  // did it. On a handoff card that is the wrong name on the finished row.
  const entry = st?.kind === 'agent' ? st.chain[terminal ? lastLeg : card.leg] ?? null : null
  const legState = (i) => {
    if (terminal) {
      if (!startedLegs.includes(i)) return 'pending'
      if (i < lastLeg) return 'handed'
      return card.status === 'done' ? 'done' : 'failed'
    }
    if (i < card.leg) return 'handed'
    if (i > card.leg) return 'pending'
    return ['running', 'handing_off'].includes(card.status) ? 'active' : 'pending'
  }
  // What a live card is carrying right now: the diff it has built, the last
  // test verdict, the last land verdict, and the rung it is on. Measured only
  // for a card that is still going: a finished one is a single line in the
  // ledger, and a git subprocess for each of ten of those buys nothing (C.1).
  const live = NON_TERMINAL.includes(card.status)
  const work = live ? workFor(card) : null
  const outcomes = live ? cardOutcomes(evs) : {}
  return {
    ...card,
    column: columnOf(card),
    station_kind: st?.kind ?? null,
    active_adapter: entry?.adapter ?? null,
    active_mode: entry?.mode ?? null,
    ...(work ? { work } : {}),
    ...(outcomes.tests ? { tests: outcomes.tests } : {}),
    ...(outcomes.land ? { land: outcomes.land } : {}),
    ...(live && entry ? { agent_model: { agent: entry.adapter ?? null, model: entry.model ?? null } } : {}),
    chain_view: st?.kind === 'agent' ? st.chain.map((e, i) => ({
      adapter: e.adapter, mode: e.mode ?? null, approve: Boolean(e.approve),
      // a leg before the last one ended in a handoff (only the last leg can complete a station)
      state: legState(i),
    })) : [],
    actions: availableActions(card),
    last_event: last ? { ts: last.ts, type: last.type, summary: last.summary, actor: last.actor } : null,
    runs_count: runs.length,
    active_run: activeRun ? { run: activeRun.run, adapter: activeRun.adapter, started_at: activeRun.started_at } : null,
    elapsed_ms: activeRun ? Date.now() - Date.parse(activeRun.started_at) : null,
    repo_name: card.repo ? card.repo.split(/[\\/]/).filter(Boolean).pop() : null,
  }
}

const LOG_TAIL_BYTES = 65536

// Read at most the last `maxBytes` of a file without loading the whole thing
// (run logs can grow large; the board only ever shows a tail of them).
function readFileTail(path, maxBytes = LOG_TAIL_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (!len) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function logTail(id, run, tail = 200) {
  const runs = readRuns(id)
  const r = run ? runs.find((x) => x.run === run) : runs[runs.length - 1]
  if (!r) return { run: null, lines: [] }
  const dir = join(cardDir(id), 'runs', String(r.run))
  const lines = []
  for (const f of ['out.log', 'err.log']) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    const text = readFileTail(p).trim()
    if (text) lines.push(...text.split('\n').map((l) => `${f === 'err.log' ? 'stderr ' : ''}${l}`))
  }
  return { run: r.run, adapter: r.adapter, status: r.status, outcome: r.outcome ?? null, lines: scrub(lines.slice(-tail).join('\n')).split('\n') }
}

function floor(cards) {
  const running = cards.filter((c) => ['running', 'handing_off'].includes(c.status)).map((c) => {
    const s = summarize(c)
    return { card_id: c.card_id, title: c.title, station: c.station, status: c.status, adapter: s.active_adapter, leg: c.leg, leases: c.leases?.length ? c.leases : ['**'], last_event: s.last_event, since: s.active_run?.started_at ?? c.updated_at, elapsed_ms: s.elapsed_ms, repo_name: s.repo_name }
  })
  const waiting = cards.filter((c) => ['waiting_human', 'needs_approval', 'paused'].includes(c.status)).map((c) => ({ card_id: c.card_id, title: c.title, station: c.station, status: c.status, since: c.updated_at, actions: availableActions(c) }))
  const queued = cards.filter((c) => c.status === 'queued').map((c) => {
    const last = lastEventOf(c.card_id)
    return { card_id: c.card_id, title: c.title, station: c.station, leases: c.leases?.length ? c.leases : ['**'], blocked_by: last?.type === 'blocked_by' ? last.summary : null }
  })
  return {
    running, waiting, queued,
    leases: held(cards),
    scheduler: { ...schedulerStatus(), max_concurrent: MAX_CONCURRENT },
    repos: [...new Set(cards.map((c) => c.repo))],
    counts: { running: running.length, queued: queued.length, waiting: waiting.length, done: cards.filter((c) => c.status === 'done').length },
  }
}

function trunk(cards, sinceMs) {
  const cutoff = Date.now() - sinceMs
  const landed = []
  for (const c of cards) {
    for (const e of readEvents(c.card_id)) {
      if (e.type !== 'landed') continue
      if (Date.parse(e.ts) < cutoff) continue
      landed.push({ ts: e.ts, card_id: c.card_id, title: c.title, summary: e.summary, body: e.body ?? null, actor: e.actor, station: e.station })
    }
  }
  landed.sort((a, b) => (a.ts < b.ts ? 1 : -1))
  return { since_ms: sinceMs, landed }
}

function parseSince(s) {
  const m = /^(\d+)(m|h|d)$/.exec(String(s ?? '1h'))
  if (!m) return 3600000
  return parseInt(m[1], 10) * { m: 60000, h: 3600000, d: 86400000 }[m[2]]
}

let toolsCache = null
// Is this agent actually here? Ask its adapter to resolve the binary the
// runner would spawn (codex's native exe, an npm entry, a BATON_<AGENT>_BIN
// override) instead of running the bare name, which on Windows needs a shell
// and told the board "no codex" while the runner could start it fine.
export async function detectTools({ refresh = false } = {}) {
  if (toolsCache && !refresh) return toolsCache
  const probe = (bin, args = ['--version']) => {
    const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    return !r.error && r.status === 0
  }
  const agents = {}
  for (const name of ['claude', 'codex', 'agy', 'grok']) {
    try {
      const a = name === 'grok' ? (await import('./adapters/grok.mjs')).default : await getAdapter(name)
      const { bin, viaNode, entry } = a.resolve()
      const target = viaNode ? (entry ?? bin) : bin
      agents[name] = /[\\/]/.test(target) ? existsSync(target) : probe(target)
    } catch { agents[name] = false }
  }
  let chb = false
  try { resolveChb(); chb = true } catch {}
  toolsCache = { ...agents, chb, git: probe('git') }
  return toolsCache
}

async function adaptersInfo() {
  const out = []
  for (const n of adapterNames()) {
    const a = await getAdapter(n)
    out.push({ name: n, modes: a.modes, fake: isFake(n), stdin: a.stdin })
  }
  return out
}

// ---- sessions (baton claude|codex|agy) ----
// The worktree list runs git once per known repository: cached for a short
// while so a board that polls does not fork fifty processes a second.
const WORKTREES_TTL = 20000
const worktreesCache = new Map()
// A stale index is refreshed by a child `leg history refresh`, never in this
// process: the scan stats thousands of files and walks every cwd, and inside
// the board's event loop that is seconds of no SSE frames and no clicks. The
// child takes the same index lock a CLI refresh would, so the two never tear
// one file; the next listing reads what it wrote.
const LEG_BIN = join(dirname(SELF), '..', 'bin', 'leg.mjs')
let historyRefreshing = false
function backgroundHistoryRefresh() {
  if (historyRefreshing) return
  historyRefreshing = true
  try {
    execFile(process.execPath, [LEG_BIN, 'history', 'refresh', '--json'], { env: process.env, windowsHide: true, timeout: 120000 }, () => { historyRefreshing = false })
  } catch { historyRefreshing = false }
}
function worktreesFor({ repo = null, dirty = true } = {}) {
  const key = `${repo ?? ''}|${dirty}`
  const hit = worktreesCache.get(key)
  if (hit && Date.now() - hit.at < WORKTREES_TTL) return hit.data
  const data = listWorktrees({ repo, dirty, dirtyLimit: 20, repoLimit: 20 })
  worktreesCache.set(key, { at: Date.now(), data })
  return data
}

// canLand shells out to git several times for one worktree, and the view runs
// it for every terminal that ever had one — over a second of subprocesses on a
// board with a few dozen records, paid again on every SSE push. A terminal that
// has ended never moves, so the answer is cached against the record's own
// revision with the short TTL the trunk already uses, which still notices a
// commit made by hand in the worktree within that window.
// A terminal that is still running can change what it can land from one turn to
// the next. One that has ended only moves if someone works in its worktree by
// hand, and a landing clears this cache outright, so it is re-read a great deal
// less often.
const CAN_LAND_TTL = 15000
const CAN_LAND_TTL_ENDED = 60000
const canLandCache = new Map()
function canLandFor(s) {
  const key = `${s.session_id}|${s.updated_at ?? ''}`
  const hit = canLandCache.get(key)
  if (hit && Date.now() < hit.until) return hit.data
  const data = canLand(s)
  // Expiries are spread across the window instead of falling together: twenty
  // worktrees re-read in one pass is another second of git inside the event
  // loop, which is the stall this cache exists to remove. Staggered, the board
  // pays for about one of them per push and never blocks on the set.
  const ttl = isActive(s) ? CAN_LAND_TTL : CAN_LAND_TTL_ENDED
  const until = Date.now() + ttl / 2 + Math.random() * ttl
  // the key carries updated_at, so a busy terminal leaves a dead entry per
  // write: drop the whole map rather than grow it for the life of the process
  if (canLandCache.size > 500) canLandCache.clear()
  canLandCache.set(key, { until, data })
  return data
}

const trunkCache = new Map()
function trunkFor(repo) {
  const hit = trunkCache.get(repo)
  if (hit && Date.now() - hit.at < 15000) return hit.data
  const g = (args) => { const r = spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }); return r.status === 0 ? r.stdout.trim() : null }
  // The branch this repo actually calls its trunk: origin's default if there is
  // one, then the usual names, then whatever this checkout is on. A repo whose
  // default is `develop` used to read as "main" here, and the board's one-line
  // entry then posted a card against a branch that does not exist.
  let branch = null
  const originHead = g(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) {
    const name = originHead.replace(/^origin\//, '')
    if (name && g(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null) branch = name
  }
  if (!branch) for (const b of ['main', 'master', 'trunk']) if (g(['rev-parse', '--verify', '--quiet', b]) !== null) { branch = b; break }
  if (!branch) branch = g(['symbolic-ref', '--short', 'HEAD']) || null
  const log = branch ? g(['log', '--format=%h%x1f%s%x1f%cr%x1f%an', '-6', branch]) : null
  const data = {
    repo, repo_name: repo.split(/[\\/]/).filter(Boolean).pop(), branch,
    commits: (log ?? '').split('\n').filter(Boolean).map((l) => { const [sha, subject, when, author] = l.split('\x1f'); return { sha, subject, when, author } }),
  }
  trunkCache.set(repo, { at: Date.now(), data })
  return data
}

// Each trunk commit a Land put there says who landed it (landings.jsonl).
function withLandings(t, landings) {
  if (!landings.length) return t
  return {
    ...t,
    commits: t.commits.map((c) => {
      const l = landings.findLast((x) => (x.commits?.length ? x.commits : [x.sha]).some((sha) => String(sha).startsWith(c.sha)))
      return l ? { ...c, landed_by: { agent: l.agent, account: l.account, session_id: l.session_id, by: l.by, at: l.ts } } : c
    }),
  }
}

// What another human sees of a terminal that is not theirs: that it is there,
// nothing it has said, read or written. No task, no paths, no file names, no
// limit text, no bundle, no events.
// No usage either. `limits` is the five-hour and seven-day percentage of this
// machine's login, written onto the record by the poller and by every claude
// status line, and `warning` carries the same percentage with the clock it
// resets on. Both are the number the capacity drawer, the accounts payload and
// guestReason all withhold, so neither may ride out on a row instead
// (.design/BOARD-DESIGN.md 6.13). The band survives, the figure does not.
function redactSession(s) {
  return {
    session_id: s.session_id, agent: s.agent, account: s.account, status: s.status, active: s.active,
    started_at: s.started_at, elapsed_ms: s.elapsed_ms, turns: s.turns, repo_name: s.repo_name, branch: s.branch,
    owner: s.owner ?? null, lineage: s.lineage ?? null,
    warning: s.warning ? { window: s.warning.window } : null,
    limit: s.limit ? { reason: s.limit.reason } : null,
    // `ahead` is owner-only for the same reason `files` is: how far someone
    // else's branch has moved is a fact about their work, and the register
    // prints it beside the dirty count that is already withheld here.
    // `waiting` and `model` are owner-only, and a guest keeps both on their own
    // terminal (that row is not redacted at all). On someone else's row they are
    // dropped: `waiting` carries either the verbatim question an agent asked —
    // the prompt text this function exists to hide — or a reset time, which is
    // this machine's usage data (.design/BOARD-DESIGN.md 6.13); and `model` is
    // which of this machine's model buckets someone else's work is spending.
    worktree: s.worktree ? { branch: s.worktree.branch, base: s.worktree.base } : null,
    // the branch is already on the worktree chip: naming it again costs nothing
    // and is what the board's land line reads
    land: s.land ? { state: s.land.state, branch: s.land.branch ?? null, base: s.land.base ?? null, sha: s.land.sha ?? null, reason: s.land.reason ?? null } : null,
    // the chip's word only: paths, dropped items and attention text stay on this machine
    harness: s.harness ? { state: s.harness.state, target: s.harness.target ?? null } : null,
    task: null, cwd: null, files: [], overlap: [], requests: [], hidden: true,
    land_blocker: `read-only: this terminal belongs to ${s.owner ?? 'someone else'}`,
  }
}

// A guest's OWN terminal is not redacted: it is their work. The login it runs
// on is still this machine's, though, and every figure on the record that was
// measured from the owner's accounts is the same secret `capacity`, `buckets`
// and the accounts payload already withhold: the two window percentages
// (`limits`), the near-wall warning, the reset clock on a limit or an all-out
// wait, and the name of the reading source. The row keeps every fact about the
// work and loses every figure about the login (.design/BOARD-DESIGN.md 6.13).
function scrubOwnerUsage(s) {
  const out = { ...s }
  delete out.limits
  delete out.all_out
  delete out.usage_source
  delete out.usage_error
  // the band survives, the figure and the clock do not: their own row may say
  // it is near a wall, the same way a redacted row does
  if (out.warning) out.warning = { window: out.warning.window }
  if (out.limit) out.limit = { ...out.limit, resets_at: null }
  // a 'reset' wait is a reset time with a sentence around it; the guest still
  // learns that their terminal is waiting for one
  if (out.waiting && out.waiting.type === 'reset') out.waiting = { type: 'reset', since: out.waiting.since ?? null }
  return out
}

// A guest owns their own terminal, so its picker rows are theirs to read, but
// a rung's reason can quote this machine's usage ("at 63%, not below 80%",
// "past your 10% reserve"), and a percentage of this machine's login belongs to
// nobody else (.design/BOARD-DESIGN.md 6.13). Only the reasons that say nothing
// about how much is left survive the crossing.
const GUEST_REASONS = new Set(['not installed on this machine', 'at its usage limit', 'shares the window that is out, buys nothing', 'refused for this hand-off'])
function guestReason(reason) {
  if (!reason) return null
  return GUEST_REASONS.has(reason) ? reason : 'not available right now'
}

function visibleSessionFile(file) {
  const value = String(file ?? '')
  return !value.includes('*** Begin Patch') && !value.includes('*** End Patch')
}

export function sessionsView({ viewer = null, share = null } = {}) {
  const shared = Boolean(share && shareIsOn(share))
  // Decided before the map below, because the per-session payload has to know
  // it: a guest owns their own terminal and may hand it off, so they get its
  // list of destinations — but a reset time is this machine's usage data and
  // belongs to nobody else, even on a terminal that is theirs.
  const guest = shared && viewer && viewer.role !== 'owner'
  const list = reapLost(listSessions())
  const ov = overlaps(list)
  const configuredAccounts = readAccounts()
  // the spending rules the picker has to print, read once for the whole view
  const prefs = readPreferences()
  const sessions = list.map((s) => {
    const land = readLand(s.session_id)
    const handoffOrder = normalizeHandoffOrder(s.handoff_order)
    // this terminal's own ladder, else the long-hand form of its order
    const handoffLadder = ladderFor(s)
    const from = { agent: s.agent, account: s.account, model: s.model ?? null }
    const chain = candidates({ agent: s.agent, account: s.account, model: s.model ?? null, accounts: configuredAccounts, order: handoffOrder, ladder: handoffLadder })
    const preferredNext = chain[0] ?? null
    const availabilityKnown = Boolean(s.installed)
    // one pass, the same one the chooser makes, so a greyed row in the picker
    // and the rung an automatic hand-off would take can never disagree. The
    // picker is a human pressing a button, so the reserve is a note here, not
    // a refusal (B.3).
    const rungs = evaluateLadder({ from, list: chain, installed: availabilityKnown ? s.installed : null, maySpend: prefs.may_spend, reserve: prefs.reserve, automatic: false, climbBack: prefs.climb_back, ladder: handoffLadder })
    const open = availabilityKnown ? rungs.find((r) => r.ok) : null
    const eligibleNext = open ? { agent: open.agent, account: open.account, ...(open.model ? { model: open.model } : {}) } : null
    const can = s.worktree ? canLandFor(s) : { ok: false, blockers: [{ code: 'no_worktree', message: 'this terminal works in the checkout itself: there is no branch of its own to land', fix: null }] }
    return {
      ...s,
      handoff_order: handoffOrder,
      chain,
      preferred_next: preferredNext,
      eligible_next: eligibleNext,
      // every destination this terminal could be handed to, each with the
      // reason it cannot be picked right now. The board's picker renders this
      // list directly, so a greyed option always carries its own explanation.
      // one row per RUNG now: `claude/opus` and `claude/sonnet` are separate
      // destinations, each with what it costs, whether it keeps the
      // conversation, and the reason it cannot (or should not) be picked.
      handoff_targets: rungs.map((r) => ({
        agent: r.agent,
        account: r.account,
        model: r.model ?? null,
        available: r.ok,
        // A row that CAN be picked has nothing to explain: the reserve and the
        // `below:N` rules come back as a note on an ok row (usage.mjs), and
        // generalising that note reads as a refusal beside a button that works.
        // A row that is blocked keeps a reason a guest may read.
        reason: guest ? (r.ok ? null : guestReason(r.reason)) : r.reason,
        resets_at: !guest ? (r.resets_at ?? null) : null,
        // the probe in fixtures/live/claude/resume-model-probe.json: a claude
        // downshift resumes the same conversation; everything else is primed
        // from the bundle, codex included until its own resume is observed
        keeps_conversation: Boolean(isDownshift(from, r) && r.agent === 'claude' && s.agent_session_id),
        // the cost word is not static: `credits` on a claude/fable rung means
        // this machine's login has usage credits switched on (preferences.mjs
        // rungCost reads extra_usage.enabled), which is a fact about the
        // owner's account that the accounts payload drops on purpose. A guest
        // gets the row and not the word.
        ...(guest ? {} : { cost: r.cost }),
      })),
      handoff_availability_known: availabilityKnown,
      handoff_ladder: handoffLadder,
      // the bucket that will actually stop this terminal, computed per request
      // and never persisted: it depends on the model the row is running, and
      // the record only knows the login. A guest never gets it: it is a
      // percentage of this machine's usage (.design/BOARD-DESIGN.md 6.13).
      ...(guest ? {} : { capacity: binding(readUsage(s.agent, s.account), s.model ?? null) }),
      can_edit_handoff_order: s.runtime_capabilities?.includes(HANDOFF_ORDER_CAPABILITY) ?? false,
      active: isActive(s),
      has_synthesis: hasRecentSynthesis(s),
      overlap: ov.get(s.session_id) ?? [],
      elapsed_ms: Date.now() - Date.parse(s.started_at),
      // Older attached Codex processes can retain one parser mistake where an
      // apply_patch source block was stored as a file name. Keep history on
      // disk and hide only unmistakable patch envelopes in the board view.
      files: [...new Set([...(s.files_touched ?? []), ...(s.files_dirty ?? [])])].filter(visibleSessionFile),
      // a 'landing' left behind by a board restart is no longer in flight
      land: land?.state === 'landing' && !landingNow(s.session_id) ? { ...land, state: 'interrupted' } : land,
      can_land: can,
      land_blocker: s.worktree ? (can.ok ? null : can.blockers[0]?.message) : null,
    }
  })
  const accounts = []
  for (const agent of Object.keys(configuredAccounts)) for (const account of configuredAccounts[agent]) {
    const u = readUsage(agent, account)
    // buckets, walls, extra_usage and facts are owner-only for the same reason
    // the percentages are: they say how much of this machine's login is gone.
    // The guest branch at the bottom of this function drops the slot to
    // {agent, account, live, shared}, so nothing here reaches them.
    accounts.push({ agent, account, five_hour: u.five_hour, seven_day: u.seven_day, limited_until: u.limited_until, limited_reason: u.limited_reason, source: u.source, observed_at: u.observed_at, updated_at: u.updated_at, stale: usageIsStale(u), live: sessions.filter((s) => s.active && s.agent === agent && s.account === account).length, buckets: u.buckets ?? [], walls: u.walls ?? {}, extra_usage: u.extra_usage ?? null, facts: u.facts ?? null })
  }
  const repos = new Map()
  for (const s of sessions) if (s.repo && (s.active || s.worktree) && !repos.has(canonPath(s.repo))) repos.set(canonPath(s.repo), s.repo)
  const landings = readLandings()
  const canon = new Map()
  const landingsFor = (key) => landings.filter((l) => { if (!canon.has(l.repo)) canon.set(l.repo, canonPath(l.repo)); return canon.get(l.repo) === key })
  const trunk = [...repos].map(([key, r]) => { try { return withLandings(trunkFor(r), landingsFor(key)) } catch { return { repo: r, commits: [] } } })
  const mine = (s) => !shared || !viewer || viewer.role === 'owner' || (s.owner ?? share.owner) === viewer.name
  const shown = sessions.map((s) => {
    if (!mine(s)) return redactSession(s)
    const row = { ...s, requests: readRequests(s.session_id).filter((r) => r.state === 'pending') }
    return guest ? scrubOwnerUsage(row) : row
  })
  return {
    sessions: shown,
    // a guest sees which accounts exist and which are busy, never how much of
    // them is used: the head prints "not shared" in these slots, and the
    // percentages, the reset times and the reading source stay on this machine
    // (.design/BOARD-DESIGN.md 6.13)
    accounts: guest ? accounts.map((a) => ({ agent: a.agent, account: a.account, live: a.live, shared: false })) : accounts,
    // a guest sees what landed, not where the repo lives on this machine
    trunk: guest ? trunk.map((t) => ({ repo_name: t.repo_name, branch: t.branch, commits: t.commits ?? [] })) : trunk,
    you: viewer,
    // the terminals verdict has to be able to say "card 3e1c has waited on you
    // for 12 minutes" without reading the whole pipeline board (redesign C.5).
    // A guest has no cards at all; an operator runs them, approves them and is
    // exactly the human one can be waiting on, so the gate is the cards
    // permission the /api/cards routes use, not the owner flag.
    ...(!shared || mayUseCards(viewer?.role ?? 'owner') ? { cards_waiting: cardsWaiting() } : {}),
    share: { on: shared, bind: shared ? share.bind : null, people: shared ? share.people.length : 0 },
    preferences: guest ? null : readPreferences(),
    ts: new Date().toISOString(),
  }
}

// ---- http helpers ----
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')) })
    req.on('end', () => {
      if (!data) return resolvePromise({})
      try { resolvePromise(JSON.parse(data)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function serveStatic(res, urlPath) {
  const map = { '/': 'index.html', '/board': 'index.html', '/board/': 'index.html', '/floor': 'floor.html', '/floor/': 'floor.html' }
  const rel = map[urlPath] ?? urlPath.replace(/^\/+/, '')
  const boardDir = resolveBoardDir()
  const file = resolve(boardDir, rel)
  if (!file.startsWith(boardDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}

// ---- SSE: watch $BATON_HOME/cards for fs events and push only what changed ----
function createSse({ healthIntervalMs = 10000, debounceMs = 30, sessionsDebounceMs = 300, sessionsMinIntervalMs = 2000, viewFor = () => sessionsView(), reauth = (c) => c.viewer } = {}) {
  const clients = new Set() // { res, viewer, token, loopback, sig }
  let watcher = null
  let healthTimer = null
  const pending = new Set()
  let flushTimer = null
  // data may be a function of the client's viewer: each human gets their own
  // payload, so a guest's stream never carries someone else's terminal. The
  // viewer is re-resolved from the live roster on every push, so a link that
  // `share rm`/`rotate` invalidated loses its stream at once.
  const broadcast = (event, data) => {
    for (const c of [...clients]) {
      const viewer = reauth(c)
      if (viewer === null) { try { c.res.end() } catch {} clients.delete(c); if (!clients.size) stopWatch(); continue }
      c.viewer = viewer
      const payload = typeof data === 'function' ? data(viewer) : data
      if (payload === null || payload === undefined) continue
      try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`) } catch {}
    }
  }
  // Re-read and re-emit exactly one card's files — never the whole ledger. Each
  // client carries its own high-water mark, so a second client connecting never
  // resets the count the first is reading from.
  const refreshCard = (id) => {
    const card = readCard(id)
    // pipeline cards and their events belong to the people who may run them:
    // the owner and any operator. A guest never gets them.
    const forOwner = (payload) => (viewer) => (viewer && !mayUseCards(viewer.role) ? null : payload)
    if (!card) { for (const c of clients) c.sig.delete(id); broadcast('removed', forOwner({ card_id: id })); return }
    const events = readEvents(id)
    // broadcast() refreshes each client's viewer (and drops revoked ones) first
    broadcast('card', forOwner(summarize(card, events)))
    for (const c of [...clients]) {
      if (!c.viewer || !mayUseCards(c.viewer.role)) { c.sig.set(id, events.length); continue }
      const from = c.sig.get(id) ?? 0
      c.sig.set(id, events.length)
      for (const e of events.slice(from)) { try { c.res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`) } catch {} }
    }
  }
  const flushPending = () => {
    flushTimer = null
    const ids = [...pending]
    pending.clear()
    for (const id of ids) refreshCard(id)
  }
  const scheduleRefresh = (id) => {
    pending.add(id)
    if (!flushTimer) flushTimer = setTimeout(flushPending, debounceMs)
  }
  let sessionsWatcher = null
  let sessionsTimer = null
  let lastSessionsPush = 0
  const pushSessions = () => {
    sessionsTimer = null
    try { broadcast('sessions', (viewer) => viewFor(viewer)) } catch (err) { log(`sessions view: ${err.message}`) }
    lastSessionsPush = Date.now()
    // the health tick pushes on its own schedule: record what it sent, so the
    // next watcher hint is measured against the page's real contents
    lastFingerprint = sessionsFingerprint()
  }
  // One live agent rewrites its record about every six seconds and takes a
  // control lock about once a second, and every one of those touches the
  // sessions tree. Rebuilding the whole view costs a second or more of `git`,
  // so a watcher that answers every touch turns a single running terminal into
  // a permanent busy loop on the one event loop this board serves every
  // request from: the board then takes seconds to hand over a stylesheet and
  // `leg` itself times out probing /api/health.
  //
  // A watcher event is only a hint. Locks and the temp files an atomic write
  // leaves behind are dropped by name, but taking a lock inside a session
  // directory also changes that directory's own mtime, and that event arrives
  // carrying nothing but the directory name — no filter on the name can tell
  // it from a real write. So the hint is checked against the data: a stat over
  // the files the view is actually built from costs a fraction of a
  // millisecond and answers the question the event cannot.
  const NOISE = /(\.lock|\.tmp)$/i
  const sessionsChangeMatters = (filename) => !filename || !NOISE.test(String(filename))
  const sessionsFingerprint = () => {
    const root = sessionsRoot()
    let dirs
    try { dirs = readdirSync(root) } catch { return '' }
    let sig = ''
    for (const name of dirs) {
      if (!name.startsWith('s-')) continue
      for (const file of ['session.json', 'land.json', 'requests.json']) {
        try { const st = statSync(join(root, name, file)); sig += `${name}/${file}:${st.mtimeMs}:${st.size};` } catch { /* not written yet */ }
      }
    }
    return sig
  }
  let lastFingerprint = null
  const pushIfChanged = () => {
    sessionsTimer = null
    const sig = sessionsFingerprint()
    // the hint was noise: the view would rebuild to exactly what the page
    // already has, so nothing is rebuilt and nothing is sent
    if (sig === lastFingerprint) return
    lastFingerprint = sig
    pushSessions()
  }
  const scheduleSessionsPush = () => {
    if (sessionsTimer) return
    const wait = Math.max(sessionsDebounceMs, sessionsMinIntervalMs - (Date.now() - lastSessionsPush))
    sessionsTimer = setTimeout(pushIfChanged, wait)
  }
  const startWatch = () => {
    if (watcher) return
    try {
      const sdir = sessionsRoot()
      mkdirSync(sdir, { recursive: true })
      // the client that opened this watch was handed the current view with its
      // hello frame, so the fingerprint starts from what it already has: an
      // unprimed one makes the first hint of any kind look like a change
      lastFingerprint = sessionsFingerprint()
      sessionsWatcher = fsWatch(realPath(sdir), { recursive: true }, (_event, filename) => { if (sessionsChangeMatters(filename)) scheduleSessionsPush() })
    } catch (err) { log(`sessions watch: ${err.message}`); sessionsWatcher = null }
    // watch the real long path: libuv's recursive watcher asserts when the
    // watched dir is an 8.3 short path (fs-event.c, seen on a GitHub runner)
    const dir = join(home(), 'cards')
    try {
      mkdirSync(dir, { recursive: true })
      watcher = fsWatch(realPath(dir), { recursive: true }, (_event, filename) => {
        if (!filename) return
        const id = String(filename).split(/[\\/]/)[0]
        if (id.startsWith('card-')) scheduleRefresh(id)
      })
    } catch (err) { log(`sse watch: ${err.message}`); watcher = null }
    // the scheduler is the pipeline's, like /api/health: a guest's topbar
    // gets the tick without it
    healthTimer = setInterval(() => {
      const ts = new Date().toISOString()
      broadcast('health', (viewer) => (viewer && viewer.role !== 'owner' ? { ok: true, ts } : { ok: true, scheduler: { ...schedulerStatus(), max_concurrent: MAX_CONCURRENT }, ts }))
      pushSessions()
    }, healthIntervalMs)
  }
  const stopWatch = () => {
    if (watcher) { watcher.close(); watcher = null }
    if (sessionsWatcher) { sessionsWatcher.close(); sessionsWatcher = null }
    if (sessionsTimer) { clearTimeout(sessionsTimer); sessionsTimer = null }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    pending.clear()
  }
  const add = (res, cards, viewer = null, meta = {}) => {
    const client = { res, viewer, token: meta.token ?? null, loopback: Boolean(meta.loopback), sig: new Map() }
    clients.add(client)
    for (const c of cards) client.sig.set(c.card_id, readEvents(c.card_id).length)
    startWatch()
    res.on('close', () => { clients.delete(client); if (!clients.size) stopWatch() })
  }
  const stop = () => { stopWatch(); for (const c of clients) { try { c.res.end() } catch {} } clients.clear() }
  return { add, stop, broadcast, clients }
}

// ---- the server ----
export function createBoardServer({ bind, port, token = process.env.LEG_TOKEN || process.env.BATON_TOKEN || '', scheduler = (process.env.LEG_NO_SCHEDULER || process.env.BATON_NO_SCHEDULER) !== '1', share, usagePolling = false, usageReader = readCodexUsage } = {}) {
  // An explicit `share` (tests) is fixed; the real server passes none and reads
  // share.json from disk, re-reading it per request (mtime-cached) so `leg
  // share add|rotate|rm` takes effect on a live board — a new link works at
  // once and a removed or rotated one stops at once — without a restart.
  const explicitShare = share !== undefined
  const initialShare = explicitShare ? share : readShare()
  const shared0 = shareIsOn(initialShare)
  // with share on, the board's address and port come from share.json
  bind = bind ?? (shared0 ? initialShare.bind : (process.env.LEG_BIND || process.env.BATON_BIND || '127.0.0.1'))
  port = port ?? (shared0 ? initialShare.port : Number(process.env.LEG_PORT || process.env.BATON_PORT || 4747))
  checkBind({ bind, token, share: initialShare })
  let shareSnapshot = initialShare
  let shareMtime = -1
  const currentShare = explicitShare ? () => initialShare : () => {
    try {
      const st = statSync(sharePath())
      if (st.mtimeMs !== shareMtime) { shareMtime = st.mtimeMs; shareSnapshot = readShare() }
    } catch { if (shareMtime !== -1) { shareMtime = -1; shareSnapshot = readShare() } }
    return shareSnapshot
  }
  const limiter = createLimiter()
  const viewFor = (viewer, sh) => sessionsView({ viewer, share: sh ?? currentShare() })
  const forOwner = (payload) => (viewer) => (viewer && !mayUseCards(viewer.role) ? null : payload)
  // SSE re-identifies each client from the live roster on every push
  const reauthClient = (c) => {
    const sh = currentShare()
    // share stopping is a revocation, never a promotion: a guest holding this
    // stream through their own token loses it, and only the machine's own
    // tokenless page (or this board's BATON_TOKEN) is the single-player owner
    if (!shareIsOn(sh)) {
      if (c.token) return tokenMatches(token, c.token) ? { name: 'token', role: 'owner' } : null
      return c.loopback ? { name: 'local', role: 'owner' } : null
    }
    const person = identify(sh, c.token)
    if (person) return { name: person.name, role: person.role }
    if (!c.token && sh.loopback_owner !== false && c.loopback) {
      const owner = personNamed(sh, sh.owner) ?? sh.people.find((p) => p.role === 'owner') ?? null
      if (owner) return { name: owner.name, role: owner.role }
    }
    return null
  }
  const sse = createSse({ viewFor, reauth: reauthClient })
  // A card that adopted a live terminal's checkout waits in the backlog until
  // that terminal has really stopped. `end` is a REQUEST: src/attach.mjs reads
  // control.json on its own poll (2s by default) and kills the child at the
  // next tick, while the scheduler ticks every second, so a card queued here
  // would put a headless agent in the same working tree as the interactive one
  // for at least a tick, and longer if the agent is mid-turn. The session
  // record is how the board learns a terminal ended (attach writes `ended`,
  // sessions.mjs reaps a lost one), so that is what this waits on.
  const ENQUEUE_POLL_MS = Math.max(50, Number(process.env.LEG_END_AS_CARD_POLL_MS || process.env.BATON_END_AS_CARD_POLL_MS || 500))
  const ENQUEUE_WAIT_MS = Math.max(1000, Number(process.env.LEG_END_AS_CARD_WAIT_MS || process.env.BATON_END_AS_CARD_WAIT_MS || 600000))
  const enqueueTimers = new Map()
  function enqueueWhenSessionEnds(cardId, sessionId, who) {
    const from = Date.now()
    const arm = () => {
      const t = setTimeout(tick, ENQUEUE_POLL_MS)
      t.unref?.()
      enqueueTimers.set(cardId, t)
    }
    const tick = () => {
      enqueueTimers.delete(cardId)
      const card = readCard(cardId)
      // killed, removed, or started by hand: it is not this timer's any more
      if (!card || card.status !== 'backlog') return
      const s = readSession(sessionId)
      if (!s || !isActive(s)) {
        try {
          const next = humanAction(cardId, 'enqueue', {}, who)
          log(`end-as-card ${cardId}: terminal ${sessionId} has stopped, the card is queued`)
          sse.broadcast('card', forOwner(summarize(next)))
        } catch (err) { log(`end-as-card ${cardId}: ${err.message}`) }
        return
      }
      if (Date.now() - from > ENQUEUE_WAIT_MS) {
        // never start it behind the human's back after a long wait: say why it
        // is sitting there and leave Run to them
        try { ledgerAppend(cardId, { actor: who, type: 'blocked_by', summary: `terminal ${sessionId} has not stopped, so this card is still in the backlog; press Run once it has` }) } catch { /* the log line below is the record */ }
        log(`end-as-card ${cardId}: terminal ${sessionId} still active after ${Math.round(ENQUEUE_WAIT_MS / 1000)}s, left in the backlog`)
        return
      }
      arm()
    }
    arm()
  }
  let sched = null
  let usageTimer = null
  let usageController = null
  let usageInFlight = null
  const refreshCodexAccounts = () => {
    if (!usagePolling || ((process.env.LEG_CODEX_BIN || process.env.BATON_CODEX_BIN) && usageReader === readCodexUsage) || usageInFlight) return usageInFlight
    usageController = new AbortController()
    const signal = usageController.signal
    usageInFlight = Promise.all((readAccounts().codex ?? ['default']).map(async (account) => {
      const codexHome = envFor('codex', account).CODEX_HOME || LAYOUT.codex.home()
      const r = await usageReader({ codexHome, timeoutMs: 8000, signal })
      if (!r.ok) return false
      recordUsage('codex', account, r.limits, 'codex app-server account/rateLimits/read', { observed_at: r.observed_at, available: r.available })
      return true
    })).then((changed) => {
      if (changed.some(Boolean)) sse.broadcast('sessions', (viewer) => viewFor(viewer))
    }).catch((err) => log(`codex usage refresh: ${err.message}`)).finally(() => {
      usageInFlight = null
      usageController = null
    })
    return usageInFlight
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    if (!path.startsWith('/api/')) return serveStatic(res, path)
    // reject a state-changing request whose Origin is a different site: a page
    // the operator has open in the same browser cannot drive the loopback board
    if (req.method !== 'GET' && req.headers.origin) {
      let ok = false
      try { ok = new URL(req.headers.origin).host === req.headers.host } catch {}
      if (!ok) return send(res, 403, { error: 'cross-origin request refused' })
    }
    // the roster, resolved fresh per request from share.json (mtime-cached)
    const share = currentShare()
    const shared = shareIsOn(share)
    const ip = remoteAddress(req) || 'unknown'
    // a token cannot be guessed at speed, and no one client can flood the board
    if (limiter.lockedOut(ip)) return send(res, 429, { error: 'too many bad tokens from here; wait a minute' }, { 'Retry-After': String(limiter.retryAfter(ip)) })
    const auth = authorize({ token, req, url, share, bind, loopbackOwner: isLoopbackRequest(req) })
    if (!auth.ok) {
      // only a token that was presented and did not match counts as a guess;
      // a board page that has not been given a token yet is not an attacker,
      // and neither is a stale tab polling the one token it was given
      const presented = presentedToken(req, url)
      if (presented) limiter.failure(ip, presented)
      return send(res, 401, { error: shared ? 'unauthorized: open the board with your own link (leg share)' : 'unauthorized: set Authorization: Bearer <LEG_TOKEN>' })
    }
    const viewer = auth.person ? { name: auth.person.name, role: auth.person.role } : { name: auth.subject ?? 'local', role: 'owner' }
    // a name is a bucket only when it names a human: 'local' and 'token' are
    // every client at once, so those are counted per address
    const rl = limiter.request(auth.person ? viewer.name : ip)
    if (!rl.ok) return send(res, 429, { error: `rate limit: more than ${limiter.max} requests a minute` }, { 'Retry-After': String(rl.retry_after) })
    const actor = { type: 'human', id: viewer.name }
    // What this viewer may reach, decided once from their role (src/share.mjs).
    // `canCards` is the pipeline board: cards, the floor, the adapters and the
    // leases, which an operator runs. `canMachine` is everything that describes
    // this computer rather than the work — the settings, the trunk's repo
    // paths, the history index, the worktree map — and stays the owner's.
    const canCards = !shared || mayUseCards(viewer.role)
    const canMachine = !shared || mayUseMachine(viewer.role)
    const ownsSession = (s) => !shared || viewer.role === 'owner' || (s.owner ?? share.owner) === viewer.name
    const parts = path.split('/').filter(Boolean) // ['api', ...]
    if (!canCards && ['cards', 'floor', 'presets', 'adapters', 'leases'].includes(parts[1])) return send(res, 403, { error: 'the pipeline board belongs to the owner and the operators of this machine' })
    if (!canMachine && ['trunk', 'history', 'worktrees', 'audit'].includes(parts[1])) return send(res, 403, { error: 'this is the map of the machine itself: every repository path and every conversation on it. It belongs to the owner of this machine.' })
    try {
      if (req.method === 'GET' && path === '/api/health') {
        const you = { ...viewer, share: { on: shared, people: shared ? share.people.length : 0 } }
        if (!canCards) return send(res, 200, { ok: true, version: VERSION, you })
        const cards = listCards()
        return send(res, 200, { ok: true, pid: process.pid, version: VERSION, bind, port, home: canMachine ? home() : null, you, scheduler: { ...schedulerStatus(), in_process: Boolean(sched), max_concurrent: MAX_CONCURRENT }, tools: await detectTools(), columns: columnsFor(cards), cards: cards.length })
      }
      if (req.method === 'GET' && path === '/api/adapters') return send(res, 200, { adapters: await adaptersInfo() })
      if (req.method === 'GET' && path === '/api/presets') return send(res, 200, { presets: PRESETS })
      if (req.method === 'GET' && path === '/api/cards') {
        const cards = listCards()
        return send(res, 200, { columns: columnsFor(cards), cards: cards.map((c) => summarize(c)) })
      }
      if (req.method === 'POST' && path === '/api/cards') {
        const body = await readBody(req)
        try {
          // a pipeline that names a file is a CLI flag, never a request body
          const card = await createCard(body, actor, { allowPipelineFile: false })
          sse.broadcast('card', forOwner(summarize(card)))
          return send(res, 201, { card: summarize(card) })
        } catch (err) {
          if (err instanceof CardInputError) return send(res, 400, { error: err.message })
          throw err
        }
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        const cards = canCards ? listCards() : []
        res.write(`event: hello\ndata: ${JSON.stringify({ columns: columnsFor(cards), cards: cards.map((c) => summarize(c)), sessions: viewFor(viewer), ts: new Date().toISOString() })}\n\n`)
        sse.add(res, cards, viewer, { token: presentedToken(req, url), loopback: isLoopbackRequest(req) })
        return
      }
      if (req.method === 'GET' && path === '/api/sessions') return send(res, 200, viewFor(viewer))
      if (path === '/api/settings') {
        if (!canMachine) return send(res, 403, { error: 'the machine settings belong to the owner of this board' })
        if (req.method === 'GET') return send(res, 200, { preferences: readPreferences() })
        if (req.method === 'POST' || req.method === 'PATCH') {
          const body = await readBody(req)
          try {
            const patch = {}
            if (body.handoff_order !== undefined) patch.handoff_order = requireHandoffOrder(body.handoff_order)
            // the ladder and the rules around it (B.3). `handoff_order` is
            // rewritten from the ladder inside writePreferences, so the two
            // keys on disk can never disagree.
            if (body.handoff_ladder !== undefined) patch.handoff_ladder = requireHandoffLadder(body.handoff_ladder)
            if (body.climb_back !== undefined) patch.climb_back = requireClimbBack(body.climb_back)
            if (body.may_spend !== undefined) patch.may_spend = Boolean(body.may_spend)
            if (body.reserve !== undefined) patch.reserve = requireReserve(body.reserve)
            if (body.notify_terminal !== undefined) patch.notify_terminal = Boolean(body.notify_terminal)
            if (body.notify_board !== undefined) patch.notify_board = Boolean(body.notify_board)
            if (body.harness !== undefined) {
              // the board may narrow the policy or turn the feature off; turning
              // it on is the first-run consent flow, which shows what will be
              // written before it writes (leg harness enable)
              if (body.harness?.enabled === true) return send(res, 400, { error: 'turn the portable harness on from a terminal: leg harness enable shows what it will write before it writes it' })
              const rank = ['warn', 'sync', 'strict']
              const current = readPreferences().harness
              if (body.harness?.policy !== undefined && rank.indexOf(body.harness.policy) > rank.indexOf(current.policy)) return send(res, 400, { error: `the board may only narrow the harness policy (now ${current.policy}); widen it from a terminal: leg harness policy ${body.harness.policy}` })
              patch.harness = { policy: body.harness?.policy, enabled: body.harness?.enabled === false ? false : undefined }
            }
            if (!Object.keys(patch).length) return send(res, 400, { error: 'nothing to change: send handoff_ladder, handoff_order, climb_back, may_spend, reserve, notify_terminal, notify_board or harness' })
            const preferences = writePreferences(patch)
            sse.broadcast('sessions', (v) => viewFor(v))
            return send(res, 200, { preferences })
          } catch (err) {
            if (err instanceof TypeError) return send(res, 400, { error: err.message })
            throw err
          }
        }
      }
      if (parts[1] === 'sessions' && parts[2]) {
        const id = parts[2]
        const sess = readSession(id)
        if (!sess) return send(res, 404, { error: `session not found: ${id}` })
        const mine = ownsSession(sess)
        // another human's terminal: its prompts, files and events are not theirs to read
        if (!mine && !(req.method === 'POST' && parts[3] === 'request-handoff')) {
          return send(res, 403, { error: `read-only: this terminal belongs to ${sess.owner ?? 'someone else'}; ask for a hand-off instead` })
        }
        if (req.method === 'POST' && parts[3] === 'request-handoff') {
          if (!shared) return send(res, 409, { error: 'share is off: use Hand off now' })
          if (mine) return send(res, 409, { error: 'this terminal is yours: use Hand off now' })
          if (!isActive(sess)) return send(res, 409, { error: `session ${id} is not active` })
          const list = readRequests(id).filter((r) => !(r.by === viewer.name && r.state === 'pending'))
          list.push({ by: viewer.name, at: new Date().toISOString(), state: 'pending' })
          writeRequests(id, list)
          appendSessionEvent(id, { type: 'handoff_requested', by: viewer.name, summary: `${viewer.name} asked ${sess.owner ?? 'the owner'} to hand this terminal off` })
          log(`hand-off requested for ${id} by ${viewer.name}`)
          sse.broadcast('sessions', (v) => viewFor(v))
          return send(res, 202, { ok: true, requested: 'handoff', by: viewer.name })
        }
        if (req.method === 'POST' && parts[3] === 'requests' && parts[4] && ['approve', 'dismiss'].includes(parts[5])) {
          const who = decodeURIComponent(parts[4])
          const list = readRequests(id)
          const hit = list.find((r) => r.by === who && r.state === 'pending')
          if (!hit) return send(res, 404, { error: `no pending hand-off request from ${who}` })
          const approve = parts[5] === 'approve'
          // check liveness before mutating the request, so a session that ended
          // just before Approve does not leave the request stuck in 'approved'
          if (approve && !isActive(sess)) return send(res, 409, { error: `session ${id} is not active` })
          hit.state = approve ? 'approved' : 'dismissed'
          hit.answered_at = new Date().toISOString()
          hit.answered_by = viewer.name
          writeRequests(id, list)
          if (approve) requestControl(id, { handoff: true, by: `${viewer.name} for ${who}` })
          appendSessionEvent(id, { type: approve ? 'handoff_requested' : 'status', by: viewer.name, summary: `${viewer.name} ${approve ? 'approved' : 'dismissed'} ${who}'s hand-off request` })
          sse.broadcast('sessions', (v) => viewFor(v))
          return send(res, 200, { ok: true, request: hit })
        }
        if (req.method === 'GET' && parts.length === 3) return send(res, 200, { session: sess, events: readSessionEvents(id), requests: readRequests(id) })
        // the card's drawer: what the agent last said, what it changed, what it
        // has done. Only ever this viewer's own terminal; the guard above sent
        // anyone else away before we read a transcript.
        if (req.method === 'GET' && parts[3] === 'detail') return send(res, 200, sessionDetail(sess))
        if (req.method === 'GET' && parts[3] === 'diff') {
          try {
            return send(res, 200, sessionDiff(sess, url.searchParams.get('file') ?? ''))
          } catch (err) {
            if (err instanceof DiffInputError) return send(res, 400, { error: err.message })
            throw err
          }
        }
        if (req.method === 'POST' && parts[3] === 'handoff-order') {
          if (!sess.runtime_capabilities?.includes(HANDOFF_ORDER_CAPABILITY)) {
            return send(res, 409, { error: 'this terminal started before order changes were available; save the order as the default, then restart the terminal when ready' })
          }
          if (!['starting', 'running', 'warning', 'limit', 'waiting'].includes(sess.status)) {
            return send(res, 409, { error: `handoff order cannot change while this terminal is ${sess.status}` })
          }
          const body = await readBody(req)
          try {
            // one route, two shapes: the old list of agents, and the ladder of
            // rungs that replaced it. Sending either rewrites the other, the
            // same way preferences.json keeps them in step.
            const ladder = body.handoff_ladder !== undefined ? requireHandoffLadder(body.handoff_ladder) : null
            const order = ladder ? orderFromLadder(ladder) : requireHandoffOrder(body.handoff_order)
            const rungs = ladder ?? ladderFor({ handoff_order: order })
            const summary = ladder ? `handoff ladder changed to ${rungs.map((r) => rungLabel(r)).join(' → ')}` : `handoff order changed to ${order.join(' → ')}`
            const next = updateSession(id, (current) => {
              if (!['starting', 'running', 'warning', 'limit', 'waiting'].includes(current.status)) {
                const conflict = new Error(`handoff order cannot change while this terminal is ${current.status}`)
                conflict.statusCode = 409
                throw conflict
              }
              return {
                handoff_order: order,
                handoff_ladder: rungs,
                chain: candidates({ agent: current.agent, account: current.account, model: current.model ?? null, accounts: readAccounts(), order, ladder: rungs }),
              }
            }, { event: { type: 'status', by: actor.id, summary } })
            sse.broadcast('sessions', (v) => viewFor(v))
            return send(res, 200, { session: next })
          } catch (err) {
            if (err instanceof TypeError) return send(res, 400, { error: err.message })
            if (err.statusCode === 409) return send(res, 409, { error: err.message })
            throw err
          }
        }
        if (req.method === 'POST' && parts[3] === 'land') {
          if (parts[4] === 'prepare') {
            const cl = canLand(sess)
            if (!cl.ok) return send(res, 409, { ok: false, error: cl.blockers[0].message, blockers: cl.blockers })
            const prep = await prepareLanding(sess, { by: actor.id })
            return send(res, prep.ok ? 200 : 409, prep)
          }
          if (parts[4] === 'fix') {
            const body = await readBody(req)
            try {
              const r = await applyLandFix(sess.session_id, body?.action, { by: actor.id, message: body?.message })
              try { sse.broadcast('sessions', (v) => viewFor(v)) } catch {}
              return send(res, 200, r)
            } catch (err) {
              return send(res, 400, { ok: false, error: err.message })
            }
          }
          const why = landBlocker(sess)
          if (why) return send(res, 409, { error: why })
          landSession(sess, { by: actor.id, autoCommit: true })
            .catch((err) => log(`land ${id}: ${err.message}`))
            // a landing moves the branch under every worktree cut from it, so
            // the cached land-ability goes with the cached trunk
            .finally(() => { trunkCache.clear(); canLandCache.clear(); try { sse.broadcast('sessions', (v) => viewFor(v)) } catch {} })
          log(`land requested for ${id} by ${actor.id}`)
          return send(res, 202, { ok: true, requested: 'land' })
        }
        // "I have to leave, keep going." The terminal's context becomes a card
        // that continues from the SAME rung, and the terminal then ends exactly
        // the way End ends it. Where the card works depends on what the
        // terminal had:
        //   - its own worktree: the card adopts it (redesign G4; two worktrees
        //     on one branch is the conflict machine the roadmap rejects) and
        //     waits in the BACKLOG until the terminal has really stopped, since
        //     `end` is a request the runner reads on its own poll and the
        //     scheduler ticks once a second.
        //   - no worktree of its own (the ordinary case): a checkout of its own
        //     is cut from that branch and the uncommitted work is carried into
        //     it, so the card continues from what the human was looking at
        //     rather than from the last commit.
        if (req.method === 'POST' && parts[3] === 'end-as-card') {
          // a card is the pipeline board, which belongs to the owner and the
          // operators of this machine even when the terminal is the caller's
          if (!canCards) return send(res, 403, { error: 'the pipeline board belongs to the owner and the operators of this machine' })
          if (!isActive(sess)) return send(res, 409, { error: `session ${id} is not active` })
          if (!sess.repo) return send(res, 409, { error: 'this terminal is not in a git repository, so there is no branch for a card to continue on' })
          let bundle
          try {
            bundle = saveSessionBundle(sess, { messages: sessionMessages(sess), why: 'ended as a card' })
          } catch (err) {
            // nothing has been ended yet: refuse rather than end a terminal
            // whose context was never written down
            return send(res, 409, { error: `the hand-off bundle could not be written, so this terminal was left alone: ${scrub(err.message).slice(0, 200)}` })
          }
          const rungs = ladderFromCurrentRung(sess)
          // one model per adapter is all a card's chain can carry, so a ladder
          // with claude/fable and claude/opus in it keeps the FIRST, which is
          // the rung this terminal is on
          const models = {}
          for (const r of rungs) if (r.model && !models[r.agent]) models[r.agent] = r.model
          const task = `${sess.task ?? 'Continue the work already under way in this checkout.'}\n\nContinue from the bundle at ${bundle.path}.`
          const adopted = sess.worktree?.path && existsSync(sess.worktree.path) ? sess.worktree.path : null
          const trunkBranch = sess.worktree?.base || sess.branch || 'main'
          // The checkout the human has been working in. Read BEFORE anything is
          // created or ended: if the work cannot be read, nothing has happened
          // yet and the terminal is left exactly as it was.
          // the repository root, which is what `git status --porcelain`,
          // `git diff` and `git ls-files` all report paths against, so the
          // patch and the file list line up with the new checkout's root
          const workRoot = adopted ?? ((sess.repo && existsSync(sess.repo)) ? sess.repo : sess.cwd)
          let carried = null
          if (!adopted) {
            try { carried = captureUncommitted(workRoot) } catch (err) {
              return send(res, 409, { error: `the uncommitted work in this checkout could not be read, so this terminal was left alone: ${scrub(err.message).slice(0, 200)}` })
            }
          }
          let card
          try {
            card = await createCard({
              repo: sess.repo, task,
              chain: rungs.map((r) => r.agent).join(',') || sess.agent,
              model: models,
              trunk: trunkBranch,
              title: sess.task ? String(sess.task).slice(0, 60) : `continued from ${id}`,
              // never queued here: the card is enqueued below, once its
              // checkout is its own and nothing else is writing to it
              queue: false,
            }, actor)
          } catch (err) {
            if (err instanceof CardInputError) return send(res, 400, { error: `the card could not be created, so this terminal was left alone: ${err.message}` })
            throw err
          }
          let carriedFiles = 0
          if (adopted) {
            ledgerUpdate(card.card_id, { patch: { lineage: { from: id }, worktree: adopted, worktree_adopted: true, worktree_branch: sess.worktree?.branch ?? null } })
          } else {
            try {
              const wt = ensureWorktree(sess.repo, card.card_id, { trunk: trunkBranch })
              carriedFiles = carryUncommitted(wt.path, carried)
              ledgerUpdate(card.card_id, { patch: { lineage: { from: id }, worktree: wt.path, worktree_branch: wt.branch } })
            } catch (err) {
              // nothing has been ended and nothing has been queued: take the
              // half-made card off the board rather than leave it there
              try { removeWorktree(sess.repo, card.card_id, { force: true }) } catch { /* it may never have been cut */ }
              try { rmSync(cardDir(card.card_id), { recursive: true, force: true }) } catch { /* the board never saw it */ }
              return send(res, 409, { error: `the work in this checkout could not be carried into a checkout of its own, so this terminal was left alone: ${scrub(err.message).slice(0, 200)}` })
            }
          }
          // `handoff_written` is the ledger's word for "a bundle was written and
          // the work moved on", which is exactly what happened here. The audited
          // line with the actor is on the terminal's side, below.
          const where = adopted
            ? ', in the terminal\'s own worktree, once that terminal has stopped'
            : `, in a worktree of its own cut from ${trunkBranch}${carriedFiles ? `, carrying ${carriedFiles} uncommitted file(s) over` : ''}`
          ledgerAppend(card.card_id, { actor, type: 'handoff_written', summary: `continued from terminal ${id}${where}` })
          requestControl(id, { end: true, by: actor.id })
          appendSessionEvent(id, { type: 'handed_off', by: actor.id, summary: `${actor.id} ended this terminal and kept it going as card ${card.card_id}` })
          updateSession(id, (cur) => ({ lineage: { ...(cur.lineage ?? {}), to: card.card_id } }))
          if (adopted) enqueueWhenSessionEnds(card.card_id, id, actor)
          else {
            try { humanAction(card.card_id, 'enqueue', {}, actor) } catch (err) { log(`end-as-card ${card.card_id}: ${err.message}`) }
          }
          log(`end-as-card for ${id} by ${actor.id}: ${card.card_id}${adopted ? ` in ${adopted} (queued when ${id} stops)` : ` in a checkout of its own${carriedFiles ? `, ${carriedFiles} file(s) carried` : ''}`}`)
          const next = summarize(readCard(card.card_id))
          sse.broadcast('card', forOwner(next))
          sse.broadcast('sessions', (v) => viewFor(v))
          return send(res, 201, { card: next, bundle: { id: bundle.id, path: bundle.path }, carried: { files: carriedFiles, adopted: Boolean(adopted) } })
        }
        if (req.method === 'POST' && (parts[3] === 'handoff' || parts[3] === 'end')) {
          if (!isActive(sess)) return send(res, 409, { error: `session ${id} is not active` })
          if (parts[3] === 'end') {
            requestControl(id, { end: true, by: actor.id })
            log(`end requested for ${id} by ${actor.id}`)
            return send(res, 200, { ok: true, requested: 'end' })
          }
          // Hand off now, optionally to a named destination. With no body the
          // chain decides, exactly as it did before the picker existed.
          const body = await readBody(req)
          let target = null
          if (body && body.agent !== undefined && body.agent !== null && body.agent !== '') {
            const want = { agent: String(body.agent), account: String(body.account ?? 'default'), model: body.model ? String(body.model).toLowerCase() : null }
            const order = normalizeHandoffOrder(sess.handoff_order)
            const ladder = ladderFor(sess)
            const chain = candidates({ agent: sess.agent, account: sess.account, model: sess.model ?? null, accounts: readAccounts(), order, ladder })
            const hit = chain.find((c) => c.agent === want.agent && c.account === want.account && (want.model ? (c.model ?? null) === want.model : true))
            const label = rungLabel(want)
            if (!hit) return send(res, 400, { error: `${label} is not a destination for this terminal (${chain.map((c) => rungLabel(c)).join(', ') || 'none'})` })
            if (sess.installed && sess.installed[want.agent] === false) return send(res, 409, { error: `${label} is not installed on this machine` })
            const u = readUsage(want.agent, want.account)
            if (!isAvailable(u)) return send(res, 409, { error: `${label} is at its usage limit until ${fmtReset(u.limited_until)}; pick another or use Hand off now without a destination` })
            if (hit.model && wallActive(u.walls?.[hit.model])) return send(res, 409, { error: `${label} is out until ${fmtReset(u.walls[hit.model].limited_until)}; pick another rung or use Hand off now without a destination` })
            target = { agent: hit.agent, account: hit.account, ...(hit.model ? { model: hit.model } : {}) }
          }
          requestControl(id, target ? { handoff: true, target, by: actor.id } : { handoff: true, by: actor.id })
          log(`handoff requested for ${id} by ${actor.id}${target ? ` to ${rungLabel(target)}` : ''}`)
          return send(res, 200, { ok: true, requested: 'handoff', target })
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          if (isActive(sess)) return send(res, 409, { error: 'end the session before removing it' })
          if (landingNow(id)) return send(res, 409, { error: 'wait for the landing to finish before removing it' })
          const force = url.searchParams.get('force') === '1'
          const keepWorktree = url.searchParams.get('keep_worktree') === '1'
          if (keepWorktree && !force) return send(res, 400, { error: 'keep_worktree requires force=1' })
          let worktree = null
          if (keepWorktree && sess.worktree) {
            worktree = { removed: false, preserved: true, path: sess.worktree.path, branch: sess.worktree.branch, reason: 'preserved by request' }
          } else if (sess.worktree) { try { worktree = pruneSessionWorktree(sess) } catch (err) { worktree = { removed: false, reason: scrub(err.message).slice(0, 200) } } }
          // Remove must not orphan unlanded work: if the worktree could not be
          // pruned (uncommitted or unmerged), keep the record unless forced
          if (worktree && !worktree.removed && !force) return send(res, 409, { error: `not removing ${id}: ${worktree.reason}. Land it first, or retry with ?force=1 to drop the record and leave the worktree in place.`, worktree })
          removeSession(id)
          sse.broadcast('sessions', (v) => viewFor(v))
          return send(res, 200, { removed: id, worktree })
        }
      }
      // ---- history: the read-only index over every agent's own store ----
      if (parts[1] === 'history') {
        const q = url.searchParams
        const int = (v, def, max) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def }
        if (req.method === 'GET' && parts.length === 2) {
          const provider = q.get('provider') || null
          if (provider && provider.split(',').some((p) => !PROVIDER_NAMES.includes(p.trim()))) return send(res, 400, { error: `unknown provider in "${provider}" (${PROVIDER_NAMES.join('|')})` })
          const tri = (v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null)
          const explicitRefresh = tri(q.get('refresh')) === true
          let refreshArg = null
          if (!explicitRefresh) {
            const idx = readIndex()
            if (idx) {
              const age = idx.refreshed_at ? Date.now() - Date.parse(idx.refreshed_at) : Infinity
              if (age > 60000) backgroundHistoryRefresh()
              refreshArg = false
            }
          } else {
            refreshArg = true
          }
          return send(res, 200, listHistory({
            provider, repo: q.get('repo') || null, search: q.get('search') || null,
            before: q.get('before') || null,
            // never the whole index in one response: a page is 1 to 200 rows
            limit: Math.max(1, int(q.get('limit'), 50, 200)), offset: int(q.get('offset'), 0, 1e6),
            managed: tri(q.get('managed')), live: tri(q.get('live')), includeHidden: tri(q.get('hidden')) === true,
            refresh: refreshArg,
          }))
        }
        if (req.method === 'GET' && parts[2] === 'providers') return send(res, 200, { providers: providerSupport() })
        if (req.method === 'POST' && parts[2] === 'refresh') {
          const body = await readBody(req)
          const t = Date.now()
          try {
            const r = refreshIndex({ force: body.full === true })
            return send(res, 200, { ms: Date.now() - t, refreshed_at: r.index.refreshed_at, stats: r.stats })
          } catch (err) { return send(res, 409, { error: `refresh did not run: ${err.message}` }) }
        }
        if (req.method === 'GET' && parts.length === 3) {
          // the id is a lookup key, never a path: findRecord compares strings,
          // and the transcript it names is read only from inside a known store
          let rec
          let wanted
          try { wanted = decodeURIComponent(parts[2]) } catch { return send(res, 400, { error: 'malformed id' }) }
          try { rec = findRecord(wanted, { refresh: false }) } catch (err) {
            if (err instanceof HistoryInputError) return send(res, 400, { error: err.message })
            throw err
          }
          if (!rec) return send(res, 404, { error: `no conversation matches ${parts[2]}` })
          return send(res, 200, recordDetail(rec, { messages: int(q.get('messages'), 8, 50) }))
        }
        return send(res, 404, { error: 'not found' })
      }
      if (req.method === 'GET' && path === '/api/worktrees') {
        const q = url.searchParams
        return send(res, 200, worktreesFor({ repo: q.get('repo') || null, dirty: q.get('dirty') !== '0' }))
      }
      if (req.method === 'GET' && path === '/api/audit') {
        const q = url.searchParams
        const kind = q.get('kind')
        if (kind && !ACTOR_KINDS.includes(kind)) return send(res, 400, { error: `kind is one of ${ACTOR_KINDS.join(', ')}` })
        const limit = parseInt(q.get('limit') ?? '200', 10)
        return send(res, 200, auditTrail({
          limit: Number.isFinite(limit) ? limit : 200,
          since: q.get('since'),
          who: q.get('who'),
          kind,
        }))
      }
      if (req.method === 'GET' && path === '/api/floor') return send(res, 200, floor(listCards()))
      if (req.method === 'GET' && path === '/api/trunk') return send(res, 200, trunk(listCards(), parseSince(url.searchParams.get('since'))))
      if (req.method === 'GET' && path === '/api/leases') return send(res, 200, { leases: held(listCards()) })
      if (parts[1] === 'cards' && parts[2]) {
        const id = parts[2]
        const card = readCard(id)
        if (!card) return send(res, 404, { error: `card not found: ${id}` })
        if (req.method === 'GET' && parts.length === 3) {
          return send(res, 200, { card: summarize(card), runs: readRuns(id), events: readEvents(id), bundle: card.last_bundle ? { id: card.last_bundle, path: card.worktree ? join(card.worktree, '.context-handoffs', card.last_bundle) : null } : null })
        }
        if (req.method === 'GET' && parts[3] === 'events') return send(res, 200, { events: readEvents(id) })
        if (req.method === 'GET' && parts[3] === 'log') {
          const run = url.searchParams.get('run') ? parseInt(url.searchParams.get('run'), 10) : null
          const tail = Math.min(2000, parseInt(url.searchParams.get('tail') ?? '200', 10) || 200)
          return send(res, 200, logTail(id, run, tail))
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          if (['running', 'handing_off'].includes(card.status)) return send(res, 409, { error: 'kill the card before removing it' })
          // don't discard uncommitted agent work without an explicit force
          if (url.searchParams.get('force') !== '1') {
            let dirty
            try { dirty = worktreeDirty(card.repo, id) } catch (err) {
              // a status check that fails must not read as clean
              return send(res, 409, { error: `cannot verify the card's worktree (git status failed: ${scrub(err.message).slice(0, 200)}). Retry with ?force=1 to discard it.` })
            }
            if (dirty.length) return send(res, 409, { error: `the card's worktree has ${dirty.length} uncommitted file(s): ${dirty.slice(0, 10).join(', ')}. Retry with ?force=1 to discard them.`, dirty })
          }
          // `branch=delete` on its own is `git branch -d`: commits the branch is
          // the only copy of are lost only when the caller says force
          let wt = null
          try { wt = removeWorktree(card.repo, id, { deleteBranch: url.searchParams.get('branch') === 'delete', force: url.searchParams.get('force') === '1' }) } catch (err) { log(`worktree remove: ${err.message}`) }
          if (wt && wt.branchUnmerged && !wt.branchDeleted) return send(res, 409, { error: `not removing ${id}: its branch has commits that are not on its base. Land it first, or retry with ?force=1 to delete the branch and discard them.`, worktree: wt })
          rmSync(cardDir(id), { recursive: true, force: true })
          sse.broadcast('removed', forOwner({ card_id: id }))
          return send(res, 200, { removed: id })
        }
        // Take over: sit down in the card's worktree yourself. The card is
        // paused first (its child is killed and its bundle written by the
        // existing transition), then Leg hands back the one command that opens
        // a terminal there. This is the only command the board ever hands a
        // human, because a browser tab cannot open one (redesign C.4).
        if (req.method === 'POST' && parts[3] === 'take-over') {
          if (TERMINAL.includes(card.status)) return send(res, 409, { error: `card ${id} is ${card.status}: there is nothing running to take over. Rerun it, or open its worktree yourself.` })
          const raw = String(summarize(card).active_adapter ?? '')
          const agent = [raw, raw.replace(/^fake-/, '')].find((n) => SUPERVISED_AGENTS.includes(n)) ?? null
          if (!agent) return send(res, 409, { error: `this card's current leg runs ${raw || 'no agent'}, which is not one of the agents leg can open a terminal for (${SUPERVISED_AGENTS.join(', ')})` })
          // Every non-terminal status moves to `paused` before the command is
          // handed back, not just `running`. A `queued` or `handing_off` card
          // is in the set the scheduler starts from, and it ticks once a
          // second: the human would paste this command into a worktree an
          // agent had just been launched in, which is the collision Take over
          // exists to prevent. The transition also writes the actor's own
          // `taken_over` line, so the audit trail names who has the checkout.
          let next
          try { next = humanAction(id, 'take_over', {}, actor) } catch (err) {
            if (err instanceof IllegalTransition) return send(res, 409, { error: err.message })
            throw err
          }
          // A card that never ran has no checkout of its own, and the terminal
          // that takes it over must never open in the human's main checkout
          // (src/attach.mjs cardWorkRoot refuses that). Cut its worktree now, on
          // the trunk the card would have used, so the command below has a
          // place to open.
          const cur = readCard(id) ?? next
          if (!(cur.worktree && existsSync(cur.worktree)) && cur.repo) {
            try {
              const wt = ensureWorktree(cur.repo, id, { trunk: cur.trunk || trunkFor(cur.repo).branch || 'main' })
              ledgerUpdate(id, { patch: { worktree: wt.path, worktree_branch: wt.branch } })
            } catch (err) {
              return send(res, 409, { error: `could not cut a checkout for ${id}: ${err.message}` })
            }
          }
          const command = `leg ${agent} --resume-card ${id}`
          log(`take-over for ${id} by ${actor.id}: ${command}`)
          const view = summarize(readCard(id) ?? next)
          sse.broadcast('card', forOwner(view))
          return send(res, 200, { card: view, command })
        }
        if (req.method === 'POST' && parts[3]) {
          const map = { run: 'enqueue', queue: 'enqueue', approve: 'approve', reassign: 'reassign', pause: 'pause', resume: 'resume', kill: 'kill', handoff: 'handoff_now', 'handoff-now': 'handoff_now', rerun: 'rerun' }
          const action = map[parts[3]]
          if (!action) return send(res, 404, { error: `unknown action ${parts[3]}` })
          const body = await readBody(req)
          try {
            const next = humanAction(id, action, body, actor)
            sse.broadcast('card', forOwner(summarize(next)))
            return send(res, 200, { card: summarize(next) })
          } catch (err) {
            if (err instanceof IllegalTransition) return send(res, 409, { error: err.message })
            if (/needs an adapter/.test(err.message)) return send(res, 400, { error: err.message })
            throw err
          }
        }
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      log(`error ${req.method} ${path}: ${err.message}`)
      return send(res, 500, { error: scrub(err.message) })
    }
  }

  const onReq = (req, res) => { handle(req, res).catch((err) => { try { send(res, 500, { error: scrub(err.message) }) } catch {} }) }
  // TLS when a certificate pair is configured (leg share on --tls-cert/--tls-key,
  // or LEG_TLS_CERT/LEG_TLS_KEY). readTls throws rather than fall back to
  // plaintext: a board told to use TLS and quietly serving http would be the
  // worst outcome of the three.
  const tls = readTls(initialShare)
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, onReq) : http.createServer(onReq)
  // When the board is bound to a non-loopback address (share on), also listen on
  // 127.0.0.1 so the machine's own browser has a tokenless owner URL — a real
  // remote peer's address is never loopback, so it still needs a token. That one
  // stays plain http even under TLS: the certificate is for the shared name, and
  // loopback traffic never leaves this machine.
  const loopbackCompanion = !isLoopback(bind) ? http.createServer(onReq) : null

  return {
    server,
    bind, port, tls: tls ? { cert_path: tls.cert_path, key_path: tls.key_path } : null,
    start() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, bind, () => {
          const addr = server.address()
          log(`listening on ${tls ? 'https' : 'http'}://${bind}:${addr.port} (home ${home()}${token ? ', token required' : ', loopback open'}${tls ? `, TLS from ${tls.cert_path}` : ''})`)
          // A terminal that crashed instead of exiting left its hand-off in
          // .leg/RESUME.md looking live. The board is the thing that starts
          // after a crash, so it is where that gets corrected.
          setImmediate(() => {
            try {
              const touched = refreshPointers()
              if (touched.length) log(`rewrote ${touched.length} stale resume pointer${touched.length === 1 ? '' : 's'}: the terminal each described is gone, or no Leg stamped it`)
            } catch (err) { log(`resume pointers not refreshed: ${err.message}`) }
          })
          if (scheduler) {
            sched = createScheduler()
            sched.run().catch((err) => log(`scheduler crashed: ${err.message}`))
          }
          if (usagePolling) {
            refreshCodexAccounts()
            usageTimer = setInterval(refreshCodexAccounts, 60000)
            usageTimer.unref?.()
          }
          if (loopbackCompanion) {
            loopbackCompanion.on('error', (err) => log(`loopback companion: ${err.message}`))
            loopbackCompanion.listen(addr.port, '127.0.0.1', () => log(`also on http://127.0.0.1:${addr.port} (this machine, tokenless owner)`))
          }
          resolvePromise({ port: addr.port, bind })
        })
      })
    },
    async stop() {
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null }
      usageController?.abort()
      for (const t of enqueueTimers.values()) clearTimeout(t)
      enqueueTimers.clear()
      sse.stop()
      if (sched) sched.stop()
      if (loopbackCompanion) await new Promise((r) => { loopbackCompanion.closeAllConnections?.(); loopbackCompanion.close(() => r()) })
      await new Promise((r) => { server.closeAllConnections?.(); server.close(r) })
    },
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()
if (isMain) {
  let srv
  try {
    srv = createBoardServer({ usagePolling: true })
  } catch (err) {
    process.stderr.write(err.message + '\n')
    process.exit(err.exitCode ?? 1)
  }
  await srv.start()
  const bye = () => { srv.stop().then(() => process.exit(0)) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
