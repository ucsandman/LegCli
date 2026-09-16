// leg-agents stays on the same version as @ucsandman/legcli, pins that
// version, and packs only the alias files. Drift fails this file and
// scripts/sync-leg-agents.mjs --check (wired into npm test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { inspect, packedFileList, PACKED_FILES, PRIMARY_NAME, ALIAS_NAME } from '../scripts/sync-leg-agents.mjs'

const ROOT = join(import.meta.dirname, '..')
const script = join(ROOT, 'scripts', 'sync-leg-agents.mjs')

test('leg-agents version, pin and engines match @ucsandman/legcli', () => {
  const { rootPkg, aliasPkg, problems } = inspect(ROOT)
  assert.equal(aliasPkg.name, ALIAS_NAME)
  assert.equal(rootPkg.name, PRIMARY_NAME)
  assert.equal(aliasPkg.version, rootPkg.version)
  assert.equal(aliasPkg.dependencies[PRIMARY_NAME], rootPkg.version)
  assert.equal(aliasPkg.engines.node, rootPkg.engines.node)
  assert.equal(aliasPkg.bin.leg, 'bin/leg.mjs')
  assert.ok(!rootPkg.files.includes('packages'))
  assert.deepEqual(problems.filter((p) => !p.startsWith('packed ')), [])
})

test('LICENSE and NOTICE in the alias match the repo root', () => {
  const { problems } = inspect(ROOT)
  assert.equal(problems.some((p) => p.includes('LICENSE')), false, problems.join('\n'))
  assert.equal(problems.some((p) => p.includes('NOTICE')), false, problems.join('\n'))
})

test('alias wrapper keeps the shebang and loads the pinned CLI via file URL', () => {
  const { wrapper, problems } = inspect(ROOT)
  assert.ok(wrapper.startsWith('#!/usr/bin/env node'))
  assert.match(wrapper, /pathToFileURL/)
  assert.match(wrapper, /@ucsandman\/legcli\/package\.json/)
  assert.match(wrapper, /bin', 'leg\.mjs/)
  assert.equal(problems.some((p) => p.includes('wrapper')), false, problems.join('\n'))
})

test('npm pack --dry-run of leg-agents is exactly the alias files', () => {
  const packed = packedFileList(join(ROOT, 'packages', 'leg-agents'))
  assert.deepEqual(packed, [...PACKED_FILES].sort())
})

test('npm pack --dry-run of @ucsandman/legcli does not include packages/leg-agents', () => {
  const packed = packedFileList(ROOT)
  assert.equal(packed.some((p) => p === 'packages/leg-agents/package.json' || p.startsWith('packages/leg-agents/')), false)
})

test('sync-leg-agents --check exits 0 on this tree', () => {
  const result = spawnSync(process.execPath, [script, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /in lockstep with @ucsandman\/legcli@/)
})
