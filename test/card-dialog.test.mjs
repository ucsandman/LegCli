// The "who runs it" surfaces in src/board/board.js: the one-line entry row's
// ladder (redesign C.2) and the rebuilt New card dialog. There is no DOM here,
// so the IIFE is run with a stub document and read back through its `module`
// seam, the way test/cards-entry-row.test.mjs and test/board-updates.test.mjs
// do. The stub carries every id the dialog asks for, because
// `getElementById` handing back a fresh node per call would make every field
// in the dialog a different element from the one the submit handler reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountSharedScripts } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOARD_JS = readFileSync(join(ROOT, 'src/board/board.js'), 'utf8')
const INDEX_HTML = readFileSync(join(ROOT, 'src/board/index.html'), 'utf8')

const DIALOG_IDS = [
  'new-card-dialog', 'new-card-form', 'new-card-error', 'nc-repo', 'nc-repo-known', 'nc-task',
  'nc-test-adapter', 'nc-fallback-summary', 'nc-pipeline', 'nc-custom-pipeline', 'nc-chain-rows',
  'nc-add-row', 'nc-save-ladder', 'nc-leases', 'nc-trunk', 'nc-land-mode', 'nc-test-command',
  'nc-title', 'nc-queue', 'nc-cancel',
]

function fakeNode() {
  const n = {
    children: [], hidden: false, attrs: {}, className: '', value: '', checked: false, disabled: false, listeners: {},
    classList: { values: new Set(), add(...xs) { xs.forEach((x) => this.values.add(x)) }, remove(...xs) { xs.forEach((x) => this.values.delete(x)) }, contains(x) { return this.values.has(x) } },
    appendChild(c) { this.children.push(c); return c },
    append(...cs) { for (const c of cs) if (c !== null && c !== undefined) this.children.push(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c) },
    remove() {},
    reset() {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'disabled') this.disabled = true },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null }, showModal() {}, close() {}, select() {}, focus() {},
  }
  Object.defineProperty(n, 'firstChild', { get() { return this.children[0] || null } })
  Object.defineProperty(n, 'textContent', { get() { return this._text || this.children.map((c) => c.textContent || '').join(' ') }, set(v) { this._text = String(v); this.children = [] } })
  return n
}

function load(names, fetchImpl = async () => { throw new Error('no fetch in this test') }) {
  const els = new Map()
  for (const id of ['toast', 'board', 'card-entry', 'drawer', 'columns', 'empty-state', 'background', ...DIALOG_IDS]) els.set(id, fakeNode())
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
  return { ...mod.exports, els, doc }
}

const ADAPTERS = [
  { name: 'claude', fake: false, modes: { allowed: ['acceptEdits', 'plan'], default: 'acceptEdits' } },
  { name: 'codex', fake: false, modes: { allowed: ['read-only', 'workspace-write'], default: 'workspace-write' } },
  { name: 'agy', fake: false, modes: { allowed: ['auto-edit'], default: 'auto-edit' } },
  { name: 'fake', fake: true, modes: { allowed: ['auto'], default: 'auto' } },
]

const CATALOG = {
  claude: [{ id: 'fable', label: 'Claude Fable' }, { id: 'opus', label: 'Claude Opus' }, { id: 'sonnet', label: 'Claude Sonnet' }],
  codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', default: true }, { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }],
  agy: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }],
  grok: [],
}

const SESSIONS = [{ session_id: 's1', repo: 'C:/work/leg', repo_name: 'leg', branch: 'main', last_activity: new Date().toISOString() }]

function capture() {
  const sent = []
  const fetchImpl = async (path, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    sent.push({ path, method: (opts && opts.method) || 'GET', body })
    const answer = path === '/api/cards'
      ? { card: { card_id: 'c1', status: 'queued', title: 'x' } }
      : { preferences: { handoff_ladder: body ? body.handoff_ladder : [], handoff_order: ['claude', 'codex', 'agy'], may_spend: false } }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(answer) }
  }
  return { sent, fetchImpl }
}

// ---- the reported bug: "I'm not able to configure any agents" ---------------
// The entry row read `handoff_ladder` and nothing else, so an install whose
// preferences.json predates 0.12.0 (an ORDER and no ladder) showed an empty
// `with` select and the sentence "no agent is configured", with three agents
// installed and working.

test('an older preferences file with only handoff_order still names its agents', () => {
  const board = load(['entryUi', 'state'])
  board.state.adapters = ADAPTERS
  board.state.preferences = { handoff_order: ['codex', 'claude', 'agy'], may_spend: false }
  assert.deepEqual(board.entryUi.ladderRungs().map((r) => r.agent), ['codex', 'claude', 'agy'])
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'codex then claude then agy')
  // a derived rung names no model: the order never carried one, and inventing
  // one would start a leg on a model nobody chose
  assert.deepEqual(board.entryUi.entryChain().map((r) => r.model), [null, null, null])
})

test('no preferences at all still names the agents that are installed', () => {
  const board = load(['entryUi', 'state'])
  board.state.adapters = ADAPTERS
  board.state.preferences = null // /api/settings never answered
  // the scripted test adapter is never a rung: a ladder that hands off to a
  // script is not a fallback
  assert.deepEqual(board.entryUi.ladderRungs().map((r) => r.agent), ['claude', 'codex', 'agy'])
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'claude then codex then agy')
})

test('an empty ladder says which of its two causes it is', () => {
  const board = load(['entryUi', 'state'])
  // nothing installed and nothing saved: the original sentence, still true
  board.state.adapters = []
  board.state.preferences = null
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'no agent is configured')
  // everything installed bills and spending is off: a different fact, and
  // "no agent is configured" sent the reader to a settings page that was fine
  board.state.adapters = [{ name: 'grok', fake: false, modes: { allowed: [], default: '' } }]
  board.state.preferences = { handoff_ladder: [{ agent: 'grok', account: 'default', model: null, when: 'always', cost: 'metered' }], may_spend: false }
  assert.deepEqual(board.entryUi.ladderRungs(), [])
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'every agent here bills by the token, and spending is off')
})

// ---- the entry row's model pick --------------------------------------------

test('the model picked on the entry row reaches the chain it posts', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['entryUi', 'state'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  // start at codex, on gpt-5.6-luna: the pair of selects on the row, in order
  board.entryUi.entryState.ladderStart = 1
  board.entryUi.entryState.model = 'gpt-5.6-luna'
  board.entryUi.entryState.task = 'Port the invoice parser'
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'codex/gpt-5.6-luna')
  await board.entryUi.submitEntry()
  const card = sent.find((s) => s.path === '/api/cards')
  assert.deepEqual(card.body.chain, [{ adapter: 'codex', model: 'gpt-5.6-luna' }], `posted: ${JSON.stringify(card.body.chain)}`)
})

test('a model picked on the row that duplicates the rung below it is one leg, not two', () => {
  const board = load(['entryUi', 'state'])
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  board.entryUi.entryState.ladderStart = 0
  board.entryUi.entryState.model = 'opus' // the reader picked what rung 2 already was
  assert.equal(board.entryUi.ladderSentence(board.entryUi.entryChain()), 'claude/opus then codex')
})

// ---- the dialog -------------------------------------------------------------

test('the dialog opens prefilled with the ladder the entry row would have run', async () => {
  const board = load(['openNewCardDialog', 'newCardDialogEls', 'state', 'entryUi'])
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.repoTrunks = [{ repo: 'C:/work/leg', repo_name: 'leg', branch: 'develop', commits: [] }]
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: 'gpt-5.6-luna', when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  // one row per rung, in ladder order
  assert.equal(ui.chainRows.children.length, 2, 'the dialog drew one row per rung')
  // the repo and the branch the entry row inferred, not "main" and a blank box
  assert.equal(ui.repo.value, 'C:/work/leg')
  assert.equal(ui.trunk.value, 'develop')
  // and the summary says what the rows mean, in the order they are read
  assert.match(ui.fallbackSummary.textContent, /^Leg starts on claude\/fable, and tries codex\/gpt-5\.6-luna/)
})

test('a dialog with rungs claude/fable then codex/gpt-5.6-luna posts a chain with those models', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: 'gpt-5.6-luna', when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Port the invoice parser'
  ui.pipeline.value = 'build'
  ui.landMode.value = 'ff'
  ui.queue.checked = true
  await board.submitNewCard({ preventDefault() {} })

  const card = sent.find((s) => s.path === '/api/cards')
  assert.ok(card, `the dialog posted nothing: ${JSON.stringify(sent)}`)
  // one object per row, carrying that row's OWN model and permissions. The old
  // form was a comma list plus adapter-keyed strings, which could not tell two
  // claude rows apart at all.
  assert.deepEqual(card.body.chain, [
    { adapter: 'claude', model: 'fable', mode: 'acceptEdits' },
    { adapter: 'codex', model: 'gpt-5.6-luna', mode: 'workspace-write' },
  ], `posted: ${JSON.stringify(card.body.chain)}`)
  assert.equal(card.body.task, 'Port the invoice parser')
  assert.equal(card.body.repo, 'C:/work/leg')
  assert.equal(card.body.queue, true)
})

test('every field the dialog had before still posts', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = { handoff_order: ['claude'], may_spend: false }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Do the thing'
  ui.repo.value = 'C:/work/other'
  ui.trunk.value = 'develop'
  ui.pipeline.value = 'custom'
  ui.customPipeline.value = '[{"name":"build","kind":"agent"}]'
  ui.leases.value = 'src/**'
  ui.landMode.value = 'pr'
  ui.testCommand.value = 'npm test'
  ui.title.value = 'A title'
  ui.queue.checked = false
  await board.submitNewCard({ preventDefault() {} })
  const body = sent.find((s) => s.path === '/api/cards').body
  assert.equal(body.pipeline, '[{"name":"build","kind":"agent"}]')
  assert.equal(body.leases, 'src/**')
  assert.equal(body.trunk, 'develop')
  assert.equal(body.land_mode, 'pr')
  assert.equal(body.test_command, 'npm test')
  assert.equal(body.title, 'A title')
  assert.equal(body.queue, false)
})

test('the per-row max turns, approval and scripted behaviour go on their own row', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'sonnet', when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Do the thing'
  // the second claude row alone asks for approval and caps its turns: the old
  // adapter-keyed form would have applied both to every claude row
  const rows = ui.chainRows.children
  const toggle = (row, name) => row.children.find((c) => c.attrs['aria-label'] === name) || row.children.map((c) => c.children.find((g) => g && g.attrs && g.attrs['aria-label'] === name)).find(Boolean)
  const approve = toggle(rows[1], 'Ask before fallback 1 starts')
  assert.ok(approve, `no approval checkbox on row 2: ${rows[1].children.map((c) => c.attrs['aria-label']).join(', ')}`)
  approve.checked = true
  approve.listeners.change()
  const turns = rows[1].children.find((c) => c.attrs['aria-label'] === 'Max turns for fallback 1')
  turns.value = '12'
  turns.listeners.input()
  await board.submitNewCard({ preventDefault() {} })
  assert.deepEqual(sent.find((s) => s.path === '/api/cards').body.chain, [
    { adapter: 'claude', model: 'fable', mode: 'acceptEdits' },
    { adapter: 'claude', model: 'sonnet', mode: 'acceptEdits', maxTurns: 12, approve: true },
  ])
})

test('Save as my default ladder writes the rows back through /api/settings', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'codex', account: 'default', model: 'gpt-5.6-luna', when: 'always', cost: 'plan' },
      { agent: 'agy', account: 'default', model: 'gemini-3.8-flash-high', when: 'always', cost: 'free' },
    ],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Do the thing'
  ui.saveLadder.checked = true
  await board.submitNewCard({ preventDefault() {} })
  const patch = sent.find((s) => s.path === '/api/settings')
  assert.ok(patch, `nothing was written back: ${sent.map((s) => s.path).join(', ')}`)
  assert.equal(patch.method, 'PATCH')
  assert.deepEqual(patch.body.handoff_ladder, [
    { agent: 'codex', account: 'default', model: 'gpt-5.6-luna', when: 'always', cost: 'plan' },
    { agent: 'agy', account: 'default', model: 'gemini-3.8-flash-high', when: 'always', cost: 'free' },
  ], `patched: ${JSON.stringify(patch.body)}`)
  // and the card was posted first: a ladder that will not save is never a
  // reason to lose a card the human already asked for
  assert.ok(sent.findIndex((s) => s.path === '/api/cards') < sent.indexOf(patch))
})

test('the ladder is never saved with a scripted test adapter on it', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = { handoff_ladder: [{ agent: 'fake', account: 'default', model: null, when: 'always', cost: 'plan' }], may_spend: false }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Do the thing'
  ui.saveLadder.checked = true
  await board.submitNewCard({ preventDefault() {} })
  assert.equal(sent.some((s) => s.path === '/api/settings'), false, 'a fake adapter was sent as a rung')
})

// ---- source and markup ------------------------------------------------------

test('the dialog asks for the task before it asks for anything else', () => {
  const dialog = INDEX_HTML.slice(INDEX_HTML.indexOf('<dialog id="new-card-dialog"'), INDEX_HTML.indexOf('</dialog>'))
  const order = ['nc-task', 'nc-repo-known', 'nc-repo', 'nc-trunk', 'nc-chain-rows']
  let at = -1
  for (const id of order) {
    // the quoted form, so nc-repo-known is not what `nc-repo` finds first
    const next = dialog.indexOf(`id="${id}"`)
    assert.ok(next > at, `${id} is out of order in the dialog (found at ${next}, after ${at})`)
    at = next
  }
  // the task field takes the caret when the dialog opens
  assert.match(dialog, /<textarea id="nc-task"[^>]*autofocus/, 'the task field is not autofocused')
  // the two columns, and the breakpoint they collapse at
  assert.match(dialog, /class="dialog-cols"/)
  const css = readFileSync(join(ROOT, 'src/board/board.css'), 'utf8')
  assert.match(css, /@media \(min-width: 900px\)[\s\S]{0,400}\.dialog-cols \{ grid-template-columns:/, 'the two-column rule is not behind the 900px breakpoint')
})

test('the dialog no longer carries the fields the rows replaced', () => {
  for (const gone of ['nc-first-agent', 'nc-first-controls']) {
    assert.equal(INDEX_HTML.includes(gone), false, `${gone} is still in index.html`)
    assert.equal(BOARD_JS.includes(gone), false, `${gone} is still read by board.js`)
  }
})

// ---- the row and the dialog are one sentence --------------------------------
// More settings is the entry row with more fields, so every noun the row is
// already set to has to survive the trip. The workflow did not: the dialog
// opened on "build only" whatever the row said, and posted it.

test('More settings carries the workflow the entry row chose', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = { handoff_order: ['claude'], may_spend: false }
  board.entryUi.entryState.task = 'Port the invoice parser'
  board.entryUi.entryState.pipeline = 'factory'
  const ui = board.newCardDialogEls()
  // what form.reset() leaves behind in a browser: the option marked selected in
  // the markup, which is build. The stub's reset() is a no-op, so this is the
  // state the dialog really opens from.
  ui.pipeline.value = 'build'
  await board.openNewCardDialog()
  assert.equal(ui.pipeline.value, 'factory', 'the dialog opened on a different workflow than the row')
  assert.equal(ui.task.value, 'Port the invoice parser')
  await board.submitNewCard({ preventDefault() {} })
  assert.equal(sent.find((s) => s.path === '/api/cards').body.pipeline, 'factory')
})

test('creating a card from the dialog disarms the entry row', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = { handoff_order: ['claude'], may_spend: false }
  board.entryUi.entryState.task = 'Port the invoice parser'
  board.entryUi.entryState.editing = 'ladder'
  await board.openNewCardDialog()
  await board.submitNewCard({ preventDefault() {} })
  assert.equal(sent.filter((s) => s.path === '/api/cards').length, 1)
  // a row still reading the sentence it just sent is the next Start posting the
  // same card a second time
  assert.equal(board.entryUi.entryState.task, '', 'the entry row is still armed with the task the dialog sent')
  assert.equal(board.entryUi.entryState.editing, null)
})

// ---- the ladder the server will actually take -------------------------------

const CUSTOM_ADAPTERS = [
  { name: 'claude', fake: false, modes: { allowed: ['acceptEdits', 'plan'], default: 'acceptEdits' } },
  { name: 'mycli', fake: false, modes: { allowed: ['auto'], default: 'auto' } },
]

// the server's own answer, from src/preferences.mjs requireHandoffLadder: one
// rung it does not know refuses the whole array
function settingsFetch(sent) {
  return async (path, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    sent.push({ path, method: (opts && opts.method) || 'GET', body })
    if (path === '/api/cards') return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ card: { card_id: 'c1', status: 'queued', title: 'x' } }) }
    const rungs = (body && body.handoff_ladder) || []
    const bad = rungs.find((r) => !['claude', 'codex', 'agy', 'grok'].includes(r.agent))
    if (bad) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: `unknown agent "${bad.agent}" in handoff_ladder (claude, codex, agy, grok)` }) }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ preferences: { handoff_ladder: rungs, handoff_order: ['claude', 'codex', 'agy'], may_spend: false } }) }
  }
}

test('a custom adapter does not stop the rest of the ladder being saved', async () => {
  const sent = []
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], settingsFetch(sent))
  board.state.adapters = CUSTOM_ADAPTERS
  board.state.models = CATALOG
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'mycli', account: 'default', model: null, when: 'always', cost: 'plan' },
    ],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  ui.task.value = 'Do the thing'
  ui.saveLadder.checked = true
  await board.submitNewCard({ preventDefault() {} })
  const patch = sent.find((s) => s.path === '/api/settings' && s.method === 'PATCH')
  assert.ok(patch, `nothing was written back: ${sent.map((s) => s.path).join(', ')}`)
  // the rung the server can express is saved; the one it cannot is left off
  assert.deepEqual(patch.body.handoff_ladder, [
    { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
  ], `patched: ${JSON.stringify(patch.body)}`)
  const said = board.els.get('toast').textContent
  assert.match(said, /Saved as your default ladder/, `the save was refused: ${said}`)
  // and the row that did not make it is named
  assert.match(said, /mycli/, `the dropped rung was not named: ${said}`)
})

// ---- the model select names the model the card will run on ------------------

test('a model the catalog does not list is still shown on the row that posts it', async () => {
  const { sent, fetchImpl } = capture()
  const board = load(['openNewCardDialog', 'submitNewCard', 'newCardDialogEls', 'state', 'entryUi'], fetchImpl)
  board.state.adapters = ADAPTERS
  // agy's catalog is cached for an hour, and is empty on a fresh board
  board.state.models = { ...CATALOG, agy: [] }
  board.state.sessions = SESSIONS
  board.state.preferences = {
    handoff_ladder: [{ agent: 'agy', account: 'default', model: 'gemini-3.8-flash-high', when: 'always', cost: 'free' }],
    may_spend: false,
  }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  const row = ui.chainRows.children[0]
  const model = row.children.find((c) => c.attrs['aria-label'] === 'Model for the first agent')
  assert.ok(model, 'no model select on the first row')
  assert.equal(model.value, 'gemini-3.8-flash-high', `the select reads "${model.value}" while the card posts gemini-3.8-flash-high`)
  assert.ok(model.children.some((o) => o.value === 'gemini-3.8-flash-high'), `options: ${JSON.stringify(model.children.map((o) => o.textContent))}`)
  ui.task.value = 'Do the thing'
  await board.submitNewCard({ preventDefault() {} })
  assert.deepEqual(sent.find((s) => s.path === '/api/cards').body.chain, [{ adapter: 'agy', model: 'gemini-3.8-flash-high', mode: 'auto-edit' }])
})

// ---- moving a row keeps the keyboard on it ----------------------------------

test('Up and Remove keep the focus on the row that moved', async () => {
  const board = load(['openNewCardDialog', 'newCardDialogEls', 'state', 'entryUi'])
  board.state.adapters = ADAPTERS
  board.state.models = CATALOG
  board.state.preferences = { handoff_order: ['claude', 'codex', 'agy'], may_spend: false }
  await board.openNewCardDialog()
  const ui = board.newCardDialogEls()
  const focused = []
  board.doc.createElement = () => {
    const n = fakeNode()
    const orig = n.focus
    n.focus = function (...args) { focused.push(n); return orig.apply(n, args) }
    return n
  }
  const btn = (row, label) => row.children.find((c) => c.attrs['aria-label'] === label)
  const agents = () => ui.chainRows.children.map((r) => r.children[1].value)
  assert.deepEqual(agents(), ['claude', 'codex', 'agy'])

  btn(ui.chainRows.children[2], 'Move fallback 2 earlier').listeners.click()
  assert.deepEqual(agents(), ['claude', 'agy', 'codex'])
  assert.ok(focused.length, 'moving a row focused nothing: the button that was pressed is gone and focus fell to the body')
  assert.equal(focused[focused.length - 1].attrs['data-focus-key'], 'chain:1:up')

  btn(ui.chainRows.children[0], 'Remove the first agent').listeners.click()
  assert.deepEqual(agents(), ['agy', 'codex'])
  assert.equal(focused[focused.length - 1].attrs['data-focus-key'], 'chain:0:remove')
})
