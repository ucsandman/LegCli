// Phase 12 finding: `leg down` kills the agents; each supervisor writes its
// verdict, but the server that would apply it is already gone, so the card sat
// in `running` forever. runCard (and the scheduler on its next tick) now
// re-attaches to that unsettled run instead of launching a fresh leg.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, baton, batonFail, batonSpawn, readCard, events, sleep } from './helpers.mjs'

const runJson = (home, id, n) => JSON.parse(readFileSync(join(home, 'cards', id, 'runs', String(n), 'run.json'), 'utf8'))

test('a running card whose driver died is re-attached to its finished run, not relaunched', async (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('reattach-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'sleep until killed', '--chain', 'fake', '--fake-mode', 'fake=sleep', '--slug', 'reattach'], env).trim()
  const driver = batonSpawn(['card', 'run', id], env)
  driver.stdout.resume(); driver.stderr.resume()
  let run = null
  for (let i = 0; i < 120 && !(run?.agent_pid && readCard(home, id).status === 'running'); i++) {
    await sleep(250)
    try { run = runJson(home, id, 1) } catch {}
  }
  assert.ok(run?.agent_pid, 'the leg started')
  for (let i = 0; i < 40 && !runJson(home, id, 1).driver_pid; i++) await sleep(250)
  assert.equal(runJson(home, id, 1).driver_pid, driver.pid, 'the run names its driver')
  // a second driver while the first is alive leaves the run alone (no double apply)
  const second = batonFail(['card', 'run', id], { ...env, BATON_QUIET: '0' })
  assert.match(second.stderr, /driven by pid/)
  assert.notEqual(second.status, 0)
  assert.equal(readCard(home, id).status, 'running')
  assert.deepEqual(readdirSync(join(home, 'cards', id, 'runs')), ['1'])
  // like `leg down`: the driving orchestrator goes away and the agent is killed
  driver.kill()
  process.kill(run.agent_pid)
  for (let i = 0; i < 120 && runJson(home, id, 1).status !== 'exited'; i++) await sleep(250)
  assert.equal(runJson(home, id, 1).status, 'exited', 'the detached supervisor wrote its verdict')
  assert.equal(runJson(home, id, 1).settled_at, undefined)
  assert.equal(readCard(home, id).status, 'running', 'nobody applied it: the card is still running')

  const r = batonFail(['card', 'run', id], env)
  t.diagnostic(`second card run exit ${r.status}: ${r.stdout.trim().split('\n').pop()}`)
  const card = readCard(home, id)
  assert.equal(card.status, 'failed', 'the verdict (failed, chain exhausted) was applied')
  assert.deepEqual(readdirSync(join(home, 'cards', id, 'runs')), ['1'], 'no second run was launched')
  assert.ok(runJson(home, id, 1).settled_at, 'the run is marked settled')
  assert.ok(events(home, id).some((e) => e.type === 'status' && /re-attached to run 1/.test(e.summary)))
  const sha = readdirSync(join(home, 'cards', id))
  assert.ok(sha.length)
})
