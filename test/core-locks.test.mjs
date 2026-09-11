// Cross-process writes to one file: run.json (supervisor, orchestrator, kill),
// card.json (every `ledger update` child), and unsynced.jsonl (a live ledger
// appending while `ledger sync` rewrites). Each was a last-writer-wins race.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { ROOT, makeHome, testEnv, sleep } from './helpers.mjs'

const LEDGER = join(ROOT, 'src', 'ledger.mjs')
const RUNNER = join(ROOT, 'src', 'runner.mjs')

function makeCard(home, env) {
  return execFileSync(process.execPath, [LEDGER, 'create', '--slug', 'lock', '--task', 'lock test', '--repo', home, '--chain', JSON.stringify([{ adapter: 'fake' }])], { env, encoding: 'utf8' }).trim()
}

function child(args, env) {
  const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  c.stdout.on('data', (d) => { out += d })
  c.stderr.on('data', (d) => { out += d })
  return new Promise((resolvePromise) => c.on('exit', (code) => resolvePromise({ code, out })))
}

test('run.json: four processes patching one run through updateRun lose nothing', async () => {
  const home = makeHome()
  const env = testEnv(home)
  const id = makeCard(home, env)
  const dir = join(home, 'cards', id, 'runs', '1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ card_id: id, run: 1, status: 'running' }, null, 2) + '\n')
  const script = `
    const m = await import(${JSON.stringify('file://' + RUNNER.replace(/\\/g, '/'))})
    for (let i = 0; i < 25; i++) m.updateRun(${JSON.stringify(id)}, 1, (cur) => ({ ...cur, ['k' + process.pid + '_' + i]: 1 }))
  `
  const results = await Promise.all([0, 1, 2, 3].map(() => child(['--input-type=module', '-e', script], env)))
  for (const r of results) assert.equal(r.code, 0, r.out)
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  const keys = Object.keys(run).filter((k) => k.startsWith('k'))
  assert.equal(keys.length, 100, `lost ${100 - keys.length} of 100 patches`)
  assert.equal(run.status, 'running')
})

test('card.json: ten concurrent `ledger update` children each land their patch', async () => {
  const home = makeHome()
  const env = testEnv(home)
  const id = makeCard(home, env)
  const keys = ['title', 'bounce_reason', 'failure', 'pr_url', 'last_bundle', 'test_command', 'handoff_outcome', 'worktree', 'trunk', 'land_mode']
  for (let round = 1; round <= 3; round++) {
    const results = await Promise.all(keys.map((k) => child([LEDGER, 'update', '--card', id, '--patch', JSON.stringify({ [k]: `${k}-${round}` })], env)))
    for (const r of results) assert.equal(r.code, 0, r.out)
    const card = JSON.parse(readFileSync(join(home, 'cards', id, 'card.json'), 'utf8'))
    const lost = keys.filter((k) => card[k] !== `${k}-${round}`)
    assert.deepEqual(lost, [], `round ${round}: patches lost to a concurrent writer`)
  }
})

test('ledger sync: a record buffered while the flush is running survives it; no DashClaw config is a clear refusal', async () => {
  const home = makeHome()
  const env = testEnv(home)
  const id = makeCard(home, env)
  const file = join(home, 'cards', id, 'unsynced.jsonl')
  const line = (n) => JSON.stringify({ op: 'record', ev: { ts: new Date().toISOString(), card_id: id, actor: { type: 'baton' }, station: 'build', leg: 0, type: 'status', summary: `buffered ${n}` }, card: { repo: home, task: 'lock test' } }) + '\n'
  writeFileSync(file, line(1) + line(2))
  // every record fails slowly, so the flush is still running when a live ledger appends
  const server = createServer((req, res) => { setTimeout(() => { res.statusCode = 500; res.end('{"error":"down"}') }, 600) })
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  try {
    const syncEnv = { ...env, BATON_SYNC_DASHCLAW: '1', DASHCLAW_URL: `http://127.0.0.1:${port}`, DASHCLAW_API_KEY: 'test-key' }
    const flush = child([LEDGER, 'sync', '--card', id], syncEnv)
    await sleep(400)
    appendFileSync(file, line(3))
    const r = await flush
    assert.equal(r.code, 1, `nothing synced, so sync exits 1: ${r.out}`)
    const kept = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).ev.summary)
    assert.deepEqual(kept.sort(), ['buffered 1', 'buffered 2', 'buffered 3'], 'the record appended mid-flush is still buffered')
    assert.ok(!existsSync(`${file}.flushing`), 'no leftover flush file')
  } finally { server.close() }
  const before = readFileSync(file, 'utf8')
  const off = await child([LEDGER, 'sync', '--card', id], env)
  assert.notEqual(off.code, 0)
  assert.match(off.out, /BATON_SYNC_DASHCLAW/)
  assert.equal(readFileSync(file, 'utf8'), before, 'the buffer is left untouched when sync is off')
})
