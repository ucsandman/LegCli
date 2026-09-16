#!/usr/bin/env node
// seed-fake-cards — fills a LEG_HOME with N backlog cards (fake chain, build
// pipeline) through the same path the CLI uses (src/cards.mjs createCard), for
// perf tests and manual board load-testing.
//   node scripts/seed-fake-cards.mjs --home <dir> --repo <git repo path> --count 50
import { resolve } from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i++ }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.home) { process.stderr.write('usage: seed-fake-cards.mjs --home <dir> --repo <git repo path> [--count 50]\n'); process.exit(2) }
if (!args.repo) { process.stderr.write('usage: seed-fake-cards.mjs --home <dir> --repo <git repo path> [--count 50]\n'); process.exit(2) }
const count = parseInt(args.count ?? '50', 10) || 50

// LEG_HOME must be set before store.mjs (and the ledger.mjs it imports) load.
process.env.LEG_HOME = resolve(args.home)
process.env.BATON_HOME = process.env.LEG_HOME
const { createCard } = await import('../src/cards.mjs')

const TITLES = ['Add retry to fetch', 'Fix flaky lease test', 'Refactor log tail', 'Wire up SSE health', 'Trim README', 'Bump adapter timeout', 'Dedupe blocked events', 'Guard null station', 'Speed up card list', 'Polish error copy']

let created = 0
for (let i = 0; i < count; i++) {
  const title = `${TITLES[i % TITLES.length]} #${i + 1}`
  await createCard({ repo: args.repo, task: title, title, chain: 'fake' }, { type: 'human', id: 'seed' })
  created += 1
}
process.stdout.write(`seeded ${created} card(s) into ${process.env.BATON_HOME}\n`)
