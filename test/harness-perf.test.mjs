// A cross-agent hand-off must stay fast. The prepare step is fingerprinted
// (src/harness/fingerprint.mjs) so an unchanged source is never re-read in
// full, and a synced destination is checked, not rewritten. The bound here is
// loose enough for a loaded CI runner and tight enough that a regression to
// "re-capture and re-apply every time" shows up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeHome } from './helpers.mjs'
import { buildClaudeHome, buildCodexHome, buildAgyHome } from './harness-fixture.mjs'

const dir = makeHome()
process.env.LEG_HOME = join(dir, 'leg')
process.env.BATON_HOME = process.env.LEG_HOME
process.env.LEG_HARNESS_HOME = dir
buildClaudeHome(dir, { skills: Array.from({ length: 25 }, (_, i) => `skill-${i}`) })
buildCodexHome(dir)
buildAgyHome(dir)
const h = await import('../src/harness/index.mjs')

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const BUDGET_MS = Number(process.env.LEG_HARNESS_PERF_BUDGET_MS || 400)

test(`a warm hand-off decision (unchanged source, synced destination) stays under ${BUDGET_MS} ms median over 10 runs`, (t) => {
  h.setHarnessConfig({ enabled: true, policy: 'sync', source: 'claude' })
  const first = h.prepareHarnessForHandoff({ from: 'claude', to: 'codex' })
  assert.equal(first.mode, 'sync')
  const times = []
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint()
    const p = h.prepareHarnessForHandoff({ from: 'claude', to: 'codex' })
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
    assert.equal(p.mode, 'check'); assert.equal(p.files_written, 0); assert.equal(p.capture_cached, true)
  }
  const med = median(times)
  t.diagnostic(`warm prepare: median ${med.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms over ${times.length} runs (first sync ${first.elapsed_ms} ms)`)
  assert.ok(med < BUDGET_MS, `median ${med.toFixed(1)} ms over budget ${BUDGET_MS} ms`)
})

test('a cached capture costs stat calls, not a re-read: under a tenth of the budget', (t) => {
  const times = []
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint()
    const c = h.captureHarness()
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
    assert.equal(c.cached, true)
  }
  const med = median(times)
  t.diagnostic(`cached capture: median ${med.toFixed(1)} ms`)
  assert.ok(med < BUDGET_MS / 10, `median ${med.toFixed(1)} ms`)
})
