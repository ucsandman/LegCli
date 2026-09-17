import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRESETS, PRESET_NAMES } from '../src/presets.mjs'
import { buildPipeline, validatePipeline, loadAdapterModes, parseChain, columns, KINDS } from '../src/pipeline.mjs'

const chain = [{ adapter: 'claude', mode: 'acceptEdits' }, { adapter: 'codex' }]

test('presets factory / build / build-land exist with the documented stations', () => {
  assert.deepEqual(PRESET_NAMES, ['factory', 'build', 'build-land'])
  assert.deepEqual(PRESETS.factory.map((s) => `${s.name}:${s.kind}`), ['plan:agent', 'build:agent', 'review:agent', 'test:test', 'land:land'])
  assert.deepEqual(PRESETS.build.map((s) => s.name), ['build'])
  assert.deepEqual(PRESETS['build-land'].map((s) => `${s.name}:${s.kind}`), ['build:agent', 'test:test', 'land:land'])
  assert.deepEqual(KINDS, ['agent', 'human', 'test', 'land'])
})

test('buildPipeline applies the card chain to every agent station lacking its own', () => {
  const p = buildPipeline({ preset: 'factory', chain })
  for (const s of p.filter((x) => x.kind === 'agent')) assert.deepEqual(s.chain.map((e) => e.adapter), ['claude', 'codex'])
  assert.equal(p.find((s) => s.kind === 'test').chain, undefined)
})

test('buildPipeline accepts a JSON file with per-station chains and a test command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'))
  const f = join(dir, 'p.json')
  writeFileSync(f, JSON.stringify([
    { name: 'build', kind: 'agent', chain: [{ adapter: 'agy', mode: 'plan', maxTurns: 3 }] },
    { name: 'test', kind: 'test', command: 'npm test' },
  ]))
  const p = buildPipeline({ file: f, chain })
  assert.deepEqual(p[0].chain, [{ adapter: 'agy', mode: 'plan', maxTurns: 3 }])
  assert.equal(p[1].command, 'npm test')
})

test('parseChain accepts a comma list and a JSON array', () => {
  assert.deepEqual(parseChain('claude, codex'), [{ adapter: 'claude' }, { adapter: 'codex' }])
  assert.deepEqual(parseChain('[{"adapter":"claude","max_turns":2,"approve":true}]'), [{ adapter: 'claude', maxTurns: 2, approve: true }])
  assert.throws(() => parseChain('[{"adapter":"claude","maxTurns":0}]'), /positive integer/)
})

test('validatePipeline refuses: empty, duplicate names, unknown kind, agent without chain, unknown adapter, forbidden mode, land not last, two lands', async () => {
  const modes = await loadAdapterModes()
  const ok = buildPipeline({ preset: 'build-land', chain })
  assert.deepEqual(validatePipeline(ok, modes), ok)
  assert.throws(() => validatePipeline([], modes), /pipeline is empty/)
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'test' }, { name: 'a', kind: 'test' }], modes), /duplicate station name "a"/)
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'robot' }], modes), /unknown kind "robot"/)
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'agent', chain: [] }], modes), /needs a non-empty chain/)
  // grok is a registered adapter now; the refusal is for a name nothing provides
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'agent', chain: [{ adapter: 'no-such-agent' }] }], modes), /unknown adapter "no-such-agent"/)
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'agent', chain: [{ adapter: 'claude', mode: 'bypassPermissions' }] }], modes), /forbidden mode "bypassPermissions" for claude/)
  assert.throws(() => validatePipeline([{ name: 'a', kind: 'agent', chain: [{ adapter: 'codex', mode: 'danger-full-access' }] }], modes), /forbidden mode "danger-full-access" for codex/)
  assert.throws(() => validatePipeline([{ name: 'land', kind: 'land' }, { name: 'b', kind: 'test' }], modes), /land station must be last/)
  assert.throws(() => validatePipeline([{ name: 'x', kind: 'land' }, { name: 'land', kind: 'land' }], modes), /must be last|at most one land/)
})

test('columns derive from the pipeline: backlog, stations, done', () => {
  assert.deepEqual(columns(PRESETS.factory), ['backlog', 'plan', 'build', 'review', 'test', 'land', 'done'])
})
