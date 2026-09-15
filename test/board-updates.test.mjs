// board-updates — the decisions behind a live card push: which pushes are worth
// a drawer refetch, when a card's log tail has gone stale, and what the floor
// does when the API says the caller is not the owner. There is no DOM here, so
// the two IIFEs are run with a stub document and read back through their
// `module` seam; the handlers that use them are checked against the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BOARD_JS = readFileSync(join(ROOT, 'src/board/board.js'), 'utf8')
const FLOOR_JS = readFileSync(join(ROOT, 'src/board/floor.js'), 'utf8')

function load(src) {
  const mod = { exports: {} }
  new Function('module', 'document', src)(mod, { addEventListener() {} })
  return mod.exports
}

const board = load(BOARD_JS)
const floor = load(FLOOR_JS)

function fnBody(src, header) {
  const i = src.indexOf(header)
  assert.ok(i !== -1, `expected to find "${header}" in the source`)
  const open = src.indexOf('{', i + header.length)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(open, j + 1) }
  }
  throw new Error(`unbalanced braces after "${header}"`)
}

function card(extra = {}) {
  return {
    card_id: 'c1', title: 'A card', task: 'do the thing', status: 'running',
    column: 'build', station: 'build', station_kind: 'agent', runs_count: 1,
    active_run: { run: 1, adapter: 'fake', started_at: '2026-09-11T09:00:00.000Z' },
    elapsed_ms: 1000, last_event: { ts: '2026-09-11T09:00:01.000Z', type: 'log', summary: 'x' },
    ...extra,
  }
}

const NOW = 1_000_000
function cache(extra = {}) { return { lines: ['a'], expanded: false, at: NOW, runs_count: 1, run: 1, ...extra } }

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function fakeNode() {
  const n = {
    children: [], hidden: false, attrs: {}, className: '', value: '', listeners: {},
    classList: { values: new Set(), add(...xs) { xs.forEach((x) => this.values.add(x)) }, remove(...xs) { xs.forEach((x) => this.values.delete(x)) }, contains(x) { return this.values.has(x) } },
    appendChild(c) { this.children.push(c); return c }, removeChild(c) { this.children = this.children.filter((x) => x !== c) }, remove() {},
    setAttribute(k, v) { this.attrs[k] = String(v) }, removeAttribute(k) { delete this.attrs[k] }, addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null }, showModal() {}, close() {}, select() {},
  }
  Object.defineProperty(n, 'firstChild', { get() { return this.children[0] || null } })
  Object.defineProperty(n, 'textContent', { get() { return this._text || this.children.map((c) => c.textContent || '').join('') }, set(v) { this._text = String(v); this.children = [] } })
  return n
}

function loadBehavior(src, names, fetchImpl) {
  const els = new Map()
  for (const id of ['toast', 'board', 'new-card-btn', 'sched-status', 'columns', 'empty-state', 'drawer', 'drawer-content', 'token-input', 'banner', 'sse-dot', 'sse-text', 'repos-list', 'count-running', 'count-queued', 'count-waiting', 'count-done', 'running-body', 'waiting-body', 'queued-body', 'leases-body', 'trunk-body']) els.set(id, fakeNode())
  const doc = { body: fakeNode(), createElement: fakeNode, createTextNode: (text) => ({ textContent: String(text) }), getElementById: (id) => els.get(id) || fakeNode(), querySelector: () => fakeNode(), addEventListener() {} }
  const streams = []
  class EventSource { constructor(url) { this.url = url; this.listeners = {}; streams.push(this) } addEventListener(k, fn) { this.listeners[k] = fn } close() { this.closed = true } }
  const localStorage = { value: '', getItem() { return this.value }, setItem(_, v) { this.value = v }, removeItem() { this.value = '' } }
  const mod = { exports: {} }
  const exports = names.join(', ')
  const transformed = src.replace(/module\.exports = \{[^}]+\}/, `module.exports = { ${exports} }`)
  new Function('module', 'document', 'fetch', 'EventSource', 'localStorage', 'location', 'history', 'window', 'confirm', 'setTimeout', 'setInterval', transformed)(mod, doc, fetchImpl, EventSource, localStorage, { href: 'http://board/' }, { replaceState() {} }, { dispatchEvent() {} }, () => true, () => 0, () => 0)
  return { ...mod.exports, els, streams }
}

const jsonResponse = (json) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(json) })
const nextTurn = () => new Promise((resolvePromise) => setImmediate(resolvePromise))

// ---- drawer refetch ----
test('a card push that only moves elapsed_ms / last_event does not refetch the drawer', () => {
  const next = card({ elapsed_ms: 41000, last_event: { ts: '2026-09-11T09:00:41.000Z', type: 'log', summary: 'y' } })
  assert.equal(board.drawerRefreshNeeded(card(), next), false)
})

test('a card push that changes anything the drawer shows refetches it', () => {
  assert.equal(board.drawerRefreshNeeded(card(), card({ status: 'done' })), true)
  assert.equal(board.drawerRefreshNeeded(card(), card({ station: 'test' })), true)
  assert.equal(board.drawerRefreshNeeded(card(), card({ runs_count: 2 })), true)
  assert.equal(board.drawerRefreshNeeded(card(), card({ active_run: null })), true)
  assert.equal(board.drawerRefreshNeeded(undefined, card()), true)
})

// ---- log tail staleness ----
test('the log tail is left alone when the run has not changed and it was just read', () => {
  assert.equal(board.staleLogTail(cache(), card(), NOW + 1000), 0)
  assert.equal(board.staleLogTail(undefined, card(), NOW + 1000), 0)
})

test('the log tail is refetched when the run number or the run count changed', () => {
  const nextRun = card({ runs_count: 2, active_run: { run: 2, adapter: 'fake', started_at: '2026-09-11T09:10:00.000Z' } })
  assert.equal(board.staleLogTail(cache(), nextRun, NOW), 8)
  assert.equal(board.staleLogTail(cache({ expanded: true }), nextRun, NOW), 200)
  assert.equal(board.staleLogTail(cache(), card({ runs_count: 2 }), NOW), 8)
})

test('a running card refetches its tail once the cached one has aged out, a finished one never does', () => {
  assert.equal(board.staleLogTail(cache(), card(), NOW + 4999), 0)
  assert.equal(board.staleLogTail(cache(), card(), NOW + 5000), 8)
  assert.equal(board.staleLogTail(cache({ run: null }), card({ active_run: null, status: 'done' }), NOW + 60000), 0)
})

// ---- source-level: the handlers that use them ----
test('upsertCard asks both predicates and never refetches the drawer directly (source-level)', () => {
  const body = fnBody(BOARD_JS, 'function upsertCard')
  assert.match(body, /staleLogTail\(/)
  assert.match(body, /drawerRefreshNeeded\(/)
  assert.match(body, /scheduleDrawerRefresh\(/)
  assert.doesNotMatch(body, /refreshDrawerAfterUpdate\(/)
})

test('the drawer refetch is coalesced into one trailing timer (source-level)', () => {
  const body = fnBody(BOARD_JS, 'function scheduleDrawerRefresh')
  assert.match(body, /setTimeout\(/)
  assert.match(body, /refreshDrawerAfterUpdate\(\)/)
})

test('an open drawer is refreshed after an SSE reconnect and after a full card refetch (source-level)', () => {
  assert.match(fnBody(BOARD_JS, "es.addEventListener('hello'"), /scheduleDrawerRefresh\(\)/)
  assert.match(fnBody(BOARD_JS, 'async function fetchCards'), /scheduleDrawerRefresh\(\)/)
})

test('a cached log entry carries the run it came from (source-level)', () => {
  const body = fnBody(BOARD_JS, 'async function ensureLogLoaded')
  assert.match(body, /runs_count:/)
  assert.match(body, /run:/)
  assert.match(body, /at:/)
})

// ---- floor lockout ----
test('the floor link back to the board carries a ?token= from the current URL', () => {
  assert.equal(floor.boardHref('http://host:4747/floor?token=abc%20d'), '/?token=abc%20d')
  assert.equal(floor.boardHref('http://host:4747/floor'), '/')
  assert.equal(floor.boardHref('/floor?token=abc'), '/')
})

test('a 401/403 from the floor APIs stops the polling and renders a way back (source-level)', () => {
  assert.match(fnBody(FLOOR_JS, 'async function api(path, opts = {})'), /err\.status = res\.status/)
  for (const name of ['async function refreshFloor', 'async function refreshTrunk']) {
    const body = fnBody(FLOOR_JS, name)
    assert.match(body, /err\.status === 401 \|\| err\.status === 403/, `${name} should recognise an auth failure`)
    assert.match(body, /lockOut\(/, `${name} should lock the page out`)
  }
  const lock = fnBody(FLOOR_JS, 'function lockOut')
  assert.match(lock, /clearInterval\(/)
  assert.match(lock, /boardHref\(/)
  const init = fnBody(FLOOR_JS, 'function init')
  assert.match(init, /state\.timers\.push\(/)
  assert.equal((init.match(/setInterval\(/g) || []).length, 2)
})

test('a locked-out floor does not reconnect its SSE (source-level)', () => {
  assert.match(fnBody(FLOOR_JS, 'function connectSse'), /if \(state\.stopped\) return/)
})

// ---- deferred UI behavior ----
test('token changes reconnect sessions for guests and restore the pipeline for owners', async () => {
  let role = 'owner'
  const app = loadBehavior(BOARD_JS, ['state', 'initSettings'], async (url) => jsonResponse(url === '/api/health' ? { you: { role } } : { columns: [], cards: [] }))
  app.initSettings()
  const input = app.els.get('token-input')
  input.value = 'owner-token'; await input.listeners.change()
  assert.equal(app.streams.length, 1)
  assert.equal(app.els.get('board').hidden, false)

  role = 'guest'; input.value = 'guest-token'; await input.listeners.change()
  assert.equal(app.streams.length, 2, 'a valid guest still receives terminal/session SSE')
  assert.equal(app.els.get('board').hidden, true)

  role = 'owner'; input.value = 'owner-token-2'; await input.listeners.change()
  assert.equal(app.streams.length, 3)
  assert.equal(app.els.get('board').hidden, false, 'owner access restores pipeline controls without reload')
})

test('an old card-list response cannot overwrite a newer SSE card update', async () => {
  const wait = deferred()
  const app = loadBehavior(BOARD_JS, ['state', 'fetchCards', 'upsertCard'], async (url) => url === '/api/cards' ? wait.promise : jsonResponse({ you: { role: 'owner' } }))
  app.state.columnEls.set('build', { list: fakeNode(), countEl: fakeNode() })
  app.fetchCards()
  app.upsertCard({ card_id: 'c', column: 'build', status: 'running', runs_count: 0, active_run: null })
  wait.resolve(jsonResponse({ columns: ['backlog'], cards: [{ card_id: 'c', column: 'backlog', status: 'backlog', runs_count: 0, active_run: null }] }))
  await nextTurn(); await nextTurn()
  assert.equal(app.state.cards.get('c').column, 'build')
})

test('an old response for the same open drawer cannot overwrite a refresh', async () => {
  const waits = []
  const app = loadBehavior(BOARD_JS, ['openDrawer'], async () => { const wait = deferred(); waits.push(wait); return wait.promise })
  const first = app.openDrawer('c')
  const second = app.openDrawer('c')
  waits[2].resolve(jsonResponse({ card: { card_id: 'c', title: 'new' }, events: [], runs: [], bundle: null })); waits[3].resolve(jsonResponse({ lines: ['new'] }))
  await second
  waits[0].resolve(jsonResponse({ card: { card_id: 'c', title: 'old' }, events: [], runs: [], bundle: null })); waits[1].resolve(jsonResponse({ lines: ['old'] }))
  await first
  assert.match(app.els.get('drawer-content').textContent, /new/)
})

test('an ABA log completion cannot overwrite or delete a later request', async () => {
  const waits = []
  const app = loadBehavior(BOARD_JS, ['state', 'ensureLogLoaded'], async () => { const wait = deferred(); waits.push(wait); return wait.promise })
  app.state.cards.set('c', { card_id: 'c', runs_count: 1, active_run: { run: 1 } })
  app.ensureLogLoaded('c', 8)
  app.ensureLogLoaded('c', 200)
  waits[1].resolve(jsonResponse({ lines: ['newer'] })); await nextTurn(); await nextTurn()
  app.ensureLogLoaded('c', 8)
  waits[0].resolve(jsonResponse({ lines: ['older'] })); await nextTurn(); await nextTurn()
  assert.deepEqual(app.state.logState.get('c').lines, ['newer'])
  assert.ok(app.state.logRequests.has('c'), 'old completion must not delete the later request')
})

test('a later floor refresh wins over an older deferred response', async () => {
  const waits = []
  const app = loadBehavior(FLOOR_JS, ['state', 'refreshFloor'], async () => { const wait = deferred(); waits.push(wait); return wait.promise })
  const first = app.refreshFloor()
  const second = app.refreshFloor()
  waits[1].resolve(jsonResponse({ running: [], waiting: [], queued: [], leases: [], repos: [], scheduler: {}, counts: { running: 2, queued: 0, waiting: 0, done: 0 } }))
  await second
  waits[0].resolve(jsonResponse({ running: [], waiting: [], queued: [], leases: [], repos: [], scheduler: {}, counts: { running: 1, queued: 0, waiting: 0, done: 0 } }))
  await first
  assert.equal(app.els.get('count-running').textContent, '2')
})

// The API token field: a board nothing but this machine can reach has no use
// for one, and the question "what do I put here" has no answer on 127.0.0.1.
test('the token field is drawn only when something other than this machine can reach the board', () => {
  const local = { bind: '127.0.0.1:4747', shareOn: false, isOwner: true, token: '', healthKnown: true, bindKnown: true }

  const off = board.tokenPanel(local)
  assert.equal(off.hidden, true, 'a loopback board with share off hides the field')
  assert.match(off.meta, /Local only/)
  assert.doesNotMatch(off.meta, /unauthenticated/, 'the meta line stops offering a token nobody needs')

  // a stored token must stay clearable, or the only way to sign out is devtools
  assert.equal(board.tokenPanel({ ...local, token: 'abc' }).hidden, false)
  assert.match(board.tokenPanel({ ...local, token: 'abc' }).meta, /API token set/)

  // anything that lets a second machine in puts the field back
  assert.equal(board.tokenPanel({ ...local, shareOn: true }).hidden, false, 'share on')
  assert.equal(board.tokenPanel({ ...local, isOwner: false }).hidden, false, 'a guest, or health never answered')
  assert.equal(board.tokenPanel({ ...local, bind: '100.71.2.9:4747' }).hidden, false, 'a Tailscale bind')
  assert.match(board.tokenPanel({ ...local, bind: '100.71.2.9:4747' }).meta, /unauthenticated/)
})

test('every loopback spelling auth.mjs accepts is read as local, and a bracketed IPv6 host survives the port strip', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '[::ffff:127.0.0.1]']) {
    const panel = board.tokenPanel({ bind: `${host}:4747`, shareOn: false, isOwner: true, token: '', healthKnown: true, bindKnown: true })
    assert.equal(panel.hidden, true, `${host} is loopback`)
  }
  assert.equal(board.bindHost('[::1]:4747'), '::1')
  assert.equal(board.bindHost('127.0.0.1:4747'), '127.0.0.1')
  // a hostname that merely starts the same is not loopback
  assert.equal(board.tokenPanel({ bind: '127.0.0.1.evil.com:4747', shareOn: false, isOwner: true, token: '', healthKnown: true, bindKnown: true }).hidden, false)
})

// A board that answered nothing has told this page no address at all, so the
// panel must not print DEFAULT_BIND at a viewer looking at another server.
test('a board that never answered names no address and still offers the field', () => {
  const blind = { bind: '127.0.0.1:4747', shareOn: false, isOwner: false, token: '', healthKnown: false, bindKnown: false }

  const fresh = board.tokenPanel(blind)
  assert.equal(fresh.hidden, false, 'the only way in is the field, so it is drawn')
  assert.doesNotMatch(fresh.meta, /127\.0\.0\.1/, 'no invented address')
  assert.match(fresh.meta, /token/i)

  const refused = board.tokenPanel({ ...blind, token: 'wrong' })
  assert.equal(refused.hidden, false)
  assert.match(refused.meta, /refused/i, 'a stored token that still gets 401 is named as the problem')
  assert.doesNotMatch(refused.meta, /127\.0\.0\.1/)
})

// With share on, auth.mjs still lets the machine's own browser in as the owner
// over loopback. The panel used to tell that owner their requests were
// "unauthenticated", on their own board.
test('a shared board tells the owner they are recognised, not that they are anonymous', () => {
  const shared = { bind: '192.168.1.6:4881', shareOn: true, isOwner: true, token: '', healthKnown: true, bindKnown: true }
  const owner = board.tokenPanel(shared)
  assert.equal(owner.hidden, false, 'the field stays, so the owner can sign in from elsewhere')
  assert.match(owner.meta, /owner/i)
  assert.doesNotMatch(owner.meta, /unauthenticated/)

  // a guest carries a token and is told where it goes
  const guest = board.tokenPanel({ ...shared, isOwner: false, token: 'abc' })
  assert.match(guest.meta, /API token set/)
  assert.match(guest.meta, /192\.168\.1\.6:4881/)
})

// A guest's /api/health is redacted: no bind, no port, no home. The panel used
// to fall back to DEFAULT_BIND and tell Priya her token was going to
// 127.0.0.1:4747, a machine that is not the one she is looking at.
test('a guest, whose health carries no address, is told no address', () => {
  const guest = board.tokenPanel({ bind: '127.0.0.1:4747', shareOn: true, isOwner: false, token: 'abc', healthKnown: true, bindKnown: false })
  assert.equal(guest.hidden, false)
  assert.match(guest.meta, /API token set/)
  assert.doesNotMatch(guest.meta, /127\.0\.0\.1/, 'never name the default bind at someone who was told nothing')

  // and a board that did name its address still says it
  const owner = board.tokenPanel({ bind: '192.168.1.6:4881', shareOn: true, isOwner: false, token: 'abc', healthKnown: true, bindKnown: true })
  assert.match(owner.meta, /192\.168\.1\.6:4881/)

  // a bind nobody confirmed is never "local only" either
  const unconfirmed = board.tokenPanel({ bind: '127.0.0.1:4747', shareOn: false, isOwner: true, token: '', healthKnown: true, bindKnown: false })
  assert.equal(unconfirmed.hidden, false, 'without a confirmed bind the field stays')
})
