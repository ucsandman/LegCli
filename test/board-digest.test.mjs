// The digest on the board: what happened while you were away, drawn above
// Terminals from /api/digest (src/digest.mjs, the record `leg digest` prints).
//
// What this file guards, state by state: a refusal (403, a guest or an
// operator on a shared board) leaves nothing on the page; a window where
// nothing moved is one line that still says how much it read; a busy window
// prints its volume and what needs a person, most urgent first, with the lost
// terminals said once as one line; "Hide for today" keeps the panel closed for
// the rest of the calendar day and skips the read entirely; a tab left open
// asks again when it comes back into view with a read more than 30 minutes
// old, or on a new calendar day, and never on a timer.
//
// src/board/digest.js runs in the browser and the repo has no DOM harness, so
// it is run here against a stub document, the way test/floor-page.test.mjs
// runs floor.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const read = (name) => readFileSync(join(ROOT, 'src', 'board', name), 'utf8')
const DIGEST_JS = read('digest.js')
const INDEX_HTML = read('index.html')

function node(tag = 'div') {
  const n = {
    tagName: tag, children: [], hidden: false, attrs: {}, className: '', listeners: {},
    classList: { values: new Set(), add(...xs) { xs.forEach((x) => this.values.add(x)) }, remove(...xs) { xs.forEach((x) => this.values.delete(x)) }, toggle(x, on) { if (on) this.values.add(x); else this.values.delete(x) }, contains(x) { return this.values.has(x) } },
    appendChild(c) { this.children.push(c); return c },
    replaceChildren(...cs) { this.children = cs; this._text = undefined },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    addEventListener(k, fn) { this.listeners[k] = fn },
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this._text !== undefined ? this._text : this.children.map((c) => c.textContent ?? '').join('') },
    set(v) { this._text = String(v); this.children = [] },
  })
  return n
}

// A clock the page can be moved along: the script's Date is this one, so a tab
// left open for hours is `advance`, not a sleep.
function clock() {
  let offset = 0
  class PageDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(Date.now() + offset) }
    static now() { return Date.now() + offset }
  }
  return { Date: PageDate, advance(ms) { offset += ms } }
}

// index.html ships the section hidden; the stub starts it the same way
function load({ respond, hiddenFor = '' } = {}) {
  const els = new Map()
  const docListeners = {}
  const doc = {
    visibilityState: 'visible',
    addEventListener: (k, fn) => { docListeners[k] = fn },
    createElement: (t) => node(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: (id) => { if (!els.has(id)) { const n = node(); if (id === 'digest') n.hidden = true; els.set(id, n) } return els.get(id) },
  }
  const store = new Map(hiddenFor ? [['legDigestHidden', hiddenFor]] : [])
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return respond(url, calls.length) }
  const time = clock()
  new Function('document', 'localStorage', 'fetch', 'Date', DIGEST_JS)(doc, localStorage, fetchImpl, time.Date)
  // the tab going to the background and coming back, as the browser reports it
  const show = (state = 'visible') => { doc.visibilityState = state; docListeners.visibilitychange?.() }
  return { el: (id) => doc.getElementById(id), calls, store, advance: time.advance, show }
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: status === 403 ? 'Forbidden' : 'OK', json: async () => body })
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString()
function todayPlus(ms) {
  const d = new Date(Date.now() + ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const today = () => todayPlus(0)

const QUIET = {
  since: at(8), until: at(0),
  volume: { terminals: 0, cards: 0, landings: 0, events: 0, sessions_on_disk: 12, cards_on_disk: 3 },
  attention: [], repos: [], walls: [],
}
const BUSY = {
  since: at(8), until: at(0),
  volume: { terminals: 9, cards: 2, landings: 1, events: 41, sessions_on_disk: 14, cards_on_disk: 2 },
  attention: [
    { kind: 'waiting_on_you', id: 's-1-claude-2fbf', short: '2fbf', agent: 'claude', account: 'default', since: at(0.6), message: 'Bash(git push origin HEAD)', rank: 0 },
    { kind: 'card_failed', id: 'card-1-flaky-test', short: 'test', since: at(0.5), message: 'the flaky test card failed at test: tests-red: 2 failures', rank: 3 },
    { kind: 'lost', id: 's-2-agy-d9f2', short: 'd9f2', agent: 'agy', account: 'default', since: at(6), message: 'the terminal closed or crashed; its bundle is on disk', rank: 4 },
    { kind: 'lost', id: 's-3-codex-7b31', short: '7b31', agent: 'codex', account: 'work', since: at(3), message: 'the terminal closed or crashed; its bundle is on disk', rank: 4 },
  ],
  repos: [], walls: [],
}

test('a refusal leaves nothing on the page: a guest and an operator get a 403', async () => {
  const b = load({ respond: () => json(403, { error: 'this is the map of the machine itself' }) })
  await settle()
  assert.equal(b.calls.length, 1, 'the board asked once')
  assert.equal(b.el('digest').hidden, true, 'the section stays hidden')
  assert.equal(b.el('digest-list').children.length, 0, 'and holds no rows')
  assert.equal(b.el('digest-meta').textContent, '', 'and no sentence')
})

test('a quiet window is one line, and it still says how much it read', async () => {
  const b = load({ respond: () => json(200, QUIET) })
  await settle()
  assert.equal(b.el('digest').hidden, false)
  assert.ok(b.el('digest').classList.contains('is-quiet'), 'the quiet form lays the head and the sentence on one line')
  assert.equal(b.el('digest-meta').textContent, 'Nothing moved in the last 8 hours. Read 12 terminals and 3 cards on disk.')
  assert.equal(b.el('digest-list').children.length, 0, 'no rows')
  assert.equal(b.el('digest-sub').hidden, true, 'and no needs-you heading')
})

test('a busy window prints its volume and what needs you, most urgent first, the lost said once', async () => {
  const b = load({ respond: () => json(200, BUSY) })
  await settle()
  assert.equal(b.calls[0].url, '/api/digest?since=8h', 'the window is the CLI default and is named on the panel')
  assert.equal(b.el('digest').hidden, false)
  assert.equal(b.el('digest').classList.contains('is-quiet'), false)
  assert.equal(b.el('digest-meta').textContent, 'In the last 8 hours: 9 terminals, 2 cards and 1 landing moved; 41 events read.')
  assert.equal(b.el('digest-sub').hidden, false)
  assert.match(b.el('digest-sub').textContent, /^Needs you\s*4$/, 'the count is every item, the two lost included')
  const rows = b.el('digest-list').children.map((r) => r.textContent)
  assert.equal(rows.length, 3, 'one row per item, and one for every lost terminal together')
  assert.match(rows[0], /^waiting on you.*claude.*2fbf.*Bash\(git push origin HEAD\).*36m ago$/)
  assert.match(rows[1], /^card failedthe flaky test card failed at test: tests-red: 2 failures30m ago$/, 'a card is named by the title its message opens with')
  assert.ok(!rows[1].includes('card test'), 'and never by the last word of its slug')
  assert.match(rows[2], /^lost.*codex\/work.*7b31.*agy.*d9f2.*closed or crashed; each bundle is on disk.*3h to 6h ago$/, 'newest first, the login named, the reason once')
})

test('a busy window with nothing for a person says so', async () => {
  const b = load({ respond: () => json(200, { ...BUSY, attention: [] }) })
  await settle()
  assert.equal(b.el('digest-sub').textContent, 'Nothing needs you')
  assert.equal(b.el('digest-list').children.length, 0)
})

test('Hide for today closes the panel and skips the read until the next calendar day', async () => {
  const b = load({ respond: () => json(200, BUSY) })
  await settle()
  b.el('digest-hide').listeners.click()
  assert.equal(b.el('digest').hidden, true)
  assert.equal(b.store.get('legDigestHidden'), today())

  const again = load({ respond: () => json(200, BUSY), hiddenFor: today() })
  await settle()
  assert.equal(again.calls.length, 0, 'a panel hidden today costs the server nothing')
  assert.equal(again.el('digest').hidden, true)

  const tomorrow = load({ respond: () => json(200, BUSY), hiddenFor: '2000-01-01' })
  await settle()
  assert.equal(tomorrow.el('digest').hidden, false, 'a hide from another day has run out')
})

const MINUTE = 60 * 1000

test('a tab left open asks again when it comes back into view with a read over 30 minutes old, and not before', async () => {
  const b = load({ respond: (url, n) => json(200, n === 1 ? BUSY : QUIET) })
  await settle()
  assert.equal(b.calls.length, 1)
  assert.equal(b.el('digest-list').children.length, 3)

  b.show('hidden'); b.show('visible')
  await settle()
  assert.equal(b.calls.length, 1, 'coming straight back is not a new arrival')

  b.advance(29 * MINUTE)
  b.show('hidden'); b.show('visible')
  await settle()
  assert.equal(b.calls.length, 1, 'a read 29 minutes old still stands')

  b.advance(2 * MINUTE)
  b.show('hidden')
  await settle()
  assert.equal(b.calls.length, 1, 'a tab going to the background asks nothing')
  b.show('visible')
  await settle()
  assert.equal(b.calls.length, 2, 'a read 31 minutes old is asked again when the tab is looked at')
  assert.equal(b.calls[1].url, '/api/digest?since=8h')
  assert.equal(b.el('digest-meta').textContent, 'Nothing moved in the last 8 hours. Read 12 terminals and 3 cards on disk.', 'and the page now says what the second read said')
  assert.equal(b.el('digest-list').children.length, 0, 'with none of the first read left on it')
  assert.equal(b.el('digest').hidden, false)
})

test('a hide that ran out overnight opens the panel the next time the tab is looked at', async () => {
  const b = load({ respond: () => json(200, BUSY), hiddenFor: today() })
  await settle()
  assert.equal(b.calls.length, 0)
  assert.equal(b.el('digest').hidden, true)

  // 31 minutes on is the same calendar day unless this runs in the last half
  // hour before midnight, where the hide has already run out
  const sameDay = todayPlus(31 * MINUTE) === today() ? 0 : 1
  b.advance(31 * MINUTE)
  b.show('hidden'); b.show('visible')
  await settle()
  assert.equal(b.calls.length, sameDay, 'still hidden today: looking at the tab costs the server nothing')

  b.advance(24 * 60 * MINUTE)
  b.show('hidden'); b.show('visible')
  await settle()
  assert.equal(b.calls.length, sameDay + 1, 'the next calendar day the hide has run out and the board asks')
  assert.equal(b.el('digest').hidden, false)
})

test('a read that is refused when the tab comes back takes the panel down', async () => {
  const b = load({ respond: (url, n) => (n === 1 ? json(200, BUSY) : json(403, { error: 'this is the map of the machine itself' })) })
  await settle()
  assert.equal(b.el('digest').hidden, false)
  b.advance(31 * MINUTE)
  b.show('hidden'); b.show('visible')
  await settle()
  assert.equal(b.calls.length, 2)
  assert.equal(b.el('digest').hidden, true, 'a refusal draws nothing, on the second read as on the first')
})

test('index.html: the section ships hidden above Terminals, and digest.js loads after audit.js', () => {
  const section = /<section class="digest" id="digest" aria-labelledby="digest-head" hidden>/
  assert.match(INDEX_HTML, section, 'hidden until /api/digest answers, so a 403 leaves nothing to read')
  assert.ok(INDEX_HTML.search(section) < INDEX_HTML.indexOf('<section class="region-terminals"'), 'above Terminals')
  assert.ok(INDEX_HTML.indexOf('<section class="capacity"') < INDEX_HTML.search(section), 'under the capacity strip')
  const tag = (src) => INDEX_HTML.indexOf(`<script src="${src}" defer></script>`)
  assert.ok(tag('digest.js') > tag('audit.js') && tag('audit.js') > -1, 'deferred, after audit.js')
})
