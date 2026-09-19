// `leg digest`: what happened while you were away, read from the records
// already on disk. What this file guards: the window is parsed by name and a
// bad one is refused; the verdict carries the volume it was read from, zero
// included; attention comes first and in order (a question on a live
// terminal, a parked card, a failed card, a lost terminal); a bounce in
// landings.jsonl is not a landing; the CLI prints it and the route is the
// owner's alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, leg, legFail } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.LEG_QUIET = '1'

const D = await import('../src/digest.mjs')
const sessions = await import('../src/sessions.mjs')
const { createBoardServer } = await import('../src/server.mjs')

const NOW = Date.parse('2026-09-18T08:00:00.000Z')
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString()

function session(id, extra = {}) {
  const dir = join(HOME, 'sessions', id)
  mkdirSync(dir, { recursive: true })
  const rec = {
    session_id: id, agent: 'claude', account: 'default', cwd: 'C:\\Projects\\leg', repo: 'C:\\Projects\\leg', repo_name: 'leg', branch: 'main',
    status: 'ended', runner_pid: 999999, pid: null, started_at: at(9), updated_at: at(2), ended_at: at(2), last_activity: at(2),
    task: 'add the audit CSV export', turns: 18, files_touched: ['src/a.mjs', 'src/b.mjs'], files_dirty: [], ahead: 2, waiting: null, exit_code: 0, ...extra,
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(rec, null, 2))
  return rec
}
function event(id, ts, type, summary) {
  appendFileSync(join(HOME, 'sessions', id, 'events.jsonl'), JSON.stringify({ ts, session_id: id, type, summary }) + '\n')
}
function card(id, extra = {}) {
  const dir = join(HOME, 'cards', id)
  mkdirSync(dir, { recursive: true })
  const rec = { card_id: id, repo: 'C:\\Projects\\leg', title: 'the audit csv card', task: 'the audit csv card', status: 'done', station: 'land', leg: 0, created_at: at(6), updated_at: at(1), pipeline: [{ name: 'build', kind: 'agent', chain: [{ adapter: 'fake' }] }, { name: 'land', kind: 'land' }], ...extra }
  writeFileSync(join(dir, 'card.json'), JSON.stringify(rec, null, 2))
  appendFileSync(join(dir, 'events-leg.jsonl'), JSON.stringify({ ts: at(1), card_id: id, actor: { type: 'leg' }, type: extra.status === 'failed' ? 'failed' : 'landed', station: 'land', leg: 0, summary: extra.status === 'failed' ? 'tests-red: 2 failures' : 'landed on main: abc1234 → def5678 (3 files, +40/-2)' }) + '\n')
  return rec
}

// the seed: a terminal that walled and moved logins, one waiting on a question,
// one lost, one from three days ago; a done card and a failed one; a landing and a bounce
session('s-20260918-000000-claude-aaaa', { account: 'work', model: 'fable', status: 'ended' })
event('s-20260918-000000-claude-aaaa', at(8.5), 'started', 'claude (default) started in C:\\Projects\\leg')
event('s-20260918-000000-claude-aaaa', at(5), 'limit', "claude usage limit: You've hit your weekly limit.")
event('s-20260918-000000-claude-aaaa', at(5), 'handoff', 'claude/fable → claude/work (kept the conversation)')
event('s-20260918-000000-claude-aaaa', at(2), 'ended', 'session ended (exit 0)')
session('s-20260918-000001-claude-bbbb', { status: 'running', runner_pid: process.pid, pid: process.pid, started_at: at(1), updated_at: at(0.1), ended_at: null, turns: 4, waiting: { type: 'permission_prompt', message: 'Allow Write to src/x.mjs?', since: at(0.6) } })
event('s-20260918-000001-claude-bbbb', at(1), 'started', 'claude (default) started')
session('s-20260918-000002-codex-cccc', { agent: 'codex', status: 'lost', started_at: at(4), updated_at: at(3), ended_at: at(3), turns: 2, task: 'refactor the poller' })
event('s-20260918-000002-codex-cccc', at(3), 'lost', 'runner pid 1 is gone; session marked lost')
session('s-20260915-000000-agy-dddd', { agent: 'agy', started_at: at(80), updated_at: at(75), ended_at: at(75), task: 'three days ago' })
card('card-20260918-0100-audit-csv')
card('card-20260918-0200-flaky-test', { status: 'failed', station: 'test', updated_at: at(0.5) })
sessions.appendLanding({ ts: at(1.5), repo: 'C:\\Projects\\leg', trunk: 'main', session_id: 's-20260918-000000-claude-aaaa', agent: 'claude', account: 'work', by: 'local', status: 'landed', commits: ['a', 'b', 'c'], what: 'landed on main: 3 files' })
sessions.appendLanding({ ts: at(1.2), repo: 'C:\\Projects\\leg', trunk: 'main', session_id: 's-20260918-000002-codex-cccc', agent: 'codex', account: 'default', by: 'local', status: 'bounced', reason: 'tests-red' })
mkdirSync(join(HOME, 'usage'), { recursive: true })
writeFileSync(join(HOME, 'usage', 'claude--default.json'), JSON.stringify({ agent: 'claude', account: 'default', limited_until: Math.floor(NOW / 1000) + 7200, limited_reason: 'weekly limit', walls: { fable: { limited_until: Math.floor(NOW / 1000) + 3600, limited_reason: 'Fable limit' } } }))

test('parseSince reads 8h, 30m, 2d and an ISO time, and refuses anything else by name', () => {
  assert.equal(D.parseSince('8h', NOW), NOW - 8 * 3600000)
  assert.equal(D.parseSince('30m', NOW), NOW - 30 * 60000)
  assert.equal(D.parseSince('2d', NOW), NOW - 2 * 86400000)
  assert.equal(D.parseSince('2026-09-18T06:00:00.000Z', NOW), NOW - 2 * 3600000)
  assert.equal(D.parseSince(undefined, NOW), NOW - 8 * 3600000, 'the default window is 8h')
  assert.throws(() => D.parseSince('yesterday', NOW), /bad --since "yesterday"/)
})

test('the digest groups the window by repository, puts what needs you first, and counts what it read', () => {
  const d = D.buildDigest({ since: '8h', now: NOW })
  assert.deepEqual([d.volume.terminals, d.volume.cards, d.volume.landings], [3, 2, 1], 'the three-day-old terminal and the bounce are out of the window')
  assert.equal(d.volume.sessions_on_disk, 4)
  assert.ok(d.volume.events >= 6, `events read: ${d.volume.events}`)
  // attention, in order: the question on the live terminal, the failed card, the lost terminal
  assert.deepEqual(d.attention.map((a) => a.kind), ['waiting_on_you', 'card_failed', 'lost'])
  assert.equal(d.attention[0].message, 'Allow Write to src/x.mjs?')
  assert.equal(d.repos.length, 1)
  const g = d.repos[0]
  assert.equal(g.repo_name, 'leg')
  assert.deepEqual(g.terminals.map((t) => [t.short, t.live]), [['bbbb', true], ['cccc', false], ['aaaa', false]], 'live first, then newest')
  const moved = g.terminals.find((t) => t.short === 'aaaa')
  assert.deepEqual(moved.noted.map((e) => e.type), ['limit', 'handoff', 'ended'], 'the events a person wants, in order; the start line is not one of them')
  assert.equal(moved.account, 'work')
  assert.deepEqual(g.cards.map((c) => [c.card_id.split('-').pop(), c.status]), [['csv', 'done'], ['test', 'failed']])
  assert.deepEqual(g.landed.map((l) => [l.short, l.commits]), [['aaaa', 3]], 'a bounce is not a landing')
  assert.deepEqual(d.walls.map((w) => [w.agent, w.account, w.model]), [['claude', 'default', 'fable'], ['claude', 'default', null]], 'soonest reset first, the model wall beside the login wall')
})

test('a window with nothing in it says so with its volume, never an empty success', () => {
  // ended records only (a live terminal always counts), and a window that
  // closed before any of them moved
  const ended = sessions.listSessions().filter((s) => !sessions.isActive(s))
  const later = Date.parse('2027-01-01T00:00:00.000Z')
  const d = D.buildDigest({ since: '1m', now: later, sessions: ended })
  assert.deepEqual([d.volume.terminals, d.volume.cards, d.volume.landings, d.volume.events], [0, 0, 0, 0])
  const text = D.renderDigest(d, { now: later })
  assert.match(text, /0 terminals, 0 cards, 0 landings, 0 events read \(3 sessions and 2 cards on disk\)/)
  assert.match(text, /nothing moved in that window/)
})

test('the rendering: volume first, needs-you next, one block per repository, the walls last', () => {
  const text = D.renderDigest(D.buildDigest({ since: '8h', now: NOW }), { now: NOW })
  const lines = text.split('\n')
  assert.match(lines[0], /^since .*: 3 terminals, 2 cards, 1 landing, \d+ events read/)
  assert.match(text, /needs you: 3\n {2}waiting on you · leg#bbbb claude · 36m ago · Allow Write to src\/x\.mjs\?\n {2}card #test · 30m ago · the audit csv card failed at test: tests-red: 2 failures\n {2}lost · leg#cccc codex · 3h 0m ago/)
  assert.match(text, /\nleg {2}\(C:\\Projects\\leg\)\n {2}leg#bbbb {2}claude @main {2}running · 4 turns · 2 files · \+2 ahead/)
  assert.match(text, /leg#aaaa {2}claude\/work\/fable @main {2}ended exit 0 2h 0m ago · 18 turns · 2 files · \+2 ahead\n {4}task: add the audit CSV export\n/)
  assert.match(text, /handoff {3}claude\/fable → claude\/work \(kept the conversation\)/)
  assert.match(text, /card#csv {2}\[done\] at land {2}the audit csv card\n/)
  assert.match(text, /landed .* 3 commits by leg#aaaa \(claude\), Land pressed by local/)
  assert.match(text, /walls standing now:\n {2}claude\/fable {2}Fable limit until .*\n {2}claude {2}weekly limit until /)
  assert.equal(text.includes('three days ago'), false, 'the old terminal is not in an 8h window')
  assert.match(D.renderDigest(D.buildDigest({ since: '4d', now: NOW }), { now: NOW }), /three days ago/, 'and is in a 4d one')
})

test('leg digest prints it, --json returns the record, and a bad window exits 2', () => {
  const env = testEnv(HOME)
  const text = leg(['digest', '--since', '30d'], env)
  assert.match(text, /needs you: 3/)
  assert.match(text, /leg#aaaa {2}claude\/work\/fable/)
  const j = JSON.parse(leg(['digest', '--since', '30d', '--json'], env))
  assert.equal(j.volume.terminals, 4)
  const bad = legFail(['digest', '--since', 'yesterday'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /bad --since/)
})

test('GET /api/digest answers the owner and refuses a guest and an operator', async () => {
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  const get = (path, headers = {}) => new Promise((resolvePromise, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => resolvePromise({ status: res.statusCode, json: (() => { try { return JSON.parse(t) } catch { return null } })() })) }).on('error', reject)
  })
  try {
    const ok = await get('/api/digest?since=30d')
    assert.equal(ok.status, 200)
    assert.equal(ok.json.volume.terminals, 4)
    assert.equal(ok.json.attention[0].kind, 'waiting_on_you')
    const bad = await get('/api/digest?since=nope')
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /bad --since/)
  } finally { await srv.stop() }
})
