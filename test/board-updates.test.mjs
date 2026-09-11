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
