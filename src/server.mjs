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
import { checkBind, authorize } from './auth.mjs'
import { listCards, readCard, readRuns, readEvents, cardDir, home } from './store.mjs'
import { humanAction } from './orchestrator.mjs'
import { createCard, CardInputError } from './cards.mjs'
import { IllegalTransition, availableActions } from './chain.mjs'
import { held } from './leases.mjs'
import { PRESETS } from './presets.mjs'
import { names as adapterNames, get as getAdapter, isFake } from './adapters/index.mjs'
import { createScheduler, schedulerStatus, MAX_CONCURRENT } from './scheduler.mjs'
import { remove as removeWorktree } from './worktree.mjs'
import { scrub } from './runner.mjs'
import { resolveChb } from './handoff.mjs'

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
  return {
    ...card,
    column: columnOf(card),
    station_kind: st?.kind ?? null,
    active_adapter: entry?.adapter ?? null,
    active_mode: entry?.mode ?? null,
    chain_view: st?.kind === 'agent' ? st.chain.map((e, i) => ({
      adapter: e.adapter, mode: e.mode ?? null, approve: Boolean(e.approve),
      // a leg before the current one ended in a handoff (only the last leg can complete a station)
      state: i < card.leg ? 'handed' : i === card.leg ? (['running', 'handing_off'].includes(card.status) ? 'active' : card.status === 'failed' ? 'failed' : card.status === 'done' ? 'done' : 'pending') : 'pending',
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
function detectTools() {
  if (toolsCache) return toolsCache
  const probe = (bin, args = ['--version']) => {
    const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    return !r.error && r.status === 0
  }
  let chb = false
  try { resolveChb(); chb = true } catch {}
  toolsCache = { claude: probe('claude'), codex: probe('codex'), gemini: probe('gemini'), agy: probe('agy'), grok: probe('grok'), chb, git: probe('git') }
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
function createSse({ healthIntervalMs = 10000, debounceMs = 30 } = {}) {
  const clients = new Set()
  const sig = new Map() // card_id → events already sent
  let watcher = null
  let healthTimer = null
  const pending = new Set()
  let flushTimer = null
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { try { res.write(frame) } catch {} }
  }
  // Re-read and re-emit exactly one card's files — never the whole ledger.
  const refreshCard = (id) => {
    const card = readCard(id)
    if (!card) { if (sig.has(id)) { sig.delete(id); broadcast('removed', { card_id: id }) } return }
    const events = readEvents(id)
    const from = sig.get(id) ?? 0
    sig.set(id, events.length)
    broadcast('card', summarize(card))
    for (const e of events.slice(from)) broadcast('event', e)
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
  const startWatch = () => {
    if (watcher) return
    const dir = join(home(), 'cards')
    try {
      mkdirSync(dir, { recursive: true })
      watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const id = String(filename).split(/[\\/]/)[0]
        if (id.startsWith('card-')) scheduleRefresh(id)
      })
    } catch (err) { log(`sse watch: ${err.message}`); watcher = null }
    healthTimer = setInterval(() => broadcast('health', { ok: true, scheduler: { ...schedulerStatus(), max_concurrent: MAX_CONCURRENT }, ts: new Date().toISOString() }), healthIntervalMs)
  }
  const stopWatch = () => {
    if (watcher) { watcher.close(); watcher = null }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    pending.clear()
  }
  const add = (res, cards) => {
    clients.add(res)
    for (const c of cards) sig.set(c.card_id, readEvents(c.card_id).length)
    startWatch()
    res.on('close', () => { clients.delete(res); if (!clients.size) stopWatch() })
  }
  const stop = () => { stopWatch(); for (const res of clients) { try { res.end() } catch {} } clients.clear() }
  return { add, stop, broadcast, clients }
}

// ---- the server ----
export function createBoardServer({ bind = process.env.BATON_BIND || '127.0.0.1', port = Number(process.env.BATON_PORT || 4747), token = process.env.BATON_TOKEN || '', scheduler = process.env.BATON_NO_SCHEDULER !== '1' } = {}) {
  checkBind({ bind, token })
  const sse = createSse()
  let sched = null

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    if (!path.startsWith('/api/')) return serveStatic(res, path)
    const auth = authorize({ token, req, url })
    if (!auth.ok) return send(res, 401, { error: 'unauthorized: set Authorization: Bearer <BATON_TOKEN>' })
    const actor = { type: 'human', id: auth.subject }
    const parts = path.split('/').filter(Boolean) // ['api', ...]
    try {
      if (req.method === 'GET' && path === '/api/health') {
        const cards = listCards()
        return send(res, 200, { ok: true, version: VERSION, bind, port, home: home(), scheduler: { ...schedulerStatus(), in_process: Boolean(sched), max_concurrent: MAX_CONCURRENT }, tools: detectTools(), columns: columnsFor(cards), cards: cards.length })
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
          sse.broadcast('card', summarize(card))
          return send(res, 201, { card: summarize(card) })
        } catch (err) {
          if (err instanceof CardInputError) return send(res, 400, { error: err.message })
          throw err
        }
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        const cards = listCards()
        res.write(`event: hello\ndata: ${JSON.stringify({ columns: columnsFor(cards), cards: cards.map(summarize), ts: new Date().toISOString() })}\n\n`)
        sse.add(res, cards)
        return
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
          try { removeWorktree(card.repo, id, { deleteBranch: url.searchParams.get('branch') === 'delete' }) } catch (err) { log(`worktree remove: ${err.message}`) }
          rmSync(cardDir(id), { recursive: true, force: true })
          sse.broadcast('removed', { card_id: id })
          return send(res, 200, { removed: id })
        }
        if (req.method === 'POST' && parts[3]) {
          const map = { run: 'enqueue', queue: 'enqueue', approve: 'approve', reassign: 'reassign', pause: 'pause', resume: 'resume', kill: 'kill', handoff: 'handoff_now', 'handoff-now': 'handoff_now', rerun: 'rerun' }
          const action = map[parts[3]]
          if (!action) return send(res, 404, { error: `unknown action ${parts[3]}` })
          const body = await readBody(req)
          try {
            const next = humanAction(id, action, body, actor)
            sse.broadcast('card', summarize(next))
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

  const server = http.createServer((req, res) => { handle(req, res).catch((err) => { try { send(res, 500, { error: scrub(err.message) }) } catch {} }) })

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
          resolvePromise({ port: addr.port, bind })
        })
      })
    },
    async stop() {
      sse.stop()
      if (sched) sched.stop()
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
