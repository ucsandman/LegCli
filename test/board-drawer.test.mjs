// The terminal drawer is meant to be left open beside the work. Two things
// follow from that and neither is cosmetic: the newest thing that happened is
// at the top, and a box the reader scrolled stays where they put it when the
// panel rebuilds three seconds later.
//
// src/board/sessions.js runs in the browser and the repo has no DOM harness for
// it, so these are source-level checks: they pin the contract that the live
// check in docs/VERIFY (open the drawer, scroll a message, wait a poll) covers
// end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const SRC = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'src', 'board', 'board.css'), 'utf8')

test('the conversation is newest first, so the last turn is at the top of the panel', () => {
  assert.match(SRC, /turns\.map\(\(m, i\) => messageRow\(m, m\.ts \|\| i\)\)\.reverse\(\)/, 'the turns are reversed before they are appended')
  assert.match(SRC, /newest first/, 'and the section says so')
  assert.ok(!/section\('Conversation', `last \$\{turns\.length\} turns`/.test(SRC), 'the old oldest-first label is gone')
})

test('the timeline is newest first too', () => {
  assert.match(SRC, /events\.slice\(-40\)\.reverse\(\)/, 'the last 40 events are reversed')
  assert.match(SRC, /section\('Timeline', 'this terminal, newest first'/)
  assert.ok(!/this terminal, newest last/.test(SRC), 'the old wording is gone')
})

test('every box that can scroll carries a key, and the offsets are carried across a rebuild', () => {
  // the four boxes CSS gives their own scrollbar
  for (const cls of ['.drawer-task', '.drawer-msg p', '.drawer-timeline', '.drawer-diff']) {
    const rule = CSS.split('\n').find((l) => l.trim().startsWith(cls + ' ') || l.trim().startsWith(cls + '{'))
    assert.ok(rule && /overflow(-y)?: auto/.test(rule), `${cls} is a scroll box in board.css`)
  }
  for (const key of ["'data-scroll-key': 'task'", "'data-scroll-key': `msg:", "'data-scroll-key': 'timeline'", "'data-scroll-key': `diff:"]) {
    assert.ok(SRC.includes(key), `${key} is set on its box`)
  }
  assert.match(SRC, /function takeScroll\(box\)/, 'the offsets are read before the wipe')
  assert.match(SRC, /function putScroll\(box, at\)/, 'and written back after the rebuild')
})

test('renderDrawer captures the offsets before it empties the panel and restores them after', () => {
  const body = SRC.slice(SRC.indexOf('function renderDrawer()'))
  const capture = body.indexOf('takeScroll(box)')
  const wipe = body.indexOf("box.textContent = ''")
  const restore = body.indexOf('putScroll(box, inner)')
  assert.ok(capture > -1 && wipe > -1 && restore > -1, 'all three steps are in renderDrawer')
  assert.ok(capture < wipe, 'the offsets are taken BEFORE the panel is emptied, or there is nothing left to read')
  assert.ok(wipe < restore, 'and put back after it is rebuilt')
})

// A board left open beside the work rebuilds itself every 3 seconds, and the
// rebuild restores focus so a tabbed control is not lost. focus() scrolls its
// element into view unless told not to, so the restore moved the viewport on
// every poll: click any button, scroll away, and the next tick dragged you
// back. The page could not be scrolled at all until the reader clicked
// somewhere harmless. Only a focus move the reader asked for may scroll.
test('focus restored by a rebuild never moves the viewport', () => {
  const body = SRC.slice(SRC.indexOf('function putFocus(box, at)'))
  const end = body.indexOf('\n  function ', 1)
  const fn = end === -1 ? body : body.slice(0, end)
  assert.match(fn, /\.focus\(\{[^}]*preventScroll:\s*true/, 'putFocus focuses with preventScroll: true')
  assert.ok(!/\.focus\(\)/.test(fn), 'and never with a bare focus(), which scrolls')
})

test('the focus moves the reader asked for are still allowed to scroll', () => {
  // confirmRow moves focus to Cancel, and closing the detail region hands focus
  // back to the control that opened it. Both follow a click, so bringing the
  // target into view is the right behaviour and must not be "fixed".
  assert.match(SRC, /setTimeout\(\(\) => no\.focus\(\), 0\)/, 'the confirm row still focuses Cancel')
  assert.match(SRC, /getElementById\('session-drawer-close'\)\?\.focus\(\)/, 'opening the detail region still focuses its close control')
})

// renderSessions moves the expanded region out of the list and back so the
// rebuild cannot orphan it. Detaching a subtree resets scrollTop on every
// scrollable box inside it, so a reader half way down a 200-line diff was
// returned to the top by a rebuild of the list around them. renderDrawer's
// own capture could not save it: by the time it ran the offset was already 0.
test('re-parenting the expanded region carries its scroll offsets across the move', () => {
  const body = SRC.slice(SRC.indexOf('function renderSessions(v)'))
  const end = body.indexOf('\n  function ', 1)
  const fn = end === -1 ? body : body.slice(0, end)
  const capture = fn.indexOf('takeScroll(region)')
  const park = fn.indexOf('document.body.appendChild(region)')
  const restore = fn.indexOf('putScroll(region,')
  assert.ok(capture > -1, 'renderSessions reads the offsets before it moves the region')
  assert.ok(park > -1, 'the region is still parked on the body during the wipe')
  assert.ok(restore > -1, 'and the offsets are written back')
  assert.ok(capture < park, 'the offsets are read BEFORE the move, or they are already zero')
  assert.ok(park < restore, 'and restored after the region is back in place')
})
