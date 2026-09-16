// The whole promise, end to end, with stub CLIs and throwaway homes:
//   1. `leg claude` starts under Leg with the portable harness enabled
//   2. the source rules are edited while the session runs
//   3. the stub claude hits a simulated usage limit
//   4. Leg picks codex, prepares its harness (re-captured, synced), launches it
//   5. codex receives the resume prompt AND the new rule in its AGENTS.md
//   6. the session record, its timeline and the drawer payload show the transition
//   7. nothing the user owned in ~/.codex was destroyed
// and the same hand-off with the feature off, which must look exactly like
// the release before this one. Plus the card path through the orchestrator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, batonSpawn, ROOT, baton, readCard, events } from './helpers.mjs'
import { buildClaudeHome, buildCodexHome, CANARY, fakeToken } from './harness-fixture.mjs'

const HOOK = join(ROOT, 'src', 'hook.mjs').replace(/\\/g, '/')
const STUBS = mkdtempSync(join(tmpdir(), 'leg-hstubs-'))
writeFileSync(join(STUBS, 'claude.mjs'), `import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
writeFileSync(process.env.STUB_DIR + '/claude-' + Date.now() + '-' + process.pid + '.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: process.env.BATON_SESSION }))
if (process.env.STUB_LIMIT === '1') {
  const payload = { hook_event_name: 'StopFailure', error: 'rate_limit', session_id: 'stub-cs', last_assistant_message: 'API Error: Rate limit reached' }
  spawnSync(process.execPath, ['${HOOK}', 'claude-hook', '--session', process.env.BATON_SESSION], { input: JSON.stringify(payload), encoding: 'utf8' })
}
setTimeout(() => {}, 120000)
`)
writeFileSync(join(STUBS, 'codex.mjs'), `import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// what the destination actually sees at launch: its own rules file, read the way Codex would
let agents = null
try { agents = readFileSync(join(process.env.LEG_HARNESS_HOME, '.codex', 'AGENTS.md'), 'utf8') } catch {}
writeFileSync(process.env.STUB_DIR + '/codex-' + Date.now() + '-' + process.pid + '.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: process.env.BATON_SESSION, agents }))
`)
writeFileSync(join(STUBS, 'agy.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/agy-' + Date.now() + '-' + process.pid + '.json', JSON.stringify({ argv: process.argv.slice(2) }))
`)

function envFor(home, stubDir, extra = {}) {
  return testEnv(home, {
    BATON_CLAUDE_BIN: join(STUBS, 'claude.mjs'), BATON_CODEX_BIN: join(STUBS, 'codex.mjs'), BATON_AGY_BIN: join(STUBS, 'agy.mjs'),
    BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_ATTACH_POLL_MS: '300', BATON_WAIT_TICK_MS: '200', BATON_LIVE_DIR: join(stubDir, 'live'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), STUB_DIR: stubDir,
    ...extra,
  })
}
const records = (dir, prefix) => readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort().flatMap((n) => { try { const t = readFileSync(join(dir, n), 'utf8'); return t ? [JSON.parse(t)] : [] } catch { return [] } })

async function runLimitHandoff(env, repo, t) {
  const child = batonSpawn(['claude'], env, { cwd: repo })
  let err = ''
  child.stderr.on('data', (d) => { err += d }); child.stdout.resume()
  const code = await new Promise((r) => child.on('exit', r))
  t.diagnostic(err.split('\n').filter((l) => /\[leg\]/.test(l)).slice(0, 14).join('\n'))
  return { code, err }
}

async function sessionsOf(home) {
  const root = join(home, 'sessions')
  const ids = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith('s-')) : []
  return ids.map((id) => ({ session: JSON.parse(readFileSync(join(root, id, 'session.json'), 'utf8')), events: readFileSync(join(root, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }))
}

test('harness on (sync): claude limit → codex launched with the task AND the freshly captured working environment; user config preserved; board payload shows it', async (t) => {
  const home = makeHome()
  buildClaudeHome(home); buildCodexHome(home)
  const repo = initRepo('harness-e2e-')
  const stubDir = mkdtempSync(join(tmpdir(), 'hstub-rec-')); mkdirSync(join(stubDir, 'live'))
  const env = envFor(home, stubDir, { STUB_LIMIT: '1' })
  // 2. establish the portable harness from the CLI (first run, non-interactive consent)
  baton(['harness', 'enable', '--yes', '--source', 'claude', '--policy', 'sync'], env)
  const tomlAfterEnable = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  // 3. the source changes after the capture: a rule added while the session is live
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8') + '\n- Rule added after enable, before the limit.\n')
  // 4-8. the limit, the choice, the preparation, the launch
  const { code, err } = await runLimitHandoff(env, repo, t)
  assert.equal(code, 0, err)
  const [{ session: s, events: evs }] = (await sessionsOf(home)).filter((x) => x.session.lineage?.to === 'codex')
  assert.ok(s, 'a session handed off to codex')
  // 9. the destination saw the expected portable rule at launch
  const [codex] = records(stubDir, 'codex-')
  assert.ok(codex, 'codex was launched')
  assert.match(codex.argv[codex.argv.length - 1], /taking over an interactive coding session from claude/)
  assert.match(codex.agents ?? '', /GENERATED by Leg harness/, 'codex read a Leg-generated AGENTS.md at launch')
  assert.match(codex.agents ?? '', /Rule added after enable, before the limit/, 'the rule added after enable reached codex: the hand-off re-captured')
  assert.match(codex.agents ?? '', /Batch tool calls/)
  // 10. the session record and timeline show the harness transition
  assert.equal(s.harness.target, 'codex')
  assert.equal(s.harness.source, 'claude')
  assert.equal(s.harness.policy, 'sync')
  assert.equal(s.harness.mode, 'sync')
  assert.equal(s.harness.capture_cached, false, 'the source change was noticed')
  assert.ok(['synced', 'partial'].includes(s.harness.state), s.harness.summary)
  assert.ok(s.harness.captured_at && s.harness.synced_at && s.harness.fingerprint)
  assert.equal(s.harness.components.rules.state, 'synced')
  assert.ok(s.harness.dropped.every((d) => d.reason))
  const types = evs.map((e) => e.type)
  for (const want of ['started', 'harness', 'limit', 'handoff', 'leg', 'ended']) assert.ok(types.includes(want), `${want} in ${types.join(',')}`)
  const harnessEvents = evs.filter((e) => e.type === 'harness')
  assert.ok(harnessEvents.some((e) => /claude is the source of the harness/.test(e.summary)), 'leg 0 recorded the source')
  const last = harnessEvents.at(-1)
  assert.match(last.summary, /codex harness (synced|partial)/)
  // the harness is prepared while the destination is chosen (a strict refusal changes the choice), so its event sits between the limit and the launch
  assert.ok(types.indexOf('limit') < types.lastIndexOf('harness') && types.lastIndexOf('harness') < types.lastIndexOf('leg'), `prepared after the limit, before the launch: ${types.join(',')}`)
  assert.match(err, /codex harness (synced|partial)/)
  // the drawer payload
  const { sessionDetail } = await import('../src/session-detail.mjs')
  process.env.LEG_HOME = home; process.env.BATON_HOME = home
  const d = sessionDetail(s)
  assert.equal(d.harness.target, 'codex')
  assert.ok(d.harness.history.some((r) => r.op === 'apply' && r.session_id === s.session_id))
  // 11. nothing the user owned was destroyed, and no credential moved
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  assert.match(toml, /\[mcp_servers\.existing\]/)
  assert.match(toml, /codex-guard/)
  assert.equal(toml, tomlAfterEnable, 'a rules-only source change left config.toml untouched')
  assert.ok(existsSync(join(home, '.codex', 'skills', 'beta', 'SKILL.md')))
  assert.ok(!toml.includes(fakeToken('a')) && !toml.includes(CANARY.claude))
  assert.ok(!readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes(CANARY.claude))
  assert.match(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), /Rule added after enable/, 'the source was never written')
  assert.ok(!existsSync(join(home, '.claude', 'leg-rules.md')))
})

test('harness off (the default): the same hand-off behaves exactly as before, touches no client config and records no harness state', async (t) => {
  const home = makeHome()
  buildClaudeHome(home); buildCodexHome(home)
  const repo = initRepo('plain-e2e-off-')
  const stubDir = mkdtempSync(join(tmpdir(), 'hstub-rec-')); mkdirSync(join(stubDir, 'live'))
  const env = envFor(home, stubDir, { STUB_LIMIT: '1' })
  const before = { agents: readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), toml: readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), skills: readdirSync(join(home, '.codex', 'skills')) }
  const { code, err } = await runLimitHandoff(env, repo, t)
  assert.equal(code, 0, err)
  const [{ session: s, events: evs }] = (await sessionsOf(home)).filter((x) => x.session.lineage?.to === 'codex')
  assert.equal(s.harness, null, 'no harness outcome on the session')
  assert.ok(!evs.some((e) => /harness/.test(e.type)), 'no harness event')
  assert.doesNotMatch(err, /harness/)
  const [codex] = records(stubDir, 'codex-')
  assert.match(codex.argv[codex.argv.length - 1], /taking over an interactive coding session from claude/)
  assert.equal(codex.agents, before.agents, 'codex read its own, untouched AGENTS.md')
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), before.toml)
  assert.deepEqual(readdirSync(join(home, '.codex', 'skills')), before.skills)
  assert.ok(!existsSync(join(home, 'harness')), 'no harness directory under the Leg home')
})

test('strict policy with a hand-edited destination: the hand-off is refused, the next option is tried, and with none left the terminal stops with exit 5 and says why', async (t) => {
  const home = makeHome()
  buildClaudeHome(home); buildCodexHome(home)
  const repo = initRepo('harness-e2e-strict-')
  const stubDir = mkdtempSync(join(tmpdir(), 'hstub-rec-')); mkdirSync(join(stubDir, 'live'))
  const env = envFor(home, stubDir, { STUB_LIMIT: '1', BATON_AGY_BIN: join(home, 'no-such-agy.exe') })
  baton(['harness', 'enable', '--yes', '--source', 'claude', '--policy', 'strict'], env)
  const f = join(home, '.codex', 'AGENTS.md')
  const edited = readFileSync(f, 'utf8').split('\n').filter((l) => !l.includes('GENERATED by Leg harness')).join('\n') + '\nmine\n'
  writeFileSync(f, edited)
  const { code, err } = await runLimitHandoff(env, repo, t)
  assert.equal(code, 5, err)
  assert.match(err, /codex refused by the strict harness policy/)
  assert.match(err, /every remaining option was refused by the strict harness policy; stopping \(exit 5\)/)
  assert.equal(records(stubDir, 'codex-').length, 0, 'codex was never launched')
  assert.equal(readFileSync(f, 'utf8'), edited, 'the hand edit is intact')
  const [{ session: s, events: evs }] = await sessionsOf(home)
  assert.equal(s.status, 'ended'); assert.equal(s.exit_code, 5)
  assert.equal(s.harness.state, 'blocked'); assert.equal(s.harness.proceed, false)
  assert.ok(evs.some((e) => e.type === 'harness_blocked'))
  assert.ok(evs.some((e) => e.type === 'ended' && /strict harness policy refused every destination/.test(e.summary)))
})

test('card path: fake-claude limit → fake-codex, with the harness on the ledger carries a harness event and the card keeps the outcome', () => {
  const home = makeHome()
  buildClaudeHome(home); buildCodexHome(home)
  const env = testEnv(home)
  baton(['harness', 'enable', '--yes', '--source', 'claude', '--policy', 'sync'], env)
  const repo = initRepo('harness-card-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'Create hello.txt containing hi', '--chain', 'fake-claude,fake-codex',
    '--fake-mode', 'fake-claude=limit,fake-codex=success', '--pipeline', 'build', '--leases', 'hello.txt'], env).trim()
  const out = baton(['card', 'run', id], env)
  assert.ok(out.includes(`${id} done at build`), out)
  const card = readCard(home, id)
  assert.equal(card.status, 'done')
  assert.equal(card.harness.target, 'codex')
  assert.ok(['synced', 'partial'].includes(card.harness.state), card.harness.summary)
  const seq = events(home, id).map((e) => e.type)
  assert.ok(seq.includes('harness'), seq.join(' → '))
  assert.ok(seq.indexOf('handoff_written') < seq.lastIndexOf('harness') && seq.lastIndexOf('harness') < seq.lastIndexOf('leg_started'))
  assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /GENERATED by Leg harness/)
})
