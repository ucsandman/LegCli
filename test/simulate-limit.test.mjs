// `baton sessions simulate-limit <id>` drives the real limit path through
// src/hook.mjs, and src/live-capture.mjs keeps the first real payload only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeHome, testEnv, baton, batonFail, ROOT } from './helpers.mjs'

const HOME = makeHome()
const LIVE = mkdtempSync(join(tmpdir(), 'baton-live-'))
process.env.BATON_HOME = HOME
process.env.BATON_LIVE_DIR = LIVE
const env = testEnv(HOME, { BATON_LIVE_DIR: LIVE })
const { createSession, updateSession, readSession, readEvents } = await import('../src/sessions.mjs')
const { readUsage } = await import('../src/usage.mjs')
const { captureLive, livePath, isSimulated } = await import('../src/live-capture.mjs')
const HOOK = join(ROOT, 'src', 'hook.mjs')
const cwd = mkdtempSync(join(tmpdir(), 'baton-cwd-'))
// a key-shaped string built at runtime so no tracked file carries one
const FAKE_KEY = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOP'].join('-')

test('simulate-limit on a claude session: hook path runs, status limit, short wall, nothing captured as live', () => {
  createSession({ id: 's-sim-claude', agent: 'claude', cwd, repo: null, chain: [{ agent: 'codex', account: 'default' }], runner_pid: process.pid })
  updateSession('s-sim-claude', { status: 'running', agent_session_id: 'cs-1' })
  const out = baton(['sessions', 'simulate-limit', 's-sim-claude'], env)
  assert.match(out, /StopFailure rate_limit sent through src\/hook\.mjs/)
  assert.match(out, /hands off within \d+ ms to codex/)
  const s = readSession('s-sim-claude')
  assert.equal(s.status, 'limit')
  assert.equal(s.limit.reason, 'rate_limit')
  assert.equal(s.limit.simulated, true)
  const u = readUsage('claude', 'default')
  assert.equal(u.limited_reason, 'rate_limit')
  assert.equal(u.source, 'baton simulate-limit')
  const nowS = Math.floor(Date.now() / 1000)
  assert.ok(u.limited_until > nowS + 60 && u.limited_until <= nowS + 121, `wall clears in ~2 min, got +${u.limited_until - nowS}s`)
  assert.ok(readEvents('s-sim-claude').some((e) => e.type === 'limit' && /simulated/.test(e.summary)))
  assert.equal(existsSync(livePath('claude', 'rate_limit', LIVE)), false, 'a simulated payload is never kept as live evidence')
  const again = batonFail(['sessions', 'simulate-limit', 's-sim-claude'], env)
  assert.equal(again.status, 3, 'a session at limit is no longer active')
})

test('simulate-limit on agy appends to the session log; on codex it is refused with the handoff alternative', () => {
  createSession({ id: 's-sim-agy', agent: 'agy', cwd, repo: null, chain: [], runner_pid: process.pid })
  updateSession('s-sim-agy', { status: 'running' })
  const out = baton(['sessions', 'simulate-limit', 's-sim-agy'], env)
  assert.match(out, /RESOURCE_EXHAUSTED appended/)
  const log = readFileSync(join(HOME, 'sessions', 's-sim-agy', 'agy.log'), 'utf8')
  assert.match(log, /RESOURCE_EXHAUSTED.*simulated by baton/)
  assert.equal(isSimulated({ log_excerpt: log }), true)
  createSession({ id: 's-sim-codex', agent: 'codex', cwd, repo: null, chain: [], runner_pid: process.pid })
  updateSession('s-sim-codex', { status: 'running' })
  const r = batonFail(['sessions', 'simulate-limit', 's-sim-codex'], env)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /rollout file/)
  assert.match(r.stderr, /baton sessions handoff s-sim-codex/)
})

test('live capture: the first real StopFailure through hook.mjs is kept scrubbed, the second never overwrites, docs flip script sees it', () => {
  createSession({ id: 's-real-claude', agent: 'claude', cwd, repo: null, chain: [], runner_pid: process.pid })
  updateSession('s-real-claude', { status: 'running' })
  const payload = { hook_event_name: 'StopFailure', error: 'rate_limit', session_id: 'cs-2', last_assistant_message: `API Error: Rate limit reached; token ${FAKE_KEY} leaked here` }
  execFileSync(process.execPath, [HOOK, 'claude-hook', '--session', 's-real-claude'], { env, input: JSON.stringify(payload), encoding: 'utf8' })
  const file = livePath('claude', 'rate_limit', LIVE)
  assert.ok(existsSync(file), 'first real payload kept')
  const kept = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(kept.source, 'observed-live')
  assert.equal(kept.session_id, 's-real-claude')
  assert.equal(kept.payload.error, 'rate_limit')
  assert.equal(readFileSync(file, 'utf8').includes(FAKE_KEY), false, 'secrets scrubbed')
  assert.match(kept.payload.last_assistant_message, /\[REDACTED\]/)
  assert.equal(readSession('s-real-claude').status, 'limit')
  assert.equal(readSession('s-real-claude').limit.simulated, false)
  assert.ok(readUsage('claude', 'default').limited_until > Math.floor(Date.now() / 1000) + 3600, 'a real wall keeps the default 5 h window')
  const before = readFileSync(file, 'utf8')
  const second = captureLive('claude', 'rate_limit', { ...payload, last_assistant_message: 'second' }, { sessionId: 'x', flipDocs: false })
  assert.equal(second.written, false)
  assert.equal(readFileSync(file, 'utf8'), before, 'never overwritten')
  // the flip script: a docs copy with a marker row goes docs-only → observed-live <date>
  assert.equal(captureLive('codex', 'usage_limit_exceeded', { type: 'event_msg', payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded', message: 'You\'ve hit your usage limit.' } } }, { flipDocs: false }).written, true)
  const check = execFileSync(process.execPath, [join(ROOT, 'scripts', 'live-limits.mjs'), '--check'], { env: { ...env, BATON_LIVE_DIR: mkdtempSync(join(tmpdir(), 'baton-live-empty-')) }, encoding: 'utf8' })
  assert.match(check, /rows=6 stale=0/, 'the shipped docs carry six marker rows and none is stale against an empty live dir')
  // against the live dir with claude + codex captured, both docs are stale
  let stale = ''
  try { execFileSync(process.execPath, [join(ROOT, 'scripts', 'live-limits.mjs'), '--check'], { env, encoding: 'utf8' }) } catch (err) { stale = err.stdout }
  assert.match(stale, /stale=2/)
  // a marker row in a scratch doc flips to observed-live with the capture date
  const scratch = mkdtempSync(join(tmpdir(), 'baton-docs-'))
  mkdirSync(join(scratch, 'docs')); mkdirSync(join(scratch, 'scripts'))
  writeFileSync(join(scratch, 'docs', 'adapters.md'), 'row: **docs-only** <!-- live:claude/rate_limit -->\n')
  writeFileSync(join(scratch, 'docs', 'cli-contracts.md'), 'row: **docs-only** <!-- live:agy/agy-resource-exhausted -->\n')
  writeFileSync(join(scratch, 'scripts', 'live-limits.mjs'), readFileSync(join(ROOT, 'scripts', 'live-limits.mjs'), 'utf8'))
  execFileSync(process.execPath, [join(scratch, 'scripts', 'live-limits.mjs')], { env, encoding: 'utf8' })
  assert.match(readFileSync(join(scratch, 'docs', 'adapters.md'), 'utf8'), /\*\*observed-live \d{4}-\d{2}-\d{2}\*\* <!-- live:claude\/rate_limit -->/)
  assert.match(readFileSync(join(scratch, 'docs', 'cli-contracts.md'), 'utf8'), /\*\*docs-only\*\*/, 'agy row stays docs-only: nothing captured')
})
