// Every fake-agent mode through the real supervisor and classifier. The
// diagnostic lines print the mode → outcome table for the transcript.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const RUNNER = join(SRC, 'runner.mjs')
const LEDGER = join(SRC, 'ledger.mjs')

const EXPECT = [
  // mode, adapter, extra env, outcome, handoff, supervisor exit, ledger event type
  ['success', 'fake', {}, 'completed', false, 0, 'leg_exited'],
  ['incomplete', 'fake', {}, 'incomplete', true, 13, 'leg_exited'],
  ['limit', 'fake', {}, 'limit', true, 13, 'limit_detected'],
  ['limit', 'fake-claude', { FAKE_LIMIT_FIXTURE: 'claude-weekly-limit' }, 'limit', true, 13, 'limit_detected'],
  ['limit', 'fake-codex', { FAKE_LIMIT_FIXTURE: 'codex-usage-limit' }, 'limit', true, 13, 'limit_detected'],
  ['stall', 'fake', { BATON_TIMERS_MS: '100,400' }, 'stalled', true, 12, 'killed'],
  ['auth', 'fake', {}, 'auth_failed', false, 13, 'error'],
  ['crash', 'fake', {}, 'failed', true, 13, 'leg_exited'],
  ['no_progress', 'fake', {}, 'no_progress', true, 13, 'leg_exited'],
]

function setup(mode, adapter, extra) {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const work = join(root, 'work') // the leg's cwd; kept apart from BATON_HOME so state writes never look like work
  mkdirSync(work)
  const env = { ...process.env, BATON_HOME: root, BATON_TIMERS_MS: '60000,120000', FAKE_MODE: mode, ...extra }
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  const id = execFileSync(process.execPath, [LEDGER, 'create', '--slug', 'modes', '--task', 't', '--repo', work,
    '--chain', JSON.stringify([{ adapter }])], { env, encoding: 'utf8' }).trim()
  const dir = join(root, 'cards', id, 'runs', '1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prompt.txt'), 'Task: modes\n')
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ card_id: id, run: 1, adapter, status: 'launching', supervisor_pid: process.pid, cwd: work, outcome: null }))
  return { root, work, env, id }
}

for (const [mode, adapter, extra, outcome, handoff, exit, eventType] of EXPECT) {
  const label = `${mode} via ${adapter}${extra.FAKE_LIMIT_FIXTURE ? ` (${extra.FAKE_LIMIT_FIXTURE})` : ''}`
  test(`fake mode ${label} → ${outcome}`, (t) => {
    const { root, work, env, id } = setup(mode, adapter, extra)
    let status = 0
    try {
      execFileSync(process.execPath, [RUNNER, 'supervise', '--card', id, '--adapter', adapter, '--run', '1', '--cwd', work], { env, encoding: 'utf8' })
    } catch (err) {
      status = err.status
    }
    const run = JSON.parse(readFileSync(join(root, 'cards', id, 'runs', '1', 'run.json'), 'utf8'))
    const eventsFile = existsSync(join(root, 'cards', id, 'events-leg.jsonl')) ? join(root, 'cards', id, 'events-leg.jsonl') : join(root, 'cards', id, 'events-baton.jsonl')
    const events = readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
    const last = events[events.length - 1]
    t.diagnostic(`| ${label.padEnd(52)} | ${String(run.outcome).padEnd(13)} | handoff=${String(run.handoff).padEnd(5)} | exit=${String(status).padEnd(2)} | ${last.type.padEnd(14)} | signal=${run.signal} |`)
    assert.equal(run.outcome, outcome)
    assert.equal(run.handoff, handoff)
    assert.equal(status, exit)
    assert.equal(last.type, eventType)
    if (mode === 'success') assert.ok(existsSync(join(work, 'hello-fake.txt')) && (existsSync(join(work, '.leg', 'DONE')) || existsSync(join(work, '.baton', 'DONE'))))
    if (mode === 'incomplete') assert.ok(existsSync(join(work, 'hello-fake.txt')) && !existsSync(join(work, '.leg', 'DONE')) && !existsSync(join(work, '.baton', 'DONE')))
    if (mode === 'no_progress') assert.ok(!existsSync(join(work, 'hello-fake.txt')))
    if (mode === 'limit') assert.equal(run.signal, extra.FAKE_LIMIT_FIXTURE ?? 'claude-session-limit')
  })
}
