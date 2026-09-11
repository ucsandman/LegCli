// The owner of a shared board: `share on` never promotes a guest, `share rm`
// never leaves the board without an owner, and turning share on or off is a
// configuration change, not a reason to end the work that is running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, baton, batonFail, sleep } from './helpers.mjs'

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const shareFile = (home) => JSON.parse(readFileSync(join(home, 'share.json'), 'utf8'))
const tokenIn = (text) => /token=([\w-]+)/.exec(text)?.[1] ?? null

// each test drives the CLI in its own home: no shared process state
function cli(port) {
  const home = makeHome()
  return { home, env: testEnv(home, { BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_PORT: String(port) }) }
}

test('`share add sam` before `share on`: sam stays a guest and the board gets a real owner', () => {
  const { home, env } = cli(4998)
  baton(['share', 'add', 'sam'], env)
  const on = baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4998', '--owner', 'wes'], env)
  const file = shareFile(home)
  assert.equal(file.owner, 'wes', 'the first person added is not the owner just for being first')
  assert.equal(file.people.find((p) => p.name === 'sam').role, 'guest')
  assert.equal(file.people.find((p) => p.name === 'wes').role, 'owner')
  assert.ok(tokenIn(on), `the owner gets their own link, printed once:\n${on}`)
})

test('`share on` keeps the owner the board already has, and prints no new link', () => {
  const { home, env } = cli(4995)
  baton(['share', 'add', 'wes', '--role', 'owner'], env)
  baton(['share', 'add', 'sam'], env)
  const on = baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4995'], env)
  const file = shareFile(home)
  assert.equal(file.owner, 'wes')
  assert.equal(file.people.length, 2, 'nobody new was added')
  assert.equal(tokenIn(on), null, `no new token is minted:\n${on}`)
})

test('`share rm` refuses to take the last owner off a board that is on', () => {
  const { home, env } = cli(4997)
  baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4997', '--owner', 'wes'], env)
  baton(['share', 'add', 'sam'], env)
  const r = batonFail(['share', 'rm', 'wes'], env)
  assert.equal(r.status, 2, `share rm <the only owner> should refuse; stdout: ${r.stdout} stderr: ${r.stderr}`)
  assert.match(r.stderr, /owner/)
  assert.equal(shareFile(home).owner, 'wes', 'the board still has an owner')
  assert.equal(shareFile(home).people.length, 2)
  baton(['share', 'rm', 'sam'], env)
  assert.equal(shareFile(home).people.length, 1, 'a guest still goes')
})

test('`share on` restarts the board without killing the agents that are running', async () => {
  const { home, env } = cli(4996)
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  const board = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  const runDir = join(home, 'cards', 'card-x1', 'runs', '1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(home, 'cards', 'card-x1', 'card.json'), JSON.stringify({ card_id: 'card-x1', status: 'running', station: 'build', repo: home, task: 'work' }))
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: 1, status: 'running', agent_pid: agent.pid, supervisor_pid: agent.pid }))
  // a pidfile for a board that is no longer listening: port 1 answers nobody
  const pidfileJson = () => JSON.stringify({ pid: board.pid, port: 1, bind: '127.0.0.1', children: [], started_at: new Date().toISOString() })
  writeFileSync(join(home, 'baton.pid'), pidfileJson())
  try {
    baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4996', '--owner', 'wes'], env)
    await sleep(500)
    assert.equal(alive(agent.pid), true, 'inviting someone to the board killed an agent mid-run')
    writeFileSync(join(home, 'baton.pid'), pidfileJson())
    baton(['down'], env)
    await sleep(1000)
    assert.equal(alive(agent.pid), false, '`baton down` still stops the agents')
  } finally {
    agent.kill()
    board.kill()
  }
})
