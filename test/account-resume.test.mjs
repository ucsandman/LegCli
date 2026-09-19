// A second login of the same agent keeps the conversation. `leg accounts add
// claude work` junctions the `projects` store into the account, so a hand-off
// from one 20x login to the other can run `claude --resume <id>` on the
// transcript the first login was writing; the rule that decides it is one
// function read by the terminal and the board's picker alike. What this file
// guards: the junction is cut (and cut later for an account made before it
// existed), the rule says `--resume` only when the transcript is really
// visible from the destination, the history index lists a shared store once,
// and a weekly wall on the first login moves a live terminal to the second
// with `--resume` and without a bundle prompt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeHome, initRepo, testEnv, legSpawn, sleep, LEG } from './helpers.mjs'
import { canonPath } from '../src/fsx.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME
process.env.BATON_QUIET = '1'

const accounts = await import('../src/accounts.mjs')
const usage = await import('../src/usage.mjs')
const sessions = await import('../src/sessions.mjs')
const H = await import('../src/history/index.mjs')

// A stand-in ~/.claude with the directories a real one has, including a
// conversation in `projects`. CLAUDE_CONFIG_DIR points the accounts layer at it
// for the duration of one test.
function fakeClaudeHome() {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
  mkdirSync(join(home, 'hooks'))
  writeFileSync(join(home, 'hooks', 'h.cjs'), '1')
  writeFileSync(join(home, 'settings.json'), '{"a":1}')
  const project = join(home, 'projects', 'C--Projects-toy')
  mkdirSync(project, { recursive: true })
  const transcript = join(project, 'cs-e2e.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, sessionId: 'cs-e2e', cwd: 'C:\\Projects\\toy' }) + '\n')
  return { home, transcript }
}

function withConfigDir(dir, fn) {
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try { return fn() } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev }
}

test('accounts add junctions the projects store, and refresh adds it to an older account', () => {
  const { home, transcript } = fakeClaudeHome()
  withConfigDir(home, () => {
    const r = accounts.addAccount('claude', 'work')
    try {
      assert.deepEqual(r.shared, ['hooks', 'projects'])
      assert.equal(lstatSync(join(r.dir, 'projects')).isSymbolicLink(), true, 'projects is a junction, not a copy')
      assert.equal(readFileSync(join(r.dir, 'projects', 'C--Projects-toy', 'cs-e2e.jsonl'), 'utf8'), readFileSync(transcript, 'utf8'), 'the transcript is visible through it')
      // an account made before `projects` was shared: the link is missing until
      // the next launch refreshes it
      rmSync(join(r.dir, 'projects'), { force: true })
      assert.equal(existsSync(join(r.dir, 'projects')), false)
      assert.equal(accounts.transcriptReachable('claude', transcript, { from: 'default', to: 'work' }), false, 'no junction, no resume')
      accounts.refreshAccount('claude', 'work')
      assert.equal(lstatSync(join(r.dir, 'projects')).isSymbolicLink(), true, 'refresh cut the missing junction')
      assert.equal(accounts.transcriptReachable('claude', transcript, { from: 'default', to: 'work' }), true)
      assert.equal(accounts.transcriptReachable('claude', transcript, { from: 'work', to: 'default' }), true, 'and the way back')
      assert.equal(accounts.transcriptReachable('claude', transcript, { from: 'default', to: 'default' }), false, 'the same login is not a switch')
      assert.equal(accounts.transcriptReachable('claude', join(tmpdir(), 'elsewhere.jsonl'), { from: 'default', to: 'work' }), false, 'a transcript outside the home is never reachable')
      assert.equal(accounts.transcriptReachable('claude', null, { from: 'default', to: 'work' }), false)
      assert.equal(accounts.transcriptReachable('agy', transcript, { from: 'default', to: 'work' }), false, 'agy has one home')
      assert.equal(readFileSync(join(home, 'hooks', 'h.cjs'), 'utf8'), '1')
    } finally {
      accounts.removeAccount('claude', 'work')
    }
    assert.equal(existsSync(transcript), true, 'removing the account removed the junction, never what it pointed at')
    assert.deepEqual(accounts.readAccounts().claude, ['default'])
  })
})

test('keepsConversation: a downshift, or another login that can see the transcript; never codex, never without an id', () => {
  const { home, transcript } = fakeClaudeHome()
  withConfigDir(home, () => {
    accounts.addAccount('claude', 'work')
    try {
      const session = { agent_session_id: 'cs-e2e', transcript_path: transcript }
      const on = (account, model) => ({ agent: 'claude', account, model })
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: on('default', 'opus'), session }), true, 'a downshift on one login')
      assert.equal(usage.keepsConversation({ from: on('default', 'opus'), to: on('default', 'fable'), session }), false, 'an upshift on one login takes the bundle')
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: on('work', null), session }), true, 'the other login, at its own default model')
      assert.equal(usage.keepsConversation({ from: on('default', 'opus'), to: on('work', 'fable'), session }), true, 'the other login, even upward: a fresh window pays the re-read')
      assert.equal(usage.keepsConversation({ from: on('work', 'fable'), to: on('default', 'fable'), session }), true, 'and back again')
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: on('work', null), session: { agent_session_id: 'cs-e2e', transcript_path: null } }), false, 'no transcript path on the record: nothing to check, so the bundle')
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: on('work', null), session: { agent_session_id: null, transcript_path: transcript } }), false, 'no id, nothing to resume')
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: { agent: 'codex', account: 'default', model: null }, session }), false, 'codex takes the bundle')
      assert.equal(usage.keepsConversation({ from: { agent: 'codex', account: 'default', model: null }, to: on('default', null), session }), false)
      rmSync(join(accounts.accountDir('claude', 'work'), 'projects'), { force: true })
      assert.equal(usage.keepsConversation({ from: on('default', 'fable'), to: on('work', null), session }), false, 'the junction gone: the rule says bundle, never a resume into an empty store')
    } finally { accounts.removeAccount('claude', 'work') }
  })
})

test('history indexes a shared projects store once: the account root scans nothing', () => {
  const { home } = fakeClaudeHome()
  withConfigDir(home, () => {
    const r = accounts.addAccount('claude', 'work')
    try {
      const own = H.PROVIDERS.claude.scan({ home })
      assert.equal(Object.keys(own.entries).length, 1, 'the real home lists the conversation')
      const viaAccount = H.PROVIDERS.claude.scan({ home: r.dir })
      assert.deepEqual([Object.keys(viaAccount.entries).length, viaAccount.scanned, viaAccount.shared], [0, 0, true], 'the junctioned store is not walked again')
    } finally { accounts.removeAccount('claude', 'work') }
  })
})

// End to end: a live claude terminal on `default` hits an account-wide (weekly)
// wall; `work` is the next candidate, sees the transcript through its junction,
// and the same terminal starts `claude --resume cs-e2e` under CLAUDE_CONFIG_DIR
// of the second login, with no bundle prompt.
test('a weekly wall on one login moves the terminal to the other login with the conversation it had', async () => {
  const stubs = mkdtempSync(join(tmpdir(), 'acct-stubs-'))
  const records = mkdtempSync(join(tmpdir(), 'acct-records-'))
  writeFileSync(join(stubs, 'claude.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/claude-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), session: process.env.BATON_SESSION, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }))
setTimeout(() => {}, 120000)
`)
  const { home, transcript } = fakeClaudeHome()
  const work = withConfigDir(home, () => accounts.addAccount('claude', 'work'))
  for (const a of ['claude--default', 'claude--work']) rmSync(join(HOME, 'usage', `${a}.json`), { force: true })
  const repo = initRepo('acct-e2e-')
  const env = testEnv(HOME, {
    BATON_CLAUDE_BIN: join(stubs, 'claude.mjs'), BATON_NO_BOARD: '1', BATON_NO_OPEN: '1',
    BATON_ATTACH_POLL_MS: '200', BATON_USAGE_POLL_MS: '600000', STUB_DIR: records, CLAUDE_CONFIG_DIR: home,
  })
  const child = legSpawn(['claude', '--no-worktree'], env, { cwd: repo })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  child.stdout.resume()
  const exited = new Promise((r) => child.on('exit', r))
  let session = null
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    session = sessions.listSessions().find((s) => s.repo && canonPath(s.repo) === canonPath(repo) && s.pid)
    if (session) break
    await sleep(100)
  }
  try {
    assert.ok(session, `the claude leg started; stderr: ${stderr.slice(-800)}`)
    // a real leg learns these from the SessionStart hook; the stub has none
    sessions.updateSession(session.session_id, { model: 'fable', agent_session_id: 'cs-e2e', transcript_path: transcript })
    const out = execFileSync(process.execPath, [LEG, 'sessions', 'simulate-limit', session.session_id, '--message', "You've hit your weekly limit."], { env, encoding: 'utf8' })
    assert.match(out, /is at limit/)
    const u = usage.readUsage('claude', 'default')
    assert.ok(u.limited_until && u.limited_until > Math.floor(Date.now() / 1000), 'the whole login is walled')
    let launches = []
    const t1 = Date.now()
    while (Date.now() - t1 < 20000) {
      launches = readdirSync(records).filter((n) => n.startsWith('claude-')).sort()
      if (launches.length >= 2) break
      await sleep(150)
    }
    assert.equal(launches.length, 2, `the terminal started a second claude; ${stderr.slice(-800)}`)
    const second = JSON.parse(readFileSync(join(records, launches[1]), 'utf8'))
    const argv = second.argv.join(' ')
    assert.match(argv, /--resume cs-e2e/, `second launch argv was ${argv}`)
    assert.equal(second.argv.some((a) => /taking over an interactive coding session/.test(String(a))), false, 'the conversation was kept, so no bundle prompt')
    assert.equal(canonPath(second.configDir), canonPath(work.dir), 'the second leg runs under the other login')
    assert.equal(second.session, session.session_id, 'same terminal, same session record')
    const after = sessions.readSession(session.session_id)
    assert.equal(after.account, 'work')
    assert.ok(sessions.readEvents(session.session_id).some((e) => /claude\/fable → claude\/work \(kept the conversation\)/.test(e.summary)), 'the ledger names the switch and that the conversation was kept')
    assert.match(stderr, /starting claude\/work in this terminal with --resume: kept the conversation/)
  } finally {
    if (session && sessions.isActive(sessions.readSession(session.session_id))) sessions.requestControl(session.session_id, { end: true })
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
    withConfigDir(home, () => accounts.removeAccount('claude', 'work'))
    for (const a of ['claude--default', 'claude--work']) rmSync(join(HOME, 'usage', `${a}.json`), { force: true })
  }
})
