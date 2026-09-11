// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ledger.mjs')
const execFileAsync = promisify(execFile)
const CLAUDE = JSON.stringify({ type: 'agent', adapter: 'claude', model: 'claude-opus-5' })
const CHAIN = JSON.stringify([{ adapter: 'claude', mode: 'acceptEdits' }, { adapter: 'codex' }])

function baseEnv(root) {
  // Strip any DASHCLAW_* the host shell/session may have set so the
  // local-only tests stay sync-isolated no matter what leaks in.
  const env = { ...process.env, BATON_HOME: root }
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  return env
}

function run(args, root) {
  return execFileSync(process.execPath, [BIN, ...args], { env: baseEnv(root), encoding: 'utf8' })
}

function runFail(args, root) {
  try {
    run(args, root)
    return null
  } catch (err) {
    return { status: err.status, stderr: err.stderr.toString() }
  }
}

function create(root, slug = 'smoke', extra = []) {
  return run(['create', '--slug', slug, '--task', 'do the thing', '--repo', root, '--chain', CHAIN, ...extra], root).trim()
}

function events(root, id, key) {
  return readFileSync(join(root, 'cards', id, `events-${key}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
}

test('create writes card.json, card_created event, and ACTIVE.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root)
  assert.match(id, /^card-\d{8}-\d{4}-smoke$/)
  const card = JSON.parse(readFileSync(join(root, 'cards', id, 'card.json'), 'utf8'))
  assert.equal(card.card_id, id)
  assert.equal(card.task, 'do the thing')
  assert.equal(card.repo, root)
  assert.deepEqual(card.chain, [{ adapter: 'claude', mode: 'acceptEdits', max_turns: null }, { adapter: 'codex', mode: null, max_turns: null }])
  assert.equal(card.status, 'backlog')
  assert.equal(card.station, '-')
  assert.equal(card.leg, 0)
  assert.deepEqual(card.pipeline, [{ name: 'build', kind: 'agent', prompt: 'build', chain: [{ adapter: 'claude', mode: 'acceptEdits' }, { adapter: 'codex' }] }])
  assert.equal(card.trunk, 'main')
  assert.equal(card.land_mode, 'ff')
  assert.equal(card.test_command, null)
  assert.equal(card.land_attempts, 0)
  assert.deepEqual(card.leases, [])
  assert.deepEqual(card.actor, { type: 'human', id: 'local' })
  const evs = events(root, id, 'human-local')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'card_created')
  assert.equal(evs[0].card_id, id)
  assert.deepEqual(evs[0].actor, { type: 'human', id: 'local' })
  assert.equal(evs[0].station, '-')
  assert.equal(evs[0].leg, 0)
  const active = readFileSync(join(root, 'ACTIVE.md'), 'utf8')
  assert.match(active, new RegExp(id))
  assert.ok(existsSync(join(root, 'cards', id, 'runs')))
})

test('append adds one JSON line to the writer\'s own file only', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'x')
  run(['append', '--card', id, '--actor', CLAUDE, '--type', 'leg_progress',
    '--summary', 'answered', '--body', 'details here', '--station', 'build', '--leg', '1'], root)
  const claudeLines = events(root, id, 'agent-claude')
  assert.equal(claudeLines.length, 1)
  const ev = claudeLines[0]
  assert.deepEqual(ev.actor, { type: 'agent', adapter: 'claude', model: 'claude-opus-5' })
  assert.equal(ev.card_id, id)
  assert.equal(ev.station, 'build')
  assert.equal(ev.leg, 1)
  assert.equal(ev.type, 'leg_progress')
  assert.equal(ev.summary, 'answered')
  assert.equal(ev.body, 'details here')
  assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  // the human file has exactly its card_created line, nothing appended
  assert.equal(events(root, id, 'human-local').length, 1)
})

test('update patches status, session id, station and leg, and regenerates ACTIVE.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'u')
  run(['update', '--card', id, '--status', 'running', '--session-id', 'abc-123', '--station', 'build', '--leg', '2'], root)
  let card = JSON.parse(readFileSync(join(root, 'cards', id, 'card.json'), 'utf8'))
  assert.equal(card.status, 'running')
  assert.equal(card.session_id, 'abc-123')
  assert.equal(card.station, 'build')
  assert.equal(card.leg, 2)
  assert.match(readFileSync(join(root, 'ACTIVE.md'), 'utf8'), new RegExp(`- ${id} \\[running\\] station=build leg=2`))
  run(['update', '--card', id, '--status', 'done'], root)
  card = JSON.parse(readFileSync(join(root, 'cards', id, 'card.json'), 'utf8'))
  assert.equal(card.status, 'done')
  assert.doesNotMatch(readFileSync(join(root, 'ACTIVE.md'), 'utf8'), new RegExp(`- ${id}`)) // done cards leave ACTIVE list
})

test('append with invalid type exits 2 and names the bad value', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'v')
  const fail = runFail(['append', '--card', id, '--actor', CLAUDE, '--type', 'gossip', '--summary', 's'], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /invalid --type "gossip"/)
})

test('append without a valid actor exits 2 (missing, malformed JSON, unknown type, bad adapter name)', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'a')
  const missing = runFail(['append', '--card', id, '--type', 'status', '--summary', 's'], root)
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /missing --actor/)
  for (const bad of ['{not json', '{"type":"robot"}', '{"type":"agent"}', '{"type":"agent","adapter":"../x"}', '{"type":"human"}']) {
    const fail = runFail(['append', '--card', id, '--actor', bad, '--type', 'status', '--summary', 's'], root)
    assert.equal(fail.status, 2, `expected exit 2 for actor ${bad}`)
    assert.match(fail.stderr, /invalid --actor/)
  }
  // nothing was written by any of them
  assert.equal(events(root, id, 'human-local').length, 1)
  assert.ok(!existsSync(join(root, 'cards', id, 'events-agent-claude.jsonl')))
})

test('append to missing card exits 3', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const fail = runFail(['append', '--card', 'card-19990101-0000-nope', '--actor', CLAUDE, '--type', 'status', '--summary', 's'], root)
  assert.equal(fail.status, 3)
  assert.match(fail.stderr, /card not found/)
})

test('create rejects a slug that will not produce a valid card id', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const fail = runFail(['create', '--slug', 'Bad Slug!', '--task', 'i', '--repo', root, '--chain', CHAIN], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /invalid --slug/)
})

test('create rejects an invalid chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  for (const bad of ['[]', '{"adapter":"claude"}', '[{"mode":"x"}]', '[{"adapter":"claude","max_turns":"two"}]', 'nope']) {
    const fail = runFail(['create', '--slug', 'c', '--task', 'i', '--repo', root, '--chain', bad], root)
    assert.equal(fail.status, 2, `expected exit 2 for chain ${bad}`)
    assert.match(fail.stderr, /invalid --chain/)
  }
})

test('readEvents merges every writer file sorted by ts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'merge')
  const dir = join(root, 'cards', id)
  writeFileSync(join(dir, 'events-agent-codex.jsonl'),
    JSON.stringify({ ts: '2026-09-10T00:00:03.000Z', card_id: id, actor: { type: 'agent', adapter: 'codex' }, station: '-', leg: 1, type: 'status', summary: 'third' }) + '\n' +
    JSON.stringify({ ts: '2026-09-10T00:00:01.000Z', card_id: id, actor: { type: 'agent', adapter: 'codex' }, station: '-', leg: 1, type: 'status', summary: 'first' }) + '\n')
  writeFileSync(join(dir, 'events-baton.jsonl'),
    JSON.stringify({ ts: '2026-09-10T00:00:02.000Z', card_id: id, actor: { type: 'baton' }, station: '-', leg: 1, type: 'status', summary: 'second' }) + '\n')
  process.env.BATON_HOME = root
  const { readEvents } = await import(`../src/ledger.mjs?root=${encodeURIComponent(root)}`)
  const evs = readEvents(id)
  assert.equal(evs.length, 4)
  assert.deepEqual(evs.slice(0, 3).map((e) => e.summary), ['first', 'second', 'third'])
  assert.equal(evs[3].type, 'card_created')
})

// -- helpers for sync tests --
function startFakeDashClaw({ statuses = [] } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null, apiKey: req.headers['x-api-key'] })
      const status = statuses.length ? statuses.shift() : 201
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: status < 400 }))
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({
      calls, server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => {
        server.closeAllConnections?.()
        server.close(r)
      }),
    }))
  })
}

async function runSyncedAsync(args, root, dashclawUrl) {
  const env = { ...process.env, BATON_HOME: root, BATON_SYNC_DASHCLAW: '1', DASHCLAW_URL: dashclawUrl }
  env.DASHCLAW_API_KEY = ['test', 'key'].join('-')
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  return stdout
}

test('with BATON_SYNC_DASHCLAW=1 a create is recorded as a DashClaw action (POST /api/actions, x-api-key)', async () => {
  const fake = await startFakeDashClaw()
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = (await runSyncedAsync(['create', '--slug', 's1', '--task', 'i', '--repo', root, '--chain', CHAIN], root, fake.url)).trim()
  await fake.close()
  const create = fake.calls.find((c) => c.method === 'POST' && c.url === '/api/actions')
  assert.ok(create, 'expected a POST /api/actions call')
  assert.equal(create.apiKey, ['test', 'key'].join('-'))
  assert.equal(create.body.action_type, 'baton_card_created')
  assert.equal(create.body.agent_id, 'baton/human:local')
  assert.ok(create.body.systems_touched.includes(id))
  assert.ok(!existsSync(join(root, 'cards', id, 'unsynced.jsonl')))
})

test('sync failure buffers to unsynced.jsonl and still exits 0; `sync` flushes it', async () => {
  const failing = await startFakeDashClaw({ statuses: [500, 500] })
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = (await runSyncedAsync(['create', '--slug', 's2', '--task', 'i', '--repo', root, '--chain', CHAIN], root, failing.url)).trim()
  await failing.close()
  const buffered = readFileSync(join(root, 'cards', id, 'unsynced.jsonl'), 'utf8').trim().split('\n')
  assert.ok(buffered.length >= 1)
  assert.equal(JSON.parse(buffered[0]).op, 'record')
  const healthy = await startFakeDashClaw()
  await runSyncedAsync(['sync', '--card', id], root, healthy.url)
  await healthy.close()
  assert.ok(healthy.calls.length >= 1)
  assert.ok(!existsSync(join(root, 'cards', id, 'unsynced.jsonl')))
})

test('append refuses secret-looking values with exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'sec')
  const fail = runFail(['append', '--card', id, '--actor', CLAUDE, '--type', 'status',
    '--summary', 'the key is sk-abcdefgh12345678'], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /refusing to log/)
  // nothing was written
  assert.ok(!existsSync(join(root, 'cards', id, 'events-agent-claude.jsonl')))
  assert.equal(events(root, id, 'human-local').length, 1) // only card_created
})

test('update dies cleanly (exit 2) on corrupt card.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = create(root, 'c1')
  writeFileSync(join(root, 'cards', id, 'card.json'), '{ not json')
  const fail = runFail(['update', '--card', id, '--status', 'done'], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /corrupt card.json/)
})

test('unknown subcommand exits 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const fail = runFail(['frobnicate', '--card', 'x'], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /unknown command/)
})

test('a corrupt card.json is skipped with a warning and does not brick ACTIVE.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const idA = create(root, 'corrupt-a')
  const idB = create(root, 'valid-b')
  writeFileSync(join(root, 'cards', idA, 'card.json'), '{ not json')
  // update on the VALID card triggers writeActive(), which must skip A and keep going
  run(['update', '--card', idB, '--status', 'queued'], root)
  const active = readFileSync(join(root, 'ACTIVE.md'), 'utf8')
  assert.match(active, new RegExp(idB))
  assert.doesNotMatch(active, new RegExp(idA))
})

test('ordinary hyphenated words are not refused as secrets; a real key still is', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const id = run(['create', '--slug', 'hyphens', '--task', 'refactor the task-management-system so the disk-space_monitor is risk-free',
    '--repo', root, '--chain', CHAIN, '--title', 'ask-me-anything-bot'], root).trim()
  assert.ok(existsSync(join(root, 'cards', id, 'card.json')), `card not created: ${id}`)
  const fail = runFail(['create', '--slug', 'leaky', '--task', 'the key is sk-abcdefgh12345678', '--repo', root, '--chain', CHAIN], root)
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /refusing to log/)
})
