import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Seeds a throwaway BATON_HOME shaped like a real working board: a few live
// terminals and a larger pile of lost and ended ones, long absolute temp paths,
// and an image tag in a prompt.
//
// Board UI work is measured against THIS, never against a board of healthy
// terminals. Styling scoped to live rows and measured on a clean board reported
// 40px terminal rows while the real screen showed 400px, and that single wrong
// fixture cost more than any other mistake in the v4 redesign.
//
//   node scripts/seed-wes-board.mjs                 # seeds ./scripts/wes-home
//   BATON_HOME=<dir> node scripts/seed-wes-board.mjs
//
// Serve it on an isolated port with a throwaway BATON_HOME and BATON_TRUST=never.
// NEVER 4747: that is the operator's live board with real sessions on it.
// a throwaway home under the OS temp dir, so nothing is written into the repo
process.env.BATON_HOME ||= join(tmpdir(), 'baton-seed-board')
const { createSession, updateSession } = await import('../src/sessions.mjs')
const { recordUsage, markLimited } = await import('../src/usage.mjs')
const { spawn } = await import('node:child_process')
const { writeFileSync } = await import('node:fs')

// reapLost() marks any active session lost when its runner pid is gone, so a
// live row needs a live process behind it. These sleepers are that process and
// nothing else; scratchpad/stop.mjs kills them.
const sleepers = []
function livePid() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' })
  p.unref()
  sleepers.push(p.pid)
  return p.pid
}

const min = 60_000, hour = 60 * min
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const B = String.fromCharCode(92)          // one backslash, unmangled by any shell
const w = (...parts) => parts.join(B)
const P = (...rest) => w('C:', 'Projects', ...rest)
// the shape that matters is LENGTH: a real worktree path under a temp dir runs
// past 90 characters, which is what buried the prompt in the rejected design
const LONG = w('C:', 'Users', 'operator', 'AppData', 'Local', 'Temp', 'agent',
  'C--Projects-baton--baton-worktrees-s-20260915-000000-claude-0000',
  '00000000-0000-0000-0000-000000000000')

const rows = [
  { id: 's-20260915-0049-claude-2fbf', agent: 'claude', status: 'warning', started: 4 * hour + 24 * min,
    cwd: P('baton'), repo: P('baton'), branch: 'main',
    task: 'ultracode run a tournament of ideas to drastically redesign and improve the UI for this project. I do not like the current setup.' },
  { id: 's-20260915-0213-claude-95d3', agent: 'claude', status: 'running', started: 2 * hour + 46 * min,
    cwd: w('C:', 'documents'), repo: null, branch: null, task: null },
  { id: 's-20260915-0257-claude-88e8', agent: 'claude', status: 'warning', started: 2 * hour + 2 * min,
    cwd: P('recruiting-tool'), repo: P('recruiting-tool'), branch: 'main',
    task: `<image name=screenshot.png path=${w('C:', 'Users', 'operator', 'Desktop', 'shot.png')}> [Image #1] sourcing candidates is a huge pain for my friend who recruits on LinkedIn, how can we help` },
  { id: 's-20260915-0455-claude-8e8a', agent: 'claude', status: 'running', started: 5 * min,
    cwd: w('C:', 'Projects'), repo: null, branch: null, task: '/handoff-load verifier-reach-contracts' },
  { id: 's-20260914-2211-claude-4c10', agent: 'claude', status: 'lost', started: 6 * hour, ended: 3 * hour,
    cwd: w(LONG, 'discovery-loop'), repo: P('discovery-loop'), branch: 'main', task: 'run the nightly discovery loop' },
  { id: 's-20260914-2010-codex-7b31', agent: 'codex', status: 'lost', started: 7 * hour, ended: 4 * hour,
    cwd: w(LONG, 'costclaw'), repo: P('costclaw'), branch: 'main', task: 'fix the per-model price table for Opus' },
  { id: 's-20260914-1802-agy-d9f2', agent: 'agy', status: 'lost', started: 9 * hour, ended: 6 * hour,
    cwd: w('C:', 'Projects'), repo: null, branch: null, task: 'summarise yesterday' },
  { id: 's-20260914-1533-claude-a04b', agent: 'claude', status: 'ended', started: 11 * hour, ended: 8 * hour,
    cwd: w(LONG, 'declick'), repo: P('declick'), branch: 'main', task: 'add the web tree verb' },
  { id: 's-20260914-1120-codex-55ac', agent: 'codex', status: 'ended', started: 13 * hour, ended: 10 * hour,
    cwd: P('costclaw'), repo: P('costclaw'), branch: 'main', task: 'monthly rollup excludes refunded calls' },
]

for (const r of rows) {
  createSession({ id: r.id, agent: r.agent, cwd: r.cwd, repo: r.repo, branch: r.branch, argv: [r.agent], runner_pid: r.ended ? 1 : livePid() })
  updateSession(r.id, {
    status: r.status,
    started_at: ago(r.started),
    last_activity: ago(r.ended ?? 0),
    ended_at: r.ended ? ago(r.ended) : null,
    task: r.task,
    turns: r.task ? 12 : 0,
    files_touched: r.repo ? [w(r.cwd, 'src', 'board', 'board.css'), w(r.cwd, 'src', 'board', 'sessions.js')] : [],
  })
}

recordUsage('claude', 'default',
  { five_hour: { pct: 38, resets_at: Math.floor((Date.now() + 3 * hour) / 1000) },
    seven_day: { pct: 95, resets_at: Math.floor((Date.now() + 40 * hour) / 1000) } },
  'statusline', { observed_at: ago(2 * hour + 13 * min) })
markLimited('codex', 'default', { resets_at: Math.floor((Date.now() + 29 * hour) / 1000), reason: 'limit', source: 'hook' })
// agy publishes no usage figure, ever. Left unwritten on purpose.

writeFileSync(join(process.env.BATON_HOME, 'sleepers.json'), JSON.stringify(sleepers))
const live = rows.filter((r) => !r.ended).length
console.log(`seeded ${rows.length} sessions (${live} live, ${rows.length - live} finished) into ${process.env.BATON_HOME}`)
