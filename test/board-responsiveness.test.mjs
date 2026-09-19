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
import { spawn } from 'node:child_process'
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
const { createBoardServer, sessionsView } = await import('../src/server.mjs')
const { readUsage } = await import('../src/usage.mjs')
const { HANDOFF_ORDER_CAPABILITY } = await import('../src/sessions.mjs')

const SID = 's-20260101-010101-claude-aaaa'
const SID2 = 's-20260101-010102-claude-bbbb'
const sessionDir = join(HOME, 'sessions', SID)

function writeRecord(extra = {}, id = SID) {
  mkdirSync(join(HOME, 'sessions', id), { recursive: true })
  writeFileSync(join(HOME, 'sessions', id, 'session.json'), JSON.stringify({
    session_id: id, agent: 'claude', account: 'default', cwd: ROOT, repo: null, branch: null,
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
  // well past the 300 ms debounce and the 2 s floor; the 10 s health tick asks
  // this same fingerprint before it pushes, so it cannot rescue a noise hint
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

// The 10 s health tick used to push the whole sessions view as well, with no
// check of any kind: on a board with 43 terminals that is a ~512-fs-call rebuild
// and a round of git subprocesses six times a minute, per client, for a payload
// byte-identical to the one the page already holds — 7,294 fs calls, 8 git
// processes and 1.14 CPU seconds a minute on a board where nothing at all was
// happening. The tick now asks the same stat fingerprint a watcher hint asks.
test('an idle board pushes no sessions view across two health ticks, and a real change still arrives', async () => {
  const { frames, stop } = listen()
  // let the hello frame and anything left pending by the test above settle
  await sleep(2600)
  const before = frames.filter((f) => f === 'sessions').length
  const healthBefore = frames.filter((f) => f === 'health').length

  await sleep(12000)
  const idlePushes = frames.filter((f) => f === 'sessions').length - before
  const ticks = frames.filter((f) => f === 'health').length - healthBefore
  // L2: the verdict carries the volume. A tick that never fired would make the
  // line below pass on no work at all.
  assert.ok(ticks >= 1, `the health tick must keep ticking; got ${ticks} health frame(s) in 12 s`)
  assert.equal(idlePushes, 0, `an idle board must rebuild nothing; got ${idlePushes} sessions frame(s) across ${ticks} health tick(s)`)

  // and the tick's silence is not deafness
  const t0 = Date.now()
  writeRecord({ turns: 99 })
  let waited = 0
  while (frames.filter((f) => f === 'sessions').length === before && waited < 3000) { await sleep(25); waited = Date.now() - t0 }
  const after = frames.filter((f) => f === 'sessions').length - before
  stop()
  assert.ok(after >= 1, `a session.json change must reach the page within 3 s; waited ${waited} ms and got ${after} frame(s)`)
})

// The one change that moves no file: a runner that dies. The unconditional
// tick used to catch it because every rebuild ran reapLost; a tick that only
// rebuilds on a fingerprint change must run the liveness pass itself, or the
// board shows a dead terminal as live until something else happens to write.
test('a runner that dies without writing is marked lost by the health tick', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const { frames, stop } = listen()
  await sleep(300)
  writeRecord({ status: 'running', runner_pid: child.pid, ended_at: null }, SID2)
  // the write itself reaches the page through the watcher; wait that push out
  let waited = 0
  while (!frames.includes('sessions') && waited < 3000) { await sleep(25); waited += 25 }
  assert.ok(frames.includes('sessions'), 'the new record must reach the page before the runner is killed')
  assert.equal(JSON.parse(readFileSync(join(HOME, 'sessions', SID2, 'session.json'), 'utf8')).status, 'running')
  const pushesBefore = frames.filter((f) => f === 'sessions').length
  child.kill()
  await new Promise((r) => child.once('exit', r))
  // no file has changed; only the tick can notice
  const t0 = Date.now()
  let record = null
  while (Date.now() - t0 < 12000) {
    record = JSON.parse(readFileSync(join(HOME, 'sessions', SID2, 'session.json'), 'utf8'))
    if (record.status === 'lost' && frames.filter((f) => f === 'sessions').length > pushesBefore) break
    await sleep(100)
  }
  stop()
  const pushes = frames.filter((f) => f === 'sessions').length - pushesBefore
  assert.equal(record.status, 'lost', `the record must say lost after its runner died; still ${record.status} after ${Date.now() - t0} ms`)
  assert.ok(pushes >= 1, `the lost terminal must reach the page; got ${pushes} sessions frame(s) after the kill`)
})

// Four usage files on disk were read 143 times per answer: evaluateLadder
// memoises inside one call, this view makes one call per terminal, and then
// reads the same login again for `capacity` and again for the accounts payload.
test('one sessions view reads a login once, however many terminals stand on it', () => {
  writeRecord({ turns: 1 }, SID2)
  const counts = new Map()
  const read = (agent, account = 'default') => {
    const key = `${agent}--${account}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return readUsage(agent, account)
  }
  const view = sessionsView({ read })
  const mine = view.sessions.filter((s) => [SID, SID2].includes(s.session_id))
  assert.equal(mine.length, 2, `both terminals must be in the view; got ${mine.length}`)
  assert.ok(counts.size >= 1, `the view must actually read a login; it read ${counts.size}`)
  const worst = Math.max(...counts.values())
  assert.ok(worst <= 2, `a login was read ${worst} times in one view: ${JSON.stringify([...counts])}`)
  assert.equal(counts.get('claude--default'), 1, `the login both terminals run on was read ${counts.get('claude--default')} time(s), across ${counts.size} login(s)`)
})

// Every row ships in every push and in every /api/sessions answer, so a field
// nothing on the board reads is paid for on every push.
test('a session row carries what the board renders, not the runner bookkeeping', async () => {
  writeRecord({ agent_sessions: { claude: 'cs-1' }, checkpoints: ['2026-01-01T01:01:30.000Z'], runtime_capabilities: [HANDOFF_ORDER_CAPABILITY] })
  const view = await (await fetch(base + '/api/sessions')).json()
  const row = view.sessions.find((s) => s.session_id === SID)
  assert.ok(row, 'the view carries the terminal')
  // what the page does read stays: the merged list the grid prints, the dirty
  // list it counts (src/board/sessions.js), and the one capability summary
  assert.deepEqual(row.files, [])
  assert.ok('files_dirty' in row, 'src/board/sessions.js counts files_dirty')
  assert.equal(row.can_edit_handoff_order, true, 'the summary of runtime_capabilities stays, and is true for a record that has it')
  for (const field of ['argv', 'runner_pid', 'head_at_start', 'checkpoints', 'agent_sessions', 'runtime_capabilities', 'files_touched']) {
    assert.equal(field in row, false, `every row in every push carries ${field}, which no board file and no test reads off a row`)
  }
  // and the whole record is still one GET away
  const full = await (await fetch(`${base}/api/sessions/${SID}`)).json()
  for (const field of ['argv', 'runner_pid', 'head_at_start', 'checkpoints', 'agent_sessions', 'runtime_capabilities', 'files_touched']) {
    assert.ok(field in full.session, `GET /api/sessions/<id> is the whole record and must still carry ${field}`)
  }
})

// A standing guard rather than a proof: one session in a throwaway home is
// cheap to render, so this passes even on the code that stalled. It fails if
// anything ever puts real work back on the path between a watcher event and
// the next request.
test('the board stays responsive while its own watcher is busy', async () => {
  const health = () => new Promise((resolvePromise, reject) => {
    const t0 = Date.now()
    const req = http.get(base + '/api/health', (r) => { r.resume(); r.on('end', () => resolvePromise(Date.now() - t0)) })
    req.on('error', reject)
  })

  const { frames, stop } = listen()
  await sleep(300)
  // The baseline is taken in this process, on this machine, right now. An
  // absolute millisecond budget measured the runner instead of the code: at
  // four-way concurrency on a loaded machine this asked for under a second and
  // got 1055 and 1140, while the same test alone passed every time. What the
  // regression actually looked like was /api/health behind a blocked event
  // loop, four to fourteen seconds against an idle baseline of two.
  const idle = Math.max(await health(), await health(), 1)

  const churn = setInterval(() => { try { writeRecord({ turns: Date.now() % 1000 }) } catch { /* torn down */ } }, 120)
  await sleep(1500)
  const busy = await health()
  clearInterval(churn)
  stop()
  void frames

  // Two ways to fail, and the original bug trips both by a wide margin: the
  // watcher must not make a request an order of magnitude slower than it is
  // when nothing is happening, and it must never reach the seconds the symptom
  // was named for, however slow the machine is.
  assert.ok(busy < Math.max(idle * 20, 500), `/api/health took ${busy} ms with the watcher busy against an idle baseline of ${idle} ms`)
  assert.ok(busy < 3000, `/api/health answered in ${busy} ms while the watcher was busy`)
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
