// Step 6 of the board redesign: cards as work you can hand back and forth with
// a terminal. The routes live in src/server.mjs and none of them existed before
// this step, so they get a file of their own rather than a corner of
// server.test.mjs (routes) or cards.test.mjs (the headless CLI).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git, sleep } from './helpers.mjs'

// LEG_HOME must be set before the ledger and the store read it (once, at import).
const HOME = makeHome()
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
process.env.LEG_QUIET = '1'
process.env.BATON_QUIET = '1'
process.env.LEG_TRUST = 'never'
process.env.BATON_TRUST = 'never'

const { createBoardServer, parseShortstat, cardOutcomes, ladderFromCurrentRung } = await import('../src/server.mjs')
const sessions = await import('../src/sessions.mjs')
const { ensure: ensureWorktree } = await import('../src/worktree.mjs')
const { createCard } = await import('../src/cards.mjs')
const { readCard } = await import('../src/store.mjs')

let srv
let base
const repo = initRepo('reborn-')

before(async () => {
  srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  base = `http://127.0.0.1:${port}`
})
after(async () => { await srv.stop() })

async function api(path, { method = 'GET', body } = {}) {
  const res = await new Promise((resolvePromise, reject) => {
    const req = http.request(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => resolvePromise({ status: r.statusCode, text: data }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
  let json = null
  try { json = JSON.parse(res.text) } catch { /* a non-JSON body is the assertion's problem */ }
  return { ...res, json }
}

function terminal(id, extra = {}) {
  const wt = ensureWorktree(repo, id, { trunk: 'main' })
  sessions.createSession({ id, agent: 'claude', account: 'default', cwd: wt.path, repo, branch: wt.branch, runner_pid: process.pid, owner: 'wes' })
  sessions.updateSession(id, {
    status: 'running', task: 'Add the audit CSV export', turns: 3,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'credits' },
      { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
    ],
    ...extra,
  })
  return { wt }
}

// ---- the work stat (C.3) ---------------------------------------------------

test('a shortstat line parses into the parts it carries, and only those', () => {
  assert.deepEqual(parseShortstat(' 4 files changed, 212 insertions(+), 18 deletions(-)'), { files: 4, insertions: 212, deletions: 18 })
  // a diff that only adds carries no deletions clause: the key is absent, not zero
  assert.deepEqual(parseShortstat(' 1 file changed, 7 insertions(+)'), { files: 1, insertions: 7 })
  assert.deepEqual(parseShortstat(' 2 files changed, 9 deletions(-)'), { files: 2, deletions: 9 })
  // nothing measured is null, never an object of zeroes
  assert.equal(parseShortstat(''), null)
  assert.equal(parseShortstat('nothing to report'), null)
})

test('the test and land verdicts come off the card ledger, last one wins, and neither is invented', () => {
  assert.deepEqual(cardOutcomes([]), {})
  const evs = [
    { ts: '2026-09-17T10:00:00Z', type: 'status', summary: 'test red: npm test (exit 1)' },
    { ts: '2026-09-17T10:05:00Z', type: 'bounced', summary: 'land bounced (attempt 1) to build', body: 'rebase conflict' },
    { ts: '2026-09-17T11:00:00Z', type: 'status', summary: 'test green: npm test' },
  ]
  const out = cardOutcomes(evs)
  assert.deepEqual(out.tests, { state: 'green', at: '2026-09-17T11:00:00Z' })
  assert.deepEqual(out.land, { state: 'bounced', reason: 'rebase conflict', sha: null })
  const landed = cardOutcomes([{ ts: '2026-09-17T11:02:00Z', type: 'landed', summary: 'landed 7f3a2c1 on main' }])
  assert.deepEqual(landed.land, { state: 'landed', reason: null, sha: '7f3a2c1' })
})

test('a live card carries a measured work stat; a finished one carries none', async () => {
  const card = await createCard({ repo, task: 'measure me', chain: 'fake', queue: true }, { type: 'human', id: 'wes' })
  const wt = ensureWorktree(repo, card.card_id, { trunk: 'main' })
  writeFileSync(join(wt.path, 'added.txt'), 'one\ntwo\nthree\n')
  git(wt.path, ['add', 'added.txt'])
  git(wt.path, ['commit', '-q', '-m', 'work'])
  const { ledgerUpdate } = await import('../src/store.mjs')
  ledgerUpdate(card.card_id, { patch: { worktree: wt.path } })

  const live = await api('/api/cards')
  const mine = live.json.cards.find((c) => c.card_id === card.card_id)
  assert.equal(mine.status, 'queued', 'the card is live')
  assert.deepEqual(mine.work, { files: 1, insertions: 3 }, `work stat: ${JSON.stringify(mine.work)}`)
  assert.ok(!('tests' in mine), 'no test has run, so no test verdict is printed')
  assert.ok(!('land' in mine), 'no landing has happened, so no land verdict is printed')

  // the same card, finished: one line in the ledger is not worth a git subprocess
  const killed = await api(`/api/cards/${card.card_id}/kill`, { method: 'POST', body: {} })
  assert.equal(killed.status, 200)
  assert.equal(killed.json.card.status, 'killed')
  assert.ok(!('work' in killed.json.card), 'a finished card carries no work stat')
})

// ---- terminal to card (C.4) ------------------------------------------------

test('the ladder a card inherits starts at the rung the terminal is standing on', () => {
  const ladder = [
    { agent: 'claude', account: 'default', model: 'fable' },
    { agent: 'claude', account: 'default', model: 'opus' },
    { agent: 'codex', account: 'default', model: null },
  ]
  const rungs = ladderFromCurrentRung({ agent: 'claude', account: 'default', model: 'opus', handoff_ladder: ladder })
  assert.deepEqual(rungs.map((r) => `${r.agent}/${r.model ?? '-'}`), ['claude/opus', 'codex/-'])
  // a terminal on a model the ladder does not list falls back to its agent's
  // first rung rather than starting the card over at the top
  const byAgent = ladderFromCurrentRung({ agent: 'codex', account: 'default', model: 'gpt-5.6-sol', handoff_ladder: ladder })
  assert.deepEqual(byAgent.map((r) => r.agent), ['codex'])
})

test('end-as-card writes the bundle, keeps the terminal worktree, records the lineage, and ends the terminal', async () => {
  const id = 's-reborn-endas'
  const { wt } = terminal(id, { model: 'opus' })

  const r = await api(`/api/sessions/${id}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(r.status, 201, r.text.slice(0, 300))
  const cardId = r.json.card.card_id

  // the bundle: written at the path every hand-off uses, and named in the task
  assert.ok(r.json.bundle.path.includes('.context-handoffs'), r.json.bundle.path)
  assert.equal(existsSync(r.json.bundle.path), true, 'the bundle is on disk')
  const card = readCard(cardId)
  assert.match(card.task, /Add the audit CSV export/)
  assert.match(card.task, /Continue from the bundle at /)
  assert.ok(card.task.includes(r.json.bundle.path), 'the task names the bundle path')

  // the terminal's own worktree, adopted rather than cut again (G4)
  assert.equal(card.worktree, wt.path)
  assert.equal(card.worktree_adopted, true)
  assert.deepEqual(card.lineage, { from: id })

  // the chain starts at the rung the terminal was on
  assert.deepEqual(card.pipeline[0].chain.map((e) => e.adapter), ['claude', 'codex'])
  assert.equal(card.pipeline[0].chain[0].model, 'opus')
  assert.equal(card.status, 'queued', 'the card is queued, not left in the backlog')

  // the terminal ends the way End ends it: a control request the runner reads
  const control = JSON.parse(readFileSync(join(sessions.sessionDir(id), 'control.json'), 'utf8'))
  assert.equal(control.end, true)

  // an audit line on both sides, each carrying who did it
  const sevs = sessions.readEvents(id)
  const handed = sevs.find((e) => e.type === 'handed_off')
  assert.ok(handed, `no handed_off event: ${sevs.map((e) => e.type).join(', ')}`)
  assert.equal(handed.by, 'local')
  assert.ok(handed.summary.includes(cardId))
  assert.equal(sessions.readSession(id).lineage.to, cardId)
  const { auditTrail } = await import('../src/audit.mjs')
  const trail = auditTrail({ limit: 200 })
  const line = trail.entries.find((e) => e.what === 'handed_off' && e.id === id)
  assert.ok(line, `no handed_off line in the audit trail (scanned ${JSON.stringify(trail.scanned)}): ${trail.entries.map((e) => e.what).join(', ')}`)
  assert.equal(line.who, 'local')
  assert.equal(line.kind, 'human')
  assert.ok(trail.scanned.events > 0, `the audit read nothing: scanned ${JSON.stringify(trail.scanned)}`)
})

test('end-as-card refuses a terminal that is not active and leaves it alone', async () => {
  const id = 's-reborn-ended'
  terminal(id)
  sessions.updateSession(id, { status: 'ended', ended_at: new Date().toISOString() })
  const r = await api(`/api/sessions/${id}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(r.status, 409)
  assert.match(r.json.error, /not active/)
})

test('an adopted worktree is the one the card actually runs in: no second worktree is cut over it', async () => {
  // the shape end-as-card leaves behind: a checkout whose name is a terminal's,
  // not the card's, marked adopted
  const adopted = ensureWorktree(repo, 's-adopted-terminal', { trunk: 'main' })
  const card = await createCard({ repo, task: 'keep the checkout', chain: 'fake', queue: true }, { type: 'human', id: 'wes' })
  const { ledgerUpdate } = await import('../src/store.mjs')
  ledgerUpdate(card.card_id, { patch: { worktree: adopted.path, worktree_adopted: true } })

  const { runCard } = await import('../src/orchestrator.mjs')
  const final = await runCard(card.card_id)
  assert.equal(final.status, 'done', `card ended ${final.status}`)
  assert.equal(final.worktree, adopted.path, 'the card kept the terminal\'s checkout')
  // the fake adapter writes its file where it ran: that is the proof it ran there
  assert.equal(existsSync(join(adopted.path, 'hello-fake.txt')), true, 'the agent worked in the adopted checkout')
  assert.equal(existsSync(join(repo, '.leg-worktrees', card.card_id)), false, 'no second worktree was cut for the card')
})

// ---- card to terminal (C.4) ------------------------------------------------

test('take-over pauses the card and returns the one command that opens a terminal in its worktree', async () => {
  const card = await createCard({ repo, task: 'take me over', chain: 'claude', queue: true }, { type: 'human', id: 'wes' })
  // a queued card has no child to kill: the route still hands back the command
  const queued = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(queued.status, 200, queued.text.slice(0, 300))
  assert.equal(queued.json.command, `leg claude --resume-card ${card.card_id}`)

  // a running one is paused first, so nothing is working in that worktree when
  // the human sits down in it
  const { humanAction } = await import('../src/orchestrator.mjs')
  humanAction(card.card_id, 'start', {}, { type: 'human', id: 'wes' })
  assert.equal(readCard(card.card_id).status, 'running')
  const running = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(running.status, 200, running.text.slice(0, 300))
  assert.equal(running.json.card.status, 'paused')
  assert.equal(running.json.command, `leg claude --resume-card ${card.card_id}`)
  const evs = (await api(`/api/cards/${card.card_id}/events`)).json.events
  assert.ok(evs.some((e) => e.type === 'paused'), 'the pause is in the ledger with its actor')
})

test('take-over refuses a finished card rather than pretending there is something to take', async () => {
  const card = await createCard({ repo, task: 'already over', chain: 'claude' }, { type: 'human', id: 'wes' })
  const { humanAction } = await import('../src/orchestrator.mjs')
  humanAction(card.card_id, 'kill', {}, { type: 'human', id: 'wes' })
  const r = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(r.status, 409)
  assert.match(r.json.error, /nothing running to take over/)
})

// ---- the digest count the terminals verdict reads (C.5) --------------------

test('the sessions view carries how many cards are waiting on a human, and the count moves', async () => {
  const before = (await api('/api/sessions')).json
  assert.equal(typeof before.cards_waiting, 'number', 'cards_waiting is on the view')
  // a card whose first station is a human is waiting on a human the moment it
  // is queued: no agent has to run for the verdict to have something to say
  const card = await createCard({
    repo, task: 'waiting on you', chain: 'claude',
    pipeline: [{ name: 'review', kind: 'human' }], queue: true,
  }, { type: 'human', id: 'wes' })
  assert.equal(readCard(card.card_id).status, 'waiting_human')
  // the count is cached for a beat, so wait past the window rather than read a
  // number that was true before this card existed
  await sleep(5200)
  const after = (await api('/api/sessions')).json
  assert.equal(after.cards_waiting, before.cards_waiting + 1, `waiting went ${before.cards_waiting} to ${after.cards_waiting}`)
})
