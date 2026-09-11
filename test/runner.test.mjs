// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from '../src/runner.mjs'
import { get as getAdapter, names as adapterNames } from '../src/adapters/index.mjs'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BIN = join(SRC, 'runner.mjs')
const LEDGER = join(SRC, 'ledger.mjs')

// The fake adapter drives bin/fake-agent.mjs; FAKE_MODE picks its behaviour, so
// detached supervise children never touch a real CLI.
function makeEnv(root, extra = {}) {
  const env = {
    ...process.env, BATON_HOME: root, BATON_TIMERS_MS: '60000,120000', FAKE_MODE: 'success', ...extra,
  }
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  return env
}

function run(args, env) {
  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
}

function runFail(args, env) {
  try {
    run(args, env)
    return null
  } catch (err) {
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

function makeCard(root, env) {
  return execFileSync(process.execPath,
    [LEDGER, 'create', '--slug', 'ho', '--task', 'test task', '--repo', root,
     '--chain', JSON.stringify([{ adapter: 'fake' }])],
    { env, encoding: 'utf8' }).trim()
}

function makePrompt(root) {
  const f = join(root, 'prompt-src.txt')
  writeFileSync(f, 'Task: test\nWrite .baton/DONE when finished.\n')
  return f
}

function runJson(root, id, n = 1) {
  return JSON.parse(readFileSync(join(root, 'cards', id, 'runs', String(n), 'run.json'), 'utf8'))
}

function prepRun(root, id, n = 1, patch = {}) {
  const dir = join(root, 'cards', id, 'runs', String(n))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prompt.txt'), 'Task: test\n')
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    card_id: id, run: n, adapter: 'fake', status: 'launching', supervisor_pid: process.pid,
    agent_pid: null, started_at: new Date().toISOString(), cwd: root, outcome: null, ...patch,
  }))
  return dir
}

function batonEvents(root, id) {
  const f = join(root, 'cards', id, 'events-baton.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
}

test('launch writes run.json + prompt.txt and prints ok JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  const out = run(['launch', '--card', id, '--adapter', 'fake', '--prompt-file', makePrompt(root), '--cwd', root, '--mode', 'accept-edits', '--max-turns', '3'], env)
  const res = JSON.parse(out)
  assert.equal(res.ok, true)
  assert.equal(res.run, 1)
  assert.ok(Number.isInteger(res.supervisor_pid))
  const r = runJson(root, id)
  assert.equal(r.card_id, id)
  assert.equal(r.run, 1)
  assert.equal(r.adapter, 'fake')
  assert.equal(r.mode, 'accept-edits')
  assert.equal(r.max_turns, 3)
  assert.equal(r.status, 'launching')
  assert.equal(r.supervisor_pid, res.supervisor_pid)
  assert.equal(r.outcome, null)
  assert.match(readFileSync(join(root, 'cards', id, 'runs', '1', 'prompt.txt'), 'utf8'), /Write \.baton\/DONE/)
})

test('launch refuses unknown card with exit 3', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const r = runFail(['launch', '--card', 'card-nope', '--adapter', 'fake', '--prompt-file', makePrompt(root)], env)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /card not found: card-nope/)
})

test('launch refuses missing prompt file with exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  const r = runFail(['launch', '--card', id, '--adapter', 'fake', '--prompt-file', join(root, 'absent.txt')], env)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /prompt file not found/)
})

test('launch refuses an unknown adapter with exit 2 before spawning anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  const r = runFail(['launch', '--card', id, '--adapter', 'nope', '--prompt-file', makePrompt(root)], env)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown adapter: nope/)
  assert.ok(!existsSync(join(root, 'cards', id, 'runs', '1')))
})

test('launch exits 11 run_already_active when the supervisor pid is alive', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  // process.pid is definitely alive: it is this test runner
  prepRun(root, id, 1, { status: 'running', supervisor_pid: process.pid })
  const r = runFail(['launch', '--card', id, '--adapter', 'fake', '--prompt-file', makePrompt(root)], env)
  assert.equal(r.status, 11)
  const res = JSON.parse(r.stdout)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'run_already_active')
  assert.equal(res.run, 1)
  assert.equal(res.supervisor_pid, process.pid)
})

test('launch marks a stale run (dead supervisor pid) orphaned and starts the next run', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  prepRun(root, id, 1, { status: 'running', supervisor_pid: 4000000 })
  const out = run(['launch', '--card', id, '--adapter', 'fake', '--prompt-file', makePrompt(root)], env)
  assert.equal(JSON.parse(out).ok, true)
  assert.equal(JSON.parse(out).run, 2)
  assert.equal(runJson(root, id, 1).status, 'orphaned')
  assert.equal(runJson(root, id, 2).status, 'launching')
})

test('supervise: fast finish -> exited 0, session id stored on run and card, no timer events', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  prepRun(root, id)
  run(['supervise', '--card', id, '--adapter', 'fake', '--run', '1', '--cwd', root], env)
  const r = runJson(root, id)
  assert.equal(r.status, 'exited')
  assert.equal(r.exit_code, 0)
  assert.equal(r.session_id, 'sess-fake')
  assert.equal(r.outcome, null)
  assert.ok(Number.isInteger(r.agent_pid))
  const card = JSON.parse(readFileSync(join(root, 'cards', id, 'card.json'), 'utf8'))
  assert.equal(card.session_id, 'sess-fake')
  const evs = batonEvents(root, id)
  assert.ok(evs.some((e) => e.type === 'leg_started' && e.actor.type === 'baton' && e.card_id === id))
  assert.ok(evs.some((e) => e.type === 'leg_exited' && /exited code 0/.test(e.summary)))
  assert.equal(evs.filter((e) => e.type === 'status' || e.type === 'killed').length, 0)
  // the prompt reached the agent through stdin
  const out = JSON.parse(readFileSync(join(root, 'cards', id, 'runs', '1', 'out.log'), 'utf8'))
  assert.ok(out.prompt_chars > 0)
})

test('supervise: agent exits non-zero -> exited 1, exit 13, scrubbed stderr tail in the ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, { FAKE_MODE: 'fail' })
  const id = makeCard(root, env)
  prepRun(root, id)
  const r = runFail(['supervise', '--card', id, '--adapter', 'fake', '--run', '1', '--cwd', root], env)
  assert.equal(r.status, 13)
  const rj = runJson(root, id)
  assert.equal(rj.status, 'exited')
  assert.equal(rj.exit_code, 1)
  const ev = batonEvents(root, id).find((e) => e.type === 'leg_exited')
  assert.ok(ev, 'expected a leg_exited ledger event')
  assert.match(ev.summary, /exited code 1/)
  assert.match(ev.body, /boom line one/)
  assert.doesNotMatch(ev.body, /sk-abcdefgh12345678/)
  assert.match(ev.body, /\[REDACTED\]/)
  // the runner does not classify or close the card; that is the chain's job
  const card = JSON.parse(readFileSync(join(root, 'cards', id, 'card.json'), 'utf8'))
  assert.equal(card.status, 'backlog')
})

test('supervise: runaway agent -> still-running status event then killed, exit 12', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, { FAKE_MODE: 'sleep', BATON_TIMERS_MS: '150,600' }) // notify at 150ms, kill at 600ms
  const id = makeCard(root, env)
  prepRun(root, id)
  const r = runFail(['supervise', '--card', id, '--adapter', 'fake', '--run', '1', '--cwd', root], env)
  assert.equal(r.status, 12)
  assert.equal(runJson(root, id).status, 'killed')
  const evs = batonEvents(root, id)
  assert.ok(evs.some((e) => e.type === 'status' && /still running/.test(e.summary)))
  assert.ok(evs.some((e) => e.type === 'killed' && /killed after/.test(e.summary)))
})

test('supervise: unkillable agent -> retry, UNKILLABLE ledger error, still exit 12', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, { FAKE_MODE: 'sleep', BATON_TIMERS_MS: '100,300,150', BATON_SKIP_KILL: '1' })
  const id = makeCard(root, env)
  prepRun(root, id)
  const r = runFail(['supervise', '--card', id, '--adapter', 'fake', '--run', '1', '--cwd', root], env)
  assert.equal(r.status, 12)
  const rj = runJson(root, id)
  assert.equal(rj.status, 'killed')
  assert.equal(rj.exit_code, null)
  assert.ok(batonEvents(root, id).some((e) => e.type === 'error' && /UNKILLABLE/.test(e.summary)),
    'expected an UNKILLABLE ledger error event')
})

test('supervise: child env is sanitized of every forbidden key and the print ceiling is 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, {
    FAKE_MODE: 'envcheck',
    ANTHROPIC_API_KEY: '<PLACEHOLDER>', ANTHROPIC_AUTH_TOKEN: '<PLACEHOLDER>',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_KEY: '<PLACEHOLDER>',
    CLAUDECODE: '1', CLAUDE_EFFORT: 'high', CLAUDE_PLUGIN_DATA: '/x',
    CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '99',
  })
  const id = makeCard(root, env)
  prepRun(root, id)
  run(['supervise', '--card', id, '--adapter', 'fake', '--run', '1', '--cwd', root], env)
  assert.equal(runJson(root, id).session_id, 'clean-env')
})

test('sanitizeEnv deletes the seven forbidden keys and every CLAUDE_CODE_* key, sets the ceiling to 0', () => {
  const out = sanitizeEnv({
    ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_BASE_URL: 'c', OPENAI_API_KEY: 'd',
    CLAUDECODE: '1', CLAUDE_EFFORT: 'e', CLAUDE_PLUGIN_DATA: 'f', CLAUDE_CODE_SESSION_ID: 'g',
    CLAUDE_CODE_ENTRYPOINT: 'h', PATH: 'keep', HOME: 'keep',
  })
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY',
    'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) {
    assert.equal(out[k], undefined, `${k} must be deleted`)
  }
  assert.equal(out.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
  assert.equal(out.PATH, 'keep')
  assert.equal(out.HOME, 'keep')
})

test('adapter registry: fake resolves; an unregistered name is refused by name', async () => {
  assert.ok(adapterNames().includes('fake'))
  const fake = await getAdapter('fake')
  assert.equal(fake.name, 'fake')
  assert.equal(fake.stdin, 'pipe')
  assert.equal(fake.argv({ mode: 'x' }).bin, process.execPath)
  await assert.rejects(getAdapter('nope'), /unknown adapter: nope/)
})

test('sweep: dead supervisor -> orphaned + ORPHANED report line + ledger error', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  prepRun(root, id, 1, { status: 'running', supervisor_pid: 4000000, agent_pid: 4000001 })
  const out = run(['sweep'], env)
  assert.match(out, new RegExp(`ORPHANED ${id} run 1: supervisor 4000000 dead`))
  assert.equal(runJson(root, id).status, 'orphaned')
  assert.ok(batonEvents(root, id).some((e) => e.type === 'error' && /\[sweep\] supervisor pid 4000000 dead/.test(e.summary)))
})

test('sweep: healthy running run is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env)
  prepRun(root, id, 1, { status: 'running', supervisor_pid: process.pid })
  const out = run(['sweep'], env)
  assert.match(out, /OK: 1 active run\(s\), no orphans/)
  assert.equal(runJson(root, id).status, 'running')
})

test('sweep: no runs at all -> OK quiet line, exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  makeCard(root, env) // card exists but has no runs
  const out = run(['sweep'], env)
  assert.match(out, /OK: no active runs/)
})
