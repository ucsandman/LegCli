// Screenshots and measures the board at both widths, reporting the numbers that
// caught real defects in the v4 redesign: full-page height, per-row height,
// horizontal overflow, the computed font-size floor, console errors, and a
// scroll-hold probe. Point it at a board seeded by scripts/seed-wes-board.mjs.
//
//   node scripts/board-shots.mjs <port> <tag>
//
// networkidle never fires on this board because it polls, so it waits for real
// content instead.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '4861'
const tag = process.argv[3] || 'run'
const out = fileURLToPath(new URL('./shots/', import.meta.url))
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const report = {}

for (const w of [1280, 400]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  // networkidle never fires: the board polls. Wait for real content instead.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('[class*="term"], .session-list > *, .panel').length > 0, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)

  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.term, .session-list > *')]
    const px = (n) => Math.round(n)
    const small = [...document.querySelectorAll('body *')]
      .filter((e) => e.textContent.trim() && !e.children.length)
      .map((e) => ({ t: e.textContent.trim().slice(0, 28), s: parseFloat(getComputedStyle(e).fontSize) }))
      .filter((x) => x.s < 14)
    return {
      pageHeight: px(document.documentElement.scrollHeight),
      docWidth: px(document.documentElement.scrollWidth),
      viewport: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      rowCount: rows.length,
      rowHeights: rows.map((r) => px(r.getBoundingClientRect().height)),
      belowFontFloor: small.slice(0, 6),
    }
  })

  // the fold is shot before anything scrolls the page, or it is a mid-page crop
  await page.screenshot({ path: `${out}${tag}-${w}-fold.png` })

  // scroll-hold: park the viewport, wait through every timer the page owns,
  // assert it did not move.
  await page.evaluate(() => window.scrollTo(0, 600))
  const before = await page.evaluate(() => window.scrollY)
  await page.waitForTimeout(6000)
  const after = await page.evaluate(() => window.scrollY)
  m.scrollHeld = before === after
  m.scrollDrift = after - before
  m.consoleErrors = errors

  await page.screenshot({ path: `${out}${tag}-${w}.png`, fullPage: true })
  report[w] = m
  await page.close()
}

await browser.close()
console.log(JSON.stringify(report, null, 2))
