// board-jump — "the page is hard to interact with while a terminal is running
// and the details are expanded, it keeps jumping around and knocking me out of
// what I'm doing" (Wes, 2026-09-18).
//
// Three mechanics answer that report, and this file pins all three: the order
// the terminals are drawn in while the reader is inside the list, the release
// once they come out, and the run of identical status lines that used to fill
// the timeline. The numbers behind them are measured in a real browser by
// scripts/board-jump-probe.mjs, which records where the expansion sits in the
// viewport across ten pushes; before the fix a row crossing the needs-you
// partition moved it 205px with scrollY unchanged, so no scroll-hold probe
// could see it.
//
// src/board/sessions.js runs in the browser and the repo has no DOM harness, so
// it is loaded through the same `module` seam board-keyboard.test.mjs uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const SRC = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')

function node() {
  const n = {
    children: [], attrs: {}, className: '',
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    appendChild(c) { this.children.push(c); return c },
    addEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    contains() { return false },
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this._text !== undefined ? this._text : '' },
    set(v) { this._text = String(v); this.children = [] },
  })
  return n
}

function load() {
  const doc = {
    listeners: {},
    createElement: () => node(),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(k, fn) { this.listeners[k] = fn },
    getSelection: () => ({ isCollapsed: true, toString: () => '', anchorNode: null }),
    body: node(),
    activeElement: null,
    hasFocus: () => true,
    get visibilityState() { return 'visible' },
    get hidden() { return false },
  }
  const mod = { exports: {} }
  const store = new Map()
  new Function('module', 'document', 'window', 'localStorage', 'setInterval', 'setTimeout', SRC)(
    // scrollBy is the page-level anchor's one instrument: anchorTop refuses to
    // measure anything in a window that cannot scroll, so a stub without it
    // would make every anchor assertion below pass on a null
    mod, doc, { addEventListener() {}, scrollBy() {} },
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    () => 0, () => 0,
  )
  return { B: mod.exports, doc }
}

const { B } = load()
const reasons = { expanded: false, selecting: false, hovering: false, focusInside: false, divergedForMs: 0 }

// ---- the order holds while the reader is inside the list -----------------
// Finding 6 (2026-09-18, second pass). This test used to assert the opposite:
// that an expansion holds the order for an hour and longer. That was the bug,
// not the contract. An expansion left open is the RESTING state of a dashboard,
// so an unbounded hold meant a terminal that hit a permission prompt went
// urgent, was counted by the tab badge, and never moved off the bottom of the
// list -- measured at 70s and still buried, and it only moved when the reader
// closed the expansion. The rule now: an expansion buys the same 30 seconds of
// stillness hovering and focus buy, and then the sort runs.
test('an expanded region holds the order, but not for the rest of the day', () => {
  assert.equal(B.holdsOrder({ ...reasons, expanded: true, divergedForMs: 1000 }), true,
    'the rows above an expansion hold still while the reader is reading it')
  assert.equal(B.holdsOrder({ ...reasons, expanded: true, divergedForMs: B.ORDER_HOLD_MS }), false,
    'a terminal waiting on the reader may not be buried under an expansion nobody has touched for half a minute')
  assert.equal(B.holdsOrder({ ...reasons, expanded: true, divergedForMs: 60 * 60 * 1000 }), false,
    'and certainly not for an hour')
})

test('a selection inside an open expansion still holds the order without a bound', () => {
  assert.equal(B.holdsOrder({ ...reasons, expanded: true, selecting: true, divergedForMs: 60 * 60 * 1000 }), true,
    'a drag really does die on a rebuild, and unlike an expansion it ends the moment the reader lets go')
})

test('the release under an open expansion is the sort itself, not the sort with the expanded row pinned', () => {
  // the reported case had the waiting terminal BELOW the expansion, so a rule
  // that pinned the expanded row to its slot would have left it exactly where
  // it was buried. What holds still is the expansion's offset in the VIEWPORT,
  // which holdAnchor restores after the rebuild; the probe asserts both halves.
  assert.deepEqual(B.listOrder(['s-c', 's-a', 's-b'], ['s-a', 's-b', 's-c'], false), ['s-c', 's-a', 's-b'],
    's-c has crossed into needs-you and takes the top, whichever row the expansion hangs under')
})

test('a live selection holds the order', () => {
  assert.equal(B.holdsOrder({ ...reasons, selecting: true, divergedForMs: 60 * 60 * 1000 }), true,
    'a rebuild clears a selection that spans it, so a drag in progress owns the list until it is let go')
})

test('a pointer on a row holds the order, but not for the rest of the day', () => {
  assert.equal(B.holdsOrder({ ...reasons, hovering: true, divergedForMs: 1000 }), true,
    'a click target must not slide out from under the pointer')
  assert.equal(B.holdsOrder({ ...reasons, hovering: true, divergedForMs: B.ORDER_HOLD_MS }), false,
    'a pointer resting on a row is a state that lasts until the machine is touched: an unbounded hold there would freeze the needs-you sort for good')
})

test('focus left on a button holds the order on the same terms', () => {
  assert.equal(B.holdsOrder({ ...reasons, focusInside: true, divergedForMs: 1000 }), true)
  assert.equal(B.holdsOrder({ ...reasons, focusInside: true, divergedForMs: B.ORDER_HOLD_MS + 1 }), false)
})

test('with the reader out of the list nothing is held', () => {
  assert.equal(B.holdsOrder({ ...reasons, divergedForMs: 5 }), false)
})

// ---- what holding actually draws ----------------------------------------
const NATURAL = ['s-c', 's-a', 's-b'] // s-c has just crossed into needs-you
const HELD = ['s-a', 's-b', 's-c']

test('the order held is the order that was on screen', () => {
  assert.deepEqual(B.listOrder(NATURAL, HELD, true), ['s-a', 's-b', 's-c'],
    'the sort says s-c is first now; the reader is mid-sentence in an expansion under s-a and the screen may not move')
})

test('the order is applied on the first render after the reader comes out', () => {
  assert.deepEqual(B.listOrder(NATURAL, HELD, false), NATURAL,
    'closing the expansion is the release: the needs-you row takes its place at the top')
})

test('a terminal that started while the order was held joins at the end', () => {
  assert.deepEqual(B.listOrder(['s-new', 's-c', 's-a', 's-b'], HELD, true), ['s-a', 's-b', 's-c', 's-new'],
    'a new row inserted above the reader would move everything they are looking at; at the end it moves nothing')
})

test('a terminal that left the board drops out of the held order', () => {
  assert.deepEqual(B.listOrder(['s-c', 's-a'], HELD, true), ['s-a', 's-c'])
})

test('with nothing held yet the sort is drawn as it is', () => {
  assert.deepEqual(B.listOrder(NATURAL, [], true), NATURAL)
})

test('a board nobody is touching holds nothing', () => {
  assert.equal(B.readerIsInTheList(), false,
    'no expansion, no pointer, no focus and no selection: the next render sorts')
})

// ---- the timeline: a repeated line is one fact, with its count -----------
const ev = (ts, summary, type = 'status') => ({ ts, type, summary })

test('a run of identical status lines inside a minute collapses to one line with its count', () => {
  const out = B.collapseEvents([
    ev('2026-09-18T10:00:00.000Z', 'started'),
    ev('2026-09-18T10:00:10.000Z', 'usage read: claude default, five_hour 38%'),
    ev('2026-09-18T10:00:20.000Z', 'usage read: claude default, five_hour 38%'),
    ev('2026-09-18T10:00:30.000Z', 'usage read: claude default, five_hour 38%'),
  ])
  assert.equal(out.length, 2, 'forty lines of the same usage poll push everything that happened off the top of the region')
  assert.equal(out[1].count, 3)
  assert.equal(out[1].last_ts, '2026-09-18T10:00:30.000Z', 'the line is stamped with the newest of the run, which is the one the reader is being told about')
  assert.equal(out[0].count, 1, 'a line that repeats nothing carries no count')
})

test('the same sentence more than a minute later is a second thing that happened', () => {
  const out = B.collapseEvents([
    ev('2026-09-18T10:00:00.000Z', 'usage read'),
    ev('2026-09-18T10:01:30.000Z', 'usage read'),
  ])
  assert.equal(out.length, 2, 'ninety seconds apart is not a repeat, it is a later reading')
})

test('only a run collapses: something in between makes two lines', () => {
  const out = B.collapseEvents([
    ev('2026-09-18T10:00:00.000Z', 'usage read'),
    ev('2026-09-18T10:00:10.000Z', 'turn 4 finished', 'turn'),
    ev('2026-09-18T10:00:20.000Z', 'usage read'),
  ])
  assert.deepEqual(out.map((e) => e.count), [1, 1, 1], 'two identical lines with a turn between them are two things, not one thing twice')
})

test('the same sentence under a different kind is a different line', () => {
  const out = B.collapseEvents([
    ev('2026-09-18T10:00:00.000Z', 'limit hit', 'status'),
    ev('2026-09-18T10:00:05.000Z', 'limit hit', 'limit'),
  ])
  assert.equal(out.length, 2)
})

test('an event with no timestamp is never folded into its neighbour', () => {
  const out = B.collapseEvents([ev(undefined, 'usage read'), ev(undefined, 'usage read')])
  assert.equal(out.length, 2, 'a gap that cannot be measured is not a gap under a minute')
})

test('collapseEvents does not mutate the record it was handed', () => {
  const raw = [ev('2026-09-18T10:00:00.000Z', 'usage read'), ev('2026-09-18T10:00:05.000Z', 'usage read')]
  B.collapseEvents(raw)
  assert.equal(raw[0].count, undefined, 'the detail payload is re-read on the next poll and is not this function\'s to write on')
})

// ---- the wiring, read as source -----------------------------------------
// These three are the render itself, which the stub DOM above cannot drive.
// scripts/board-jump-probe.mjs measures them in a browser; this is the guard
// that stops one of them being deleted between probe runs.
test('renderSessions draws the held order, not the sort', () => {
  const fn = SRC.slice(SRC.indexOf('function renderSessions'))
  assert.match(fn, /listOrder\(natural, heldOrder, readerIsInTheList\(\)\)/,
    'the sort still runs and still decides what the order WILL be; what is drawn is what listOrder returns')
  assert.match(fn, /heldOrder = order/, 'and what was drawn is what the next render holds')
})

test('the expansion is left where it is rather than moved through the body', () => {
  const fn = SRC.slice(SRC.indexOf('function renderSessions'))
  assert.match(fn, /const keep = region && region\.parentNode === grid/,
    'taking the region out of the document and putting it back clears any selection inside it, and this runs on every push')
  assert.doesNotMatch(fn, /grid\.textContent = ''/,
    'wiping the grid takes the region with it: the rows are removed one by one so the region can stay')
  assert.match(fn, /holdAnchor\(region, wasAt\)/,
    'and when the rows above it do change height, its offset in the viewport is put back')
})

test('the timed redraw of the region stands down for a selection and for a confirm row', () => {
  const fn = SRC.slice(SRC.indexOf('function renderDrawer'))
  assert.match(fn, /if \(drawerStandsDown\(\{/, 'the stand-down is one decision, made in one place, with a bound on it')
  assert.match(SRC, /loadDrawer\(\{ timed: true \}\)/, 'the 3-second poll is the timed caller')
  assert.match(SRC, /renderDrawer\(\{ timed: true \}\)/, 'and so is a push')
})

// ---- finding 5: the anchor is only for a region already in the list -------
test('a region still parked outside the list has no anchor to restore', () => {
  const grid = { id: 'session-grid' }
  const at = (top) => ({ hidden: false, getBoundingClientRect: () => ({ top }) })
  assert.equal(B.anchorFor({ parentNode: grid, ...at(120) }, grid), 120,
    'a region the reader has already placed in the list keeps its offset across a rebuild of the rows above it')
  assert.equal(B.anchorFor({ parentNode: { tagName: 'BODY' }, ...at(880) }, grid), null,
    '#session-drawer sits at the end of <body> until the render that opens it moves it into the grid: measured there and restored, it scrolled the page 403px on the single most common click on the board')
  assert.equal(B.anchorFor(null, grid), null, 'no region, no anchor')
  assert.equal(B.anchorFor({ parentNode: grid, ...at(120) }, null), null, 'no grid, nothing to be in')
})

test('renderSessions asks for the anchor by list membership, not by element', () => {
  const fn = SRC.slice(SRC.indexOf('function renderSessions'))
  assert.match(fn, /const wasAt = anchorFor\(region, grid\)/,
    'the anchor is a position the reader gave the region; a region that is not in the list yet never had one')
  assert.doesNotMatch(fn, /const wasAt = anchorTop\(region\)/,
    'measuring the parked region is what made Details jump the page')
})

// ---- finding 18: a forgotten selection may not freeze the region ----------
const standing = { timed: true, selecting: false, confirming: false, heldForMs: 0 }

test('the region stands down under a live selection, and only for twenty seconds', () => {
  assert.equal(B.drawerStandsDown({ ...standing, selecting: true, heldForMs: 0 }), true,
    'a reader dragging across a path must reach the end of the word')
  assert.equal(B.drawerStandsDown({ ...standing, selecting: true, heldForMs: B.DRAWER_HOLD_MS - 1 }), true)
  assert.equal(B.drawerStandsDown({ ...standing, selecting: true, heldForMs: B.DRAWER_HOLD_MS }), false,
    'a double-click leaves an uncollapsed selection behind and a reader who keeps reading never lets go: unbounded, twelve finished turns were never drawn in sixty seconds')
  assert.ok(B.DRAWER_HOLD_MS <= 60000, 'the reader must see new turns within a minute')
})

test('with no selection and no question the region redraws on every poll', () => {
  assert.equal(B.drawerStandsDown({ ...standing }), false)
})

test('a redraw the reader asked for never stands down', () => {
  assert.equal(B.drawerStandsDown({ timed: false, selecting: true, confirming: true, heldForMs: 0 }), false,
    'show 40 more, Resume updates and a rung moved are redraws the reader pressed for')
})

test('a confirm row is a question on one terminal, not a freeze on every region', () => {
  const fn = SRC.slice(SRC.indexOf('function renderDrawer'))
  assert.match(fn, /confirming: Boolean\(pendingConfirm && pendingConfirm\.id === drawer\.id\)/,
    'a Remove confirmation on an unrelated row used to stop this expansion updating too')
})

test('a timeline line carries the key its scroll is anchored by', () => {
  assert.match(SRC, /'data-event-key': `\$\{e\.ts\}\|\$\{e\.type\}`/,
    'the timeline is newest first, so a new line lands above the reader; the line at the top edge is what stays put')
  assert.match(SRC, /putTimelineAnchor\(box, onLine\)/)
})
