// Per-model buckets: what a wall message walled (src/buckets.mjs), which
// bucket binds a terminal (usage.binding), and the record that holds both
// (usage: walls, history, extra_usage).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'leg-buckets-'))

const { bucketFromWall, MODEL_ALIASES, modelFlagFor } = await import('../src/buckets.mjs')
const usage = await import('../src/usage.mjs')
const claudeUsage = await import('../src/taps/claude-usage.mjs')

const nowS = () => Math.floor(Date.now() / 1000)

test('bucketFromWall: session and weekly wall the login, a model name walls one family', () => {
  // docs/en/costs: session and weekly limits are shared across every model, so
  // a same-login model switch buys nothing.
  assert.deepEqual(bucketFromWall('claude', "You've hit your session limit"), { scope: 'account' })
  assert.deepEqual(bucketFromWall('claude', "You’ve hit your weekly limit"), { scope: 'account' })
  // both observed wordings: the docs say "hit", the live StopFailure said "reached"
  assert.deepEqual(bucketFromWall('claude', "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model."), { scope: 'model', model: 'fable' })
  assert.deepEqual(bucketFromWall('claude', "You've hit your Opus limit"), { scope: 'model', model: 'opus' })
  assert.deepEqual(bucketFromWall('claude', "You’ve hit your Sonnet limit"), { scope: 'model', model: 'sonnet' })
  assert.deepEqual(bucketFromWall('claude', 'Your spend limit has been reached'), { scope: 'account', bucket: 'spend' })
  // codex names the limit it hit (docs-only wording, codex-rs/protocol error.rs)
  assert.deepEqual(bucketFromWall('codex', "You've hit your usage limit for gpt-5. Switch to another model now, or wait."), { scope: 'model', model: 'gpt-5' })
  // codex's own account wall is not a model called "usage"
  assert.deepEqual(bucketFromWall('codex', "You've hit your usage limit."), { scope: 'account' })
  // rule 5: unrecognised wording walls the whole login, which is the safe direction
  assert.deepEqual(bucketFromWall('claude', 'API Error: Rate limit reached'), { scope: 'account' })
  assert.deepEqual(bucketFromWall('claude', ''), { scope: 'account' })
  assert.deepEqual(bucketFromWall('claude', null), { scope: 'account' })
  assert.deepEqual(bucketFromWall('agy', 'rpc error: code = ResourceExhausted'), { scope: 'account' })
})

test('the alias list and the model flag each adapter spells', () => {
  assert.deepEqual(MODEL_ALIASES.claude, ['fable', 'opus', 'sonnet', 'haiku'])
  // src/adapters/claude.mjs:29 and agy.mjs:34 push --model; codex.mjs:42 and grok.mjs:45 push -m
  assert.equal(modelFlagFor('claude'), '--model')
  assert.equal(modelFlagFor('agy'), '--model')
  assert.equal(modelFlagFor('codex'), '-m')
  assert.equal(modelFlagFor('grok'), '-m')
  assert.equal(modelFlagFor('nothing-like-this'), null, 'an agent Leg does not know gets no flag, never a guessed --model')
})

// ---- the tap: the live payload shape → buckets + extra_usage ----

const LIVE = {
  five_hour: { utilization: 29, resets_at: '2026-09-17T20:30:00Z' },
  seven_day: { utilization: 47, resets_at: '2026-09-23T19:00:00Z' },
  seven_day_opus: null,
  limits: [
    { type: 'session', utilization: 29, resets_at: '2026-09-17T20:30:00Z', is_active: false, severity: 'normal', scope: null },
    { type: 'weekly_all', utilization: 47, resets_at: '2026-09-23T19:00:00Z', is_active: false, severity: 'normal', scope: null },
    { type: 'weekly_scoped', utilization: 63, resets_at: '2026-09-23T19:00:00Z', is_active: true, severity: 'normal', scope: { model: { display_name: 'Fable' } } },
  ],
  extra_usage: { is_enabled: false, disabled_reason: 'out_of_credits', monthly_limit: 12500, tangelo: 'codename', iguana_necktie: 7 },
  spend: { can_toggle: false, can_purchase_credits: false },
}

test('the usage payload: limits[] become buckets, and a payload with no limits key yields none', () => {
  const buckets = claudeUsage.bucketsFrom(LIVE)
  assert.equal(buckets.length, 3)
  assert.deepEqual(buckets.map((b) => b.kind), ['session', 'weekly_all', 'weekly_scoped'])
  assert.deepEqual(buckets.map((b) => b.group), ['session', 'weekly', 'weekly'])
  assert.deepEqual(buckets.map((b) => b.model), [null, null, 'fable'])
  assert.deepEqual(buckets.map((b) => b.percent), [29, 47, 63])
  assert.deepEqual(buckets.map((b) => b.is_active), [false, false, true])
  // epoch seconds, the same units as the existing windows
  assert.equal(buckets[0].resets_at, 1789677000)
  assert.equal(buckets[2].resets_at, 1790190000)
  assert.deepEqual(claudeUsage.bucketsFrom({ five_hour: LIVE.five_hour }), [], 'no limits key: no buckets, and the two windows are untouched')
  assert.deepEqual(claudeUsage.bucketsFrom({ limits: [null, {}, { type: 'x' }] }), [], 'a row with no percentage is not a bucket')
})

test('extra_usage carries the five fields Leg prints and none of the codename keys', () => {
  const e = claudeUsage.extraUsageFrom(LIVE)
  assert.deepEqual(e, { enabled: false, reason: 'out_of_credits', can_toggle: false, limit_minor: 12500 })
  const keys = JSON.stringify(e)
  for (const codename of ['tangelo', 'iguana_necktie', 'nimbus_quill']) {
    assert.equal(keys.includes(codename), false, `extra_usage carries the codename key ${codename}`)
  }
  assert.equal(claudeUsage.extraUsageFrom({}), null, 'a payload with no spend block records nothing')
})

// ---- the record ----

test('binding(): is_active first, then the row\'s model, then weekly_all, then session', () => {
  const buckets = claudeUsage.bucketsFrom(LIVE)
  const u = { buckets, five_hour: { pct: 29, resets_at: 1789677000 }, seven_day: { pct: 47, resets_at: 1790190000 } }
  const active = usage.binding(u, null)
  assert.deepEqual(active, { kind: 'weekly_scoped', model: 'fable', percent: 63, resets_at: 1790190000, scope: 'model' })

  const quiet = buckets.map((b) => ({ ...b, is_active: false }))
  assert.equal(usage.binding({ ...u, buckets: quiet }, 'fable').kind, 'weekly_scoped', 'no active row: the row scoped to this terminal\'s model binds')
  assert.equal(usage.binding({ ...u, buckets: quiet }, 'fable').scope, 'model')
  assert.equal(usage.binding({ ...u, buckets: quiet }, 'sonnet').kind, 'weekly_all', 'a model with no bucket falls to the account weekly')
  assert.equal(usage.binding({ ...u, buckets: quiet }, 'sonnet').scope, 'account')
  const sessionOnly = quiet.filter((b) => b.kind === 'session')
  assert.equal(usage.binding({ ...u, buckets: sessionOnly }, 'sonnet').kind, 'session')
})

test('binding(): no buckets at all falls back to the hottest legacy window, so the old verdict stays right', () => {
  const u = { buckets: [], five_hour: { pct: 29, resets_at: 1789677000 }, seven_day: { pct: 47, resets_at: 1790190000 } }
  assert.deepEqual(usage.binding(u, 'fable'), { kind: 'seven_day', model: null, percent: 47, resets_at: 1790190000, scope: 'account' })
  assert.equal(usage.binding({ buckets: [], five_hour: null, seven_day: null }, null), null, 'no figure anywhere is null, never a zero')
})

test('a model wall leaves the login open; recordUsage clears it once its clock passes', () => {
  const later = nowS() + 7200
  usage.recordUsage('claude', 'wall-model', { five_hour: { pct: 29, resets_at: later }, seven_day: { pct: 47, resets_at: later }, buckets: claudeUsage.bucketsFrom(LIVE) }, 'test')
  const u = usage.markLimited('claude', 'wall-model', { reason: 'model_limit', source: 'claude StopFailure', scope: 'model', model: 'fable', evidence: "You've reached your Fable limit." })
  assert.equal(u.limited_until, null, 'a Fable wall does not wall the login')
  assert.equal(u.limited_reason, null)
  assert.equal(usage.isAvailable(u), true, 'claude/sonnet can still be handed work')
  assert.equal(u.walls.fable.limited_reason, 'model_limit')
  assert.equal(u.walls.fable.evidence, "You've reached your Fable limit.")
  assert.equal(u.walls.fable.limited_until, 1790190000, 'the wall takes the model bucket\'s own reset')
  assert.equal(usage.wallActive(u.walls.fable), true)
  assert.equal(usage.wallActive(u.walls.opus), false, 'a model with no wall is not walled')

  // an expired model wall is cleared by the next reading, the way an expired
  // account wall already is
  const expired = usage.markLimited('claude', 'wall-expired', { reason: 'model_limit', source: 'test', resets_at: nowS() + 60, scope: 'model', model: 'fable' })
  assert.equal(usage.wallActive(expired.walls.fable), true)
  usage.markLimited('claude', 'wall-expired', { reason: 'model_limit', source: 'test', scope: 'model', model: 'fable' })
  // rewrite the wall into the past, then let a reading sweep it
  const dir = usage.usageFile('claude', 'wall-expired')
  const rec = JSON.parse(readFileSync(dir, 'utf8'))
  rec.walls.fable.limited_until = nowS() - 10
  writeFileSync(dir, JSON.stringify(rec))
  const swept = usage.recordUsage('claude', 'wall-expired', { five_hour: null, seven_day: null }, 'test')
  assert.deepEqual(swept.walls, {}, 'a reading clears a model wall whose clock has passed')
})

test('an account wall behaves exactly as it always has', () => {
  const u = usage.markLimited('claude', 'wall-account', { reason: 'rate_limit', source: 'claude StopFailure' })
  assert.ok(u.limited_until > nowS(), 'the login is out')
  assert.equal(u.limited_reason, 'rate_limit')
  assert.equal(usage.isAvailable(u), false)
  assert.deepEqual(u.walls, {}, 'an account wall writes no model wall')
})

test('history: one ring per bucket, capped at 24, cleared when the window resets', () => {
  const acct = 'history'
  const base = { kind: 'weekly_scoped', group: 'weekly', model: 'fable', resets_at: 1790190000, is_active: true, severity: 'normal' }
  for (let i = 0; i < 30; i += 1) {
    usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 40 + i }] }, 'test')
  }
  let u = usage.readUsage('claude', acct)
  const ring = u.history['weekly_scoped:fable']
  assert.equal(ring.length, 24, 'the ring caps at 24')
  assert.equal(ring.at(-1).percent, 69)
  assert.equal(ring[0].percent, 46, 'the oldest entries fall off the front')

  // the same percentage twice writes nothing
  usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 69 }] }, 'test')
  u = usage.readUsage('claude', acct)
  assert.equal(u.history['weekly_scoped:fable'].length, 24, 'an unchanged percentage is not a sample')

  // a new window is a new ring: a rate computed across a reset is a wrong number
  usage.recordUsage('claude', acct, { buckets: [{ ...base, resets_at: 1790794800, percent: 3 }] }, 'test')
  u = usage.readUsage('claude', acct)
  assert.deepEqual(u.history['weekly_scoped:fable'].map((e) => e.percent), [3], 'the reset cleared the ring for that key')
  assert.equal(Number.isFinite(u.history['weekly_scoped:fable'][0].at), true, 'each sample carries the second it was taken')
})

test('recordUsage keeps every old field and adds the new ones beside them', () => {
  const acct = 'shape'
  usage.recordUsage('claude', acct, { five_hour: { pct: 29, resets_at: 1789677000 }, seven_day: { pct: 47, resets_at: 1790190000 } }, 'claude usage endpoint')
  const u = usage.readUsage('claude', acct)
  assert.equal(u.five_hour.pct, 29)
  assert.equal(u.seven_day.pct, 47)
  assert.equal(u.source, 'claude usage endpoint')
  assert.deepEqual(u.buckets, [], 'a reading with no buckets leaves the list empty, not missing')
  assert.deepEqual(u.walls, {})
  assert.equal(u.extra_usage, null)
  // codex's measured facts ride the same call
  usage.recordUsage('codex', acct, { five_hour: null, seven_day: null, facts: { model: 'gpt-5.6-sol', plan_type: 'prolite', credits_balance: '0' } }, 'codex rollout token_count')
  assert.deepEqual(usage.readUsage('codex', acct).facts, { model: 'gpt-5.6-sol', plan_type: 'prolite', credits_balance: '0' })
})
