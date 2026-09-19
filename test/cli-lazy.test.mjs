// cli-lazy — bin/leg.mjs used to statically import 26 modules (68 project
// modules total, incl. the whole card-orchestration stack via
// src/orchestrator.mjs and src/scheduler.mjs) for every command, `--version`
// included. Each command group now imports only what it needs, inside its
// own branch. A `node:module` resolve hook records every project module ESM
// loads during one CLI invocation, the same technique
// scratchpad/prof/02-modules.mjs used to measure the original cost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEG, makeHome, testEnv } from './helpers.mjs'

const dir = mkdtempSync(join(tmpdir(), 'leg-modcount-'))
writeFileSync(join(dir, 'resolve-hook.mjs'), `let port = null
export async function initialize(data) { port = data.port }
export async function load(url, context, next) {
  if (port && /^file:/.test(url)) { try { port.postMessage(url.replace(/\\\\/g, '/')) } catch {} }
  return next(url, context)
}
`)
const counter = join(dir, 'count-modules.mjs')
writeFileSync(counter, `import { register } from 'node:module'
import { writeFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
const { port1, port2 } = new MessageChannel()
const seen = []
port1.on('message', (m) => { seen.push(m) })
port1.unref()
register('./resolve-hook.mjs', import.meta.url, { data: { port: port2 }, transferList: [port2] })
process.on('exit', () => {
  const src = seen.filter((u) => /\\/(src|bin)\\//.test(u))
  writeFileSync(process.env.MODCOUNT_OUT, JSON.stringify({ total: seen.length, project: src.length, project_files: src.sort() }))
})
`)

// One `leg <args>` invocation, under the counting hook: { total, project, project_files }.
function moduleGraph(args) {
  const home = makeHome()
  const env = testEnv(home)
  const out = join(dir, `mc-${args.join('-').replace(/[^a-z0-9]+/gi, '_') || 'bare'}-${Math.random().toString(36).slice(2)}.json`)
  const r = spawnSync(process.execPath, ['--import', 'file:///' + counter.replace(/\\/g, '/'), LEG, ...args],
    { env: { ...env, MODCOUNT_OUT: out }, encoding: 'utf8' })
  assert.equal(r.status, 0, `leg ${args.join(' ')} exited ${r.status}: ${r.stderr}`)
  return JSON.parse(readFileSync(out, 'utf8'))
}

test('leg --version loads fewer than 15 project modules', () => {
  const g = moduleGraph(['--version'])
  assert.ok(g.project < 15, `expected < 15 project modules, got ${g.project}: ${g.project_files.join(', ')}`)
})

test('leg --version and leg sessions ls never load src/orchestrator.mjs', () => {
  for (const args of [['--version'], ['sessions', 'ls']]) {
    const g = moduleGraph(args)
    assert.ok(!g.project_files.some((f) => f.endsWith('/src/orchestrator.mjs')),
      `leg ${args.join(' ')} loaded orchestrator.mjs: ${g.project_files.join(', ')}`)
  }
})
