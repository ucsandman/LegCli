#!/usr/bin/env node
// server — the board's HTTP + SSE backend. Ledger-backed: every handler reads
// card.json / events-*.jsonl on demand (no module-level card store), so a
// restart shows the same board and a second process sees the same truth.
// BATON_BIND (127.0.0.1) + BATON_PORT (4747) + BATON_TOKEN are the
// multiplayer seams (src/auth.mjs).
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, rmSync, watch as fsWatch, mkdirSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join, dirname, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBind, authorize, remoteAddress, presentedToken, isLoopback } from './auth.mjs'
import { readShare, isOn as shareIsOn, sharePath, identify, personNamed } from './share.mjs'
import { createLimiter } from './ratelimit.mjs'
import { realPath, canonPath } from './fsx.mjs'
import { listCards, readCard, readRuns, readEvents, cardDir, home } from './store.mjs'
import { humanAction } from './orchestrator.mjs'
import { createCard, CardInputError } from './cards.mjs'
import { IllegalTransition, availableActions } from './chain.mjs'
import { held } from './leases.mjs'
import { PRESETS } from './presets.mjs'
import { names as adapterNames, get as getAdapter, isFake } from './adapters/index.mjs'
import { createScheduler, schedulerStatus, MAX_CONCURRENT } from './scheduler.mjs'
import { remove as removeWorktree, worktreeDirty } from './worktree.mjs'
import { scrub } from './runner.mjs'
import { resolveChb } from './handoff.mjs'
import { listSessions, readSession, readEvents as readSessionEvents, requestControl, removeSession, overlaps, isActive, sessionsRoot, reapLost, readLand, readLandings, readRequests, writeRequests, appendEvent as appendSessionEvent } from './sessions.mjs'
import { landSession, landBlocker, landingNow, pruneSessionWorktree } from './land.mjs'
import { readUsage } from './usage.mjs'
import { readAccounts } from './accounts.mjs'

const SELF = fileURLToPath(import.meta.url)
const BOARD_DIR = join(dirname(SELF), 'board')
const VERSION = JSON.parse(readFileSync(join(dirname(SELF), '..', 'package.json'), 'utf8')).version
const DEFAULT_ORDER = ['plan', 'build', 'review', 'test', 'land']
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' }

const log = (msg) => { if (process.env.BATON_QUIET !== '1') process.stdout.write(`[board] ${new Date().toISOString()} ${msg}\n`) }

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

export function summarize(card) {
  const st = (card.pipeline ?? []).find((s) => s.name === card.station) ?? null
  const entry = st?.kind === 'agent' ? st.chain[card.leg] ?? null : null
  const last = lastEventOf(card.card_id)
  const runs = readRuns(card.card_id)
  const activeRun = runs.find((r) => ['launching', 'running'].includes(r.status)) ?? null
  // Once a station is over (done/failed) card.leg is reset, so the rail is
  // rebuilt from the legs that actually started at this station.
  const terminal = ['done', 'failed', 'killed'].includes(card.status)
  const startedLegs = terminal && st?.kind === 'agent'
    ? readEvents(card.card_id).filter((ev) => ev.type === 'leg_started' && ev.station === card.station).map((ev) => ev.leg)
    : []
  const lastLeg = startedLegs.length ? Math.max(...startedLegs) : card.leg
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
  return {
    ...card,
    column: columnOf(card),
    station_kind: st?.kind ?? null,
    active_adapter: entry?.adapter ?? null,
    active_mode: entry?.mode ?? null,
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
  for (const name of ['claude', 'codex', 'agy']) {
    try {
      const { bin, viaNode, entry } = (await getAdapter(name)).resolve()
      const target = viaNode ? (entry ?? bin) : bin
      agents[name] = /[\\/]/.test(target) ? existsSync(target) : probe(target)
    } catch { agents[name] = false }
  }
  let chb = false
  try { resolveChb(); chb = true } catch {}
  toolsCache = { ...agents, grok: probe('grok'), chb, git: probe('git') }
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
const trunkCache = new Map()
function trunkFor(repo) {
  const hit = trunkCache.get(repo)
  if (hit && Date.now() - hit.at < 15000) return hit.data
  const g = (args) => { const r = spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }); return r.status === 0 ? r.stdout.trim() : null }
  let branch = null
  for (const b of ['main', 'master', 'trunk']) if (g(['rev-parse', '--verify', '--quiet', b]) !== null) { branch = b; break }
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
function redactSession(s) {
  return {
    session_id: s.session_id, agent: s.agent, account: s.account, status: s.status, active: s.active,
    started_at: s.started_at, elapsed_ms: s.elapsed_ms, turns: s.turns, repo_name: s.repo_name, branch: s.branch,
    owner: s.owner ?? null, limits: s.limits ?? null, lineage: s.lineage ?? null,
    warning: s.warning ? { window: s.warning.window, pct: s.warning.pct, resets_at: s.warning.resets_at } : null,
    limit: s.limit ? { reason: s.limit.reason, resets_at: s.limit.resets_at ?? null } : null,
    waiting: s.waiting ?? null,
    worktree: s.worktree ? { branch: s.worktree.branch, base: s.worktree.base } : null,
    land: s.land ? { state: s.land.state, base: s.land.base ?? null, sha: s.land.sha ?? null, reason: s.land.reason ?? null } : null,
    task: null, cwd: null, files: [], overlap: [], requests: [], hidden: true,
    land_blocker: `read-only: this terminal belongs to ${s.owner ?? 'someone else'}`,
  }
}

export function sessionsView({ viewer = null, share = null } = {}) {
  const shared = Boolean(share && shareIsOn(share))
  const list = reapLost(listSessions())
  const ov = overlaps(list)
  const sessions = list.map((s) => {
    const land = readLand(s.session_id)
    return {
      ...s,
      active: isActive(s),
      overlap: ov.get(s.session_id) ?? [],
      elapsed_ms: Date.now() - Date.parse(s.started_at),
      files: [...new Set([...(s.files_touched ?? []), ...(s.files_dirty ?? [])])],
      // a 'landing' left behind by a board restart is no longer in flight
      land: land?.state === 'landing' && !landingNow(s.session_id) ? { ...land, state: 'interrupted' } : land,
      land_blocker: s.worktree ? landBlocker(s) : null,
    }
  })
  const acc = readAccounts()
  const accounts = []
  for (const agent of Object.keys(acc)) for (const account of acc[agent]) {
    const u = readUsage(agent, account)
    accounts.push({ agent, account, five_hour: u.five_hour, seven_day: u.seven_day, limited_until: u.limited_until, limited_reason: u.limited_reason, source: u.source, updated_at: u.updated_at, live: sessions.filter((s) => s.active && s.agent === agent && s.account === account).length })
  }
  const repos = new Map()
  for (const s of sessions) if (s.repo && (s.active || s.worktree) && !repos.has(canonPath(s.repo))) repos.set(canonPath(s.repo), s.repo)
  const landings = readLandings()
  const canon = new Map()
  const landingsFor = (key) => landings.filter((l) => { if (!canon.has(l.repo)) canon.set(l.repo, canonPath(l.repo)); return canon.get(l.repo) === key })
  const trunk = [...repos].map(([key, r]) => { try { return withLandings(trunkFor(r), landingsFor(key)) } catch { return { repo: r, commits: [] } } })
  const guest = shared && viewer && viewer.role !== 'owner'
  const mine = (s) => !shared || !viewer || viewer.role === 'owner' || (s.owner ?? share.owner) === viewer.name
  const shown = sessions.map((s) => (mine(s) ? { ...s, requests: readRequests(s.session_id).filter((r) => r.state === 'pending') } : redactSession(s)))
  return {
    sessions: shown,
    accounts,
    // a guest sees what landed, not where the repo lives on this machine
    trunk: guest ? trunk.map((t) => ({ repo_name: t.repo_name, branch: t.branch, commits: t.commits ?? [] })) : trunk,
    you: viewer,
    share: { on: shared, bind: shared ? share.bind : null, people: shared ? share.people.length : 0 },
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
  const map = { '/': 'index.html', '/floor': 'floor.html' }
  const rel = map[urlPath] ?? urlPath.replace(/^\/+/, '')
  const file = resolve(BOARD_DIR, rel)
  if (!file.startsWith(BOARD_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found')
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}

// ---- SSE: watch $BATON_HOME/cards for fs events and push only what changed ----
function createSse({ healthIntervalMs = 10000, debounceMs = 30, viewFor = () => sessionsView(), reauth = (c) => c.viewer } = {}) {
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
    // pipeline cards and their events are the owner's: a guest never gets them
    const forOwner = (payload) => (viewer) => (viewer && viewer.role !== 'owner' ? null : payload)
    if (!card) { for (const c of clients) c.sig.delete(id); broadcast('removed', forOwner({ card_id: id })); return }
    const events = readEvents(id)
    // broadcast() refreshes each client's viewer (and drops revoked ones) first
    broadcast('card', forOwner(summarize(card)))
    for (const c of [...clients]) {
      if (!c.viewer || c.viewer.role !== 'owner') { c.sig.set(id, events.length); continue }
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
  const pushSessions = () => { sessionsTimer = null; try { broadcast('sessions', (viewer) => viewFor(viewer)) } catch (err) { log(`sessions view: ${err.message}`) } }
  const startWatch = () => {
    if (watcher) return
    try {
      const sdir = sessionsRoot()
      mkdirSync(sdir, { recursive: true })
      sessionsWatcher = fsWatch(realPath(sdir), { recursive: true }, () => { if (!sessionsTimer) sessionsTimer = setTimeout(pushSessions, 300) })
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
    healthTimer = setInterval(() => { broadcast('health', { ok: true, scheduler: { ...schedulerStatus(), max_concurrent: MAX_CONCURRENT }, ts: new Date().toISOString() }); pushSessions() }, healthIntervalMs)
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
export function createBoardServer({ bind, port, token = process.env.BATON_TOKEN || '', scheduler = process.env.BATON_NO_SCHEDULER !== '1', share } = {}) {
  // An explicit `share` (tests) is fixed; the real server passes none and reads
  // share.json from disk, re-reading it per request (mtime-cached) so `baton
  // share add|rotate|rm` takes effect on a live board — a new link works at
  // once and a removed or rotated one stops at once — without a restart.
  const explicitShare = share !== undefined
  const initialShare = explicitShare ? share : readShare()
  const shared0 = shareIsOn(initialShare)
  // with share on, the board's address and port come from share.json
  bind = bind ?? (shared0 ? initialShare.bind : (process.env.BATON_BIND || '127.0.0.1'))
  port = port ?? (shared0 ? initialShare.port : Number(process.env.BATON_PORT || 4747))
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
  const forOwner = (payload) => (viewer) => (viewer && viewer.role !== 'owner' ? null : payload)
  // SSE re-identifies each client from the live roster on every push
  const reauthClient = (c) => {
    const sh = currentShare()
    if (!shareIsOn(sh)) return { name: 'local', role: 'owner' }
    const person = identify(sh, c.token)
    if (person) return { name: person.name, role: person.role }
    if (!c.token && sh.loopback_owner !== false && c.loopback) {
      const owner = personNamed(sh, sh.owner) ?? sh.people.find((p) => p.role === 'owner') ?? null
      if (owner) return { name: owner.name, role: owner.role }
    }
    return null
  }
  const sse = createSse({ viewFor, reauth: reauthClient })
  let sched = null

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
    const auth = authorize({ token, req, url, share })
    if (!auth.ok) {
      // only a token that was presented and did not match counts as a guess;
      // a board page that has not been given a token yet is not an attacker
      if (presentedToken(req, url)) limiter.failure(ip)
      return send(res, 401, { error: shared ? 'unauthorized: open the board with your own link (baton share)' : 'unauthorized: set Authorization: Bearer <BATON_TOKEN>' })
    }
    const viewer = auth.person ? { name: auth.person.name, role: auth.person.role } : { name: auth.subject ?? 'local', role: 'owner' }
    const rl = limiter.request(viewer.name === 'local' ? ip : viewer.name)
    if (!rl.ok) return send(res, 429, { error: `rate limit: more than ${limiter.max} requests a minute` }, { 'Retry-After': String(rl.retry_after) })
    const actor = { type: 'human', id: viewer.name }
    // a guest sees the terminals lane, read-only; the pipeline side is the owner's
    const guest = shared && viewer.role !== 'owner'
    const ownsSession = (s) => !shared || viewer.role === 'owner' || (s.owner ?? share.owner) === viewer.name
    const parts = path.split('/').filter(Boolean) // ['api', ...]
    if (guest && ['cards', 'floor', 'presets', 'adapters', 'leases', 'trunk'].includes(parts[1])) return send(res, 403, { error: 'the pipeline board belongs to the owner of this machine' })
    try {
      if (req.method === 'GET' && path === '/api/health') {
        const you = { ...viewer, share: { on: shared, people: shared ? share.people.length : 0 } }
        if (guest) return send(res, 200, { ok: true, version: VERSION, you })
        const cards = listCards()
        return send(res, 200, { ok: true, version: VERSION, bind, port, home: home(), you, scheduler: { ...schedulerStatus(), in_process: Boolean(sched), max_concurrent: MAX_CONCURRENT }, tools: await detectTools(), columns: columnsFor(cards), cards: cards.length })
      }
      if (req.method === 'GET' && path === '/api/adapters') return send(res, 200, { adapters: await adaptersInfo() })
      if (req.method === 'GET' && path === '/api/presets') return send(res, 200, { presets: PRESETS })
      if (req.method === 'GET' && path === '/api/cards') {
        const cards = listCards()
        return send(res, 200, { columns: columnsFor(cards), cards: cards.map(summarize) })
      }
      if (req.method === 'POST' && path === '/api/cards') {
        const body = await readBody(req)
        try {
          const card = await createCard(body, actor)
          sse.broadcast('card', forOwner(summarize(card)))
          return send(res, 201, { card: summarize(card) })
        } catch (err) {
          if (err instanceof CardInputError) return send(res, 400, { error: err.message })
          throw err
        }
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        const cards = guest ? [] : listCards()
        res.write(`event: hello\ndata: ${JSON.stringify({ columns: columnsFor(cards), cards: cards.map(summarize), sessions: viewFor(viewer), ts: new Date().toISOString() })}\n\n`)
        sse.add(res, cards, viewer, { token: presentedToken(req, url), loopback: isLoopback(remoteAddress(req)) })
        return
      }
      if (req.method === 'GET' && path === '/api/sessions') return send(res, 200, viewFor(viewer))
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
        if (req.method === 'POST' && parts[3] === 'land') {
          const why = landBlocker(sess)
          if (why) return send(res, 409, { error: why })
          landSession(sess, { by: actor.id })
            .catch((err) => log(`land ${id}: ${err.message}`))
            .finally(() => { trunkCache.clear(); try { sse.broadcast('sessions', (v) => viewFor(v)) } catch {} })
          log(`land requested for ${id} by ${actor.id}`)
          return send(res, 202, { ok: true, requested: 'land' })
        }
        if (req.method === 'POST' && (parts[3] === 'handoff' || parts[3] === 'end')) {
          if (!isActive(sess)) return send(res, 409, { error: `session ${id} is not active` })
          requestControl(id, parts[3] === 'handoff' ? { handoff: true, by: actor.id } : { end: true, by: actor.id })
          log(`${parts[3]} requested for ${id} by ${actor.id}`)
          return send(res, 200, { ok: true, requested: parts[3] })
        }
        if (req.method === 'DELETE' && parts.length === 3) {
          if (isActive(sess)) return send(res, 409, { error: 'end the session before removing it' })
          if (landingNow(id)) return send(res, 409, { error: 'wait for the landing to finish before removing it' })
          const force = url.searchParams.get('force') === '1'
          let worktree = null
          if (sess.worktree) { try { worktree = pruneSessionWorktree(sess) } catch (err) { worktree = { removed: false, reason: scrub(err.message).slice(0, 200) } } }
          // Remove must not orphan unlanded work: if the worktree could not be
          // pruned (uncommitted or unmerged), keep the record unless forced
          if (worktree && !worktree.removed && !force) return send(res, 409, { error: `not removing ${id}: ${worktree.reason}. Land it first, or retry with ?force=1 to drop the record and leave the worktree in place.`, worktree })
          removeSession(id)
          sse.broadcast('sessions', (v) => viewFor(v))
          return send(res, 200, { removed: id, worktree })
        }
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
            const dirty = worktreeDirty(card.repo, id)
            if (dirty.length) return send(res, 409, { error: `the card's worktree has ${dirty.length} uncommitted file(s): ${dirty.slice(0, 10).join(', ')}. Retry with ?force=1 to discard them.`, dirty })
          }
          try { removeWorktree(card.repo, id, { deleteBranch: url.searchParams.get('branch') === 'delete', force: true }) } catch (err) { log(`worktree remove: ${err.message}`) }
          rmSync(cardDir(id), { recursive: true, force: true })
          sse.broadcast('removed', forOwner({ card_id: id }))
          return send(res, 200, { removed: id })
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
  const server = http.createServer(onReq)
  // When the board is bound to a non-loopback address (share on), also listen on
  // 127.0.0.1 so the machine's own browser has a tokenless owner URL — a real
  // remote peer's address is never loopback, so it still needs a token.
  const loopbackCompanion = !isLoopback(bind) ? http.createServer(onReq) : null

  return {
    server,
    bind, port,
    start() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, bind, () => {
          const addr = server.address()
          log(`listening on http://${bind}:${addr.port} (home ${home()}${token ? ', token required' : ', loopback open'})`)
          if (scheduler) {
            sched = createScheduler()
            sched.run().catch((err) => log(`scheduler crashed: ${err.message}`))
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
    srv = createBoardServer()
  } catch (err) {
    process.stderr.write(err.message + '\n')
    process.exit(err.exitCode ?? 1)
  }
  await srv.start()
  const bye = () => { srv.stop().then(() => process.exit(0)) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
