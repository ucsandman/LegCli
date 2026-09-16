// Human actions and recovery against LIVE runs (test/chain.test.mjs only
// exercises the pure transitions): Hand off now and Reassign on a running leg,
// Kill during the launching window and during a test station, a second driver
// arriving while the first is still between `queued` and its run.json, a card
// left at a test station by a dead driver, the board staying responsive while
// a test station runs, chain model/network reaching the agent argv, and a
// second scheduler refusing to start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { ROOT, makeHome, testEnv, initRepo, baton, batonFail, batonSpawn, readCard, events, sleep } from './helpers.mjs'

const runJson = (home, id, n) => { try { return JSON.parse(readFileSync(join(home, 'cards', id, 'runs', String(n), 'run.json'), 'utf8')) } catch { return null } }
const runDirs = (home, id) => (existsSync(join(home, 'cards', id, 'runs')) ? readdirSync(join(home, 'cards', id, 'runs')).sort() : [])
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const killTree = (pid) => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(pid, 'SIGKILL') } catch {} }
}
const crashed = (home, id) => events(home, id).filter((e) => e.type === 'error' && /orchestrator crashed|illegal transition/.test(e.summary)).map((e) => e.summary)

async function waitFor(pred, ms, what) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = pred() } catch {}
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await sleep(200)
  }
}

function spawnDriver(id, env) {
  const d = batonSpawn(['card', 'run', id], { ...env, BATON_QUIET: '0' })
  d.out = ''
  d.stdout.on('data', (c) => { d.out += c })
  d.stderr.on('data', (c) => { d.out += c })
  d.exited = new Promise((r) => d.on('exit', (code) => r(code)))
  return d
}

const atLegRunning = (home, id) => () => runJson(home, id, 1)?.agent_pid && readCard(home, id).status === 'running'
const atStation = (home, id, name) => () => { const c = readCard(home, id); return c.status === 'running' && c.station === name }
const TEST_PIPE = JSON.stringify([{ name: 'build', kind: 'agent' }, { name: 'test', kind: 'test' }])
const sleepCmd = (ms, exit = 0) => `node -e "setTimeout(() => process.exit(${exit}), ${ms})"`

test('Hand off now on a running leg: bundle written, the next leg runs in the same driver, the card ends done', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('handoffnow-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'hand me off', '--chain', 'fake-claude,fake-codex', '--fake-mode', 'fake-claude=sleep,fake-codex=success', '--slug', 'handoffnow'], env).trim()
  const driver = spawnDriver(id, env)
  await waitFor(atLegRunning(home, id), 30000, 'leg 0 to start')
  baton(['card', 'handoff-now', id], env)
  const code = await driver.exited
  const card = readCard(home, id)
  t.diagnostic(`driver exit ${code}; card ${card.status} at ${card.station} leg ${card.leg}; runs ${runDirs(home, id).join(',')}`)
  assert.deepEqual(crashed(home, id), [], driver.out.slice(-1500))
  assert.equal(card.status, 'done', driver.out.slice(-1500))
  assert.equal(code, 0)
  assert.ok(card.last_bundle, 'the bundle the human asked for was written')
  assert.ok(events(home, id).some((e) => e.type === 'handoff_written' && /next: fake-codex/.test(e.summary)))
  assert.deepEqual(runDirs(home, id), ['1', '2'])
  assert.equal(runJson(home, id, 1).outcome, 'killed')
})

test('Reassign on a running leg: the old leg is stopped and the same driver runs the new adapter', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('reassign-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'reassign me', '--chain', 'fake-claude', '--fake-mode', 'fake-claude=sleep', '--slug', 'reassign'], env).trim()
  const driver = spawnDriver(id, env)
  await waitFor(atLegRunning(home, id), 30000, 'leg 0 to start')
  baton(['card', 'reassign', id, '--adapter', 'fake-codex'], env)
  const code = await driver.exited
  const card = readCard(home, id)
  t.diagnostic(`driver exit ${code}; card ${card.status}; runs ${runDirs(home, id).join(',')}`)
  assert.deepEqual(crashed(home, id), [], driver.out.slice(-1500))
  assert.equal(card.status, 'done', driver.out.slice(-1500))
  assert.deepEqual(runDirs(home, id), ['1', '2'])
  assert.equal(runJson(home, id, 2).adapter, 'fake-codex')
})

test('a second driver arriving before the first has a run.json is refused; exactly one leg is launched', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('claim-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'one driver only', '--chain', 'fake', '--fake-mode', 'fake=sleep', '--slug', 'claim'], env).trim()
  const first = spawnDriver(id, env)
  await sleep(150)
  const second = batonFail(['card', 'run', id], { ...env, BATON_QUIET: '0' })
  await waitFor(atLegRunning(home, id), 30000, 'the first driver to start the leg')
  t.diagnostic(`second driver exit ${second.status}: ${(second.stderr + second.stdout).trim().split('\n').pop()}`)
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /driven by pid/)
  assert.deepEqual(runDirs(home, id), ['1'], 'no second leg was launched into the worktree')
  assert.equal(readCard(home, id).status, 'running')
  assert.deepEqual(crashed(home, id), [])
  baton(['card', 'kill', id], env)
  await first.exited
  assert.equal(readCard(home, id).status, 'killed')
})

test('Kill during the launching window (no agent_pid yet) still tears the supervisor down', async () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('launchkill-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'kill me early', '--chain', 'fake', '--slug', 'launchkill'], env).trim()
  // a supervisor that has not spawned its agent yet: run.json says launching, agent_pid null
  const sup = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  try {
    const dir = join(home, 'cards', id, 'runs', '1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ card_id: id, run: 1, adapter: 'fake', status: 'launching', supervisor_pid: sup.pid, agent_pid: null, started_at: new Date().toISOString(), outcome: null }, null, 2))
    process.env.BATON_HOME = home
    const { killActiveRun } = await import('../src/orchestrator.mjs')
    const killed = killActiveRun(id)
    assert.equal(killed, true, 'a launching run counts as killed')
    await waitFor(() => !pidAlive(sup.pid), 5000, 'the supervisor to die')
    assert.equal(pidAlive(sup.pid), false)
    assert.equal(runJson(home, id, 1).kill_requested, true)
  } finally { killTree(sup.pid) }
})

test('Kill during a test station sticks: the red result that arrives later does not requeue the card', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('testkill-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'kill me while testing', '--chain', 'fake', '--pipeline', TEST_PIPE, '--test-command', sleepCmd(4000, 1), '--slug', 'testkill'], env).trim()
  const driver = spawnDriver(id, env)
  await waitFor(atStation(home, id, 'test'), 30000, 'the test station to start')
  baton(['card', 'kill', id], env)
  const code = await driver.exited
  const card = readCard(home, id)
  t.diagnostic(`driver exit ${code}; card ${card.status} at ${card.station}`)
  assert.deepEqual(crashed(home, id), [], driver.out.slice(-1500))
  assert.equal(card.status, 'killed', 'the kill was not undone by the late test result')
  assert.ok(!events(home, id).some((e) => e.type === 'bounced'), 'no bounce after a kill')
})

test('a card left running at a test station by a dead driver is recovered by the scheduler', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('testcrash-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'crash me while testing', '--chain', 'fake', '--pipeline', TEST_PIPE, '--test-command', sleepCmd(2500), '--slug', 'testcrash'], env).trim()
  const driver = spawnDriver(id, env)
  await waitFor(atStation(home, id, 'test'), 30000, 'the test station to start')
  killTree(driver.pid)
  await driver.exited
  assert.equal(readCard(home, id).status, 'running', 'the crash left the card running at test')
  const sched = batonSpawn(['scheduler', 'start', '--ticks', '80', '--interval-ms', '250'], env)
  let schedOut = ''
  sched.stdout.on('data', (d) => { schedOut += d })
  sched.stderr.on('data', (d) => { schedOut += d })
  try {
    await waitFor(() => readCard(home, id).status === 'done', 25000, `the scheduler to recover the card (last: ${JSON.stringify(readCard(home, id).status)}; ${schedOut.slice(-300)})`)
  } finally { killTree(sched.pid) }
  t.diagnostic(`recovered: ${events(home, id).filter((e) => e.type === 'status').map((e) => e.summary).join(' | ')}`)
  assert.equal(readCard(home, id).status, 'done')
})

test('the board keeps answering while a test station runs inside its scheduler', async (t) => {
  const home = makeHome()
  const env = testEnv(home, { BATON_PORT: '0', BATON_BIND: '127.0.0.1', BATON_QUIET: '0', BATON_MAX_CONCURRENT: '2' })
  const repo = initRepo('busyboard-')
  const server = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let log = ''
  let port = null
  server.stdout.on('data', (d) => { log += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log); if (m) port = Number(m[1]) })
  server.stderr.on('data', (d) => { log += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log); if (m) port = Number(m[1]) })
  const health = () => new Promise((resolvePromise) => {
    const t0 = Date.now()
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 8000 }, (res) => { res.resume(); res.on('end', () => resolvePromise({ status: res.statusCode, ms: Date.now() - t0 })) })
    req.on('error', () => resolvePromise({ status: null, ms: Date.now() - t0 }))
    req.on('timeout', () => { req.destroy(); resolvePromise({ status: 'timeout', ms: Date.now() - t0 }) })
  })
  try {
    await waitFor(() => port, 15000, `the server to listen (${log.slice(-300)})`)
    const id = baton(['card', 'add', '--repo', repo, '--task', 'slow tests', '--chain', 'fake', '--pipeline', TEST_PIPE, '--test-command', sleepCmd(6000), '--slug', 'slowtests', '--queue'], env).trim()
    await waitFor(atStation(home, id, 'test'), 30000, 'the test station to start')
    await sleep(300)
    const probes = [await health(), await health()]
    t.diagnostic(`health during the test station: ${probes.map((p) => `${p.status} in ${p.ms}ms`).join(', ')}`)
    for (const p of probes) {
      assert.equal(p.status, 200)
      assert.ok(p.ms < 1500, `health took ${p.ms}ms: the test command blocked the board`)
    }
    await waitFor(() => readCard(home, id).status === 'done', 30000, 'the card to finish')
  } finally { killTree(server.pid) }
})

test('a chain entry\'s model and network reach the agent argv', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('model-')
  const viaFlag = baton(['card', 'add', '--repo', repo, '--task', 'cheap model', '--chain', 'fake', '--model', 'fake=haiku', '--slug', 'modelflag'], env).trim()
  assert.equal(readCard(home, viaFlag).pipeline[0].chain[0].model, 'haiku', '--model <adapter>=<name> lands on the station chain entry')
  baton(['card', 'run', viaFlag], env)
  const run1 = runJson(home, viaFlag, 1)
  assert.equal(run1.model, 'haiku', 'the run record names the model')
  const out1 = JSON.parse(readFileSync(join(home, 'cards', viaFlag, 'runs', '1', 'out.log'), 'utf8').trim().split('\n').pop())
  t.diagnostic(`fake-agent argv: ${JSON.stringify(out1.argv)}`)
  assert.deepEqual(out1.argv.slice(out1.argv.indexOf('--model'), out1.argv.indexOf('--model') + 2), ['--model', 'haiku'])

  const pipe = JSON.stringify([{ name: 'build', kind: 'agent', chain: [{ adapter: 'fake', model: 'sonnet', network: true }] }])
  const viaPipeline = baton(['card', 'add', '--repo', repo, '--task', 'network on', '--chain', 'fake', '--pipeline', pipe, '--slug', 'netpipe'], env).trim()
  baton(['card', 'run', viaPipeline], env)
  const out2 = JSON.parse(readFileSync(join(home, 'cards', viaPipeline, 'runs', '1', 'out.log'), 'utf8').trim().split('\n').pop())
  assert.ok(out2.argv.includes('--network'), `network: true reached the argv: ${JSON.stringify(out2.argv)}`)
  assert.ok(out2.argv.includes('sonnet'))
})

test('a second `leg scheduler start` refuses while one is running and leaves its pidfile alone', async () => {
  const home = makeHome()
  const env = testEnv(home)
  const pidfile = join(home, 'scheduler.pid')
  const first = batonSpawn(['scheduler', 'start', '--ticks', '100', '--interval-ms', '250'], env)
  first.stdout.resume(); first.stderr.resume()
  try {
    await waitFor(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() === String(first.pid), 10000, 'the first scheduler to write its pidfile')
    const second = batonFail(['scheduler', 'start', '--ticks', '1'], env)
    assert.notEqual(second.status, 0)
    assert.match(second.stderr + second.stdout, /already running/)
    assert.equal(readFileSync(pidfile, 'utf8').trim(), String(first.pid), 'the pidfile still names the first scheduler')
  } finally { killTree(first.pid) }
})
