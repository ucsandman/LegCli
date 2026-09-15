// Seeds a throwaway BATON_HOME with a floor that has something in every lane:
// two cards running, two waiting on a human, one queued and blocked by a lease
// another card holds, and a landing on the trunk. The floor is derived entirely
// from card records and their events (server.mjs floor()), so the states are
// written straight to the ledger rather than driven through real runs.
//
//   BATON_HOME=<dir> node scripts/seed-floor-board.mjs <repo path>
//
// Serve it on a spare port with BATON_TRUST=never. NEVER 4747.
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.BATON_HOME ||= join(tmpdir(), 'baton-floor-board')
const repo = process.argv[2] || join(tmpdir(), 'toy-demo')
const { createCard } = await import('../src/cards.mjs')
const { ledgerAppend, ledgerUpdate, cardDir } = await import('../src/store.mjs')
const { mkdirSync, writeFileSync } = await import('node:fs')

// one run record per card, started far enough back that the elapsed column
// shows a real number rather than 00:00
function writeRun(id, startedMsAgo) {
  const dir = join(cardDir(id), 'runs', '1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(cardDir(id), 'runs', '1', 'run.json'), JSON.stringify({
    run: 1, adapter: 'fake-claude', status: 'running',
    started_at: new Date(Date.now() - startedMsAgo).toISOString(),
  }, null, 2))
}

const min = 60_000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

const rows = [
  { title: 'Lease holder', task: 'Rewrite the retry path in the fetch wrapper', chain: 'fake-claude,fake-codex',
    leases: 'src/**', status: 'running', leg: 0, started: 42_000,
    event: ['leg_started', 'leg started: adapter=fake-claude run=6 mode=default'] },
  { title: 'Bounced by land', task: 'Dedupe the blocked events on the floor', chain: 'fake-codex',
    leases: 'b.mjs', status: 'running', leg: 0, started: 35_000,
    event: ['leg_started', 'leg started: adapter=fake-codex run=12 mode=default'] },
  { title: 'Paused', task: 'Trim the README install block', chain: 'fake-claude',
    leases: 'README.md', status: 'paused', leg: 0, started: 9 * min,
    event: ['paused', 'paused by local'] },
  { title: 'Waiting for human', task: 'Confirm the new pricing copy before it lands', chain: 'fake-claude,fake-codex',
    leases: 'site/**', status: 'needs_approval', leg: 1, started: 4 * min,
    event: ['approval_needed', 'fake-claude → fake-codex needs approval before leg 1'] },
  { title: 'Blocked by lease', task: 'Guard the null station in the scheduler', chain: 'fake-claude',
    leases: 'src/x/**', status: 'queued', leg: 0, started: 2 * min,
    event: ['blocked_by', 'blocked by card "Lease holder" on src/** (against src/x/**)'] },
]

const made = []
for (const r of rows) {
  const card = await createCard({ repo, task: r.task, title: r.title, chain: r.chain, leases: r.leases }, { type: 'human', id: 'seed' })
  const id = card.card_id
  ledgerUpdate(id, { status: r.status, station: 'build', leg: r.leg })
  ledgerAppend(id, { type: r.event[0], summary: r.event[1], station: 'build', leg: r.leg })
  // the floor clocks a running card from its active run, and falls back to
  // updated_at: without a run record every row read 00:00
  writeRun(id, r.started)
  made.push(`${r.title} -> ${r.status}`)
}

// one card already landed on the trunk, so the trunk lane is not empty
const landed = await createCard({ repo, task: 'Add the landing note to the changelog', title: 'Add landing note', chain: 'fake-claude' }, { type: 'human', id: 'seed' })
ledgerUpdate(landed.card_id, { status: 'done', station: 'build', leg: 0 })
ledgerAppend(landed.card_id, { type: 'landed', summary: 'landed on main: 5714348 → b0c888f (1 file, +1/-0)', station: 'build', leg: 0 })
made.push(`Add landing note -> landed ${ago(90_000).slice(11, 16)}`)

console.log(`seeded ${made.length} cards into ${process.env.BATON_HOME}\n  ${made.join('\n  ')}`)
