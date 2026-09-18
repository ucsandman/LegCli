// The floor, rebuilt 2026-09-18: "the floor needs a UI overhaul and the ability
// to start tasks or cards from it" (Wes).
//
// Three things are checked here that nothing else can check:
//   1. the one-line entry row and the capacity strip exist ONCE, in the two
//      shared scripts, and both pages load them. A second copy of either is a
//      second Start button posting a different body, or a percentage that reads
//      two ways across two pages.
//   2. the floor's five stations are on the page, each with the count element
//      its heading prints and the empty line it shows instead of rows.
//   3. a queued row says where it is in the queue and what it waits for, in the
//      scheduler's own words.
//
// src/board/floor.js runs in the browser and the repo has no DOM harness, so it
// is loaded through the same `module` seam board-updates.test.mjs uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, mountSharedScripts } from './helpers.mjs'

const read = (name) => readFileSync(join(ROOT, 'src', 'board', name), 'utf8')
const FLOOR_JS = read('floor.js')
const FLOOR_HTML = read('floor.html')
const INDEX_HTML = read('index.html')
const BOARD_JS = read('board.js')
const SESSIONS_JS = read('sessions.js')
const ENTRY_JS = read('entry.js')
const STRIP_JS = read('strip.js')

// The stub is a real enough tree for the station renderer: a node knows whether
// it contains another (the row hold reads document.activeElement through it),
// insertBefore moves a node instead of cloning it, and focus() is recorded on
// the document the way a browser records it.
function node(tag = 'div', ctx = null) {
  const n = {
    tagName: tag, children: [], hidden: false, attrs: {}, className: '', value: '', listeners: {},
    classList: { values: new Set(), add(...xs) { xs.forEach((x) => this.values.add(x)) }, remove(...xs) { xs.forEach((x) => this.values.delete(x)) }, toggle(x, on) { if (on) this.values.add(x); else this.values.delete(x) }, contains(x) { return this.values.has(x) } },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c },
    insertBefore(c, ref) {
      this.children = this.children.filter((x) => x !== c)
      const at = ref ? this.children.indexOf(ref) : -1
      if (at < 0) this.children.push(c); else this.children.splice(at, 0, c)
      c.parentElement = this
      return c
    },
    removeChild(c) { this.children = this.children.filter((x) => x !== c) },
    remove() { if (this.parentElement) this.parentElement.removeChild(this) },
    contains(x) { return x === this || this.children.some((c) => (c.contains ? c.contains(x) : false)) },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null },
    focus() { if (ctx && ctx.doc) ctx.doc.activeElement = this },
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this._text !== undefined ? this._text : this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('') },
    set(v) { this._text = String(v); this.children = [] },
  })
  return n
}

// every element in one page's tree, so activeElement is one answer
function makeDoc() {
  const els = new Map()
  const ctx = {}
  const mk = (tag) => node(tag, ctx)
  const doc = {
    body: mk(), createElement: mk, createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: (id) => { if (!els.has(id)) els.set(id, mk()); return els.get(id) },
    querySelector: () => null, addEventListener() {}, activeElement: null, hidden: false,
  }
  ctx.doc = doc
  return { doc, els, mk }
}

const noFetch = async () => { throw new Error('no fetch in this test') }

// floor.js is one IIFE with a `module` seam at the bottom; a behaviour test
// needs the functions the seam does not name, so the export line is rewritten
// the way test/board-updates.test.mjs rewrites the board's.
function loadWith(names, fetchImpl) {
  const { doc, els, mk } = makeDoc()
  const localStorage = { value: '', getItem() { return this.value }, setItem(_, v) { this.value = v }, removeItem() { this.value = '' } }
  const mod = { exports: {} }
  const location = { host: 'x:1', href: 'http://x/' }
  const src = names ? FLOOR_JS.replace(/module\.exports = \{[^}]+\}/, `module.exports = { ${names.join(', ')} }`) : FLOOR_JS
  const win = mountSharedScripts(doc, localStorage)
  new Function('module', 'document', 'window', 'localStorage', 'location', 'fetch', 'EventSource', 'setTimeout', 'setInterval', src)(
    mod, doc, win, localStorage, location, fetchImpl || noFetch,
    class { addEventListener() {} close() {} }, () => 0, () => 0,
  )
  return { ...mod.exports, els, doc, location, mk }
}

function load() { return loadWith(null) }

const jsonResponse = (json) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(json) })
const refused = (status, error) => ({ ok: false, status, statusText: 'Forbidden', text: async () => JSON.stringify({ error }) })
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
function deepFind(root, pred) {
  if (!root) return null
  if (pred(root)) return root
  for (const child of root.children || []) { const hit = deepFind(child, pred); if (hit) return hit }
  return null
}

// ---- 1. one entry row, one capacity strip, both pages ----------------------

test('the entry row and the capacity strip are shared files, loaded by both pages', () => {
  for (const [name, html] of [['index.html', INDEX_HTML], ['floor.html', FLOOR_HTML]]) {
    for (const src of ['strip.js', 'entry.js']) {
      assert.match(html, new RegExp(`<script src="${src}" defer></script>`), `${name} loads ${src}`)
    }
    // deferred scripts run in document order, so the two shared ones must come
    // before the page script that calls into them at load
    const tag = (src) => html.indexOf(`<script src="${src}"`)
    const page = name === 'index.html' ? 'board.js' : 'floor.js'
    assert.ok(tag('strip.js') < tag(page), `${name}: strip.js is loaded before ${page}`)
    assert.ok(tag('entry.js') < tag(page), `${name}: entry.js is loaded before ${page}`)
  }
  assert.match(BOARD_JS, /window\.legEntry\.create\(/, 'the board mounts the shared entry row')
  assert.match(FLOOR_JS, /window\.legEntry\.create\(/, 'the floor mounts the shared entry row')
})

test('the strip is written once: only strip.js builds a token or a figure', () => {
  assert.match(STRIP_JS, /function capToken\(a\)/)
  assert.match(STRIP_JS, /function capFigure\(a, b\)/)
  assert.match(STRIP_JS, /function capacityStrip\(list\)/)
  for (const [name, src] of [['sessions.js', SESSIONS_JS], ['floor.js', FLOOR_JS], ['board.js', BOARD_JS]]) {
    for (const fn of ['capToken', 'capFigure', 'capValueText', 'capacityStrip', 'bindingOf']) {
      assert.doesNotMatch(src, new RegExp(`function ${fn}\\(`), `${name} must not define ${fn}: strip.js owns it`)
    }
  }
  // and both pages render it into the same box
  assert.match(SESSIONS_JS, /capacityStrip\(list\)/)
  assert.match(FLOOR_JS, /strip\(\)\.capacityStrip\(list\)/)
  for (const html of [INDEX_HTML, FLOOR_HTML]) {
    assert.match(html, /id="capacity-tokens"/)
    assert.match(html, /id="capacity-toggle"/)
    assert.match(html, /id="capacity-drawer"/)
  }
})

test('the entry row is written once: only entry.js builds it', () => {
  assert.match(ENTRY_JS, /function renderEntryLine\(\)/)
  assert.match(ENTRY_JS, /function submitEntry\(\)/)
  for (const [name, src] of [['board.js', BOARD_JS], ['floor.js', FLOOR_JS]]) {
    for (const fn of ['renderEntryLine', 'submitEntry', 'entryChain', 'ladderRungs']) {
      assert.doesNotMatch(src, new RegExp(`function ${fn}\\(`), `${name} must not define ${fn}: entry.js owns it`)
    }
  }
  // the floor has no dialog markup of its own: one copy, on the board, reached
  // with the sentence the reader typed
  assert.doesNotMatch(FLOOR_HTML, /<dialog/, 'the floor carries no second copy of the New card dialog')
  assert.match(FLOOR_JS, /#new-card=\$\{encodeURIComponent\(task\)\}/, 'More settings carries the task over to the board')
  assert.match(BOARD_JS, /hash\.startsWith\('new-card'\)/, 'the board opens the dialog from that hash')
  // the workflow noun the reader picked on the floor's row rides the same hash
  // (review finding 3, floor half): the floor emits it and the board reads it
  // back into the entry state the dialog opens from
  assert.match(FLOOR_JS, /&pipeline=\$\{encodeURIComponent\(entryState\.pipeline\)\}/, 'More settings carries the workflow over to the board')
  assert.match(BOARD_JS, /pipeline=\(\[a-z_-\]\+\)\$\//, 'the board parses the workflow out of the hash')
  assert.match(BOARD_JS, /if \(m\) entryState\.pipeline = m\[1\]/, 'and opens the dialog on it')
})

// ---- 2. the stations -------------------------------------------------------

test('the floor has the five stations, each with its count and its own rows box', () => {
  const floor = load()
  assert.deepEqual(floor.STATIONS.map((s) => s.key), ['running', 'waiting', 'queued', 'backlog', 'done'])
  for (const station of floor.STATIONS) {
    assert.match(FLOOR_HTML, new RegExp(`id="${station.head}"`), `floor.html has the ${station.key} heading`)
    assert.match(FLOOR_HTML, new RegExp(`id="${station.box}"`), `floor.html has the ${station.key} rows box`)
    assert.match(FLOOR_HTML, new RegExp(`id="${station.count}"`), `floor.html has the ${station.key} count`)
    assert.ok(station.empty.length > 20, `${station.key} has an empty line that says what puts something in it`)
  }
  // the headings a reader actually sees
  for (const word of ['Running', 'Waiting on you', 'Queued', 'Backlog', 'Done today']) {
    assert.ok(FLOOR_HTML.includes(`>${word} <span class="region-count"`), `floor.html heading: ${word}`)
  }
  // and the login panels are behind the disclosure, not above every row
  assert.ok(FLOOR_HTML.indexOf('id="capacity-drawer"') < FLOOR_HTML.indexOf('id="card-entry"'))
  assert.ok(FLOOR_HTML.indexOf('id="card-entry"') < FLOOR_HTML.indexOf('id="running-rows"'))
  assert.match(FLOOR_HTML, /<div class="drawer capacity-drawer" id="capacity-drawer" hidden>/)
})

test('a card lands in exactly one station, and Done today is today only', () => {
  const floor = load()
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
  const cards = [
    { card_id: 'a', status: 'running', updated_at: at(60000) },
    { card_id: 'b', status: 'handing_off', updated_at: at(30000) },
    { card_id: 'c', status: 'needs_approval', updated_at: at(120000) },
    { card_id: 'd', status: 'queued', updated_at: at(10000) },
    { card_id: 'e', status: 'backlog', updated_at: at(10000) },
    { card_id: 'f', status: 'done', updated_at: at(60000) },
    { card_id: 'g', status: 'done', updated_at: at(3 * 86400000) },
  ]
  const by = (key) => floor.stationCards(floor.STATIONS.find((s) => s.key === key), cards).map((c) => c.card_id)
  assert.deepEqual(by('running'), ['a', 'b'])
  assert.deepEqual(by('waiting'), ['c'])
  assert.deepEqual(by('queued'), ['d'])
  assert.deepEqual(by('backlog'), ['e'])
  // three days ago is not today, whatever the clock says
  assert.deepEqual(by('done'), ['f'])
})

// ---- 3. a queued row says where it is and what holds it --------------------

test('a queued row prints its position and the scheduler\'s own reason', () => {
  const floor = load()
  const card = { card_id: 'c2', status: 'queued' }
  // with no blocker on the payload the honest answer is the slot
  assert.equal(floor.waitingFor(card), 'waiting for a free slot')
  assert.equal(floor.queueNote(card, 1, 3), '2 of 3 in the queue, waiting for a free slot')
  assert.equal(floor.cardHref(card), '/#card=c2')
})

test('a card that is not in a run prints how long it has been idle, never a run clock', () => {
  const floor = load()
  const idle = floor.cardClock({ status: 'needs_approval', active_run: null, updated_at: new Date(Date.now() - 300000).toISOString() })
  assert.equal(idle, 'idle 5m', `between runs the clock said ${idle}`)
  assert.match(floor.cardClock({ status: 'running', active_run: { run: 1 }, elapsed_ms: 65000 }), /^01:0\d$/)
})

test('the floor keeps the keys the board answers on its rows, and types stay typing', () => {
  assert.match(FLOOR_JS, /e\.key === 'j'/)
  assert.match(FLOOR_JS, /e\.key === 'k'/)
  assert.match(FLOOR_JS, /e\.key === 'Enter'/)
  assert.match(FLOOR_JS, /\['input', 'textarea', 'select'\]\.includes\(tag\)/, 'typing a task is not steering')
})

// ---- 4. the row's four buttons -------------------------------------------
// Reassign is the one action whose POST carries a body: src/chain.mjs refuses
// it without an adapter, so a floor button that posted `{}` could only ever
// produce an error toast.

const ADAPTERS = [
  { name: 'claude', modes: { allowed: ['auto-edit', 'plan'], default: 'auto-edit' } },
  { name: 'codex', modes: { allowed: ['full-auto'], default: 'full-auto' } },
]
const FLOOR_PAYLOAD = { running: [], waiting: [], queued: [], leases: [], repos: [], scheduler: { running: true, max_concurrent: 2 } }

function runningCard(extra = {}) {
  return {
    card_id: 'c1', title: 'A card', status: 'running', station: 'build', station_kind: 'agent',
    repo_name: 'leg', runs_count: 1, updated_at: '2026-09-18T09:00:00.000Z', active_adapter: 'codex',
    last_event: { ts: '2026-09-18T09:00:01.000Z', type: 'log', summary: 'one' },
    actions: ['pause', 'handoff_now', 'reassign', 'kill'], ...extra,
  }
}

test('Reassign on a floor row collects an adapter before it posts (finding 7)', async () => {
  const posts = []
  const app = loadWith(['buildActions'], async (url, opts = {}) => {
    if ((opts.method || 'GET') !== 'GET') { posts.push({ url, body: opts.body ? JSON.parse(opts.body) : null }); return jsonResponse({ ok: true }) }
    if (String(url).startsWith('/api/adapters')) return jsonResponse({ adapters: ADAPTERS })
    if (String(url).startsWith('/api/cards')) return jsonResponse({ cards: [] })
    if (String(url).startsWith('/api/floor')) return jsonResponse(FLOOR_PAYLOAD)
    return jsonResponse({})
  })
  const card = runningCard()
  const wrap = app.buildActions(card)
  const button = wrap.children.find((b) => b.getAttribute('data-action') === 'reassign')
  assert.ok(button, 'the row still offers Reassign')

  button.listeners.click()
  await settle()
  assert.deepEqual(posts, [], 'pressing Reassign posts nothing on its own: it asks which adapter')

  const picker = wrap.children[0]
  assert.equal(picker.className, 'reassign-picker')
  const [adapterSelect, modeSelect, apply, cancel] = picker.children
  assert.deepEqual(adapterSelect.children.map((o) => o.getAttribute('value')), ['claude', 'codex'])
  assert.equal(adapterSelect.value, 'codex', 'the picker opens on the adapter the card is on')
  adapterSelect.value = 'claude'
  adapterSelect.listeners.change()
  assert.deepEqual(modeSelect.children.map((o) => o.getAttribute('value')), ['auto-edit', 'plan'])

  await apply.listeners.click()
  await settle()
  assert.equal(posts.length, 1, 'Apply posts once')
  assert.match(posts[0].url, /\/api\/cards\/c1\/reassign$/)
  assert.deepEqual(posts[0].body, { adapter: 'claude', mode: 'auto-edit' }, 'the body carries the adapter chain.mjs requires')
  assert.ok(wrap.children.some((b) => b.getAttribute && b.getAttribute('data-action') === 'kill'), 'the buttons come back after Apply')
  assert.ok(cancel, 'and Cancel is beside Apply')
})

test('Cancel on the reassign picker puts the row buttons back and posts nothing (finding 7)', async () => {
  const posts = []
  const app = loadWith(['buildActions'], async (url, opts = {}) => {
    if ((opts.method || 'GET') !== 'GET') { posts.push(url); return jsonResponse({ ok: true }) }
    return jsonResponse({ adapters: ADAPTERS })
  })
  const wrap = app.buildActions(runningCard())
  wrap.children.find((b) => b.getAttribute('data-action') === 'reassign').listeners.click()
  await settle()
  wrap.children[0].children[3].listeners.click()
  assert.deepEqual(posts, [])
  assert.deepEqual(wrap.children.map((b) => b.getAttribute('data-action')), ['pause', 'handoff_now', 'reassign', 'kill'])
})

// ---- 5. the station keeps updating around the row you are on --------------

test('focus in one row holds that row alone, for 30 seconds, and the station keeps repainting (finding 8)', () => {
  const app = loadWith(['renderStation', 'STATIONS'])
  const station = app.STATIONS.find((s) => s.key === 'running')
  const box = app.doc.getElementById(station.box)
  const alpha = runningCard({ card_id: 'a', title: 'Alpha' })
  const bravo = runningCard({ card_id: 'b', title: 'Bravo' })

  app.renderStation(station, [alpha, bravo])
  assert.equal(box.children.length, 2)
  const rowA = box.children[0]
  const kill = deepFind(rowA, (n) => n.getAttribute && n.getAttribute('data-action') === 'kill')
  assert.ok(kill, 'the row has a Kill button')
  kill.focus()
  assert.equal(app.doc.activeElement, kill)

  // the poll that lands while the button still has focus
  app.renderStation(station, [runningCard({ card_id: 'a', title: 'Alpha renamed' }), runningCard({ card_id: 'b', title: 'Bravo moved on' })])
  assert.equal(box.children[0], rowA, 'the row under the reader keeps its node')
  assert.doesNotMatch(rowA.textContent, /Alpha renamed/, 'and its words, so the press and any picker survive')
  assert.match(box.children[1].textContent, /Bravo moved on/, 'every other row in the station still repaints')
  assert.equal(app.doc.activeElement, kill, 'focus stays where the reader put it')
  assert.equal(box.signature, '', 'a held station is not marked caught up')

  // 30 seconds later the hold is over: a station can never stop for good
  box.heldAt = Date.now() - 31000
  app.renderStation(station, [runningCard({ card_id: 'a', title: 'Alpha renamed' }), runningCard({ card_id: 'b', title: 'Bravo moved on' })])
  assert.notEqual(box.children[0], rowA, 'the hold is bounded')
  assert.match(box.children[0].textContent, /Alpha renamed/)
})

// ---- 6. one 403 is not the whole floor ------------------------------------

test('a 403 from the trunk lane stands that table down, not the floor (finding 9)', async () => {
  const app = loadWith(['state', 'refreshTrunk', 'refreshFloor'], async (url) => {
    if (String(url).startsWith('/api/trunk') || String(url).startsWith('/api/floor')) {
      return refused(403, 'this is the map of the machine itself: every repository path and every conversation on it.')
    }
    return jsonResponse({})
  })
  const body = app.doc.getElementById('trunk-body')
  const table = app.mk()
  const section = app.mk()
  table.appendChild(body)
  section.appendChild(table)

  await app.refreshTrunk()
  assert.equal(app.state.stopped, false, 'an operator keeps the floor they are entitled to')
  assert.equal(app.state.trunkOff, true, 'and stops asking for the lane they are not')
  assert.equal(table.hidden, true, 'the trunk table goes')
  assert.match(section.textContent, /Trunk lane not shown: this is the map of the machine/, 'with a line saying whose it is')
  assert.notEqual(app.doc.getElementById('sse-text').textContent, 'stopped', 'the page is still live')

  // an endpoint the page cannot exist without still locks it out
  await app.refreshFloor()
  assert.equal(app.state.stopped, true)
  assert.equal(app.doc.getElementById('sse-text').textContent, 'stopped')
})

// ---- 7. Enter belongs to whatever has focus -------------------------------

test('Enter on a button or a link is that control\'s, never the ring\'s (finding 19)', () => {
  const app = loadWith(['state', 'floorKey'])
  app.state.cards.set('c1', { card_id: 'c1', title: 'A card' })
  app.state.ringId = 'c1'
  let prevented = 0
  const press = (target) => app.floorKey({ key: 'Enter', target, preventDefault() { prevented++ } })
  const control = { tagName: 'BUTTON', closest: (sel) => (/button|a,/.test(sel) ? control : null) }

  press(control)
  assert.equal(prevented, 0, 'the button keeps its own Enter')
  assert.equal(app.location.href, 'http://x/', 'and the page did not navigate to the ringed card')

  // Enter on the page itself still opens the ringed card
  press({ tagName: 'DIV', closest: () => null })
  assert.equal(prevented, 1)
  assert.equal(app.location.href, '/#card=c1')
})

// ---- 8. what a queued row is really waiting for ---------------------------

test('a queued row names the stopped scheduler instead of blaming a free slot (finding 24)', () => {
  const app = loadWith(['state', 'waitingFor', 'queueNote', 'renderHeader'])
  const card = { card_id: 'c2', status: 'queued' }
  assert.equal(app.waitingFor(card), 'waiting for a free slot', 'with nothing known, the slot is the honest answer')

  app.renderHeader({ repos: [], scheduler: { running: false, max_concurrent: 2 } })
  assert.equal(app.waitingFor(card), 'the scheduler is stopped')
  assert.equal(app.queueNote(card, 0, 1), '1 of 1 in the queue, the scheduler is stopped')

  app.renderHeader({ repos: [], scheduler: { running: true, max_concurrent: 2 } })
  assert.equal(app.waitingFor(card), 'waiting for a free slot')
  // the scheduler's own reason still wins over both
  app.state.blockers.set('c2', 'blocked by card "X" on src/**')
  assert.equal(app.waitingFor(card), 'blocked by card "X" on src/**')
})

test('the Backlog empty line names a control that is on the screen (finding 25)', () => {
  const floor = load()
  const backlog = floor.STATIONS.find((s) => s.key === 'backlog')
  assert.match(backlog.empty, /Run now unticked/, 'the label the dialog really carries')
  assert.doesNotMatch(backlog.empty, /queue box/, 'there is no control by that name')
  assert.match(INDEX_HTML, /id="nc-queue"[\s\S]{0,60}Run now/, 'and that is what index.html labels it')
})
