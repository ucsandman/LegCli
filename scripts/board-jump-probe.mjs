// board-jump-probe — the regression harness for "the page keeps jumping around
// and knocking me out of what I'm doing".
//
// A reader with a terminal expanded, the pointer inside the expansion and the
// Timeline in view is reading a region whose position on the page is decided by
// the rows ABOVE it. Every push re-sorts the list (needs-you first), rebuilds
// every row from scratch, and a row that grew a waiting sentence, or moved
// across the needs-you partition, takes the expansion with it. scrollY does not
// change, so no scroll-hold probe can see it; what moves is the content under a
// still viewport.
//
// This drives exactly that: seeds a board, expands the last live row, scrolls
// the Timeline into view, focuses a control and selects a sentence inside the
// expansion, then over ten pushes appends events and flips a row ABOVE it into
// needs-you. It records, per push, where the region sits in the viewport, what
// has focus, and whether the selection survived.
//
//   node scripts/board-jump-probe.mjs            # ten pushes, prints a table
//   node scripts/board-jump-probe.mjs --json     # the same, as JSON
//
// The verdict line is the whole point: regionTop must not move by more than
// 2px, focus must not be lost, and the selection must survive. NEVER port 4747,
// that is the operator's live board; this one binds an ephemeral port of its
// own and kills everything it started.
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const POLLS = 10

const HOME = mkdtempSync(join(tmpdir(), 'leg-jump-probe-'))
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
process.env.LEG_TRUST = 'never'
process.env.BATON_TRUST = 'never'
process.env.LEG_QUIET = '1'
process.env.BATON_QUIET = '1'

function cleanup() {
  try {
    const f = join(HOME, 'sleepers.json')
    if (existsSync(f)) for (const pid of JSON.parse(readFileSync(f, 'utf8'))) { try { process.kill(pid) } catch { /* already gone */ } }
  } catch { /* nothing to kill */ }
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* windows holds a handle sometimes */ }
}
// the seeder's sleepers outlive this process if it dies before the finally, and
// a leaked sleeper is a node process nobody owns, so the exits are covered too
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('SIGINT', () => { cleanup(); process.exit(130) })

// the seeder spawns detached sleepers so the live rows have a runner pid that
// reapLost() can find; they are written to sleepers.json and killed at the end
const seed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-wes-board.mjs')], {
  env: { ...process.env }, encoding: 'utf8',
})
if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); cleanup(); process.exit(1) }

const { createBoardServer } = await import('../src/server.mjs')
const { updateSession, appendEvent } = await import('../src/sessions.mjs')

// the four live rows the seeder writes, in the order renderSessions sorts them:
// needs-you first (0049, 0257), then started_at ascending (0213, 0455).
// The expansion hangs under a RUNNING row in the middle of the list, which is
// where a reader actually leaves it, and the row that flips is the one BELOW
// it: crossing into needs-you sends that row to the top of the list and pushes
// the expansion — and everything the reader is looking at — down the page.
const EXPANDED = 's-20260915-0213-claude-95d3'
const FLIPS = 's-20260915-0455-claude-8e8a'

const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
const { port } = await srv.start()
const base = `http://127.0.0.1:${port}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let browser = null

try {
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  // networkidle never fires: the board polls. Wait for real rows instead.
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#session-grid .term', { timeout: 20000 })
  await sleep(800)

  // ---- scenario 1 (finding 5): the click that opens the expansion ---------
  // The reader is scrolled down the page, looking at the terminals, and presses
  // Details. #session-drawer is still parked at the end of <body> at that
  // moment, so an anchor measured there is hundreds of pixels below where the
  // region will land, and putting it "back" scrolls the whole window. Nothing
  // the reader asked for moved, so scrollY must not move either.
  await page.evaluate(() => window.scrollTo(0, 400))
  await sleep(250)
  const openBefore = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    drawerParent: document.getElementById('session-drawer')?.parentNode?.id || document.getElementById('session-drawer')?.parentNode?.tagName || 'none',
  }))
  // .click() on the element itself, not page.click(): Playwright scrolls a
  // target into view before it clicks, which would move the page for us and
  // hide the very displacement this scenario measures.
  await page.evaluate((key) => document.querySelector(`[data-focus-key="${key}"]`)?.click(), `details:${EXPANDED}`)
  await page.waitForSelector('#session-drawer:not([hidden]) .drawer-timeline', { timeout: 20000 })
  await sleep(1200)
  const openAfter = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    drawerParent: document.getElementById('session-drawer')?.parentNode?.id || document.getElementById('session-drawer')?.parentNode?.tagName || 'none',
  }))
  const openDrift = Math.abs(openAfter.scrollY - openBefore.scrollY)

  // scroll so the Timeline is in view, which is where the reader is
  await page.evaluate(() => {
    const t = document.querySelector('#session-drawer [data-scroll-key="timeline"]')
    if (t) window.scrollTo(0, Math.max(0, window.scrollY + t.getBoundingClientRect().top - 300))
  })
  await sleep(300)

  // a control the reader tabbed to, and a sentence they are half way through
  // selecting: both live inside the expansion and both must survive a push
  await page.evaluate(() => {
    document.querySelector('#session-drawer [data-focus-key="drawer-pause"]')?.focus({ preventScroll: true })
    const p = document.querySelector('#session-drawer .drawer-timeline .timeline-summary')
    if (p && p.firstChild) {
      const r = document.createRange()
      r.selectNodeContents(p)
      const sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
    }
  })

  const read = () => page.evaluate(() => {
    const region = document.getElementById('session-drawer')
    const rect = region ? region.getBoundingClientRect() : null
    const a = document.activeElement
    const timeline = document.querySelector('#session-drawer [data-scroll-key="timeline"]')
    const sel = document.getSelection()
    return {
      scrollY: Math.round(window.scrollY),
      regionTop: rect ? Math.round(rect.top) : null,
      docTop: rect ? Math.round(rect.top + window.scrollY) : null,
      focus: a ? (a.getAttribute?.('data-focus-key') || a.id || a.tagName) : 'none',
      selection: sel ? String(sel).trim().slice(0, 28) : '',
      timelineScroll: timeline ? Math.round(timeline.scrollTop) : null,
      rows: [...document.querySelectorAll('#session-grid .term')].map((r) => r.getAttribute('data-session-id').slice(-4)).join(' '),
      lines: document.querySelectorAll('#session-drawer .drawer-timeline .timeline-item').length,
      // the volume behind the verdict: the raw events those lines stand for,
      // counting a collapsed line as the ×N it carries
      shows: [...document.querySelectorAll('#session-drawer .drawer-timeline .timeline-item')]
        .reduce((n, it) => n + (Number((it.querySelector('.timeline-count')?.textContent || '').replace('×', '')) || 1), 0),
      repeat: document.querySelector('#session-drawer .timeline-count')?.textContent || '',
    }
  })

  const rows = [{ poll: 0, what: 'settled', ...await read() }]

  for (let i = 1; i <= POLLS; i++) {
    // a status event on the expanded terminal, the usage-poll spam Wes sees
    appendEvent(EXPANDED, { type: 'status', summary: 'usage read: claude default, five_hour 38%' })
    let what = 'event'
    // and half way through, a row ABOVE it crosses into the needs-you partition
    if (i === 4) {
      updateSession(FLIPS, { status: 'warning', waiting: { type: 'idle_prompt', message: 'Claude is waiting for your input', since: new Date().toISOString() } })
      what = 'row above -> needs-you'
    }
    if (i === 8) {
      updateSession(FLIPS, { status: 'running', waiting: null })
      what = 'row above -> running'
    }
    // 1500ms, not 2200: the region's stand-down under a live selection is
    // capped at DRAWER_HOLD_MS (20s, scenario 3 below), so this phase has to
    // finish inside that cap for "the selection survived every poll" to be a
    // statement about the stand-down rather than about the cap.
    await sleep(1500)
    rows.push({ poll: i, what, ...await read() })
  }

  // A region that stands down while the reader is selecting text holds its
  // selection trivially, by never redrawing again. The reader letting go is the
  // other half of the contract: the events that arrived while they were reading
  // must land, and the flood of identical status lines must be one line by now.
  const held = rows.length - 1
  await page.evaluate(() => document.getSelection().removeAllRanges())
  for (let i = POLLS + 1; i <= POLLS + 3; i++) {
    appendEvent(EXPANDED, { type: 'status', summary: 'usage read: claude default, five_hour 38%' })
    let what = 'let go'
    if (i === POLLS + 2) {
      updateSession(FLIPS, { status: 'warning', waiting: { type: 'idle_prompt', message: 'Claude is waiting for your input', since: new Date().toISOString() } })
      what = 'row above -> needs-you'
    }
    await sleep(2200)
    rows.push({ poll: i, what, ...await read() })
  }

  const EXP4 = EXPANDED.slice(-4)
  const FLIP4 = FLIPS.slice(-4)

  // ---- scenario 2 (finding 6): the needs-you sort under an expansion -------
  // The resting state of a dashboard is one terminal expanded and nobody
  // touching the machine. A different terminal then hits a permission prompt.
  // The hold on `expanded` had no time bound at all, so that row stayed
  // wherever it was for as long as the expansion was open: the board knew (the
  // row went urgent, the tab badge counted it) and would not surface it. It
  // gets the same ORDER_HOLD_MS release hovering and focus already had. What
  // must not move is the expansion's offset in the viewport, which is
  // holdAnchor's job, so both halves are measured here.
  updateSession(FLIPS, { status: 'running', waiting: null })
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  })
  await page.mouse.move(2, 2)
  await sleep(4500)
  const settled = await read()
  updateSession(FLIPS, { status: 'warning', waiting: { type: 'idle_prompt', message: 'Claude is waiting for your input', since: new Date().toISOString() } })
  const late = [{ at: 0, what: 'flipped below', ...settled }]
  for (let t = 3; t <= 39; t += 3) {
    await sleep(3000)
    late.push({ at: t, what: '', ...await read() })
  }
  const surfaced = (r) => r.rows.indexOf(FLIP4) >= 0 && r.rows.indexOf(FLIP4) < r.rows.indexOf(EXP4)
  const appliedAt = late.find(surfaced)
  const lateDrift = Math.max(...late.map((r) => Math.abs(r.regionTop - settled.regionTop)))

  // ---- scenario 3 (finding 18): a selection must not freeze the region -----
  // A double-click leaves an uncollapsed selection behind. The stand-down had
  // no time bound either, so a reader who picked out a path and kept reading
  // never saw another turn land: twelve finished and none of them appeared in
  // sixty seconds, with nothing on screen saying the region was stale. The
  // stand-down is capped at DRAWER_HOLD_MS; the selection dies with the redraw
  // that ends it, which is the price of the reader seeing what is happening.
  await page.evaluate(() => {
    const p = document.querySelector('#session-drawer .drawer-timeline .timeline-summary')
    if (p && p.firstChild) {
      const r = document.createRange()
      r.selectNodeContents(p)
      const sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
    }
  })
  await sleep(600)
  const frozenBase = await read()
  // distinct summaries, so collapseEvents cannot fold them into one line and
  // hide the fact that nothing was drawn
  for (let n = 1; n <= 6; n++) appendEvent(EXPANDED, { type: 'turn', summary: `turn ${n} finished, ${n} files` })
  const frozen = [{ at: 0, ...frozenBase }]
  for (let t = 5; t <= 45; t += 5) {
    await sleep(5000)
    frozen.push({ at: t, ...await read() })
  }
  const thawedAt = frozen.find((r) => r.shows > frozenBase.shows)

  const base0 = rows[0]
  const drift = (r) => Math.abs(r.regionTop - base0.regionTop)
  const worst = Math.max(...rows.map(drift))
  const focusLost = rows.filter((r) => r.focus !== base0.focus).length
  const selLost = rows.slice(0, held + 1).filter((r) => !r.selection).length
  const last = rows[rows.length - 1]
  const caughtUp = last.shows - rows[0].shows
  const verdict = {
    pollsHoldingASelection: held,
    pollsAfterLettingGo: rows.length - 1 - held,
    baselineRegionTop: base0.regionTop,
    worstRegionTopDrift: worst,
    scrollYDrift: Math.max(...rows.map((r) => Math.abs(r.scrollY - base0.scrollY))),
    focusLostPolls: focusLost,
    selectionLostPolls: selLost,
    eventsAfterLettingGo: caughtUp,
    timelineLines: last.lines,
    repeatCollapsedTo: last.repeat,
    // scenario 1: the click that opens the expansion
    openScrollYBefore: openBefore.scrollY,
    openScrollYAfter: openAfter.scrollY,
    openScrollYDrift: openDrift,
    // scenario 2: the needs-you sort under an expansion
    needsYouSurfacedAfterS: appliedAt ? appliedAt.at : null,
    orderSamples: late.length,
    regionTopDriftWhileResorting: lateDrift,
    // scenario 3: the region under a forgotten selection
    regionCaughtUpAfterS: thawedAt ? thawedAt.at : null,
    eventsHeldBack: 6,
    eventsLanded: thawedAt ? thawedAt.shows - frozenBase.shows : 0,
    consoleErrors: errors,
    pass: worst <= 2 && focusLost === 0 && selLost === 0 && caughtUp >= POLLS && last.repeat !== ''
      && openDrift <= 2
      && Boolean(appliedAt) && lateDrift <= 2
      && Boolean(thawedAt) && thawedAt.at <= 45,
  }

  if (asJson) console.log(JSON.stringify({ rows, open: [openBefore, openAfter], late, frozen, verdict }, null, 2))
  else {
    const table = (title, cols, data) => {
      console.log(title)
      const w = cols.map((c) => Math.max(c.length, ...data.map((r) => String(r[c] ?? '').length)))
      const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ')
      console.log(line(cols))
      console.log(w.map((n) => '-'.repeat(n)).join('  '))
      for (const r of data) console.log(line(cols.map((c) => r[c])))
      console.log('')
    }
    table('the expansion under ten pushes (a selection held, then let go)',
      ['poll', 'what', 'scrollY', 'regionTop', 'docTop', 'focus', 'selection', 'lines', 'shows', 'repeat', 'rows'], rows)
    table('scenario 1: the click that opens the expansion (finding 5)',
      ['when', 'scrollY', 'drawerParent'],
      [{ when: 'before Details', ...openBefore }, { when: 'after Details', ...openAfter }])
    table('scenario 2: a terminal goes needs-you under an open expansion (finding 6)',
      ['at', 'what', 'rows', 'regionTop', 'scrollY'], late)
    table('scenario 3: the region under a forgotten selection (finding 18)',
      ['at', 'lines', 'shows', 'selection'], frozen)
    console.log(`regionTop drift: ${worst}px (must be <= 2)   scrollY drift: ${verdict.scrollYDrift}px`)
    console.log(`focus lost on ${focusLost} of ${rows.length - 1} polls   selection lost on ${selLost} of ${held} polls holding one`)
    console.log(`after letting go: ${caughtUp} new events landed in the region, drawn as ${last.lines} line${last.lines === 1 ? '' : 's'}, repeats collapsed to ${last.repeat || 'nothing'}`)
    console.log(`opening the expansion moved the page ${openDrift}px (${openBefore.scrollY} -> ${openAfter.scrollY}, must be <= 2)`)
    console.log(appliedAt
      ? `needs-you surfaced ${appliedAt.at}s after the flip, over ${late.length} samples, with the expansion held to ${lateDrift}px in the viewport`
      : `needs-you NEVER surfaced in ${late[late.length - 1].at}s of an open expansion, over ${late.length} samples: rows stayed "${late[late.length - 1].rows}"`)
    console.log(thawedAt
      ? `the region caught up ${thawedAt.at}s after 6 turns landed under a live selection (${thawedAt.shows - frozenBase.shows} of 6 drawn)`
      : `the region NEVER caught up: 6 turns landed and ${frozen[frozen.length - 1].shows - frozenBase.shows} were drawn in ${frozen[frozen.length - 1].at}s`)
    if (errors.length) console.log(`console errors: ${errors.length}\n  ${errors.slice(0, 5).join('\n  ')}`)
    console.log(verdict.pass ? 'PASS: the expansion held still under the reader' : 'FAIL: the page moved under the reader')
  }
  process.exitCode = verdict.pass ? 0 : 1
} finally {
  await browser?.close().catch(() => {})
  await srv.stop().catch(() => {})
  cleanup()
}
