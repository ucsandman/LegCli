// End to end through `baton claude` with stub CLIs in place of the real ones
// (BATON_<AGENT>_BIN pointing at .mjs stubs): the stub claude fires the same
// StopFailure hook Claude Code would, the runner hands off; with every other
// option walled the terminal waits for the first reset and then starts that
// agent from the bundle; End from the board while waiting quits with exit 3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, batonSpawn, sleep, ROOT } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
const { markLimited, readUsage } = await import('../src/usage.mjs')
const { listSessions, readEvents, requestControl } = await import('../src/sessions.mjs')

const STUBS = mkdtempSync(join(tmpdir(), 'baton-stubs-'))
const HOOK = join(ROOT, 'src', 'hook.mjs').replace(/\\/g, '/')
// a key-shaped value built at runtime, planted to prove the child never sees it
const PLANTED = ['sk', 'planted', 'stripped', 'abcdefgh12345678'].join('-')
// claude stub: records argv, fires StopFailure rate_limit through the hook when told to, then idles until killed
writeFileSync(join(STUBS, 'claude.mjs'), `import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
writeFileSync(process.env.STUB_DIR + '/claude-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: process.env.BATON_SESSION, api_key: process.env.ANTHROPIC_API_KEY ?? null }))
if (process.env.STUB_LIMIT === '1') {
  const payload = { hook_event_name: 'StopFailure', error: 'rate_limit', session_id: 'stub-cs', last_assistant_message: 'API Error: Rate limit reached' }
  spawnSync(process.execPath, ['${HOOK}', 'claude-hook', '--session', process.env.BATON_SESSION], { input: JSON.stringify(payload), encoding: 'utf8' })
}
setTimeout(() => {}, 120000)
`)
// codex stub: records argv (the resume prompt is the last arg) and exits 0
writeFileSync(join(STUBS, 'codex.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/codex-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: process.env.BATON_SESSION }))
`)
writeFileSync(join(STUBS, 'agy.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/agy-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2) }))
`)
const emptyClaudeHome = mkdtempSync(join(tmpdir(), 'claude-home-empty-'))

function envFor(stubDir, extra = {}) {
  return testEnv(HOME, {
    BATON_CLAUDE_BIN: join(STUBS, 'claude.mjs'), BATON_CODEX_BIN: join(STUBS, 'codex.mjs'), BATON_AGY_BIN: join(STUBS, 'agy.mjs'),
    BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_ATTACH_POLL_MS: '300', BATON_WAIT_TICK_MS: '200', BATON_LIVE_DIR: join(stubDir, 'live'),
    CLAUDE_CONFIG_DIR: emptyClaudeHome, STUB_DIR: stubDir, ANTHROPIC_API_KEY: PLANTED, BATON_CODEX_ARGS: '-m cheap-model',
    ...extra,
  })
}
const records = (dir, prefix) => readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))

test('limit → every option out → waits for the first reset → starts codex from the bundle in the same terminal (exit 0)', async (t) => {
  const repo = initRepo('attach-e2e-')
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-rec-')); mkdirSync(join(stubDir, 'live'))
  const nowS = Math.floor(Date.now() / 1000)
  markLimited('codex', 'default', { resets_at: nowS + 4, reason: 'test' })
  markLimited('agy', 'default', { resets_at: nowS + 30, reason: 'test' })
  const child = batonSpawn(['claude', '--model', 'haiku'], envFor(stubDir, { STUB_LIMIT: '1' }), { cwd: repo })
  let err = ''
  child.stderr.on('data', (d) => { err += d }); child.stdout.resume()
  const code = await new Promise((r) => child.on('exit', r))
  t.diagnostic(err.split('\n').filter((l) => /\[baton\]/.test(l)).slice(0, 12).join('\n'))
  assert.equal(code, 0, err)
  const s = listSessions().find((x) => x.lineage?.to === 'codex')
  assert.ok(s, 'a session handed off to codex')
  const types = readEvents(s.session_id).map((e) => e.type)
  for (const want of ['started', 'limit', 'all_out', 'handoff', 'leg', 'ended']) assert.ok(types.includes(want), `${want} in ${types.join(',')}`)
  assert.ok(types.indexOf('all_out') < types.indexOf('handoff'), 'waited before handing off')
  const allOut = readEvents(s.session_id).find((e) => e.type === 'all_out')
  assert.match(allOut.summary, /waiting for codex at/)
  assert.equal(s.status, 'ended'); assert.equal(s.waiting, null)
  assert.match(err, /waiting for codex; Ctrl-C to quit/)
  assert.match(err, /codex is back; starting it from the bundle/)
  // the stub claude never saw the API key; codex got BATON_CODEX_ARGS and the resume prompt, in the repo
  const [claude] = records(stubDir, 'claude-')
  assert.equal(claude.api_key, null, 'ANTHROPIC_API_KEY stripped')
  assert.deepEqual(claude.argv.slice(0, 2), ['--model', 'haiku'])
  const [codex] = records(stubDir, 'codex-')
  assert.deepEqual(codex.argv.slice(0, 2), ['-m', 'cheap-model'])
  assert.match(codex.argv[codex.argv.length - 1], /taking over an interactive coding session from claude/)
  assert.equal(codex.session, s.session_id)
  assert.equal(codex.cwd.toLowerCase(), repo.toLowerCase())
  assert.ok(existsSync(join(repo, '.baton', 'RESUME.md')), 'RESUME.md written for the next agent')
  assert.ok(existsSync(join(stubDir, 'live', 'claude', 'limit-rate_limit.json')), 'the (non-simulated) StopFailure was kept as live evidence')
  assert.equal(readUsage('claude', 'default').limited_reason, 'rate_limit')
})

test('End from the board while waiting quits with exit 3 and the session is ended, not lost', async (t) => {
  const repo = initRepo('attach-e2e2-')
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-rec-')); mkdirSync(join(stubDir, 'live'))
  const nowS = Math.floor(Date.now() / 1000)
  markLimited('codex', 'default', { resets_at: nowS + 600, reason: 'test' })
  markLimited('agy', 'default', { resets_at: nowS + 900, reason: 'test' })
  const child = batonSpawn(['claude'], envFor(stubDir, { STUB_LIMIT: '1' }), { cwd: repo })
  let err = ''
  child.stderr.on('data', (d) => { err += d }); child.stdout.resume()
  const t0 = Date.now()
  let s = null
  while (Date.now() - t0 < 20000) { s = listSessions().find((x) => x.status === 'waiting' && x.cwd.toLowerCase() === repo.toLowerCase()); if (s) break; await sleep(100) }
  assert.ok(s, `a waiting session within 20 s; stderr: ${err}`)
  assert.equal(s.waiting.agent, 'codex')
  assert.ok(s.waiting.resets_at > nowS + 500)
  t.diagnostic(`waiting for ${s.waiting.agent}, resets in ${s.waiting.resets_at - nowS}s`)
  requestControl(s.session_id, { end: true })
  const code = await new Promise((r) => child.on('exit', r))
  assert.equal(code, 3)
  const fin = listSessions().find((x) => x.session_id === s.session_id)
  assert.equal(fin.status, 'ended')
  assert.ok(readEvents(s.session_id).some((e) => e.type === 'ended' && /quit while waiting/.test(e.summary)))
  assert.equal(records(stubDir, 'codex-').length, 0, 'codex never started')
})
