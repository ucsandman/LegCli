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
// the board polls the session record to know when the terminal a card adopted
// has stopped; a test should not wait half a second per look
process.env.LEG_END_AS_CARD_POLL_MS = '100'

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
  assert.equal(card.worktree_branch, wt.branch, 'the branch that checkout is really on, for the row to print')
  assert.deepEqual(card.lineage, { from: id })

  // the chain starts at the rung the terminal was on
  assert.deepEqual(card.pipeline[0].chain.map((e) => e.adapter), ['claude', 'codex'])
  assert.equal(card.pipeline[0].chain[0].model, 'opus')
  // the terminal is still live in that checkout: `end` is a request its runner
  // reads on its own poll, and the scheduler ticks every second, so the card
  // waits in the backlog rather than starting a second agent in there
  assert.equal(card.status, 'backlog', 'the card waits while the terminal it shares a checkout with is still running')
  const { pickRunnable, heldByLiveTerminal } = await import('../src/scheduler.mjs')
  const { listCards } = await import('../src/store.mjs')
  assert.equal(heldByLiveTerminal(card), id, 'and the scheduler knows which terminal holds it')
  assert.equal(pickRunnable(listCards(), { max: 10 }).start.some((c) => c.card_id === cardId), false, 'the scheduler would not start it')

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

test('the adopted card is queued the moment the terminal it shares a checkout with stops', async () => {
  const id = 's-reborn-waitsfor'
  terminal(id, { model: 'opus', task: 'Keep the invoice work going' })
  const r = await api(`/api/sessions/${id}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(r.status, 201, r.text.slice(0, 300))
  const cardId = r.json.card.card_id
  assert.equal(readCard(cardId).status, 'backlog')
  await sleep(400)
  assert.equal(readCard(cardId).status, 'backlog', 'the card stays put while the terminal is still live')
  // the runner has read control.json and stopped: the record is how the board
  // learns that, and the card goes in the moment it says so
  sessions.updateSession(id, { status: 'ended', ended_at: new Date().toISOString() })
  let status = readCard(cardId).status
  for (let i = 0; i < 60 && status !== 'queued'; i++) { await sleep(100); status = readCard(cardId).status }
  assert.equal(status, 'queued', 'the card was never queued after the terminal ended')
})

test('a terminal with no worktree of its own: the card gets a checkout of its own, with the uncommitted work in it', async () => {
  const id = 's-reborn-lone'
  // the ordinary case: one terminal in the repo itself, no worktree (attach
  // isolate() cuts one only when a second live session shares the checkout)
  sessions.createSession({ id, agent: 'claude', account: 'default', cwd: repo, repo, branch: 'main', runner_pid: process.pid, owner: 'wes' })
  sessions.updateSession(id, { status: 'running', task: 'Port the invoice parser', turns: 2, worktree: null })
  // what the human is looking at: one file git has never seen, and one edit to
  // a file it tracks
  writeFileSync(join(repo, 'work-in-progress.txt'), 'the half-finished work\n')
  writeFileSync(join(repo, 'README.md'), 'edited by the terminal\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'a tracked file to edit'])
  writeFileSync(join(repo, 'README.md'), 'edited by the terminal, and not committed\n')

  const r = await api(`/api/sessions/${id}/end-as-card`, { method: 'POST', body: {} })
  assert.equal(r.status, 201, r.text.slice(0, 300))
  const card = readCard(r.json.card.card_id)
  assert.equal(card.worktree_adopted, undefined, 'there was no worktree to adopt')
  assert.ok(card.worktree && card.worktree !== repo, `the card got a checkout of its own: ${card.worktree}`)
  assert.equal(card.worktree_branch, `leg/${card.card_id}`)
  assert.equal(card.status, 'queued', 'its checkout is its own, so nothing has to wait')
  // the whole point: the work the human was looking at is in there
  assert.equal(existsSync(join(card.worktree, 'work-in-progress.txt')), true, 'the untracked file was left behind')
  // git may check the file out with this machine's line endings, so compare the text
  assert.equal(readFileSync(join(card.worktree, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'edited by the terminal, and not committed\n', 'the uncommitted edit was left behind')
  assert.equal(r.json.carried.files >= 2, true, `the answer says what it carried: ${JSON.stringify(r.json.carried)}`)
  // and the terminal still has its own copy: nothing was moved out from under it
  assert.equal(existsSync(join(repo, 'work-in-progress.txt')), true)
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
  // a queued card has no child to kill, and the route still hands back the
  // command — but it leaves the card paused, so the scheduler cannot start a
  // leg in the worktree the human is about to open (see the next test)
  const queued = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(queued.status, 200, queued.text.slice(0, 300))
  assert.equal(queued.json.command, `leg claude --resume-card ${card.card_id}`)
  assert.equal(queued.json.card.status, 'paused')
  // a card that never ran has no checkout, and the command must never open
  // the human's main checkout under the card's name: the route cuts the
  // worktree before it hands the command back, and cardWorkRoot refuses the
  // repo fallback
  const { existsSync } = await import('node:fs')
  const { cardWorkRoot } = await import('../src/attach.mjs')
  const cut = readCard(card.card_id)
  assert.ok(cut.worktree && existsSync(cut.worktree), `take-over cut a worktree for a card that never ran: ${cut.worktree}`)
  assert.notEqual(cardWorkRoot(cut), repo, 'the terminal never opens in the main checkout')
  assert.equal(cardWorkRoot({ card_id: 'card-never', repo, worktree: null }), null, 'no checkout means no place to open, never the repo itself')

  // a running one is paused first, so nothing is working in that worktree when
  // the human sits down in it
  const { humanAction } = await import('../src/orchestrator.mjs')
  humanAction(card.card_id, 'resume', {}, { type: 'human', id: 'wes' })
  humanAction(card.card_id, 'start', {}, { type: 'human', id: 'wes' })
  assert.equal(readCard(card.card_id).status, 'running')
  const running = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(running.status, 200, running.text.slice(0, 300))
  assert.equal(running.json.card.status, 'paused')
  assert.equal(running.json.command, `leg claude --resume-card ${card.card_id}`)
  const evs = (await api(`/api/cards/${card.card_id}/events`)).json.events
  assert.ok(evs.some((e) => e.type === 'taken_over'), `the take-over is in the ledger with its actor: ${evs.map((e) => e.type).join(', ')}`)
})

test('take-over on a card the scheduler could still start leaves it out of the runnable set, with the actor on the line', async () => {
  const { pickRunnable } = await import('../src/scheduler.mjs')
  const { listCards } = await import('../src/store.mjs')
  const card = await createCard({ repo, task: 'queued when taken over', chain: 'claude', queue: true }, { type: 'human', id: 'wes' })
  assert.equal(readCard(card.card_id).status, 'queued', 'the card is in the set the scheduler starts from')
  const r = await api(`/api/cards/${card.card_id}/take-over`, { method: 'POST', body: {} })
  assert.equal(r.status, 200, r.text.slice(0, 300))
  assert.equal(r.json.command, `leg claude --resume-card ${card.card_id}`)
  // the whole point: one tick later the scheduler must not launch a leg into
  // the worktree the human was just handed
  assert.equal(readCard(card.card_id).status, 'paused', 'the card is out of the runnable set')
  assert.equal(r.json.card.status, 'paused', 'and the board is told so in the same answer')
  const runnable = pickRunnable(listCards(), { max: 10 }).start.map((c) => c.card_id)
  assert.equal(runnable.includes(card.card_id), false, `the scheduler would still start it: ${runnable.join(', ')}`)
  // who has the checkout is an audit question, so the line names them
  const evs = (await api(`/api/cards/${card.card_id}/events`)).json.events
  const took = evs.find((e) => e.type === 'taken_over')
  assert.ok(took, `no taken_over event: ${evs.map((e) => e.type).join(', ')}`)
  assert.equal(took.actor.id, 'local')
  assert.match(took.summary, /was queued/)
  const { auditTrail } = await import('../src/audit.mjs')
  const line = auditTrail({ limit: 200 }).entries.find((e) => e.what === 'taken_over' && e.id === card.card_id)
  assert.ok(line, 'the take-over is in the audit trail')
  assert.equal(line.who, 'local')
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

test('the sessions view carries the card that is waiting on a human, not just how many', async () => {
  const before = (await api('/api/sessions')).json
  assert.equal(typeof before.cards_waiting.count, 'number', 'cards_waiting carries a count')
  // a card whose first station is a human is waiting on a human the moment it
  // is queued: no agent has to run for the verdict to have something to say
  const card = await createCard({
    repo, task: 'waiting on you', chain: 'claude', title: 'Waiting on a human',
    pipeline: [{ name: 'review', kind: 'human' }], queue: true,
  }, { type: 'human', id: 'wes' })
  assert.equal(readCard(card.card_id).status, 'waiting_human')
  // the count is cached for a beat, so wait past the window rather than read a
  // number that was true before this card existed
  await sleep(5200)
  const after = (await api('/api/sessions')).json
  assert.equal(after.cards_waiting.count, before.cards_waiting.count + 1, `waiting went ${before.cards_waiting.count} to ${after.cards_waiting.count}`)
  // C.5's sentence is `card 3e1c has waited on you for 12 minutes.` with the
  // sub `It is at the review station.`: a count alone cannot write either half
  const first = after.cards_waiting.first
  assert.ok(first, 'the waiting card itself is on the view')
  // the shape src/board/sessions.js `waitingCard` reads
  assert.deepEqual(Object.keys(first).sort(), ['id', 'since', 'station', 'title'])
  assert.equal(first.id.startsWith('card-'), true, first.id)
  assert.equal(first.station, 'review', 'the station the sub-sentence names')
  assert.ok(Number.isFinite(Date.parse(first.since)), `since is a timestamp: ${first.since}`)
})

test('an operator runs the cards, so the waiting card reaches them; a guest gets nothing', async () => {
  const share = await import('../src/share.mjs')
  const tokens = { wes: share.newToken(), dana: share.newToken(), sam: share.newToken() }
  const roster = {
    version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: false,
    people: [['wes', 'owner'], ['dana', 'operator'], ['sam', 'guest']].map(([name, role]) => ({ name, role, token_sha256: share.hashToken(tokens[name]) })),
  }
  const shared = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster })
  const { port } = await shared.start()
  const at = `http://127.0.0.1:${port}`
  const get = (token) => new Promise((resolvePromise, reject) => {
    const req = http.request(`${at}/api/sessions`, { headers: { authorization: `Bearer ${token}` } }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => resolvePromise({ status: r.statusCode, json: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end()
  })
  try {
    const owner = await get(tokens.wes)
    assert.equal(owner.status, 200)
    assert.ok(owner.json.cards_waiting.count >= 1, 'the owner reads the waiting count')
    const operator = await get(tokens.dana)
    assert.equal(operator.status, 200)
    assert.equal('cards_waiting' in operator.json, true, 'an operator approves cards, so the verdict may name one on their board')
    assert.equal(operator.json.cards_waiting?.count, owner.json.cards_waiting.count, 'and reads the same waiting cards the owner does')
    assert.equal(operator.json.capacity, undefined, 'and still nothing that describes the machine')
    const guest = await get(tokens.sam)
    assert.equal(guest.status, 200)
    assert.equal('cards_waiting' in guest.json, false, 'a guest has no cards at all')
  } finally { await shared.stop() }
})
