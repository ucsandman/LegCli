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
