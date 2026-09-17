// board-responsiveness — the board answered a stylesheet in fourteen seconds
// and dropped clicks on Remove, because one running terminal saturated the
// server's event loop and the page rebuilt its whole grid three times a push.
// These are the four seams that produced it: what the sessions watcher is
// allowed to wake for, how often it may rebuild the view, what `leg` does when
// the board is too busy to answer a health probe, and how many times one push
// reaches the page.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, sleep } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// BATON_HOME must be set before the ledger module is imported (it reads it once).
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME
process.env.BATON_QUIET = '1'
const { createBoardServer } = await import('../src/server.mjs')

const SID = 's-20260101-010101-claude-aaaa'
const sessionDir = join(HOME, 'sessions', SID)

function writeRecord(extra = {}) {
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    session_id: SID, agent: 'claude', account: 'default', cwd: ROOT, repo: null, branch: null,
    argv: [], worktree: null, owner: 'tester', repo_name: null, status: 'ended',
    runner_pid: 999999, pid: null,
    started_at: '2026-01-01T01:01:01.000Z', updated_at: new Date().toISOString(),
    ended_at: '2026-01-01T01:02:00.000Z', last_activity: '2026-01-01T01:01:01.000Z',
    agent_session_id: null, transcript_path: null, task: 'watcher probe', turns: 0,
    files_touched: [], files_dirty: [], head: null, head_at_start: null, ...extra,
  }, null, 2))
}

let srv
let base

before(async () => {
  mkdirSync(sessionDir, { recursive: true })
  writeRecord()
  srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  base = `http://127.0.0.1:${port}`
})
after(async () => { await srv.stop() })

// Collect SSE frames until stopped. Returns { frames, stop }.
function listen() {
  const frames = []
  let socket = null
  const req = http.get(base + '/api/events', (res) => {
    let buf = ''
    res.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(raw)?.[1]
        if (ev) frames.push(ev)
      }
    })
  })
  req.on('socket', (s) => { socket = s })
  // an SSE response never ends on its own: destroy the socket too, or the
  // runner holds an open handle and the process never exits
  return { frames, stop: () => { req.destroy(); socket?.destroy() } }
}

test('the sessions watcher ignores lock and atomic-write temp files', async () => {
  const { frames, stop } = listen()
  await sleep(400)
  const before = frames.filter((f) => f === 'sessions').length

  // exactly the churn a live agent makes: a control lock about once a second
  // and a temp file per atomic write of its record
  for (let i = 0; i < 30; i++) {
    const lock = join(sessionDir, '.control.lock')
    const tmp = join(sessionDir, `session.json.${process.pid}.${Date.now()}${i}.tmp`)
    writeFileSync(lock, 'held')
    writeFileSync(tmp, '{}')
    rmSync(lock, { force: true })
    rmSync(tmp, { force: true })
    await sleep(40)
  }
  // well past the 300 ms debounce and the 2 s floor, still short of the 10 s
  // health tick that pushes on its own
  await sleep(2500)
  stop()

  const pushes = frames.filter((f) => f === 'sessions').length - before
  assert.equal(pushes, 0, `lock and temp churn must not rebuild the view; got ${pushes} sessions frame(s)`)
})

test('a real record change still pushes, and the rebuild is floored to one per interval', async () => {
  const { frames, stop } = listen()
  await sleep(400)
  const before = frames.filter((f) => f === 'sessions').length

  // ten writes of the record inside one second: the reader needs to see the
  // change, not ten rebuilds of a view that costs seconds of git to make
  for (let i = 0; i < 10; i++) { writeRecord({ turns: i }); await sleep(100) }
  await sleep(2600)
  stop()

  const pushes = frames.filter((f) => f === 'sessions').length - before
  assert.ok(pushes >= 1, 'a change to session.json must reach the page')
  assert.ok(pushes <= 3, `ten writes in one second must coalesce; got ${pushes} sessions frames`)
})

// A standing guard rather than a proof: one session in a throwaway home is
// cheap to render, so this passes even on the code that stalled. It fails if
// anything ever puts real work back on the path between a watcher event and
// the next request.
test('the board stays responsive while its own watcher is busy', async () => {
  const { frames, stop } = listen()
  await sleep(300)
  const churn = setInterval(() => { try { writeRecord({ turns: Date.now() % 1000 }) } catch { /* torn down */ } }, 120)
  await sleep(1500)

  const t0 = Date.now()
  await new Promise((resolvePromise, reject) => {
    const req = http.get(base + '/api/health', (r) => { r.resume(); r.on('end', resolvePromise) })
    req.on('error', reject)
  })
  const ms = Date.now() - t0
  clearInterval(churn)
  stop()
  void frames

  // the symptom was /api/health taking four to fourteen seconds behind a
  // blocked event loop; a second is already far outside anything healthy
  assert.ok(ms < 1000, `/api/health answered in ${ms} ms while the watcher was busy`)
})

test('a board too busy to answer a health probe is still a board: leg attaches to it', async () => {
  // a listener that completes the TCP handshake and then says nothing, which
  // is exactly how a saturated board looks to the health probe
  const held = []
  const deaf = net.createServer((s) => { held.push(s) })
  await new Promise((r) => deaf.listen(0, '127.0.0.1', r))
  const port = deaf.address().port

  const prevPort = process.env.LEG_PORT
  const prevBaton = process.env.BATON_PORT
  process.env.LEG_PORT = String(port)
  process.env.BATON_PORT = String(port)
  try {
    const { ensureBoard } = await import('../src/attach.mjs')
    const t0 = Date.now()
    const board = await ensureBoard({ open: false })
    const ms = Date.now() - t0

    assert.equal(board.busy, true, 'a port that is taken must be reported as a busy board')
    assert.equal(board.started, false, 'a second server must not be spawned onto a taken port')
    assert.equal(board.url, `http://127.0.0.1:${port}`, 'the caller still gets the board URL to open')
    // the old path spawned a server that could only die of EADDRINUSE and then
    // polled a dead child for the full fifteen seconds before giving up
    assert.ok(ms < 12000, `attaching to a busy board took ${ms} ms`)
  } finally {
    if (prevPort === undefined) delete process.env.LEG_PORT; else process.env.LEG_PORT = prevPort
    if (prevBaton === undefined) delete process.env.BATON_PORT; else process.env.BATON_PORT = prevBaton
    // the probe's own connection is still open on both ends
    for (const s of held) s.destroy()
    await new Promise((r) => deaf.close(r))
  }
})

// ---- the page: one push must reach the grid once ----
const SESSIONS_JS = readFileSync(join(ROOT, 'src/board/sessions.js'), 'utf8')
const BOARD_JS = readFileSync(join(ROOT, 'src/board/board.js'), 'utf8')

test('one sessions push rebuilds the terminals grid exactly once', () => {
  const leg = SESSIONS_JS.match(/addEventListener\('leg:sessions'/g) ?? []
  const baton = SESSIONS_JS.match(/addEventListener\('baton:sessions'/g) ?? []
  assert.equal(leg.length, 1, `sessions.js must render from one listener; found ${leg.length} for leg:sessions`)
  assert.equal(baton.length, 0, 'sessions.js must not also render from the legacy baton:sessions alias')
})

test('a superseded EventSource cannot drive a rebuild, and the payload is parsed once', () => {
  const line = BOARD_JS.split('\n').find((l) => l.includes("es.addEventListener('sessions'"))
  assert.ok(line, 'expected a sessions handler on the EventSource in board.js')
  const body = line
  assert.match(body, /state\.es === es && request === state\.sseRequest/, 'every dispatch must sit behind the staleness guard')
  // the guard must cover the whole handler: `if (guard) a(); b()` let a
  // superseded EventSource still run b, which is how the old line read
  assert.equal((body.match(/window\.dispatchEvent/g) ?? []).length, 0,
    'the handler must dispatch through publishSessions, not inline past the guard')
  assert.equal((body.match(/JSON\.parse/g) ?? []).length, 1, 'the payload must be parsed once, not once per dispatched event')
})

// The defect this catches threw `TypeError: Cannot read properties of null
// (reading 'action')` into the console and nothing else: every Yes on this page
// — Remove, Remove record, End, Land — silently did nothing. sessions.js is an
// IIFE with no export seam, so the contract is checked where it lives.
test('confirmRow clears pendingConfirm before it calls back, so no callback may read it', () => {
  const body = /function confirmRow\(question, verb, onYes\) \{([\s\S]*?)\n {2}\}/.exec(SESSIONS_JS)
  assert.ok(body, 'expected confirmRow in sessions.js')
  assert.match(body[1], /pendingConfirm = null; onYes\(yes\)/,
    'the Yes handler clears the pending confirm before invoking the callback')

  // therefore the call site must hand confirmRow a snapshot, never the variable
  const site = /if \(pendingConfirm && pendingConfirm\.id === s\.session_id\) \{([\s\S]*?)\n {4}\}/.exec(SESSIONS_JS)
  assert.ok(site, 'expected the pending-confirm branch in renderSession')
  const callback = /confirmRow\([^\n]*?,\s*\(btn\) => ([^\n]*?)\)\)\n/.exec(site[1])
    ?? /confirmRow\((.*)\)\)/.exec(site[1])
  assert.ok(callback, 'expected a confirmRow call in the pending-confirm branch')
  assert.doesNotMatch(callback[1], /pendingConfirm/,
    'the callback must close over a snapshot; reading pendingConfirm dereferences null and throws before act() runs')
  assert.match(site[1], /const pending = pendingConfirm/, 'the branch snapshots the pending confirm')
})

test('an open confirm row is not torn down by an incoming push', () => {
  const render = /function render\(v\) \{([\s\S]*?)\n {2}\}/.exec(SESSIONS_JS)
  assert.ok(render, 'expected render(v) in sessions.js')
  assert.match(render[1], /if \(!pendingConfirm\) renderSessions\(v\)/,
    'a push must not rebuild the grid while a confirm row is waiting for an answer')
  // the timed re-sort replaces the same buttons on its own schedule
  assert.match(SESSIONS_JS, /!pendingConfirm && !selectionInsideGrid\(\)/,
    'the 15 s re-sort must stand down while a confirm row is open')
})

test('the board files the page loads are the ones under test', () => {
  assert.ok(existsSync(join(ROOT, 'src/board/sessions.js')))
  assert.ok(existsSync(join(ROOT, 'src/board/board.js')))
  assert.match(BOARD_JS, /function publishSessions\(detail\)/, 'board.js publishes both event names from one place')
})
