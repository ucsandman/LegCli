// Optional syncs: off by default (zero spawns, zero requests); workboard argv
// mapping against an openclaw stub; the "plugin unavailable" path; DashClaw
// action records with the real field names; buffering + flush.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { makeHome, testEnv, initRepo, events, ROOT } from './helpers.mjs'
import { actionForEvent, dashclawConfig } from '../src/sync/dashclaw.mjs'
import { VERBS } from '../src/sync/workboard.mjs'
import { enabledSyncs } from '../src/sync/index.mjs'

const LEDGER = join(ROOT, 'src', 'ledger.mjs')
const ledger = (args, env) => execFileSync(process.execPath, [LEDGER, ...args], { env, encoding: 'utf8' }).trim()
// The DashClaw stub lives in this process: a synchronous child would starve it,
// so the DashClaw tests drive the ledger asynchronously.
const execFileAsync = promisify(execFile)
const ledgerAsync = async (args, env) => (await execFileAsync(process.execPath, [LEDGER, ...args], { env, encoding: 'utf8' })).stdout.trim()
// a stand-in credential, assembled at runtime so no key-shaped literal sits in the tree
const KEY = ['stub', 'key', 'for', 'tests'].join('-')

function stubOpenclaw(home) {
  const stub = join(home, 'openclaw-stub.mjs')
  const log = join(home, 'openclaw-argv.log')
  writeFileSync(stub, "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.OPENCLAW_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('ok\\n')\n")
  return { stub, log, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []) }
}

function stubDashclaw({ statuses = [] } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null, apiKey: req.headers['x-api-key'] })
      const status = statuses.length ? statuses.shift() : 201
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: status < 400, action_id: 'act_stub' }))
    })
  })
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise({
    calls, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
  })))
}

// testEnv strips the host's DASHCLAW_* on purpose; put the stub's back afterwards
const withDashclaw = (home, url, extra = {}) => {
  const env = testEnv(home, extra)
  env.DASHCLAW_URL = url
  env.DASHCLAW_API_KEY = KEY
  return env
}

test('default: no sync is enabled; create/append/update spawn nothing and request nothing', async () => {
  const home = makeHome()
  const oc = stubOpenclaw(home)
  const dc = await stubDashclaw()
  const repo = initRepo('sync-')
  // both targets are reachable, but neither flag is set
  const env = withDashclaw(home, dc.url, { OPENCLAW_BIN: oc.stub, OPENCLAW_LOG: oc.log })
  delete env.BATON_SYNC_WORKBOARD
  delete env.BATON_SYNC_DASHCLAW
  assert.deepEqual(enabledSyncs(env), [])
  const id = await ledgerAsync(['create', '--slug', 'off', '--task', 't', '--repo', repo, '--chain', '[{"adapter":"fake"}]'], env)
  await ledgerAsync(['append', '--card', id, '--actor', '{"type":"baton"}', '--type', 'status', '--summary', 'hello'], env)
  await ledgerAsync(['update', '--card', id, '--status', 'done'], env)
  await dc.close()
  assert.deepEqual(oc.argv(), [])
  assert.deepEqual(dc.calls, [])
  assert.ok(!existsSync(join(home, 'cards', id, 'unsynced.jsonl')))
})

test('workboard on: create → add, status → move, done → done, argv only against the stub', () => {
  const home = makeHome()
  const oc = stubOpenclaw(home)
  const repo = initRepo('sync-')
  const env = testEnv(home, { BATON_SYNC_WORKBOARD: '1', OPENCLAW_BIN: oc.stub, OPENCLAW_LOG: oc.log })
  assert.deepEqual(enabledSyncs(env), ['workboard'])
  const id = ledger(['create', '--slug', 'wb', '--task', 'Mirror me', '--repo', repo, '--chain', '[{"adapter":"fake"}]', '--title', 'WB'], env)
  ledger(['update', '--card', id, '--status', 'queued'], env)
  ledger(['update', '--card', id, '--station', 'build'], env) // no status change → no mirror
  ledger(['update', '--card', id, '--status', 'done'], env)
  const argv = oc.argv()
  assert.deepEqual(argv, [
    ['workboard', 'add', '--title', 'WB', '--id', id, '--column', 'backlog'],
    ['workboard', 'move', id, 'queued'],
    ['workboard', 'done', id],
  ])
  assert.deepEqual(VERBS.status({ card_id: 'x', status: 'running' }), ['move', 'x', 'running'])
  // no failure events were recorded
  assert.equal(events(home, id).filter((e) => e.type === 'status' && /\[sync/.test(e.summary)).length, 0)
})

test('workboard unavailable (plugin disabled): one status event, then silence', () => {
  const home = makeHome()
  const stub = join(home, 'openclaw-unavailable.mjs')
  const msg = readFileSync(join(ROOT, 'fixtures', 'sync', 'workboard-help.txt'), 'utf8').trim().split('\n')[0]
  writeFileSync(stub, `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.OPENCLAW_LOG, 'x\\n')\nprocess.stderr.write(${JSON.stringify(msg)} + '\\n')\nprocess.exit(1)\n`)
  const log = join(home, 'oc.log')
  const repo = initRepo('sync-')
  const env = testEnv(home, { BATON_SYNC_WORKBOARD: '1', OPENCLAW_BIN: stub, OPENCLAW_LOG: log })
  const id = ledger(['create', '--slug', 'un', '--task', 't', '--repo', repo, '--chain', '[{"adapter":"fake"}]'], env)
  ledger(['update', '--card', id, '--status', 'queued'], env)
  ledger(['update', '--card', id, '--status', 'done'], env)
  const evs = events(home, id).filter((e) => e.type === 'status')
  assert.equal(evs.length, 1)
  assert.match(evs[0].summary, /\[sync:workboard\] unavailable \(plugin disabled\): The `openclaw workboard` command is unavailable because `plugins\.allow` excludes "workboard"/)
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'openclaw spawned once, then the marker stops further attempts')
  assert.ok(existsSync(join(home, 'sync-workboard.unavailable')))
})

test('dashclaw on: every event becomes POST /api/actions with the validator\'s field names and the x-api-key header', async () => {
  const home = makeHome()
  const dc = await stubDashclaw()
  const repo = initRepo('sync-')
  const env = withDashclaw(home, dc.url, { BATON_SYNC_DASHCLAW: '1' })
  assert.deepEqual(enabledSyncs(env), ['dashclaw'])
  assert.equal(dashclawConfig({ BATON_SYNC_DASHCLAW: '0', DASHCLAW_URL: 'x', DASHCLAW_API_KEY: 'y' }), null, 'flag required even with credentials')
  const id = await ledgerAsync(['create', '--slug', 'dc', '--task', 'Record me', '--repo', repo, '--chain', '[{"adapter":"fake"}]'], env)
  await ledgerAsync(['append', '--card', id, '--actor', '{"type":"agent","adapter":"claude"}', '--type', 'limit_detected', '--summary', 'hit the weekly limit', '--body', 'signal claude-weekly-limit', '--station', 'build', '--leg', '0'], env)
  await dc.close()
  assert.equal(dc.calls.length, 2)
  for (const c of dc.calls) { assert.equal(c.method, 'POST'); assert.equal(c.url, '/api/actions'); assert.equal(c.apiKey, KEY) }
  const created = dc.calls[0].body
  assert.equal(created.agent_id, 'leg/human:local')
  assert.equal(created.action_type, 'leg_card_created')
  assert.match(created.declared_goal, /card created/)
  assert.equal(created.status, 'pending')
  assert.ok(created.systems_touched.includes(id))
  const limit = dc.calls[1].body
  assert.equal(limit.agent_id, 'leg/claude')
  assert.equal(limit.action_type, 'leg_limit_detected')
  assert.equal(limit.status, 'blocked')
  assert.equal(limit.output_summary, 'signal claude-weekly-limit')
  assert.deepEqual(JSON.parse(limit.input_summary).actor, { type: 'agent', adapter: 'claude' })
  // pure mapping: required fields present for every event type
  for (const type of ['leg_started', 'landed', 'killed', 'blocked_by']) {
    const a = actionForEvent({ ts: 'now', type, summary: 's', card_id: 'c', station: 'build', leg: 0, actor: { type: 'baton' } })
    assert.ok(a.agent_id && a.action_type && a.declared_goal, type)
    assert.ok(['running', 'completed', 'failed', 'cancelled', 'pending', 'pending_approval', 'blocked'].includes(a.status), type)
  }
  assert.ok(!existsSync(join(home, 'cards', id, 'unsynced.jsonl')))
})

test('dashclaw down: records buffer to unsynced.jsonl with one throttled status event; `ledger sync` flushes when it is back', async () => {
  const home = makeHome()
  const down = await stubDashclaw({ statuses: [500, 500, 500] })
  const repo = initRepo('sync-')
  const env = withDashclaw(home, down.url, { BATON_SYNC_DASHCLAW: '1' })
  const id = await ledgerAsync(['create', '--slug', 'buf', '--task', 't', '--repo', repo, '--chain', '[{"adapter":"fake"}]'], env)
  await ledgerAsync(['append', '--card', id, '--actor', '{"type":"baton"}', '--type', 'leg_started', '--summary', 'go'], env)
  await down.close()
  const buffered = readFileSync(join(home, 'cards', id, 'unsynced.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(buffered.length, 2)
  assert.equal(buffered[0].op, 'record')
  assert.equal(buffered[0].ev.type, 'card_created')
  const failures = events(home, id).filter((e) => e.type === 'status' && /\[sync:dashclaw\] failed/.test(e.summary))
  assert.equal(failures.length, 1, 'throttled to one failure event per minute')
  const up = await stubDashclaw()
  let status = 0
  try { await ledgerAsync(['sync', '--card', id], { ...env, DASHCLAW_URL: up.url }) } catch (err) { status = err.code }
  await up.close()
  assert.equal(status, 0)
  assert.equal(up.calls.length, 2)
  assert.ok(!existsSync(join(home, 'cards', id, 'unsynced.jsonl')))
})
