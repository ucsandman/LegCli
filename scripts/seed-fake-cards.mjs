#!/usr/bin/env node
// seed-fake-cards — fills a LEG_HOME with N backlog cards (fake chain, build
// pipeline) through the same path the CLI uses (src/cards.mjs createCard), for
// perf tests and manual board load-testing. --finished and --live add a
// realistic mix of finished and live cards, driven through humanAction
// (src/orchestrator.mjs) rather than by hand-editing card.json.
//   node scripts/seed-fake-cards.mjs --home <dir> --repo <git repo path> --count 50 --finished 10 --live 3
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
if (!args.home) { process.stderr.write('usage: seed-fake-cards.mjs --home <dir> --repo <git repo path> [--count 50] [--finished 0] [--live 0]\n'); process.exit(2) }
if (!args.repo) { process.stderr.write('usage: seed-fake-cards.mjs --home <dir> --repo <git repo path> [--count 50] [--finished 0] [--live 0]\n'); process.exit(2) }
const count = parseInt(args.count ?? '50', 10) || 50
const finishedCount = parseInt(args.finished ?? '0', 10) || 0
const liveCount = parseInt(args.live ?? '0', 10) || 0

// LEG_HOME must be set before store.mjs (and the ledger.mjs it imports) load.
process.env.LEG_HOME = resolve(args.home)
process.env.BATON_HOME = process.env.LEG_HOME
const { createCard } = await import('../src/cards.mjs')
const { humanAction } = await import('../src/orchestrator.mjs')

const TITLES = ['Add retry to fetch', 'Fix flaky lease test', 'Refactor log tail', 'Wire up SSE health', 'Trim README', 'Bump adapter timeout', 'Dedupe blocked events', 'Guard null station', 'Speed up card list', 'Polish error copy']
const actor = { type: 'human', id: 'seed' }

let created = 0
for (let i = 0; i < count; i++) {
  const title = `${TITLES[i % TITLES.length]} #${i + 1}`
  await createCard({ repo: args.repo, task: title, title, chain: 'fake' }, actor)
  created += 1
}

// Finished cards: queue, start, then drive a leg_result straight to done or
// failed. `chain: 'fake'` has no fallback, so a `failed` outcome exhausts the
// chain immediately (src/chain.mjs leg_result) instead of handing off.
let done = 0
let failed = 0
for (let i = 0; i < finishedCount; i++) {
  const wantDone = i % 2 === 0
  const title = `Seeded finished card #${i + 1}`
  const card = await createCard({ repo: args.repo, task: title, title, chain: 'fake', queue: true }, actor)
  humanAction(card.card_id, 'start', {}, actor)
  humanAction(card.card_id, 'leg_result', { outcome: wantDone ? 'completed' : 'failed', adapter: 'fake' }, actor)
  if (wantDone) done += 1
  else failed += 1
}

// Live cards: cycle through queued, running, needs_approval and paused, each
// reached through the same transitions a real run takes. `fake=sleep` keeps a
// running (or queued, on a board that is actually driving its scheduler) card
// from finishing out from under the board the moment it is looked at.
const LIVE_KINDS = ['queued', 'running', 'needs_approval', 'paused']
const liveSeeded = { queued: 0, running: 0, needs_approval: 0, paused: 0 }
for (let i = 0; i < liveCount; i++) {
  const kind = LIVE_KINDS[i % LIVE_KINDS.length]
  const title = `Seeded live card #${i + 1}`
  if (kind === 'needs_approval') {
    // a second, approval-gated leg to hand off into
    const card = await createCard({ repo: args.repo, task: title, title, chain: 'fake-claude,fake-codex', approve: 'fake-codex', queue: true }, actor)
    humanAction(card.card_id, 'start', {}, actor)
    humanAction(card.card_id, 'leg_result', { outcome: 'incomplete', adapter: 'fake-claude' }, actor)
    humanAction(card.card_id, 'bundle_written', {}, actor)
  } else {
    const card = await createCard({ repo: args.repo, task: title, title, chain: 'fake', fake_mode: 'fake=sleep', queue: true }, actor)
    if (kind === 'running' || kind === 'paused') humanAction(card.card_id, 'start', {}, actor)
    if (kind === 'paused') humanAction(card.card_id, 'pause', {}, actor)
  }
  liveSeeded[kind] += 1
}

// test/perf.test.mjs matches "seeded N card(s)" as a substring, so the
// original --count-only sentence stays intact; the finished/live counts are
// appended rather than folded into it.
const liveSummary = LIVE_KINDS.map((k) => `${liveSeeded[k]} ${k}`).join(', ')
const extra = []
if (finishedCount) extra.push(`${finishedCount} finished (${done} done, ${failed} failed)`)
if (liveCount) extra.push(`${liveCount} live (${liveSummary})`)
const suffix = extra.length ? `, ${extra.join(', ')}` : ''
process.stdout.write(`seeded ${created} card(s)${suffix} into ${process.env.BATON_HOME}\n`)
