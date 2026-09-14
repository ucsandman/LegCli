// The legs after the first one, through `baton claude|agy` with stub CLIs (as
// in attach-e2e): what the next agent's card carries (its own usage, its own
// chain, its own near-limit warning), a Hand off from the board while every
// OTHER option is walled, and the agy log + turn readers across two legs of
// one session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, batonSpawn, sleep, ROOT } from './helpers.mjs'
import { canonPath } from '../src/fsx.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
const { markLimited, clearLimited } = await import('../src/usage.mjs')
const { listSessions, readEvents, requestControl } = await import('../src/sessions.mjs')

const STUBS = mkdtempSync(join(tmpdir(), 'baton-leg-stubs-'))
const HOOK = join(ROOT, 'src', 'hook.mjs').replace(/\\/g, '/')
const SESSIONS = `file:///${join(ROOT, 'src', 'sessions.mjs').replace(/\\/g, '/')}`
// every stub records its launch and then watches the record the runner writes
const PRELUDE = `import { appendFileSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
const S = await import('${SESSIONS}')
const sid = process.env.BATON_SESSION
const dir = process.env.STUB_DIR
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seen = (p) => readdirSync(dir).filter((n) => n.startsWith(p)).length
const record = (p) => writeFileSync(join(dir, p + '-' + Date.now() + '.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: sid }))
async function untilRecord(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = S.readSession(sid); if (s && pred(s)) return s; await sleep(50) } return null }
`
writeFileSync(join(STUBS, 'claude.mjs'), `${PRELUDE}
const legs = seen('claude-')
record('claude')
const limit = () => spawnSync(process.execPath, ['${HOOK}', 'claude-hook', '--session', sid], { input: JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', session_id: 'stub-cs', last_assistant_message: 'API Error: Rate limit reached' }), encoding: 'utf8' })
// only the first claude leg hits a limit; a leg Baton starts itself just idles
const mode = legs === 0 ? process.env.STUB_MODE : 'idle'
if (mode === 'warn-then-limit') {
  await untilRecord((s) => s.agent === 'claude' && s.pid)
  const at = Math.floor(Date.now() / 1000) + 3600
  S.updateSession(sid, { limits: { five_hour: { pct: 99, resets_at: at }, seven_day: { pct: 12, resets_at: at } }, usage_source: 'stub status line' })
  await untilRecord((s) => s.warning)
  limit()
} else if (mode === 'turns-then-limit') {
  await untilRecord((s) => s.agent === 'claude' && s.pid)
  S.updateSession(sid, { turns: 5 })
  limit()
}
setTimeout(() => {}, 120000)
`)
writeFileSync(join(STUBS, 'codex.mjs'), `${PRELUDE}
record('codex')
const s = await untilRecord((x) => x.agent === 'codex')
if (s) {
  writeFileSync(join(dir, 'leg-record.json'), JSON.stringify(s))
  const at = Math.floor(Date.now() / 1000) + 3600
  S.updateSession(sid, { limits: { five_hour: { pct: 99, resets_at: at }, seven_day: { pct: 5, resets_at: at } } })
  await untilRecord((x) => x.warning, 8000)
}
`)
writeFileSync(join(STUBS, 'agy.mjs'), `${PRELUDE}
const legs = seen('agy-')
record('agy')
const argv = process.argv.slice(2)
const log = argv[argv.indexOf('--log-file') + 1]
if (process.env.STUB_AGY_MODE === 'unicode-then-limit') {
  appendFileSync(join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'history.jsonl'), JSON.stringify({ display: 'keep going', timestamp: Date.now(), workspace: process.cwd(), conversationId: 'c-stub' }) + '\\n')
  // ordinary status lines with the glyphs agy prints: every one of them puts
  // the log's byte count further ahead of its character count
  appendFileSync(log, Array.from({ length: 60 }, (_, i) => 'I0911 status ' + i + ' \\u2705 \\u2705 \\u2705 \\u2705 \\u2705 ok').join('\\n') + '\\n')
  await sleep(1500)
  appendFileSync(log, 'rpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED Individual quota reached. Resets in 71h19m42s.\\n')
  await untilRecord((s) => s.status === 'limit', 8000)
} else if (process.env.STUB_AGY_MODE === 'limit-once') {
  if (legs === 0) appendFileSync(log, 'quota is out, it resets in 3s for this model\\n')
  setTimeout(() => {}, 120000)
}
`)

function envFor(stubDir, extra = {}) {
  return testEnv(HOME, {
    BATON_CLAUDE_BIN: join(STUBS, 'claude.mjs'), BATON_CODEX_BIN: join(STUBS, 'codex.mjs'), BATON_AGY_BIN: join(STUBS, 'agy.mjs'),
    BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_ATTACH_POLL_MS: '300', BATON_WAIT_TICK_MS: '200', BATON_LIVE_DIR: join(stubDir, 'live'),
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'claude-home-empty-')), STUB_DIR: stubDir,
    ...extra,
  })
}
const records = (dir, prefix) => readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
const mine = (repo) => (s) => Boolean(s.repo) && canonPath(s.repo) === canonPath(repo)
async function until(pred, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(100) }
  return null
}
function startAgent(agent, repo, stubDir, extra = {}) {
  const child = batonSpawn([agent], envFor(stubDir, extra), { cwd: repo })
  child.err = ''
  child.out = ''
  child.stderr.on('data', (d) => { child.err += d }); child.stdout.on('data', (d) => { child.out += d })
  child.exited = new Promise((r) => child.on('exit', r))
  return child
}
function scratch(name) {
  const stubDir = mkdtempSync(join(tmpdir(), name))
  mkdirSync(join(stubDir, 'live'))
  return stubDir
}
// end the terminal if it is still up, and always wait for its exit
async function endAndWait(child, sid, ms = 60000) {
  const r = await Promise.race([child.exited, sleep(ms).then(() => 'timeout')])
  if (r !== 'timeout') return r
  if (sid) requestControl(sid, { end: true })
  return await Promise.race([child.exited, sleep(20000).then(() => { try { child.kill() } catch {} return 'killed' })])
}

// ---- one claude to codex hand-off, asserted by the three tests below ----
// Run on first use inside a test, never at module scope: the runner starts the
// tests it has already registered while module scope awaits, and their walls
// would land in the middle of the run.
let handoffRun = null
const handoff = () => (handoffRun ??= (async () => {
  const repo = initRepo('attach-leg-handoff-')
  const stubDir = scratch('stub-handoff-')
  for (const a of ['claude', 'codex', 'agy']) clearLimited(a, 'default')
  const child = startAgent('claude', repo, stubDir, { STUB_MODE: 'warn-then-limit' })
  const s = await until(() => listSessions().find(mine(repo)))
  const code = await endAndWait(child, s?.session_id)
  const dumpFile = join(stubDir, 'leg-record.json')
  return { code, err: child.err, events: s ? readEvents(s.session_id) : [], dump: existsSync(dumpFile) ? JSON.parse(readFileSync(dumpFile, 'utf8')) : null }
})())

test('the second agent starts with the first one’s usage gone from the card', async () => {
  const h = await handoff()
  assert.ok(h.dump, `codex started and dumped its leg record; exit ${h.code}, stderr: ${h.err.slice(-800)}`)
  assert.equal(h.dump.agent, 'codex')
  assert.equal(h.dump.limits, null, 'claude percentages do not stay on the codex card')
  assert.equal(h.dump.usage_source, null)
  assert.equal(h.dump.usage_error, null)
})

test('the chain is recomputed at the hand-off, so it never names the agent already running', async () => {
  const h = await handoff()
  assert.ok(h.dump, `codex started and dumped its leg record; stderr: ${h.err.slice(-800)}`)
  assert.deepEqual(h.dump.chain.map((c) => c.agent), ['claude', 'agy'], 'the chain after codex keeps the saved priority, so agy stays last')
})

test('the near-limit warning fires again on the second leg', async () => {
  const warnings = (await handoff()).events.filter((e) => e.type === 'warning')
  assert.equal(warnings.length, 2, `one warning per leg, got: ${warnings.map((w) => w.summary).join(' | ') || 'none'}`)
  assert.match(warnings[1].summary, /^codex 5h window at 99%/)
  assert.match(warnings[1].summary, /next option claude/)
})

test('Hand off from the board with every other option walled restarts the current agent instead of parking the terminal', async () => {
  const repo = initRepo('attach-leg-board-')
  const stubDir = scratch('stub-board-')
  const nowS = Math.floor(Date.now() / 1000)
  clearLimited('claude', 'default')
  markLimited('codex', 'default', { resets_at: nowS + 600, reason: 'test' })
  markLimited('agy', 'default', { resets_at: nowS + 900, reason: 'test' })
  const child = startAgent('claude', repo, stubDir, { STUB_MODE: 'idle' })
  const s = await until(() => listSessions().find((x) => mine(repo)(x) && x.pid))
  try {
    assert.ok(s, `the first leg started; stderr: ${child.err.slice(-800)}`)
    requestControl(s.session_id, { handoff: true })
    const outcome = await until(() => (records(stubDir, 'claude-').length >= 2 && 'restarted') || (readEvents(s.session_id).some((e) => e.type === 'all_out') && 'waited'), 25000)
    assert.equal(outcome, 'restarted', `claude is available, so the hand-off restarts it instead of waiting; stderr: ${child.err.slice(-800)}`)
    // the killed agent's terminal modes are undone before the next leg draws:
    // otherwise the wheel prints mouse reports and a stale scrolling region
    // makes the new output land on top of the lines already on screen
    assert.ok(child.out.includes('\x1b[?1006l') && child.out.includes('\x1b7\x1b[r\x1b8'), 'the hand-off restored the terminal')
    const second = records(stubDir, 'claude-')[1]
    assert.match(second.argv[second.argv.length - 1], /taking over an interactive coding session from claude/)
  } finally {
    if (s) requestControl(s.session_id, { end: true })
    await endAndWait(child, s?.session_id, 20000)
  }
})

// ---- one claude to agy hand-off, asserted by the two tests below ----
let agyLegRun = null
const agyLeg = () => (agyLegRun ??= (async () => {
  const repo = initRepo('attach-leg-agy-')
  const stubDir = scratch('stub-agy-')
  const userHome = mkdtempSync(join(tmpdir(), 'agy-user-home-'))
  mkdirSync(join(userHome, '.gemini', 'antigravity-cli'), { recursive: true })
  const nowS = Math.floor(Date.now() / 1000)
  clearLimited('claude', 'default'); clearLimited('agy', 'default')
  markLimited('codex', 'default', { resets_at: nowS + 600, reason: 'test' })
  const child = startAgent('claude', repo, stubDir, { STUB_MODE: 'turns-then-limit', STUB_AGY_MODE: 'unicode-then-limit', USERPROFILE: userHome, HOME: userHome })
  const s = await until(() => listSessions().find(mine(repo)))
  await until(() => s && readEvents(s.session_id).some((e) => e.type === 'limit' && /agy limit/.test(e.summary)), 25000)
  if (s) requestControl(s.session_id, { end: true })
  const code = await endAndWait(child, s?.session_id, 25000)
  return { code, err: child.err, events: s ? readEvents(s.session_id) : [], session: s ? listSessions().find((x) => x.session_id === s.session_id) : null }
})())

test('an agy leg adds its prompts to the turns the session already had', async () => {
  const r = await agyLeg()
  assert.ok(r.session, `the session record survived; stderr: ${r.err.slice(-800)}`)
  assert.ok(r.events.some((e) => e.type === 'leg' && /^agy/.test(e.summary)), `an agy leg ran: ${r.events.map((e) => `${e.type} ${e.summary}`).join(' | ')}; stderr: ${r.err.slice(-900)}`)
  assert.equal(r.session.turns, 6, 'five claude turns plus the one prompt typed into agy')
})

test('the agy wall is seen behind a log full of non-ASCII status lines', async () => {
  const limits = (await agyLeg()).events.filter((e) => e.type === 'limit')
  assert.ok(limits.some((e) => /agy limit \(agy-resource-exhausted\)/.test(e.summary)), `the RESOURCE_EXHAUSTED line after 60 unicode lines is read: ${limits.map((e) => e.summary).join(' | ') || 'no limit event at all'}`)
})

test('a second agy leg does not re-fire the wall the first leg left in the session log', async () => {
  const repo = initRepo('attach-leg-agy2-')
  const stubDir = scratch('stub-agy2-')
  const userHome = mkdtempSync(join(tmpdir(), 'agy-user-home2-'))
  mkdirSync(join(userHome, '.gemini', 'antigravity-cli'), { recursive: true })
  const nowS = Math.floor(Date.now() / 1000)
  clearLimited('agy', 'default')
  markLimited('claude', 'default', { resets_at: nowS + 600, reason: 'test' })
  markLimited('codex', 'default', { resets_at: nowS + 600, reason: 'test' })
  const child = startAgent('agy', repo, stubDir, { STUB_AGY_MODE: 'limit-once', USERPROFILE: userHome, HOME: userHome })
  const s = await until(() => listSessions().find(mine(repo)))
  try {
    assert.ok(s, `the agy session started; stderr: ${child.err.slice(-800)}`)
    const twoLegs = await until(() => readEvents(s.session_id).filter((e) => e.type === 'leg').length >= 2, 30000)
    assert.ok(twoLegs, `agy came back and started a second leg; stderr: ${child.err.slice(-800)}`)
    await sleep(1500) // several polls of the second leg over the log the first one left
    const limits = readEvents(s.session_id).filter((e) => e.type === 'limit')
    assert.equal(limits.length, 1, `the old wall in the log is not read again: ${limits.map((e) => e.summary.slice(0, 60)).join(' | ')}`)
  } finally {
    if (s) requestControl(s.session_id, { end: true })
    await endAndWait(child, s?.session_id, 20000)
  }
})
