// board-keyboard: the ring, the keys that act on it, the two guards that stop a
// key acting on a row the reader cannot see, and the two reads that must not
// throw (localStorage, the browser toast).
//
// src/board/sessions.js runs in the browser and the repo has no DOM harness, so
// it is loaded through the same `module` seam board-verdict.test.mjs uses, with
// a stub document under it. This one is richer than that file's: it answers
// `#session-grid .term` with real rows carrying `data-session-id`, answers
// `dialog[open]`, and hands back the keydown listener the file registers, so
// every key here is pressed the way a reader presses it rather than by calling
// an internal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const SRC = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')

function node() {
  const n = {
    children: [], attrs: {}, className: '', listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    appendChild(c) { this.children.push(c); return c },
    addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null },
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this._text !== undefined ? this._text : this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('') },
    set(v) { this._text = String(v); this.children = [] },
  })
  return n
}

// one `.term` row: the four buttons the keyboard map presses, each recording
// its own click, plus the class the ring paints.
function row(id, { landDisabled = false } = {}) {
  const clicks = []
  const focused = []
  const classes = new Set()
  const button = (name, disabled) => ({ name, disabled, click() { clicks.push(name) }, focus() { focused.push(name) } })
  const buttons = {
    land: button('land', landDisabled), handoff: button('handoff', false),
    details: button('details', false), end: button('end', false),
  }
  return {
    id, clicks, focused, classes, buttons,
    classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), contains: (n) => classes.has(n) },
    getAttribute: (k) => (k === 'data-session-id' ? id : null),
    querySelector(sel) {
      const m = /^\[data-focus-key\^="(.+?):"\]$/.exec(sel)
      if (m) return buttons[m[1]] || null
      return buttons.land // the row's first control, which is what moveRing focuses
    },
  }
}

function load({ rows = [], dialogOpen = false, storage = 'ok' } = {}) {
  const state = { rows, dialogOpen, visible: true, focused: true }
  const doc = {
    listeners: {},
    createElement: () => node(),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => null,
    querySelector: (sel) => (sel === 'dialog[open]' ? (state.dialogOpen ? node() : null) : null),
    querySelectorAll: (sel) => (sel === '#session-grid .term' ? state.rows : []),
    addEventListener(k, fn) { this.listeners[k] = fn },
    body: node(),
    activeElement: null,
    hasFocus: () => state.focused,
    get visibilityState() { return state.visible ? 'visible' : 'hidden' },
    get hidden() { return !state.visible },
  }
  const store = new Map()
  const localStorage = storage === 'throws'
    ? { getItem() { throw new Error('access to storage is not allowed from this context') }, setItem() { throw new Error('access to storage is not allowed from this context') } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  const mod = { exports: {} }
  new Function('module', 'document', 'window', 'localStorage', 'setInterval', 'setTimeout', SRC)(
    mod, doc, { addEventListener() {} }, localStorage, () => 0, () => 0,
  )
  const press = (key, extra = {}) => doc.listeners.keydown({ key, preventDefault() {}, target: { tagName: 'BODY' }, ...extra })
  return { B: mod.exports, state, doc, press }
}

const clicksOf = (rows) => rows.map((r) => r.clicks.join(',')).join('|')

// ---- #13: the board renders with storage blocked -------------------------
test('getToken answers an empty string when localStorage throws', () => {
  const { B } = load({ storage: 'throws' })
  assert.equal(B.getToken(), '', 'a browser with site data blocked must not take every fetch down with it')
})

// ---- #12: no ring, no act ------------------------------------------------
test('with no ring set, the first letter key only sets the ring', () => {
  const rows = [row('s-a'), row('s-b')]
  const { press } = load({ rows })
  press('h')
  assert.equal(clicksOf(rows), '|', 'a key pressed before any ring exists must not act on the topmost row')
  assert.ok(rows[0].classes.has('is-focused'), 'the first press paints the ring so the reader can see what the next one will hit')
  press('h')
  assert.equal(clicksOf(rows), 'handoff|', 'the second press acts on the row the ring is on')
})

test('j sets the ring on the first row and announces it', () => {
  const rows = [row('s-a'), row('s-b')]
  const { press } = load({ rows })
  press('j')
  assert.ok(rows[0].classes.has('is-focused'))
  assert.deepEqual(rows[0].focused, ['land'], 'moving the ring moves focus so a screen reader says which terminal it landed on')
})

// ---- #9: a dialog, the map and a confirm row own the page ----------------
test('no key acts while a dialog is open', () => {
  const rows = [row('s-a'), row('s-b')]
  const { press, state } = load({ rows })
  press('j')
  press('j') // ring on s-b
  state.dialogOpen = true
  for (const k of ['h', 'l', 'd', 'e', 'j', 'k', '1']) press(k)
  assert.equal(clicksOf(rows), '|', 'the New card dialog is modal: keydown still reaches document, and nothing behind it may act')
  state.dialogOpen = false
  press('h')
  assert.equal(clicksOf(rows), '|handoff', 'and the keys come back when the dialog closes, on the row the ring was already on')
})

test('no key acts while the keyboard map is open, and ? still closes it', () => {
  const rows = [row('s-a')]
  const { press } = load({ rows })
  press('j')
  press('?')
  for (const k of ['h', 'l', 'd', 'e']) press(k)
  assert.equal(clicksOf(rows), '', 'the map explains the keys; reading it must not fire them')
  press('?')
  press('h')
  assert.equal(clicksOf(rows), 'handoff', 'closing the map hands the keys back')
})

test('h and e press a button that asks first, never act() directly', () => {
  assert.match(SRC, /h\.addEventListener\('click', ask\(/, 'Hand off now must route through the same confirm row End does: h clicks this button')
  assert.match(SRC, /e\.addEventListener\('click', ask\(/, 'End already asks')
  const keys = SRC.slice(SRC.indexOf('function boardKey'))
  assert.match(keys, /pendingConfirm/, 'a confirm row is an unanswered question: no key may act over it')
})

test('l stands down while Land is disabled', () => {
  const rows = [row('s-a', { landDisabled: true })]
  const { press } = load({ rows })
  press('j')
  press('l')
  assert.equal(clicksOf(rows), '', 'a disabled button is never clicked')
})

// ---- #11: the ring is a session id, not an index -------------------------
test('a re-sort keeps the ring on the same terminal', () => {
  const a = row('s-a'), b = row('s-b'), c = row('s-c')
  const { press, state, B } = load({ rows: [a, b, c] })
  press('j')
  press('j') // ring on s-b
  assert.ok(b.classes.has('is-focused'))
  // a Notification hook lands on C, so renderSessions sorts it first
  state.rows = [c, a, b]
  B.paintRing()
  assert.ok(b.classes.has('is-focused'), 'the ring belongs to a terminal, not to a position')
  assert.ok(!a.classes.has('is-focused'), 'the row that slid under the ring must not take it')
  press('e')
  assert.equal(clicksOf([a, b, c]), '|end|', 'and the key still ends the terminal the reader chose')
})

test('the ring is cleared when its terminal leaves the board', () => {
  const a = row('s-a'), b = row('s-b')
  const { press, state, B } = load({ rows: [a, b] })
  press('j')
  press('j') // ring on s-b
  state.rows = [a] // s-b ended and moved to the ledger
  B.paintRing()
  assert.equal(B.ringSession(), null, 'a ring on a terminal that is gone is a ring on nothing')
  press('e')
  assert.equal(clicksOf([a, b]), '|', 'so the next key only sets the ring again')
  assert.ok(a.classes.has('is-focused'))
})

// ---- #30: a toast for a state the reader did not just cause --------------
test('no browser notification while the reader is looking at the board', () => {
  const { B, state } = load({ rows: [] })
  const fired = []
  const prev = globalThis.Notification
  globalThis.Notification = function Note(title) { fired.push(title) }
  globalThis.Notification.permission = 'granted'
  try {
    const sess = (id) => ({ session_id: id, agent: 'claude', repo_name: 'leg', active: true, status: 'running', turns: 3 })
    B.announceWaiting([], { notify_board: true })
    B.announceWaiting([sess('s-20260917-0049-claude-7f3a')], { notify_board: true })
    assert.equal(fired.length, 0, 'the tab is visible and focused: the reader has already read the sentence on the row')
    state.focused = false
    B.announceWaiting([sess('s-20260917-0049-claude-7f3a'), sess('s-20260917-0050-claude-9c11')], { notify_board: true })
    assert.deepEqual(fired, ['leg#9c11 is waiting on you'], 'and it still fires for a transition the reader was away for')
  } finally {
    if (prev === undefined) delete globalThis.Notification; else globalThis.Notification = prev
  }
})
