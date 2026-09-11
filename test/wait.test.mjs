// src/wait.mjs: the countdown resolves at the reset, cancels on abort or a
// cancel check, and formats remaining time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForReset, fmtCountdown } from '../src/wait.mjs'

test('fmtCountdown', () => {
  assert.equal(fmtCountdown(5), '5s')
  assert.equal(fmtCountdown(65), '1m05s')
  assert.equal(fmtCountdown(3725), '1h02m05s')
  assert.equal(fmtCountdown(-3), '0s')
})

test('waitForReset resolves ready at the reset and ticks with a falling remainder', async () => {
  const ticks = []
  const t0 = Date.now()
  const r = await waitForReset({ resetsAt: Date.now() / 1000 + 0.6, tickMs: 100, onTick: (s) => ticks.push(s) })
  assert.equal(r, 'ready')
  assert.ok(Date.now() - t0 >= 500 && Date.now() - t0 < 2000)
  assert.ok(ticks.length >= 3, `ticks ${ticks.length}`)
  assert.ok(ticks[0] > ticks[ticks.length - 1])
})

test('waitForReset: null reset is ready at once; abort and isCancelled both cancel', async () => {
  assert.equal(await waitForReset({ resetsAt: null }), 'ready')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  const t0 = Date.now()
  assert.equal(await waitForReset({ resetsAt: Date.now() / 1000 + 60, tickMs: 50, signal: ac.signal }), 'cancelled')
  assert.ok(Date.now() - t0 < 2000)
  let n = 0
  assert.equal(await waitForReset({ resetsAt: Date.now() / 1000 + 60, tickMs: 20, isCancelled: () => ++n >= 3 }), 'cancelled')
  assert.equal(n, 3)
})
