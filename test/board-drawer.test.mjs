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
