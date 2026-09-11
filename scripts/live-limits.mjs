#!/usr/bin/env node
// live-limits — flip the docs rows for the interactive walls from docs-only to
// observed-live once fixtures/live/<agent>/limit-<signal>.json exists (written
// by src/live-capture.mjs the first time the real signal arrives). Each row in
// docs/adapters.md and docs/cli-contracts.md carries a marker
// `<!-- live:<agent>/<signal> -->` right after its status word.
//   node scripts/live-limits.mjs          rewrite the rows
//   node scripts/live-limits.mjs --check  exit 1 when a row is stale
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = process.env.BATON_LIVE_DIR || join(ROOT, 'fixtures', 'live')
const DOCS = ['docs/adapters.md', 'docs/cli-contracts.md'].map((p) => join(ROOT, p))
const MARK = /\*\*(docs-only|observed-live(?: [0-9-]+)?)\*\* <!-- live:([a-z]+)\/([a-z_-]+) -->/g

let stale = 0
for (const doc of DOCS) {
  const text = readFileSync(doc, 'utf8')
  const next = text.replace(MARK, (whole, _status, agent, signal) => {
    const f = join(LIVE, agent, `limit-${signal}.json`)
    if (!existsSync(f)) return whole
    let day = ''
    try { day = String(JSON.parse(readFileSync(f, 'utf8')).captured_at ?? '').slice(0, 10) } catch {}
    return `**observed-live${day ? ' ' + day : ''}** <!-- live:${agent}/${signal} -->`
  })
  if (next !== text) {
    stale += 1
    if (!process.argv.includes('--check')) { writeFileSync(doc, next); process.stdout.write(`live-limits: updated ${doc}\n`) }
    else process.stdout.write(`live-limits: STALE ${doc}\n`)
  }
}
const rows = DOCS.reduce((n, d) => n + (readFileSync(d, 'utf8').match(MARK) ?? []).length, 0)
process.stdout.write(`live-limits: rows=${rows} ${process.argv.includes('--check') ? `stale=${stale}` : `updated=${stale}`}\n`)
process.exit(process.argv.includes('--check') && stale ? 1 : 0)
