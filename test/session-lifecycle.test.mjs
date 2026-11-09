// The terminal lifecycle (src/session-lifecycle.mjs): the edge table, the
// in-lock guard in updateSession, the leg boundary, and the surfaces that
// refuse what the table refuses (board routes, `leg sessions`, the board's
// buttons).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHome, testEnv, legFail, ROOT } from './helpers.mjs'

// BATON_HOME must be set before the store is imported (it reads it once).
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const L = await import('../src/session-lifecycle.mjs')
const sessions = await import('../src/sessions.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { legBoundary, claimHandoffChoice } = await import('../src/attach.mjs')
const { handleHook } = await import('../src/taps/claude.mjs')
const { createUsagePollers } = await import('../src/usage-poll.mjs')

const {
  SESSION_STATES, SESSION_ACTIVE_STATES, SESSION_EDGES, SESSION_TRANSITIONS,
  ORDER_EDITABLE_STATES, SESSION_STATE_LABELS, IllegalSessionTransition, canTransition, nextStates, sessionActions, assertAction,
} = L
const cwd = mkdtempSync(join(tmpdir(), 'leg-lifecycle-cwd-'))
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const BOARD_SRC = src('src/board/sessions.js')
const OLD_ACTIVE = ['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting']
// read from an older record, never entered (src/session-lifecycle.mjs, docs/VOCABULARY.md)
const LEGACY = ['handed_off']

// the board server for the surface tests at the end
let srv
let base
before(async () => {
  srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  base = `http://127.0.0.1:${port}`
})
after(async () => { await srv.stop() })

let n = 0
// a record in `status`, written through the unchecked seed path
function seed(status, over = {}) {
  const id = `s-life-${++n}-${status}`
  sessions.createSession({ id, agent: over.agent ?? 'claude', cwd, repo: null, runner_pid: process.pid })
  if (status !== 'starting' || Object.keys(over).length) sessions.updateSession(id, { status, ...over })
  return id
}
const eventsOf = (id) => sessions.readEvents(id)
const refusals = (id) => eventsOf(id).filter((e) => e.type === 'transition_refused')

function boardStatusMap() {
  const at = BOARD_SRC.indexOf('const STATUS = {')
  assert.ok(at > 0, 'the board keeps its STATUS map')
  const body = BOARD_SRC.slice(at, BOARD_SRC.indexOf('}', at) + 1)
  return Object.fromEntries([...body.matchAll(/(\w+): \['([^']+)', '\w+'\]/g)].map((m) => [m[1], m[2]]))
}

// every `updateSession(` call in one source file, with its argument text
function updateCalls(text) {
  const out = []
  const re = /updateSession\(/g
  let m
  while ((m = re.exec(text))) {
    if (text.slice(Math.max(0, m.index - 16), m.index).includes('function ')) continue
    let depth = 1; let i = m.index + m[0].length; let quote = null
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
      if (c === "'" || c === '"') quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    out.push({ line: text.slice(0, m.index).split('\n').length, args: text.slice(m.index + m[0].length, i - 1) })
  }
  return out
}
function srcFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : /\.(mjs|js)$/.test(d.name) ? [join(dir, d.name)] : []))
}

// ---- the table -------------------------------------------------------------

test('SESSION_EDGES (printed) is the whole table: valid rows, no self-loops, frozen', (t) => {
  for (const [from, to, actor, note] of SESSION_EDGES) t.diagnostic(`| ${from.padEnd(11)} | ${to.padEnd(11)} | ${actor.padEnd(6)} | ${note} |`)
  t.diagnostic(`${SESSION_EDGES.length} edge rows, ${new Set(SESSION_EDGES.map((e) => `${e[0]}>${e[1]}`)).size} distinct moves`)
  assert.ok(SESSION_EDGES.length > 0)
  for (const [from, to, actor, note] of SESSION_EDGES) {
    assert.ok(SESSION_STATES.includes(from), `from ${from}`)
    assert.ok(SESSION_STATES.includes(to), `to ${to}`)
    assert.notEqual(from, to, `${from} has a self-loop row`)
    assert.ok(['user', 'agent', 'cron', 'system'].includes(actor), `actor ${actor}`)
    assert.ok(typeof note === 'string' && note.length > 0, `${from} → ${to} carries a note`)
  }
  const keys = SESSION_EDGES.map((e) => e.slice(0, 3).join('>'))
  assert.equal(new Set(keys).size, keys.length, 'no duplicate (from, to, actor) row')
  assert.ok(Object.isFrozen(SESSION_EDGES) && Object.isFrozen(SESSION_EDGES[0]) && Object.isFrozen(SESSION_TRANSITIONS) && Object.isFrozen(SESSION_TRANSITIONS.running))
  for (const s of SESSION_STATES) assert.deepEqual([...SESSION_TRANSITIONS[s]], [...new Set(SESSION_EDGES.filter((e) => e[0] === s).map((e) => e[1]))], `SESSION_TRANSITIONS.${s} is derived from the rows`)
})

test('the states are the nine sessions.mjs, the board and the table all name', () => {
  assert.deepEqual([...SESSION_STATES], ['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting', 'handed_off', 'ended', 'lost'])
  assert.deepEqual([...sessions.SESSION_STATUSES], [...SESSION_STATES])
  assert.deepEqual(Object.keys(boardStatusMap()), [...SESSION_STATES], 'the board STATUS map lists the same nine, in order')
  assert.deepEqual(Object.keys(SESSION_STATE_LABELS), [...SESSION_STATES])
  assert.deepEqual(boardStatusMap(), { ...SESSION_STATE_LABELS }, 'the board words mirror SESSION_STATE_LABELS')
})

test('every status literal a writer in src/ sets is a state of the table', () => {
  let seen = 0
  for (const rel of ['src/attach.mjs', 'src/sessions.mjs', 'src/taps/claude.mjs', 'src/usage-poll.mjs']) {
    for (const m of src(rel).matchAll(/status(?:: | = )'([a-z_]+)'/g)) {
      seen++
      assert.ok(SESSION_STATES.includes(m[1]), `${rel} writes status '${m[1]}', which is not a state`)
    }
  }
  assert.ok(seen >= 15, `scanned ${seen} status literals`)
})

test('every non-legacy state is reachable from starting; legacy states have no way in', () => {
  const seen = new Set(['starting'])
  const queue = ['starting']
  while (queue.length) for (const to of SESSION_TRANSITIONS[queue.shift()]) if (!seen.has(to)) { seen.add(to); queue.push(to) }
  for (const s of SESSION_STATES.filter((x) => !LEGACY.includes(x))) assert.ok(seen.has(s), `${s} is unreachable`)
  assert.deepEqual(SESSION_STATES.filter((s) => !seen.has(s)), LEGACY, 'the unreachable states are exactly the legacy ones')
  for (const s of LEGACY) {
    assert.equal(seen.has(s), false)
    assert.deepEqual(SESSION_EDGES.filter((e) => e[1] === s), [], `${s} has an incoming edge`)
  }
})

test('terminal, active and order-editable sets are derived and equal the old lists', () => {
  assert.deepEqual(SESSION_STATES.filter((s) => nextStates(s).length === 0), SESSION_STATES.filter((s) => SESSION_TRANSITIONS[s].length === 0))
  assert.deepEqual(SESSION_STATES.filter((s) => nextStates(s).length === 0), ['handed_off', 'ended'], 'the terminal states: no move out')
  assert.deepEqual([...SESSION_ACTIVE_STATES], OLD_ACTIVE)
  assert.deepEqual([...SESSION_ACTIVE_STATES], SESSION_STATES.filter((s) => canTransition(s, 'ended', { actor: 'user' })), 'active = a human can End it')
  assert.deepEqual([...ORDER_EDITABLE_STATES], ['starting', 'running', 'warning', 'limit', 'waiting'], 'the old server.mjs list')
  for (const s of SESSION_STATES) assert.equal(sessions.isActive({ status: s }), OLD_ACTIVE.includes(s), `isActive(${s})`)
})

test('every status writer in src/ passes onIllegal; the rest stay unchecked', () => {
  let calls = 0; let statusCalls = 0
  for (const rel of srcFiles('src')) {
    const text = src(rel)
    const patchVars = [...new Set([...text.matchAll(/\b(\w+)\.status\s*=[^=]/g)].map((m) => m[1]))]
    for (const c of updateCalls(text)) {
      calls++
      const setsStatus = /\bstatus\s*:/.test(c.args) || patchVars.some((v) => new RegExp(`\\b${v}\\b`).test(c.args))
      if (!setsStatus) continue
      statusCalls++
      assert.match(c.args, /onIllegal: '(skip|drop_status)'/, `${rel}:${c.line} writes a status without onIllegal`)
    }
  }
  assert.ok(calls >= 40, `scanned ${calls} updateSession calls`)
  assert.equal(statusCalls, 16, `the 16 status writers: attach.mjs (10), sessions.mjs (1), taps/claude.mjs (4), usage-poll.mjs (1); found ${statusCalls}`)
  // agy and grok: a limit found earlier in the same tick is not overwritten
  assert.equal(src('src/attach.mjs').split("if (s.status === 'starting' && !patch.status) patch.status = 'running'").length - 1, 2)
})

test('docs/cli-contracts.md carries the edge table row for row', () => {
  const doc = src('docs/cli-contracts.md')
  for (const [from, to, actor, note] of SESSION_EDGES) {
    assert.ok(doc.includes(`| \`${from}\` | \`${to}\` | ${actor} | ${note} |`), `docs/cli-contracts.md is missing ${from} → ${to} (${actor})`)
  }
})

// ---- legal transitions: one per edge row --------------------------------------

for (const [from, to, actor] of SESSION_EDGES) {
  test(`legal: ${from} → ${to} (${actor}) is accepted by the table and written under the lock`, () => {
    assert.equal(canTransition(from, to), true)
    assert.equal(canTransition(from, to, { actor }), true)
    assert.ok(nextStates(from).includes(to))
    const id = seed(from)
    const next = sessions.updateSession(id, { status: to, marker: 1 }, { onIllegal: 'skip', event: { type: 'status', summary: 'moved' } })
    assert.equal(next.status, to)
    assert.equal(sessions.readSession(id).status, to)
    assert.deepEqual(refusals(id), [])
    assert.equal(eventsOf(id).at(-1).type, 'status')
  })
}

test('legal: a same-status write is not a transition and is accepted with no refusal', () => {
  for (const s of ['starting', 'handing_off', 'waiting', 'limit']) {
    assert.equal(canTransition(s, s), false, 'no self-loop row')
    const id = seed(s)
    const next = sessions.updateSession(id, { status: s, marker: 2 }, { onIllegal: 'skip', event: { type: 'all_out', summary: 'again' } })
    assert.equal(next.status, s)
    assert.equal(next.marker, 2, `${s} → ${s} writes the rest of the patch`)
    assert.deepEqual(refusals(id), [])
    assert.equal(eventsOf(id).at(-1).type, 'all_out', 'the caller\'s own event stands')
  }
})

test('legal: the human verbs each state offers', () => {
  for (const s of ['starting', 'running', 'warning', 'limit']) {
    assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'handoff'), s)
    assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'approve_request'), s)
  }
  for (const s of SESSION_ACTIVE_STATES) assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'end'), s)
  for (const s of ORDER_EDITABLE_STATES) assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'edit_order'), s)
  for (const s of ['starting', 'running', 'warning', 'limit', 'waiting']) assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'end_as_card'), s)
  for (const s of ['ended', 'lost', 'handed_off']) assert.doesNotThrow(() => assertAction({ session_id: 's-x', status: s }, 'remove'), s)
  assert.deepEqual(sessionActions({ status: 'running' }), ['handoff', 'approve_request', 'end', 'end_as_card', 'edit_order'])
  assert.deepEqual(sessionActions({ status: 'handing_off' }), ['end'])
  assert.deepEqual(sessionActions({ status: 'waiting' }), ['end', 'end_as_card', 'edit_order'])
  assert.deepEqual(sessionActions({ status: 'ended' }), ['remove'])
})

// ---- illegal transitions: one per move the table does not have ------------------

const ILLEGAL = SESSION_STATES.flatMap((from) => SESSION_STATES.filter((to) => to !== from && !SESSION_TRANSITIONS[from].includes(to)).map((to) => [from, to]))

test('the illegal moves are every ordered pair the table leaves out', (t) => {
  t.diagnostic(`${ILLEGAL.length} illegal moves`)
  assert.equal(ILLEGAL.length, 9 * 8 - new Set(SESSION_EDGES.map((e) => `${e[0]}>${e[1]}`)).size)
})

for (const [from, to] of ILLEGAL) {
  test(`illegal: ${from} → ${to} is refused, in both modes, and the record keeps ${from}`, () => {
    assert.equal(canTransition(from, to), false)
    assert.ok(!nextStates(from).includes(to))
    const id = seed(from)
    assert.equal(sessions.updateSession(id, { status: to }, { onIllegal: 'skip' }).status, from)
    const dropped = sessions.updateSession(id, { status: to, marker: 3 }, { onIllegal: 'drop_status' })
    assert.equal(dropped.status, from)
    assert.equal(dropped.marker, 3, 'drop_status writes the rest of the patch')
    assert.equal(sessions.readSession(id).status, from)
  })
}

test('illegal: limit → warning from a stale tick keeps limit and still writes the tick\'s files', () => {
  const id = seed('limit')
  const next = sessions.updateSession(id, { status: 'warning', files_dirty: ['a.mjs'], warning: { window: '5h', pct: 90 } }, { onIllegal: 'drop_status' })
  assert.equal(next.status, 'limit')
  assert.deepEqual(next.files_dirty, ['a.mjs'])
  assert.deepEqual(refusals(id), [], 'the tick passes no event, so the refusal is silent')
  assert.equal(canTransition('limit', 'running'), false)
})

test('illegal: the codex poller cannot put limit over waiting or handing_off; the percentages still land', async () => {
  const waiting = seed('waiting', { agent: 'codex' })
  const handing = seed('handing_off', { agent: 'codex' })
  const running = seed('running', { agent: 'codex' })
  const resets = Math.floor(Date.now() / 1000) + 3600
  const pollers = createUsagePollers({
    agents: ['codex'],
    accounts: () => ({ codex: ['default'] }),
    fetchers: { codex: async () => ({ ok: true, available: false, observed_at: new Date().toISOString(), limits: { five_hour: { pct: 100, resets_at: resets }, seven_day: { pct: 40, resets_at: resets + 1000 } } }) },
    schedule: () => null, cancel: () => {},
  })
  try { await pollers.pollNow('codex', 'default') } finally { pollers.stop() }
  for (const id of [waiting, handing]) {
    const s = sessions.readSession(id)
    assert.equal(s.status, id === waiting ? 'waiting' : 'handing_off', `${id} keeps its status`)
    assert.equal(s.limits.five_hour.pct, 100, 'the reading still lands')
    assert.deepEqual(refusals(id), [], 'silently: the poller passes no event')
  }
  assert.equal(sessions.readSession(running).status, 'limit', 'a running codex terminal still walls')
})

test('illegal: a claude StopFailure from a child that is handing off keeps handing_off, and its line becomes transition_refused', () => {
  const id = seed('handing_off')
  assert.equal(handleHook(id, { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached', leg_simulated: true }), 'LIMIT')
  const s = sessions.readSession(id)
  assert.equal(s.status, 'handing_off')
  const r = refusals(id)
  assert.equal(r.length, 1)
  assert.equal(r[0].from, 'handing_off')
  assert.equal(r[0].to, 'limit')
  assert.match(r[0].summary, /^limit refused while handing_off: claude usage limit \(simulated\): API Error: Rate limit reached/)
  assert.equal(eventsOf(id).some((e) => e.type === 'limit'), false, 'no limit line for a limit that did not happen to this record')
})

test('illegal: an ended record is never reopened; reapLost on a stale list leaves status and ended_at alone', () => {
  for (const to of ['starting', 'running', 'lost', 'limit']) assert.equal(canTransition('ended', to), false, `ended → ${to}`)
  const id = seed('ended', { ended_at: '2026-01-01T00:00:00.000Z', runner_pid: 999999 })
  const stale = { ...sessions.readSession(id), status: 'running' }
  const [out] = sessions.reapLost([stale])
  assert.equal(out.status, 'ended')
  const s = sessions.readSession(id)
  assert.equal(s.status, 'ended')
  assert.equal(s.ended_at, '2026-01-01T00:00:00.000Z')
  assert.equal(refusals(id).length, 1, 'one transition_refused line at most')
  assert.equal(eventsOf(id).some((e) => e.type === 'lost'), false)
})

test('illegal: lost cannot come back, and handed_off goes nowhere', () => {
  for (const to of ['running', 'starting', 'limit', 'handing_off']) assert.equal(canTransition('lost', to), false, `lost → ${to}`)
  for (const to of SESSION_STATES) assert.equal(canTransition('handed_off', to), false, `handed_off → ${to}`)
})

test('illegal: starting, running and warning cannot go straight to waiting once checked; the seed path still can', () => {
  for (const from of ['starting', 'running', 'warning']) {
    assert.equal(canTransition(from, 'waiting'), false)
    const id = seed(from)
    assert.equal(sessions.updateSession(id, { status: 'waiting' }, { onIllegal: 'skip' }).status, from)
    assert.equal(sessions.updateSession(id, { status: 'waiting' }).status, 'waiting', 'no onIllegal: the unchecked seed path tests use')
  }
})

test('illegal: skip writes nothing; one transition_refused line replaces the caller\'s event', () => {
  const id = seed('ended')
  const before = sessions.readSession(id)
  const r = sessions.updateSession(id, { status: 'handing_off', handoff: { reason: 'x' } }, { onIllegal: 'skip', event: { type: 'handoff_requested', summary: 'hand off requested from the board' } })
  assert.deepEqual(r, before)
  const after = sessions.readSession(id)
  assert.equal(after.updated_at, before.updated_at, 'updated_at is unchanged')
  assert.equal(after.handoff, null)
  const ev = eventsOf(id)
  assert.equal(ev.some((e) => e.type === 'handoff_requested'), false)
  assert.deepEqual(refusals(id).map((e) => e.summary), ['handing_off refused while ended: hand off requested from the board'])
  assert.throws(() => sessions.updateSession(id, { status: 'ended' }, { onIllegal: 'drop-status' }), TypeError)
})

test('illegal: a claim on a record that already ended is refused and not reported as claimed', () => {
  const id = seed('ended')
  const claim = claimHandoffChoice({ sid: id, agent: 'claude', account: 'default', installed: { claude: true, codex: true, agy: true, grok: true }, reason: 'limit' })
  assert.ok(claim.choice.next, 'a destination was chosen, so only the lifecycle stood in the way')
  assert.equal(claim.claimed, false)
  assert.equal(claim.session.status, 'ended')
  assert.equal(sessions.readSession(id).status, 'ended')
})

test('illegal: the human verbs a state does not offer throw, with the contract fields', () => {
  const check = (status, verb, words) => assert.throws(() => assertAction({ session_id: 's-x', status }, verb), (e) => {
    assert.ok(e instanceof IllegalSessionTransition)
    assert.equal(e.code, 'illegal_transition')
    assert.equal(e.current, status)
    assert.deepEqual(e.allowed, [...nextStates(status, { actor: 'user' })])
    assert.deepEqual(e.actions, sessionActions({ status }))
    if (words) assert.match(e.message, words)
    return true
  })
  check('handing_off', 'handoff', /^session s-x is handing off: Hand off now is not available now \(it can: end\)$/)
  check('waiting', 'handoff', /^session s-x is waiting for reset: Hand off now is not available now/)
  check('waiting', 'approve_request')
  check('handing_off', 'approve_request')
  check('handing_off', 'end_as_card', /End, and keep going as a card is not available now/)
  check('handing_off', 'edit_order')
  assert.throws(() => assertAction({ session_id: 's-x', status: 'running' }, 'fly'), TypeError)
  const e = (() => { try { assertAction({ session_id: 's-x', status: 'handing_off' }, 'handoff') } catch (err) { return err } })()
  assert.equal(e.requested, 'handing_off')
  assert.deepEqual(e.allowed, ['ended'])
  assert.deepEqual(e.actions, ['end'])
  for (const status of ['ended', 'lost']) {
    for (const verb of ['handoff', 'approve_request', 'end', 'end_as_card', 'edit_order']) {
      assert.throws(() => assertAction({ session_id: 's-gone', status }, verb), (err) => err.message === 'session s-gone is not active' && err.code === 'illegal_transition', `${verb} on ${status}`)
    }
  }
})

// ---- the leg boundary ------------------------------------------------------

test('legBoundary: an End written during the hand-off stops before the next leg', () => {
  const id = seed('handing_off')
  sessions.requestControl(id, { end: true, by: 'wes' })
  assert.deepEqual(legBoundary(id), { end: true })
  assert.equal(existsSync(join(sessions.sessionDir(id), 'control.json')), false)
  assert.equal(eventsOf(id).at(-1).summary, 'end requested during the hand-off by wes; the next leg was not started')
  assert.deepEqual(legBoundary(id), { end: false }, 'nothing left to read')
})

test('legBoundary: a Hand off now that raced into the hand-off is dropped and said so', () => {
  const id = seed('handing_off')
  sessions.requestControl(id, { handoff: true })
  assert.deepEqual(legBoundary(id), { end: false })
  assert.equal(existsSync(join(sessions.sessionDir(id), 'control.json')), false)
  assert.equal(eventsOf(id).at(-1).summary, 'a hand-off requested during the hand-off was dropped')
})

// ---- surfaces ----------------------------------------------------------------

function api(path, { method = 'GET', body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => { let json = null; try { json = JSON.parse(data) } catch {} resolvePromise({ status: r.statusCode, json }) })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
const controlOf = (id) => {
  const f = join(sessions.sessionDir(id), 'control.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

test('POST handoff while handing_off answers 409 with the contract and writes no request', async () => {
  const id = seed('handing_off')
  const r = await api(`/api/sessions/${id}/handoff`, { method: 'POST' })
  assert.equal(r.status, 409)
  assert.equal(r.json.code, 'illegal_transition')
  assert.equal(r.json.current, 'handing_off')
  assert.equal(r.json.requested, 'handing_off')
  assert.deepEqual(r.json.allowed, ['ended'])
  assert.deepEqual(r.json.actions, ['end'])
  assert.equal(r.json.error, `session ${id} is handing off: Hand off now is not available now (it can: end)`)
  assert.equal(controlOf(id), null)
})

test('POST handoff and Approve while waiting answer 409; the request stays pending', async () => {
  const id = seed('waiting')
  const h = await api(`/api/sessions/${id}/handoff`, { method: 'POST' })
  assert.equal(h.status, 409)
  assert.equal(h.json.code, 'illegal_transition')
  assert.equal(h.json.current, 'waiting')
  assert.equal(controlOf(id), null)
  sessions.writeRequests(id, [{ by: 'sam', at: new Date().toISOString(), state: 'pending' }])
  const a = await api(`/api/sessions/${id}/requests/sam/approve`, { method: 'POST' })
  assert.equal(a.status, 409)
  assert.equal(a.json.code, 'illegal_transition')
  assert.equal(a.json.requested, 'handing_off')
  assert.equal(sessions.readRequests(id)[0].state, 'pending')
  assert.equal(controlOf(id), null)
  // and a running terminal still takes both
  const live = seed('running')
  assert.equal((await api(`/api/sessions/${live}/handoff`, { method: 'POST' })).status, 200)
  assert.equal(controlOf(live).handoff, true)
})

test('POST end while handing_off is accepted, and the leg boundary honors it', async () => {
  const id = seed('handing_off')
  const r = await api(`/api/sessions/${id}/end`, { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(controlOf(id).end, true)
  assert.deepEqual(legBoundary(id), { end: true })
  assert.equal(controlOf(id), null)
  assert.match(eventsOf(id).at(-1).summary, /the next leg was not started$/)
})

test('POST end-as-card while handing_off answers 409; on an ended terminal the sentence is still "not active"', async () => {
  const id = seed('handing_off')
  const r = await api(`/api/sessions/${id}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(r.status, 409)
  assert.equal(r.json.code, 'illegal_transition')
  assert.equal(r.json.current, 'handing_off')
  const gone = seed('ended')
  const g = await api(`/api/sessions/${gone}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(g.status, 409)
  assert.match(g.json.error, /not active/)
  assert.equal(g.json.code, 'illegal_transition')
})

test('GET rows carry actions; GET one session carries actions and allowed_next', async () => {
  const ids = ['running', 'handing_off', 'waiting', 'ended'].map((s) => seed(s))
  const view = await api('/api/sessions')
  assert.equal(view.status, 200)
  for (const id of ids) {
    const row = view.json.sessions.find((s) => s.session_id === id)
    assert.ok(row, id)
    assert.deepEqual(row.actions, sessionActions(row), `${id} row actions`)
    const one = await api(`/api/sessions/${id}`)
    assert.deepEqual(one.json.actions, sessionActions(one.json.session))
    assert.deepEqual(one.json.allowed_next, [...nextStates(one.json.session.status)])
  }
  assert.deepEqual(view.json.sessions.find((s) => s.session_id === ids[1]).actions, ['end'])
})

test('leg sessions handoff on a waiting terminal exits 3 with the sentence; show and ls --json carry the moves', () => {
  const env = testEnv(HOME)
  const id = seed('waiting')
  const r = legFail(['sessions', 'handoff', id], env)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /waiting for reset: Hand off now is not available/)
  assert.equal(controlOf(id), null)
  const sim = legFail(['sessions', 'simulate-limit', id], env)
  assert.equal(sim.status, 3)
  assert.match(sim.stderr, new RegExp(`session ${id} is already waiting`))
  const gone = seed('ended')
  const e = legFail(['sessions', 'end', gone], env)
  assert.equal(e.status, 3)
  assert.match(e.stderr, new RegExp(`session ${gone} is not active`))
  const show = JSON.parse(legFail(['sessions', 'show', id], env).stdout)
  assert.deepEqual(show.actions, ['end', 'end_as_card', 'edit_order'])
  assert.deepEqual(show.allowed_next, [...nextStates('waiting')])
  const list = JSON.parse(legFail(['sessions', 'ls', '--json'], env).stdout)
  const row = list.find((x) => x.session_id === id)
  assert.deepEqual(row.actions, show.actions)
  assert.deepEqual(row.allowed_next, show.allowed_next)
})

test('the board draws its session controls from the row\'s actions', () => {
  assert.equal(BOARD_SRC.includes('editableNow = ['), false, 'the inline editable list is gone')
  assert.match(BOARD_SRC, /const can = \(s, verb\) => \(s\.actions \|\| \[\]\)\.includes\(verb\)/)
  assert.match(BOARD_SRC, /if \(can\(s, 'handoff'\) && targets\.length\) \{/, 'the Hand off now to picker')
  assert.match(BOARD_SRC, /if \(can\(s, 'handoff'\)\) \{\n\s+const h = el\('button'/, 'Hand off now')
  assert.match(BOARD_SRC, /if \(can\(s, 'end'\)\) \{\n\s+const e = el\('button'/, 'End')
  assert.match(BOARD_SRC, /s\.repo && canCards\(\) && can\(s, 'end_as_card'\)/, 'End, and keep going as a card')
  assert.match(BOARD_SRC, /\} else if \(can\(s, 'remove'\)\) \{/, 'Remove')
  assert.match(BOARD_SRC, /if \(!s\.hidden && can\(s, 'edit_order'\)\) \{/, 'the ladder editor')
  assert.match(BOARD_SRC, /if \(can\(s, 'approve_request'\)\) \{\n\s+const ok = el\('button'/, 'Approve')
})
