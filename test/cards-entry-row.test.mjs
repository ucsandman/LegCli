// The background card's own surfaces in src/board/board.js: the one-line entry
// (redesign C.2) and the card row's register and clock (C.3). There is no DOM
// here, so the IIFE is run with a stub document and read back through its
// `module` seam, the way test/board-updates.test.mjs does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountSharedScripts } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOARD_JS = readFileSync(join(ROOT, 'src/board/board.js'), 'utf8')

function fakeNode() {
  const n = {
    children: [], hidden: false, attrs: {}, className: '', value: '', listeners: {},
    classList: { values: new Set(), add(...xs) { xs.forEach((x) => this.values.add(x)) }, remove(...xs) { xs.forEach((x) => this.values.delete(x)) }, contains(x) { return this.values.has(x) } },
    appendChild(c) { this.children.push(c); return c }, removeChild(c) { this.children = this.children.filter((x) => x !== c) }, remove() {},
    setAttribute(k, v) { this.attrs[k] = String(v) }, removeAttribute(k) { delete this.attrs[k] }, addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null }, showModal() {}, close() {}, select() {}, focus() {},
  }
  Object.defineProperty(n, 'firstChild', { get() { return this.children[0] || null } })
  Object.defineProperty(n, 'textContent', { get() { return this._text || this.children.map((c) => c.textContent || '').join('') }, set(v) { this._text = String(v); this.children = [] } })
  return n
}

function load(names, fetchImpl = async () => { throw new Error('no fetch in this test') }) {
  const els = new Map()
  for (const id of ['toast', 'board', 'card-entry', 'drawer', 'columns', 'empty-state', 'background']) els.set(id, fakeNode())
  const doc = { body: fakeNode(), createElement: fakeNode, createTextNode: (text) => ({ textContent: String(text) }), getElementById: (id) => els.get(id) || fakeNode(), querySelector: () => fakeNode(), addEventListener() {} }
  class EventSource { constructor(url) { this.url = url } addEventListener() {} close() {} }
  const localStorage = { value: '', getItem() { return this.value }, setItem(_, v) { this.value = v }, removeItem() { this.value = '' } }
  const mod = { exports: {} }
  const src = BOARD_JS.replace(/module\.exports = \{[^}]+\}/, `module.exports = { ${names.join(', ')} }`)
  // the two shared scripts the page loads before board.js: without them the
  // board has no entry row and no capacity strip to call into
  const win = mountSharedScripts(doc, localStorage)
  new Function('module', 'document', 'fetch', 'EventSource', 'localStorage', 'location', 'history', 'window', 'confirm', 'setTimeout', 'setInterval', src)(
    mod, doc, fetchImpl, EventSource, localStorage, { href: 'http://board/' }, { replaceState() {} }, win, () => true, () => 0, () => 0,
  )
  return { ...mod.exports, els, doc } // `els` is the stub DOM, not a board export
}

const LADDER = [
  { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'work', model: 'opus', when: 'always', cost: 'plan' },
  { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
]

// ---- C.2: the one-line entry posts what its sentence says ------------------

test('Start posts one leg per rung with its model, de-duplicated by adapter AND model', async () => {
  const sent = []
  const board = load(['entryUi', 'state'], async (path, opts) => {
    sent.push({ path, body: JSON.parse(opts.body) })
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ card: { card_id: 'c1', status: 'queued', title: 'x' } }) }
  })
  board.state.preferences = { handoff_ladder: LADDER, may_spend: false }
  board.state.sessions = [{ session_id: 's1', repo: 'C:/work/leg', repo_name: 'leg', branch: 'main', last_activity: new Date().toISOString() }]
  board.entryUi.entryState.task = 'Port the invoice parser'
  await board.entryUi.submitEntry()

  assert.equal(sent.length, 1, 'Start posted once')
  assert.equal(sent[0].path, '/api/cards')
  // the ladder's models reach the card: without them every leg runs whatever
  // the CLI defaults to, and the hand-off from leg 0 to leg 1 buys nothing
  assert.deepEqual(sent[0].body.chain, [
    { adapter: 'claude', model: 'fable' },
    { adapter: 'claude', model: 'opus' },
    { adapter: 'codex' },
  ], `chain posted: ${JSON.stringify(sent[0].body.chain)}`)
  // claude/opus on the `work` account is the same (adapter, model) as the rung
  // above it, so it is one leg, not two identical ones
  assert.equal(board.entryUi.entryChain().length, 3)
  // and the sentence over the field describes exactly that
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'claude/fable then claude/opus then codex')
})

test('Start sends the repo\'s own default branch, and the sentence names it', async () => {
  const sent = []
  const board = load(['entryUi', 'state'], async (path, opts) => {
    sent.push(JSON.parse(opts.body))
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ card: { card_id: 'c1', status: 'queued', title: 'x' } }) }
  })
  board.state.preferences = { handoff_ladder: LADDER, may_spend: false }
  board.state.sessions = [{ session_id: 's1', repo: 'C:/work/oldrepo', repo_name: 'oldrepo', branch: 'master', last_activity: new Date().toISOString() }]
  // what the server read for that repo: origin/HEAD, else main/master/trunk
  board.state.repoTrunks = [{ repo: 'C:/work/oldrepo', repo_name: 'oldrepo', branch: 'master', commits: [] }]
  assert.equal(board.entryUi.entryTrunk({ path: 'C:/work/oldrepo', name: 'oldrepo' }), 'master')
  board.entryUi.entryState.task = 'Port the invoice parser'
  await board.entryUi.submitEntry()
  assert.equal(sent[0].trunk, 'master', `a card posted with no trunk is refused in this repo: ${JSON.stringify(sent[0])}`)
  // the line the human reads before pressing Start
  board.entryUi.renderEntryLine()
  const line = board.els.get('card-entry').children.map((c) => c.textContent).join('')
  assert.match(line, / on master, with /, `the entry line says: ${line}`)
  assert.equal(/ on main, /.test(line), false, `the entry line still hardcodes main: ${line}`)
})

// ---- C.3: the row's register and its clock ---------------------------------

test('a card\'s row prints the branch its checkout is really on', () => {
  const board = load(['cardBranch'])
  // adopted from a terminal: the branch is the TERMINAL's, and no reader can
  // derive it from the card id
  assert.equal(board.cardBranch({
    card_id: 'card-20260917-2348-add-the-audit-csv-export-conti',
    worktree: 'C:/work/leg/.leg-worktrees/s-reborn-endas', worktree_adopted: true, worktree_branch: 'leg/s-reborn-endas',
  }), 'leg/s-reborn-endas')
  // its own checkout: the whole branch name, which git will match
  assert.equal(board.cardBranch({
    card_id: 'card-20260917-2348-add-the-audit-csv-export-conti',
    worktree: 'C:/work/leg/.leg-worktrees/card-20260917-2348-add-the-audit-csv-export-conti',
    worktree_branch: 'leg/card-20260917-2348-add-the-audit-csv-export-conti',
  }), 'leg/card-20260917-2348-add-the-audit-csv-export-conti')
  // a card that has not been cut a checkout yet is on the trunk it will branch from
  assert.equal(board.cardBranch({ card_id: 'card-20260917-2348-x', worktree: null, trunk: 'develop' }), 'develop')
})

test('the elapsed column on a live card between runs is labelled, and is not the card\'s age', () => {
  const board = load(['runElapsed'])
  const now = Date.now()
  // running: the run clock, exactly as a terminal row prints it
  assert.match(board.runElapsed({ runs_count: 1, active_run: { started_at: new Date(now - 65000).toISOString() } }), /^01:0\d$/)
  // never started: the placeholder
  assert.equal(board.runElapsed({ runs_count: 0, created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now).toISOString() }), '--:--')
  // live, between runs: a card created a day ago and stopped five minutes ago
  // must not print 24 hours in the column that means "this run"
  const between = board.runElapsed({
    runs_count: 1, active_run: null, status: 'needs_approval',
    created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 300000).toISOString(),
  })
  assert.equal(between, 'idle 5m', `between runs the column said ${between}`)
})
