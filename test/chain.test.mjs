import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transition, TRANSITIONS, IllegalTransition, availableActions, HUMAN_ACTIONS } from '../src/chain.mjs'
import { PRESETS } from '../src/presets.mjs'

const chain = [{ adapter: 'fake-claude' }, { adapter: 'fake-codex' }, { adapter: 'agy', approve: true }]
const pipe = (preset) => PRESETS[preset].map((s) => (s.kind === 'agent' ? { ...s, chain } : s))
const mk = (over = {}) => ({ card_id: 'c1', pipeline: pipe('factory'), station: 'build', leg: 0, status: 'running', land_attempts: 0, ...over })
const types = (r) => r.events.map((e) => e.type)

test('TRANSITIONS table (printed) covers every action the machine implements', (t) => {
  for (const [from, action, to, note] of TRANSITIONS) t.diagnostic(`| ${from.padEnd(16)} | ${action.padEnd(17)} | ${to.padEnd(15)} | ${note} |`)
  const actions = new Set(TRANSITIONS.map((r) => r[1]))
  for (const a of ['enqueue', 'start', 'bundle_written', 'pause', 'resume', 'kill', 'reassign', 'handoff_now', 'approve', 'rerun']) assert.ok(actions.has(a), a)
  assert.deepEqual(HUMAN_ACTIONS, ['pause', 'resume', 'kill', 'reassign', 'handoff_now', 'approve', 'rerun'])
})

test('enqueue: backlog → queued at the first station (waiting_human when it is a human station)', () => {
  const r = transition(mk({ status: 'backlog', station: '-' }), 'enqueue')
  assert.equal(r.card.status, 'queued')
  assert.equal(r.card.station, 'plan')
  const h = transition({ ...mk({ status: 'backlog', station: '-' }), pipeline: [{ name: 'gate', kind: 'human' }, ...pipe('build')] }, 'enqueue')
  assert.equal(h.card.status, 'waiting_human')
})

test('start: queued → running; a human station goes to waiting_human', () => {
  assert.equal(transition(mk({ status: 'queued' }), 'start').card.status, 'running')
  const h = transition({ ...mk({ status: 'queued', station: 'gate' }), pipeline: [{ name: 'gate', kind: 'human' }] }, 'start')
  assert.equal(h.card.status, 'waiting_human')
})

test('leg completed → station_done and next station queued; last station → done', () => {
  const r = transition(mk(), 'leg_result', { outcome: 'completed', adapter: 'fake-claude' })
  assert.equal(r.card.status, 'queued')
  assert.equal(r.card.station, 'review')
  assert.equal(r.card.leg, 0)
  assert.deepEqual(types(r), ['station_done'])
  const last = transition(mk({ pipeline: pipe('build') }), 'leg_result', { outcome: 'completed' })
  assert.equal(last.card.status, 'done')
  assert.deepEqual(types(last), ['station_done', 'done'])
  const human = transition({ ...mk({ pipeline: [...pipe('build'), { name: 'gate', kind: 'human' }] }) }, 'leg_result', { outcome: 'completed' })
  assert.equal(human.card.status, 'waiting_human')
})

test('leg handoff outcomes → handing_off with next_leg; chain exhausted → failed', () => {
  for (const outcome of ['limit', 'incomplete', 'no_progress', 'stalled', 'failed']) {
    const r = transition(mk(), 'leg_result', { outcome, signal: outcome === 'limit' ? 'claude-session-limit' : 'none' })
    assert.equal(r.card.status, 'handing_off', outcome)
    assert.equal(r.card.next_leg, 1)
    assert.equal(r.card.handoff_outcome, outcome)
  }
  const ex = transition(mk({ leg: 2 }), 'leg_result', { outcome: 'limit' })
  assert.equal(ex.card.status, 'failed')
  assert.deepEqual(types(ex), ['failed'])
  assert.match(ex.events[0].summary, /chain exhausted/)
})

test('auth_failed / launch_failed → failed without advancing; killed → killed', () => {
  for (const outcome of ['auth_failed', 'launch_failed']) {
    const r = transition(mk(), 'leg_result', { outcome })
    assert.equal(r.card.status, 'failed')
    assert.equal(r.card.leg, 0)
    assert.equal(r.card.failure, outcome)
  }
  assert.equal(transition(mk(), 'leg_result', { outcome: 'killed' }).card.status, 'killed')
  assert.throws(() => transition(mk(), 'leg_result', { outcome: 'weird' }), /unknown leg outcome/)
})

test('bundle_written → queued at leg+1, or needs_approval when the next entry has approve: true', () => {
  const q = transition(mk({ status: 'handing_off', next_leg: 1, handoff_outcome: 'limit' }), 'bundle_written')
  assert.equal(q.card.status, 'queued')
  assert.equal(q.card.leg, 1)
  assert.deepEqual(types(q), [])
  const a = transition(mk({ status: 'handing_off', leg: 1, next_leg: 2 }), 'bundle_written')
  assert.equal(a.card.status, 'needs_approval')
  assert.equal(a.card.leg, 2)
  assert.deepEqual(types(a), ['approval_needed'])
})

test('test station: green → next / done; red → bounce to the nearest earlier build (or first agent) with bounce_reason', () => {
  const g = transition(mk({ station: 'test' }), 'test_result', { green: true })
  assert.equal(g.card.station, 'land')
  assert.equal(g.card.status, 'queued')
  const r = transition(mk({ station: 'test' }), 'test_result', { green: false, reason: '2 failing' })
  assert.equal(r.card.station, 'build')
  assert.equal(r.card.status, 'queued')
  assert.equal(r.card.bounce_reason, '2 failing')
  assert.deepEqual(types(r), ['bounced'])
  const noBuild = transition({ ...mk({ station: 'test' }), pipeline: [{ name: 'plan', kind: 'agent', chain }, { name: 'test', kind: 'test' }] }, 'test_result', { green: false })
  assert.equal(noBuild.card.station, 'plan')
})

test('land station: landed → done; bounced → build with land_attempts; third bounce → failed', () => {
  const ok = transition(mk({ station: 'land' }), 'land_result', { landed: true })
  assert.equal(ok.card.status, 'done')
  assert.deepEqual(types(ok), ['landed', 'station_done', 'done'])
  const b = transition(mk({ station: 'land' }), 'land_result', { bounced: true, reason: 'conflict' })
  assert.equal(b.card.station, 'build')
  assert.equal(b.card.land_attempts, 1)
  assert.deepEqual(types(b), ['bounced'])
  const f = transition(mk({ station: 'land', land_attempts: 2 }), 'land_result', { bounced: true, reason: 'red' })
  assert.equal(f.card.status, 'failed')
  assert.equal(f.card.land_attempts, 3)
})

test('human actions: pause, resume, kill, reassign, handoff_now, approve, rerun', () => {
  const p = transition(mk(), 'pause')
  assert.equal(p.card.status, 'paused')
  const r = transition(p.card, 'resume')
  assert.equal(r.card.status, 'queued')
  assert.equal(r.card.resume_from_bundle, true)
  for (const st of ['queued', 'running', 'handing_off', 'waiting_human', 'needs_approval', 'paused', 'backlog']) {
    assert.equal(transition(mk({ status: st }), 'kill').card.status, 'killed', st)
  }
  const re = transition(mk({ leg: 1 }), 'reassign', { adapter: 'agy', mode: 'plan' })
  assert.equal(re.card.status, 'queued')
  assert.deepEqual(re.card.pipeline.find((s) => s.name === 'build').chain[1], { adapter: 'agy', mode: 'plan' })
  assert.equal(re.card.kill_requested, true)
  assert.throws(() => transition(mk(), 'reassign', {}), /needs an adapter/)
  const h = transition(mk(), 'handoff_now')
  assert.equal(h.card.status, 'handing_off')
  assert.equal(h.card.next_leg, 1)
  const ap = transition(mk({ status: 'needs_approval', leg: 2 }), 'approve')
  assert.equal(ap.card.status, 'queued')
  assert.deepEqual(types(ap), ['approved'])
  const wh = transition({ ...mk({ status: 'waiting_human', station: 'gate' }), pipeline: [{ name: 'gate', kind: 'human' }, ...pipe('build')] }, 'approve')
  assert.equal(wh.card.station, 'build')
  assert.equal(wh.card.status, 'queued')
  for (const st of ['done', 'failed', 'killed']) {
    const rr = transition(mk({ status: st, station: 'land', leg: 2, land_attempts: 2, bounce_reason: 'x' }), 'rerun')
    assert.equal(rr.card.status, 'queued')
    assert.equal(rr.card.station, 'plan')
    assert.equal(rr.card.leg, 0)
    assert.equal(rr.card.land_attempts, 0)
    assert.equal(rr.card.bounce_reason, null)
  }
})

test('illegal transitions throw IllegalTransition naming from and action', () => {
  const cases = [
    [mk({ status: 'done' }), 'pause'], [mk({ status: 'queued' }), 'resume'], [mk({ status: 'running' }), 'approve'],
    [mk({ status: 'running' }), 'rerun'], [mk({ status: 'backlog' }), 'start'], [mk({ status: 'queued' }), 'leg_result'],
    [mk({ status: 'running', station: 'test' }), 'leg_result'], [mk({ status: 'done' }), 'kill'], [mk({ leg: 2 }), 'handoff_now'],
    [mk({ status: 'queued' }), 'bundle_written'],
  ]
  for (const [card, action] of cases) {
    assert.throws(() => transition(card, action, { outcome: 'completed' }), (err) => err instanceof IllegalTransition && new RegExp(`illegal transition ${card.status} --${action}-->`).test(err.message), `${card.status} --${action}`)
  }
  assert.throws(() => transition(mk(), 'frobnicate'), /unknown action/)
})

test('availableActions offers only sensible buttons per status', () => {
  assert.deepEqual(availableActions(mk()), ['pause', 'handoff_now', 'kill', 'reassign'])
  assert.deepEqual(availableActions(mk({ status: 'paused' })), ['resume', 'kill', 'reassign'])
  assert.deepEqual(availableActions(mk({ status: 'needs_approval' })), ['approve', 'kill', 'reassign'])
  assert.deepEqual(availableActions(mk({ status: 'done' })), ['rerun'])
  assert.deepEqual(availableActions(mk({ status: 'backlog' })), ['kill', 'reassign', 'enqueue'])
})

test('Hand off now is offered only when the chain has a next leg (the transition refuses it otherwise)', () => {
  assert.ok(availableActions(mk({ leg: 1 })).includes('handoff_now'))
  assert.ok(!availableActions(mk({ leg: 2 })).includes('handoff_now'), 'last leg of the chain')
  const single = { ...mk(), pipeline: pipe('build').map((s) => ({ ...s, chain: [{ adapter: 'fake-claude' }] })) }
  assert.ok(!availableActions(single).includes('handoff_now'), 'a one-entry chain never has a next leg')
  assert.ok(!availableActions(mk({ station: 'test' })).includes('handoff_now'), 'a test station has no chain')
})

test('land bounced with no agent station to bounce to fails the card instead of throwing', () => {
  const card = { ...mk({ station: 'land' }), pipeline: [{ name: 'test', kind: 'test' }, { name: 'land', kind: 'land' }] }
  const r = transition(card, 'land_result', { bounced: true, reason: 'rebase-conflict' })
  assert.equal(r.card.status, 'failed')
  assert.equal(r.card.failure, 'land')
  assert.deepEqual(types(r), ['failed'])
})

test('a red test never bounces forward: an agent station after the test is not a target', () => {
  const card = { ...mk({ station: 'test' }), pipeline: [{ name: 'test', kind: 'test' }, { name: 'fix', kind: 'agent', chain }] }
  const r = transition(card, 'test_result', { green: false, reason: '1 failing' })
  assert.equal(r.card.status, 'failed')
  assert.match(r.events[0].summary, /no agent station to bounce to/)
})
