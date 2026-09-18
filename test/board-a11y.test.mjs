// board-a11y — accessibility checks on the static board UI. Two things:
// (a) WCAG contrast for body text and every chip/pill colour in board.css,
// computed from the actual CSS custom properties (not asserted from memory);
// (b) every interactive control in index.html/floor.html and every one
// board.js/floor.js creates has an accessible name (text, aria-label, or a
// <label for>). Parsing is regex over the source files on purpose — simple
// and honest beats a full CSS/DOM parser for a two-file board.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(join(ROOT, 'src/board/board.css'), 'utf8')
const INDEX_HTML = readFileSync(join(ROOT, 'src/board/index.html'), 'utf8')
const FLOOR_HTML = readFileSync(join(ROOT, 'src/board/floor.html'), 'utf8')
const BOARD_JS = readFileSync(join(ROOT, 'src/board/board.js'), 'utf8')
const FLOOR_JS = readFileSync(join(ROOT, 'src/board/floor.js'), 'utf8')
const HISTORY_JS = readFileSync(join(ROOT, 'src/board/history.js'), 'utf8')

// ---- WCAG relative luminance / contrast ----
function hexToRgb(hex) {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full.slice(0, 6), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function relLuminance({ r, g, b }) {
  const chan = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

function contrast(hexA, hexB) {
  const lA = relLuminance(hexToRgb(hexA))
  const lB = relLuminance(hexToRgb(hexB))
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA]
  return (lighter + 0.05) / (darker + 0.05)
}

// ---- tiny bracket matchers, reused for both CSS and JS source scanning ----
function matchDelims(src, openIdx, open, close) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

// ---- CSS: custom properties + rule lookup (flat regex, fine for this file:
// no chip/pill rule lives inside a @media/@keyframes block) ----
function parseRootVars(css) {
  const block = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''
  const vars = {}
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
  return vars
}

const ROOT_VARS = parseRootVars(CSS)

function resolveColor(raw) {
  const v = (raw ?? '').trim()
  const varMatch = v.match(/^var\(--([\w-]+)\)$/)
  return varMatch ? resolveColor(ROOT_VARS[varMatch[1]]) : v
}

function findRules(css, selectorRe) {
  const out = []
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim()
    if (selectorRe.test(selector)) out.push({ selector, body: m[2] })
  }
  return out
}

function ruleColor(body) {
  const m = body.match(/(?<!-)color:\s*([^;]+);/)
  return m ? resolveColor(m[1]) : null
}

function ruleBackground(body) {
  const m = body.match(/(?<!-)background(?:-color)?:\s*([^;]+);/)
  return m ? resolveColor(m[1]) : null
}

function extractCssBlock(src, marker) {
  const idx = src.indexOf(marker)
  assert.ok(idx !== -1, `expected to find "${marker}" in board.css`)
  const open = src.indexOf('{', idx)
  const close = matchDelims(src, open, '{', '}')
  assert.ok(close !== -1, `unbalanced braces after "${marker}"`)
  return src.slice(open + 1, close)
}

// ---- (a) contrast ----
test('board text meets WCAG AA (>= 4.5:1) against the page background', (t) => {
  const [bodyRule] = findRules(CSS, /^html,\s*body$/)
  assert.ok(bodyRule, 'expected an `html, body` rule in board.css')
  const fg = ruleColor(bodyRule.body)
  const bg = ruleBackground(bodyRule.body)
  assert.ok(fg && bg, `expected color + background on \`html, body\` (got fg=${fg} bg=${bg})`)
  const ratio = contrast(fg, bg)
  t.diagnostic(`body text ${fg} on ${bg}: ${ratio.toFixed(2)}:1`)
  assert.ok(ratio >= 4.5, `body text contrast ${ratio.toFixed(2)}:1 < 4.5:1 (${fg} on ${bg})`)
})

test('every chip/pill colour meets WCAG UI-component contrast (>= 3.0:1) against its background', (t) => {
  const panelBg = resolveColor('var(--panel-2)')
  const rules = findRules(CSS, /chip|pill/i).filter((r) => ruleColor(r.body))
  assert.ok(rules.length >= 6, `expected several chip/pill colour rules in board.css, found ${rules.length}`)
  for (const r of rules) {
    const fg = ruleColor(r.body)
    const bg = ruleBackground(r.body) || panelBg
    const ratio = contrast(fg, bg)
    t.diagnostic(`${r.selector} :: ${fg} on ${bg} -> ${ratio.toFixed(2)}:1`)
    assert.ok(ratio >= 3.0, `${r.selector} contrast ${ratio.toFixed(2)}:1 < 3.0:1 (${fg} on ${bg})`)
  }
})

// ---- tab order / focus ring / reduced motion ----
test('no positive tabindex anywhere in the board sources', () => {
  for (const [name, src] of [['index.html', INDEX_HTML], ['floor.html', FLOOR_HTML], ['board.js', BOARD_JS], ['floor.js', FLOOR_JS]]) {
    const bad = src.match(/tabindex\s*[:=]\s*["']?([1-9]\d*)/i)
    assert.equal(bad, null, `${name}: positive tabindex found (${bad?.[0]})`)
  }
})

test('board.css never sets outline:none/0 without a :focus-visible replacement', () => {
  const offenders = findRules(CSS, /.*/)
    .filter((r) => /outline\s*:\s*(none|0)\b/.test(r.body) && !/:focus-visible|:focus\b/.test(r.selector))
  assert.deepEqual(offenders.map((r) => r.selector), [])
  assert.match(CSS, /:focus-visible[\s\S]{0,80}outline:\s*2px solid/, 'expected a :focus-visible outline rule')
})

test('prefers-reduced-motion disables the running-leg pulse animation and transitions', () => {
  const block = extractCssBlock(CSS, '@media (prefers-reduced-motion: reduce)')
  assert.match(block, /state-active[\s\S]*?\{[\s\S]*?animation:\s*none/, 'expected the running-leg pill animation to be disabled')
  assert.match(block, /\*\s*\{[\s\S]*?transition:\s*none/, 'expected transitions to be disabled')
})

// ---- (b) HTML controls have accessible names ----
function labelledIdsIn(html) {
  const ids = new Set()
  for (const m of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) ids.add(m[1])
  return ids
}

function labelWrappedSnippets(html) {
  return [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1])
}

function htmlControls(html) {
  const out = []
  for (const m of html.matchAll(/<input\b([^>]*)>/g)) out.push({ tag: 'input', attrs: m[1], full: m[0], inner: null })
  for (const m of html.matchAll(/<select\b([^>]*)>/g)) out.push({ tag: 'select', attrs: m[1], full: m[0], inner: null })
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) out.push({ tag: 'textarea', attrs: m[1], full: m[0], inner: m[2] })
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) out.push({ tag: 'button', attrs: m[1], full: m[0], inner: m[2] })
  for (const m of html.matchAll(/<a\b([^>]*\bhref="[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)) out.push({ tag: 'a', attrs: m[1], full: m[0], inner: m[2] })
  return out
}

function hasAccessibleName(control, labelledIds, wrapped) {
  const ariaLabel = control.attrs.match(/aria-label="([^"]*)"/)
  if (ariaLabel && ariaLabel[1].trim()) return true
  const id = control.attrs.match(/\bid="([^"]+)"/)
  if (id && labelledIds.has(id[1])) return true
  if (['button', 'a'].includes(control.tag) && control.inner && control.inner.replace(/<[^>]+>/g, '').trim()) return true
  if (wrapped.some((w) => w.includes(control.full))) return true
  return false
}

function checkHtmlFile(t, html, name) {
  const labelledIds = labelledIdsIn(html)
  const wrapped = labelWrappedSnippets(html)
  const controls = htmlControls(html)
  assert.ok(controls.length > 0, `expected at least one control in ${name}, found none`)
  for (const c of controls) {
    const id = (c.attrs.match(/\bid="([^"]+)"/) || [null, '(no id)'])[1]
    const ok = hasAccessibleName(c, labelledIds, wrapped)
    t.diagnostic(`${name}: <${c.tag}> ${id} -> ${ok ? 'labelled' : 'MISSING LABEL'}`)
    assert.ok(ok, `${name}: unlabelled <${c.tag}> ${c.full.slice(0, 100)}`)
  }
}

test('index.html: every control has an accessible name', (t) => checkHtmlFile(t, INDEX_HTML, 'index.html'))
test('floor.html: every control has an accessible name', (t) => checkHtmlFile(t, FLOOR_HTML, 'floor.html'))

// ---- (b) controls created by board.js / floor.js ----
function extractElCalls(src, tags) {
  const out = []
  const re = new RegExp(`el\\(\\s*'(${tags.join('|')})'`, 'g')
  let m
  while ((m = re.exec(src))) {
    const openIdx = src.indexOf('(', m.index)
    const closeIdx = matchDelims(src, openIdx, '(', ')')
    if (closeIdx === -1) continue
    out.push({ tag: m[1], text: src.slice(m.index, closeIdx + 1) })
  }
  return out
}

function jsChildrenText(call) {
  const braceOpen = call.text.indexOf('{')
  if (braceOpen === -1) return ''
  const braceClose = matchDelims(call.text, braceOpen, '{', '}')
  const rest = braceClose === -1 ? call.text : call.text.slice(braceClose + 1)
  const bracketOpen = rest.indexOf('[')
  if (bracketOpen === -1) return ''
  const bracketClose = matchDelims(rest, bracketOpen, '[', ']')
  return bracketClose === -1 ? '' : rest.slice(bracketOpen, bracketClose + 1)
}

function checkJsControls(t, src, name) {
  const calls = extractElCalls(src, ['button', 'input', 'select', 'textarea', 'a'])
  assert.ok(calls.length > 3, `expected several el() controls in ${name}, found ${calls.length}`)
  for (const call of calls) {
    const hasAria = /'aria-label'\s*:/.test(call.text)
    const children = jsChildrenText(call)
    const hasText = ['button', 'a'].includes(call.tag) && children.replace(/[[\]\s'"]/g, '').length > 0
    const ok = hasAria || hasText
    t.diagnostic(`${name}: <${call.tag}> ${call.text.slice(0, 70).replace(/\s+/g, ' ')}… -> ${ok ? 'labelled' : 'MISSING LABEL'}`)
    assert.ok(ok, `${name}: unlabelled <${call.tag}> created at: ${call.text.slice(0, 140)}`)
  }
}

test('board.js: every control it creates has an accessible name', (t) => checkJsControls(t, BOARD_JS, 'board.js'))
test('floor.js: every control it creates has an accessible name', (t) => checkJsControls(t, FLOOR_JS, 'floor.js'))
test('history.js: every control it creates has an accessible name', (t) => checkJsControls(t, HISTORY_JS, 'history.js'))
// sessions.js draws the terminal rows, the hand-off picker and the ladder
// editor, and until the ladder landed it was scanned by nothing: its header
// says so in as many words. Every control it builds now carries a visible name
// or an 'aria-label' by test rather than by hand rule. A checkbox inside a
// <label> is named correctly in a browser, but this scan reads source and
// cannot see the wrapper, so those carry an explicit aria-label with the same
// words as the label beside them.
test('sessions.js: every control it creates has an accessible name', (t) => checkJsControls(t, readFileSync(join(ROOT, 'src/board/sessions.js'), 'utf8'), 'sessions.js'))

// .chip is flat by design: no padding, no background, colour only. Anything
// that sets one beside other text therefore has to supply the gap itself, or
// the two render welded — `claudeclaude-2fbf`, `Files2 changed`, `10:40 AMstarted`.
// This has now been fixed three times in three different containers, so the
// rule is pinned rather than remembered.
test('every container that puts a flat chip beside other text declares a gap', () => {
  const flat = CSS.match(/^\.chip \{([^}]*)\}/m)
  assert.ok(flat, 'expected a .chip rule in board.css')
  assert.doesNotMatch(flat[1], /padding|background/, '.chip is flat: if it gains padding, these gaps can go')

  for (const sel of ['.detail-heading', '.cap-line', '.file-row']) {
    const body = extractCssBlock(CSS, `${sel} {`)
    assert.match(body, /display:\s*(inline-)?flex/, `${sel} must lay its children out with flex`)
    assert.match(body, /gap:\s*\d/, `${sel} must declare a gap, or its chips weld to the text before them`)
  }

  // the timeline row keeps its summary on its own line, so it spaces the two
  // inline spans directly instead of going flex
  assert.match(CSS, /\.turn-when \+ \.turn-role \{[^}]*margin-left:\s*\d/, 'the kind word needs space after the clock')
})

test('the file row carries the class its gap is written against', () => {
  const SESSIONS_JS = readFileSync(join(ROOT, 'src/board/sessions.js'), 'utf8')
  assert.match(SESSIONS_JS, /class: 'btn btn-text file-row'/, 'fileRow must keep the file-row class')
})

// The card row shipped with .r1 .r2 .r3 .r4 carrying no rule at all, so the
// Background tasks rows rendered on browser defaults while every other row on
// the board had been ported. A class that reaches the DOM and has no rule is
// either dead or a miss; both are worth knowing about, so the exceptions are
// listed by name with a reason rather than left to a grep.
const NO_RULE_NEEDED = new Set([
  // queried from JS as selectors, never styled. `region-background` is the
  // Background panel that holds the live cards: its rows are `.term` rows and
  // its head is a `.section-head`, exactly as the terminals region, so the
  // section itself carries no rule of its own either.
  'region-settings', 'region-terminals', 'region-finished', 'region-trunk', 'region-history',
  'region-background',
  'disclosure', 'default-order', 'finished-list', 'trunk-list',
  'region', 'region-title', 'lease-blocked-row',
  // floor table columns: the cells are styled through table/th/td
  'c-agent', 'c-blocked', 'c-card', 'c-event', 'c-lease', 'c-leases',
  'c-station', 'c-status', 'c-summary',
])

const CLASS_TOKEN = /^[A-Za-z][\w-]*$/
function classesUsedIn(src) {
  const used = new Set()
  for (const m of src.matchAll(/class: [`'"]([^`'"]+)[`'"]/g)) {
    for (const c of m[1].split(/\s+/)) if (CLASS_TOKEN.test(c)) used.add(c)
  }
  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (CLASS_TOKEN.test(c)) used.add(c)
  }
  return used
}

test('every class the board puts in the DOM has a rule in board.css', () => {
  const declared = new Set()
  for (const m of CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)) declared.add(m[1])

  const SESSIONS_JS = readFileSync(join(ROOT, 'src/board/sessions.js'), 'utf8')
  const sources = {
    'board.js': BOARD_JS, 'sessions.js': SESSIONS_JS, 'floor.js': FLOOR_JS, 'history.js': HISTORY_JS,
    'index.html': INDEX_HTML, 'floor.html': FLOOR_HTML,
  }
  const missing = []
  for (const [name, src] of Object.entries(sources)) {
    for (const c of classesUsedIn(src)) {
      if (declared.has(c) || NO_RULE_NEEDED.has(c)) continue
      missing.push(`${name}: .${c}`)
    }
  }
  assert.deepEqual(missing, [], `these classes reach the DOM with no rule in board.css: ${missing.join(', ')}`)
})

// scheduler.mjs writes `blocked by <holder> on <lease> (against <lease>)` as the
// event summary, and the floor's column is already headed "Blocked by". Adding
// a second prefix printed `blocked by blocked by card "X" on src/**`, which sat
// in docs/screenshots/floor-landing.png for four days before anyone read it.
test('the floor does not re-prefix a blocked_by summary that already says it', () => {
  const cell = FLOOR_JS.split('\n').find((l) => l.includes("'data-label': 'Blocked by'"))
  assert.ok(cell, "expected the floor's Blocked by cell in floor.js")
  assert.doesNotMatch(cell, /blocked by \$\{/, 'the summary already opens with "blocked by"')
})

// D14: the keyboard map is the list of bindings, and every binding CLICKS a
// button that is already on the row. Two ways to fail: a map row naming a
// button that does not exist, and a key the handler acts on that the map never
// mentions. Both are checked against the source of sessions.js itself, which
// is where both tables live.
const SESSIONS_SRC = readFileSync(join(ROOT, 'src/board/sessions.js'), 'utf8')

function tableLiteral(name) {
  const at = SESSIONS_SRC.indexOf(`const ${name} = [`)
  assert.ok(at > 0, `expected ${name} in sessions.js`)
  const open = SESSIONS_SRC.indexOf('[', at)
  return SESSIONS_SRC.slice(open, matchDelims(SESSIONS_SRC, open, '[', ']') + 1)
}

test('every key in the map presses a button that exists on the row', () => {
  const rows = [...tableLiteral('KEY_BUTTONS').matchAll(/\{ key: '(.+?)', focus: '(.+?)', button: '(.+?)' \}/g)]
  assert.equal(rows.length, 4, 'h, l, d and e')
  for (const [, key, focus, button] of rows) {
    assert.ok(SESSIONS_SRC.includes(`'data-focus-key': \`${focus}:`), `${key} presses a button with no data-focus-key "${focus}:" in sessions.js`)
    assert.ok(SESSIONS_SRC.includes(`'${button}'`), `${key} names a button labelled "${button}" that sessions.js never builds`)
  }
})

test('every key the board handles is named in the map it opens', () => {
  const moves = [...tableLiteral('KEY_MOVES').matchAll(/\{ key: '(.+?)', what: '(.+?)' \}/g)].map((m) => m[1])
  assert.deepEqual(moves, ['j', 'k', '1 to 9', '?', 'Escape'])
  const handler = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('function boardKey'))
  for (const key of ['j', 'k', '?']) assert.ok(handler.includes(`e.key === '${key}'`), `${key} is in the map and not in the handler`)
  assert.ok(handler.includes('/^[1-9]$/.test(e.key)'), '1 to 9 is in the map and not in the handler')
  assert.ok(SESSIONS_SRC.includes("if (e.key === 'Escape')"), 'Escape is in the map and not in the handler')
  // a key pressed into a field is text, not a command
  assert.ok(SESSIONS_SRC.includes("tag === 'input' || tag === 'select' || tag === 'textarea'"), 'the handler must stand down while a field has focus')
})

// A dialog's accessible name replaces its contents for a screen reader, so an
// aria-label that does not match the heading on screen gives two names to one
// thing: the voice-control user says the visible one and finds no control.
test('every dialog is announced by the heading it shows', () => {
  const dialogs = [...INDEX_HTML.matchAll(/<dialog\b([^>]*)>([\s\S]*?)<\/dialog>/g)]
  assert.ok(dialogs.length, 'index.html has at least one dialog')
  for (const [, attrs, body] of dialogs) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1] || '(no id)'
    const heading = /<h2[^>]*class="dialog-title"[^>]*>([^<]+)<\/h2>/.exec(body)?.[1]?.trim()
    assert.ok(heading, `${id} has no visible .dialog-title heading`)
    const labelledBy = /\baria-labelledby="([^"]+)"/.exec(attrs)?.[1]
    const label = /\baria-label="([^"]+)"/.exec(attrs)?.[1]
    if (labelledBy) {
      const target = new RegExp(`id="${labelledBy}"[^>]*>([^<]+)<`).exec(body)?.[1]?.trim()
      assert.equal(target, heading, `${id}: aria-labelledby points at something other than its heading`)
      assert.equal(label, undefined, `${id}: an aria-label beside aria-labelledby is a second name`)
    } else {
      assert.equal(label, heading, `${id}: the announced name and the heading on screen say different things`)
    }
  }
})
