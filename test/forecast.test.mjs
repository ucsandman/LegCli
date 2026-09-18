// The burn-rate forecast (redesign spec A.5 row 4, E rule 6).
//
// Two rules are checked here and nowhere else:
//   1. the sample gate. Under 3 samples spanning 10 minutes there is no time
//      figure at all, because a rate drawn through two points a minute apart is
//      a guess printed in the largest type on the page.
//   2. a rate never crosses a reset. The ring is cleared when `resets_at`
//      moves, and `seconds_left` is capped at the time to the reset even when
//      the slope says there is more.
// A flat line is a measured zero and a falling percentage inside one window is
// a data error, not a refund: both answer null.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'leg-forecast-'))

const usage = await import('../src/usage.mjs')

const nowS = () => Math.floor(Date.now() / 1000)
const HOUR = 3600
const KEY = 'weekly_scoped:fable'
const base = { kind: 'weekly_scoped', group: 'weekly', model: 'fable', is_active: true, severity: 'normal' }

// a record with a ring written by hand: `burn()` is pure, so the samples and
// the reset can be placed to the second
function rec(samples, { resets_at = nowS() + 40 * HOUR } = {}) {
  return {
    agent: 'claude', account: 'default', buckets: samples.length ? [{ ...base, percent: samples.at(-1).percent, resets_at }] : [],
    history: { [KEY]: samples },
  }
}
const at = (secsAgo, percent) => ({ percent, at: nowS() - secsAgo })

test('the sample gate: under 3 samples, or under 10 minutes of span, there is no time', () => {
  assert.equal(usage.burn(rec([at(900, 50), at(0, 56)]), KEY), null, 'two samples print nothing')
  assert.equal(usage.burn(rec([at(540, 50), at(270, 53), at(0, 56)]), KEY), null, 'three over nine minutes print nothing')
  assert.equal(usage.burn(rec([]), KEY), null, 'an empty ring is not a rate')
  assert.equal(usage.burn({}, KEY), null, 'a record with no history at all answers null')
})

test('three samples over eleven minutes print a time, with the volume they came from', () => {
  const f = usage.burn(rec([at(660, 50), at(330, 53), at(0, 56)]), KEY)
  assert.ok(f, 'the gate passes at eleven minutes')
  assert.equal(f.samples, 3)
  assert.equal(f.span_s, 660)
  // 6 points in 11 minutes is 32.7 percent per hour; 44 points are left
  assert.equal(Math.round(f.rate_pct_per_h * 10) / 10, 32.7)
  assert.equal(Math.round(f.seconds_left), 4840, '(100 - 56) / (6/660) seconds')
})

test('seconds_left is capped at the reset: a rate never extrapolates across a window', () => {
  const soon = nowS() + 600
  const f = usage.burn(rec([at(660, 50), at(330, 51), at(0, 52)], { resets_at: soon }), KEY)
  assert.ok(f)
  assert.ok(f.seconds_left <= 600, `capped at the reset, was ${f.seconds_left}`)
  assert.equal(Math.round(f.seconds_left), 600)
  // the same ring with the reset two days out is the slope's own answer, and
  // it is far longer than the cap above
  const far = usage.burn(rec([at(660, 50), at(330, 51), at(0, 52)], { resets_at: nowS() + 48 * HOUR }), KEY)
  assert.ok(far.seconds_left > 600 * 10, `the uncapped slope is hours, was ${far.seconds_left}`)
  // a window whose clock has already passed has no forecast: the ring is
  // cleared by the next reading, and until it arrives this rate describes a
  // window that is over
  assert.equal(usage.burn(rec([at(660, 50), at(330, 51), at(0, 52)], { resets_at: nowS() - 60 }), KEY), null)
})

test('a flat line is a measured zero and a falling percentage is a data error: both null', () => {
  const flat = [at(3600, 50), at(2400, 50), at(1200, 50), at(0, 50)]
  assert.equal(usage.burn(rec(flat), KEY), null, 'an hour of flat is a zero rate, not a time')
  assert.equal(usage.burn(rec([at(3600, 60), at(1800, 55), at(0, 50)]), KEY), null, 'a falling percentage is not a refund')
})

test('binding() carries the forecast for the bucket that binds, and every field it had', () => {
  const u = rec([at(660, 50), at(330, 53), at(0, 56)])
  const b = usage.binding(u, 'fable')
  assert.equal(b.kind, 'weekly_scoped')
  assert.equal(b.model, 'fable')
  assert.equal(b.percent, 56)
  assert.equal(b.scope, 'model')
  assert.ok(Number.isFinite(b.resets_at))
  assert.equal(b.forecast.samples, 3, 'the forecast rides the binding bucket, with no server change')
  // the gate failing is a null forecast beside a real percentage, never a
  // missing binding
  const thin = usage.binding(rec([at(60, 55), at(0, 56)]), 'fable')
  assert.equal(thin.percent, 56)
  assert.equal(thin.forecast, null)
  // the legacy path (no buckets at all) has no ring to read and says so
  const legacy = usage.binding({ five_hour: { pct: 29, resets_at: nowS() + HOUR }, seven_day: null })
  assert.equal(legacy.percent, 29)
  assert.equal(legacy.forecast, null)
})

test('the ring keeps a flat reading every ten minutes, so an hour of flat is measurable', () => {
  const acct = 'flat'
  const start = Date.now() - 70 * 60_000
  const iso = (mins) => new Date(start + mins * 60_000).toISOString()
  const write = (percent, mins) => usage.recordUsage('claude', acct, { buckets: [{ ...base, percent, resets_at: nowS() + 40 * HOUR }] }, 'test', { observed_at: iso(mins) })

  write(50, 0)
  write(50, 5)
  let u = usage.readUsage('claude', acct)
  assert.equal(u.history[KEY].length, 1, 'an unchanged percentage five minutes later is still noise')

  // …but an unchanged percentage an interval later is a MEASUREMENT: the
  // "only when it changed" rule was about noise, not about starving the gate
  for (const m of [11, 22, 33, 44, 55, 66]) write(50, m)
  u = usage.readUsage('claude', acct)
  assert.equal(u.history[KEY].length, 7, 'one sample per ten-minute interval while the figure holds')
  assert.equal(u.history[KEY].at(-1).at - u.history[KEY][0].at, 66 * 60)
  assert.equal(usage.burn(u, KEY), null, 'an hour of flat is a zero rate, and a zero rate is not a time')
})

test('a reset clears the ring, and the forecast is null until three new samples land', () => {
  const acct = 'reset'
  const first = nowS() + 40 * HOUR
  const start = Date.now() - 60 * 60_000
  const iso = (mins) => new Date(start + mins * 60_000).toISOString()
  usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 50, resets_at: first }] }, 'test', { observed_at: iso(0) })
  usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 60, resets_at: first }] }, 'test', { observed_at: iso(15) })
  usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 70, resets_at: first }] }, 'test', { observed_at: iso(30) })
  let u = usage.readUsage('claude', acct)
  assert.equal(u.history[KEY].length, 3)
  assert.ok(usage.burn(u, KEY), 'three samples over thirty minutes forecast')

  usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: 4, resets_at: first + 7 * 24 * HOUR }] }, 'test', { observed_at: iso(45) })
  u = usage.readUsage('claude', acct)
  assert.deepEqual(u.history[KEY].map((e) => e.percent), [4], 'the new window starts its own ring')
  assert.equal(usage.burn(u, KEY), null, 'and there is no rate across the reset')
})

// ---- the ring itself: what it keeps, and for how long ----

test('the ring is written on a time basis, so three terminals on one login still reach the gate', () => {
  // Each attached terminal runs its own usage poller against the same per-login
  // record (src/attach.mjs USAGE_MS), so three of them write every 20 seconds.
  // A ring capped only by count would then span 24 x 20s = under the 10-minute
  // burn gate, and the forecast would vanish from exactly the busiest login.
  const acct = 'three-terminals'
  const resets = nowS() + 40 * HOUR
  const start = Date.now() - 45 * 60_000
  let percent = 40
  for (let s = 0; s <= 30 * 60; s += 20) {
    usage.recordUsage('claude', acct, { buckets: [{ ...base, percent: Math.round(percent * 10) / 10, resets_at: resets }] }, 'test', { observed_at: new Date(start + s * 1000).toISOString() })
    percent += 0.2
  }
  const u = usage.readUsage('claude', acct)
  const ring = u.history[KEY]
  assert.ok(ring.length <= usage.HISTORY_MAX, `the ring still caps at ${usage.HISTORY_MAX}, was ${ring.length}`)
  assert.ok(ring.at(-1).at - ring[0].at >= usage.BURN_MIN_SPAN_S, `the ring spans the burn gate, was ${ring.at(-1).at - ring[0].at}s`)
  const f = usage.burn(u, KEY)
  assert.ok(f, 'three live terminals on one login still get a forecast')
  assert.ok(f.samples >= usage.BURN_MIN_SAMPLES)
  // and no two samples are closer together than the minimum gap
  for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].at - ring[i - 1].at >= usage.HISTORY_MIN_GAP_S, 'samples are spaced by time, not by write')
})

test('the ring never carries samples across a reset, even when the bucket was missing for a write', () => {
  const acct = 'gap-then-reset'
  const first = nowS() + 20 * HOUR
  const start = Date.now() - 90 * 60_000
  const iso = (mins) => new Date(start + mins * 60_000).toISOString()
  const write = (buckets, mins) => usage.recordUsage('claude', acct, { buckets }, 'test', { observed_at: iso(mins) })
  const scoped = (percent, resets_at) => ({ ...base, percent, resets_at })
  const account = { kind: 'weekly_all', group: 'weekly', model: null, percent: 47, resets_at: first, is_active: false }

  write([scoped(55, first), account], 0)
  write([scoped(59, first), account], 15)
  write([scoped(63, first), account], 30)
  assert.deepEqual(usage.readUsage('claude', acct).history[KEY].map((e) => e.percent), [55, 59, 63])
  // one reading that carries the account row and not the scoped one: an older
  // endpoint, or a degraded payload. The ring has no `prev` to compare against.
  write([account], 45)
  // …and then the window resets and the new one starts filling
  const second = first + 7 * 24 * HOUR
  write([scoped(56, second), { ...account, resets_at: second }], 60)
  const u = usage.readUsage('claude', acct)
  assert.deepEqual(u.history[KEY].map((e) => e.percent), [56], 'the new window starts its own ring')
  assert.equal(u.history[KEY][0].resets_at, second, 'each sample carries the window it was taken in')
  assert.equal(usage.burn(u, KEY), null, 'and no rate is drawn across the reset')
})

test('the ring evicts by age as well as by count: a sample older than its own window is gone', () => {
  const acct = 'age'
  const session = { kind: 'session', group: 'session', model: null, is_active: true, severity: 'normal' }
  const resets = nowS() + 2 * HOUR
  const start = Date.now() - 8 * 60 * 60_000
  const iso = (mins) => new Date(start + mins * 60_000).toISOString()
  const write = (percent, mins) => usage.recordUsage('claude', acct, { buckets: [{ ...session, percent, resets_at: resets }] }, 'test', { observed_at: iso(mins) })
  write(10, 0)      // eight hours ago
  write(12, 60)     // seven hours ago
  write(50, 460)
  write(55, 470)
  write(60, 480)
  const u = usage.readUsage('claude', acct)
  assert.deepEqual(u.history.session.map((e) => e.percent), [50, 55, 60], 'a 5-hour window keeps no sample older than five hours')
})
