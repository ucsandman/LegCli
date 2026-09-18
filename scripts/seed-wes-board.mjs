import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Seeds a throwaway LEG_HOME shaped like a real working board: a few live
// terminals and a larger pile of lost and ended ones, long absolute temp paths,
// and an image tag in a prompt.
//
// Board UI work is measured against THIS, never against a board of healthy
// terminals. Styling scoped to live rows and measured on a clean board reported
// 40px terminal rows while the real screen showed 400px, and that single wrong
// fixture cost more than any other mistake in the v4 redesign.
//
//   node scripts/seed-wes-board.mjs                 # seeds ./scripts/wes-home
//   LEG_HOME=<dir> node scripts/seed-wes-board.mjs
//
// Serve it on an isolated port with a throwaway LEG_HOME and LEG_TRUST=never.
// NEVER 4747: that is the operator's live board with real sessions on it.
// a throwaway home under the OS temp dir, so nothing is written into the repo
process.env.LEG_HOME ||= process.env.BATON_HOME || join(tmpdir(), 'leg-seed-board')
process.env.BATON_HOME ||= process.env.LEG_HOME
const { createSession, updateSession, HANDOFF_ORDER_CAPABILITY } = await import('../src/sessions.mjs')
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
// 'Projects-seed', not 'Projects': these rows print like real repos, but a
// button on a seeded row (End as a card, Land) runs git against the path it
// names. On 2026-09-17 a seeded End-as-card cut a worktree and wrote a bundle
// into the real recruiting-tool repository on this machine. A path that
// does not exist 409s instead.
const P = (...rest) => w('C:', 'Projects-seed', ...rest)
// the shape that matters is LENGTH: a real worktree path under a temp dir runs
// past 90 characters, which is what buried the prompt in the rejected design
const LONG = w('C:', 'Users', 'operator', 'AppData', 'Local', 'Temp', 'agent',
  'C--Projects-baton--baton-worktrees-s-20260915-000000-claude-0000',
  '00000000-0000-0000-0000-000000000000')

// `model` is the alias the leg resolved to, `waiting` is the Notification shape
// (a human is being waited on), `dirty` and `ahead` are what the git poll
// writes. One live row carries a permission prompt and another an idle prompt,
// because the board's whole attention story is those two rows; one live row
// carries no model at all, so the register's agent-alone path is on screen too.
const rows = [
  { id: 's-20260915-0049-claude-2fbf', agent: 'claude', status: 'warning', started: 4 * hour + 24 * min,
    cwd: P('baton'), repo: P('baton'), branch: 'main', model: 'fable', dirty: 3, ahead: 2,
    waiting: { type: 'permission_prompt', message: 'Bash(git push origin HEAD)', since: ago(40_000) },
    task: 'ultracode run a tournament of ideas to drastically redesign and improve the UI for this project. I do not like the current setup.' },
  { id: 's-20260915-0213-claude-95d3', agent: 'claude', status: 'running', started: 2 * hour + 46 * min, quiet: 4 * min,
    cwd: w('C:', 'documents'), repo: null, branch: null, model: 'sonnet', task: null },
  { id: 's-20260915-0257-claude-88e8', agent: 'claude', status: 'warning', started: 2 * hour + 2 * min,
    cwd: P('recruiting-tool'), repo: P('recruiting-tool'), branch: 'main', model: 'opus', dirty: 1,
    waiting: { type: 'idle_prompt', message: 'Claude is waiting for your input', since: ago(11 * min) },
    task: `<image name=screenshot.png path=${w('C:', 'Users', 'operator', 'Desktop', 'shot.png')}> [Image #1] sourcing candidates is a huge pain for my friend who recruits on LinkedIn, how can we help` },
  { id: 's-20260915-0455-claude-8e8a', agent: 'claude', status: 'running', started: 5 * min,
    cwd: w('C:', 'Projects'), repo: null, branch: null, task: '/handoff-load verifier-reach-contracts' },
  { id: 's-20260914-2211-claude-4c10', agent: 'claude', status: 'lost', started: 6 * hour, ended: 3 * hour,
    cwd: w(LONG, 'discovery-loop'), repo: P('discovery-loop'), branch: 'main', model: 'fable', task: 'run the nightly discovery loop' },
  { id: 's-20260914-2010-codex-7b31', agent: 'codex', status: 'lost', started: 7 * hour, ended: 4 * hour,
    cwd: w(LONG, 'costclaw'), repo: P('costclaw'), branch: 'main', model: 'gpt-5.6-sol', task: 'fix the per-model price table for Opus' },
  { id: 's-20260914-1802-agy-d9f2', agent: 'agy', status: 'lost', started: 9 * hour, ended: 6 * hour,
    cwd: w('C:', 'Projects'), repo: null, branch: null, task: 'summarise yesterday' },
  { id: 's-20260914-1533-claude-a04b', agent: 'claude', status: 'ended', started: 11 * hour, ended: 8 * hour,
    cwd: w(LONG, 'declick'), repo: P('declick'), branch: 'main', task: 'add the web tree verb' },
  { id: 's-20260914-1120-codex-55ac', agent: 'codex', status: 'ended', started: 13 * hour, ended: 10 * hour,
    cwd: P('costclaw'), repo: P('costclaw'), branch: 'main', task: 'monthly rollup excludes refunded calls' },
]

// distinct from files_touched below: the board prints basenames, and two
// different paths ending in the same name read as one file listed twice
const DIRTY = ['server.mjs', 'attach.mjs', 'usage.mjs']
// The ladder a terminal started with (docs/redesign-2026-09-17.md B.3): the
// claude models first, because a same-login switch keeps the conversation, then
// the other CLIs. Written onto the record the way src/attach.mjs writes it, so
// the picker, the per-terminal ladder editor and `Back to fable` all have the
// shape they render from. `orderFromLadder` of this list is the default order,
// which is what `ladderFor` insists on.
const SEED_LADDER = [
  { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'sonnet', when: 'always', cost: 'plan' },
  { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
  { agent: 'agy', account: 'default', model: null, when: 'walled-only', cost: 'free' },
]
for (const r of rows) {
  createSession({
    id: r.id, agent: r.agent, cwd: r.cwd, repo: r.repo, branch: r.branch, argv: [r.agent],
    runner_pid: r.ended ? 1 : livePid(), model: r.model ?? null,
    // what a terminal started by this Leg carries: without it the board offers
    // the ladder editor read-only and the model rail stays text
    runtimeCapabilities: r.ended ? [] : [HANDOFF_ORDER_CAPABILITY],
    // which CLIs were on the PATH when this terminal started. Without it the
    // server cannot say which rung is eligible and the row prints the caveat
    // for an older record instead of a destination.
    installed: r.ended ? null : { claude: true, codex: true, agy: true, grok: false },
  })
  updateSession(r.id, {
    ...(r.ended ? {} : { handoff_ladder: SEED_LADDER.map((x) => ({ ...x })) }),
    // the claude conversation id: a downshift on the same login resumes it,
    // which is the only reason a picker row can say it keeps the conversation
    ...(r.ended || r.agent !== 'claude' ? {} : { agent_session_id: `conv-${r.id.slice(-4)}` }),
    status: r.status,
    started_at: ago(r.started),
    last_activity: ago(r.ended ?? r.quiet ?? 0),
    ended_at: r.ended ? ago(r.ended) : null,
    task: r.task,
    turns: r.task ? 12 : 0,
    waiting: r.waiting ?? null,
    // `ahead` is written by the git poll in src/attach.mjs; an older record has
    // no such key, and the row prints the token only when it is there
    ...(r.ahead ? { ahead: r.ahead } : {}),
    files_dirty: r.dirty && r.repo ? DIRTY.slice(0, r.dirty).map((f) => w(r.cwd, 'src', f)) : [],
    files_touched: r.repo ? [w(r.cwd, 'src', 'board', 'board.css'), w(r.cwd, 'src', 'board', 'sessions.js')] : [],
  })
}

// The two windows are what an older Leg record carries; `buckets` is what the
// live `limits[]` array carries, and the shape here is the one verified off
// the endpoint on 2026-09-17: a session bucket, an account-wide weekly, and a
// model-scoped weekly the endpoint itself marks active. The board prints the
// active one, which is the whole point: 95% is the login, 63% is what will
// actually stop the work.
const fiveHourReset = Math.floor((Date.now() + 3 * hour) / 1000)
const weekReset = Math.floor((Date.now() + 40 * hour) / 1000)
recordUsage('claude', 'default',
  { five_hour: { pct: 38, resets_at: fiveHourReset },
    seven_day: { pct: 95, resets_at: weekReset },
    buckets: [
      { kind: 'session', group: 'session', model: null, percent: 38, resets_at: fiveHourReset, is_active: false, severity: 'normal' },
      { kind: 'weekly_all', group: 'weekly', model: null, percent: 95, resets_at: weekReset, is_active: false, severity: 'normal' },
      { kind: 'weekly_scoped', group: 'weekly', model: 'fable', percent: 63, resets_at: weekReset, is_active: true, severity: 'normal' },
      // a second model family with a reading of its own. The live payload on
      // 2026-09-17 had `seven_day_opus` null, so this is the shape the endpoint
      // publishes once opus has been used, not a figure anyone measured; it is
      // here because the model rail and the per-model capacity phrase have
      // nothing to draw with one bucket.
      { kind: 'weekly_scoped', group: 'weekly', model: 'opus', percent: 12, resets_at: weekReset, is_active: false, severity: 'normal' },
    ],
    // the live payload on 2026-09-17: credits are off and cannot be turned on
    // from the API, which is what the ladder editor says under may_spend
    extra_usage: { enabled: false, reason: 'out_of_credits', can_toggle: false, limit_minor: 12500, used_minor: 0 } },
  'statusline', { observed_at: ago(2 * hour + 13 * min) })
markLimited('codex', 'default', { resets_at: Math.floor((Date.now() + 29 * hour) / 1000), reason: 'limit', source: 'hook' })
// agy publishes no usage figure, ever. Left unwritten on purpose.

writeFileSync(join(process.env.BATON_HOME, 'sleepers.json'), JSON.stringify(sleepers))
const live = rows.filter((r) => !r.ended).length
console.log(`seeded ${rows.length} sessions (${live} live, ${rows.length - live} finished) into ${process.env.BATON_HOME}`)
