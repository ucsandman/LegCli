// cards — create a card from loosely typed input (CLI flags or a JSON body):
// parse the chain, build and validate the pipeline, then hand the ledger the
// exact shape. Shared by bin/baton.mjs and src/server.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { homedir } from 'node:os'
import { buildPipeline, validatePipeline, loadAdapterModes, parseChain } from './pipeline.mjs'
import { PRESET_NAMES } from './presets.mjs'
import { ledgerCreate, readCard } from './store.mjs'
import { humanAction } from './orchestrator.mjs'

export class CardInputError extends Error {}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isParentOf(parent, child) {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent
  const c = process.platform === 'win32' ? child.toLowerCase() : child
  return c.startsWith(p + sep)
}

function list(v) {
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean)
  return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
}

// "adapter=value,adapter=value" or {adapter: value}
function kv(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const m = {}
  for (const part of list(raw)) {
    const eq = part.indexOf('=')
    if (eq <= 0) throw new CardInputError(`expected adapter=value, got "${part}"`)
    m[part.slice(0, eq).trim()] = part.slice(eq + 1)
  }
  return m
}

export async function createCard(input, actor = { type: 'human', id: 'local' }) {
  if (!input.repo) throw new CardInputError('missing repo')
  const repo = resolve(String(input.repo))
  if (!existsSync(repo)) throw new CardInputError(`repo not found: ${repo}`)
  if (!statSync(repo).isDirectory()) throw new CardInputError(`repo is not a directory: ${repo}`)
  let top
  try {
    top = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim()
  } catch {
    throw new CardInputError(`repo is not a git repository: ${repo}`)
  }
  const resolvedTop = resolve(top)
  if (!samePath(resolvedTop, repo)) throw new CardInputError(`repo is not the repository root: ${repo} (root is ${resolvedTop})`)
  const batonHome = resolve(process.env.BATON_HOME || join(homedir(), '.baton'))
  if (samePath(repo, batonHome) || isParentOf(repo, batonHome)) throw new CardInputError('repo cannot contain BATON_HOME')
  const task = String(input.task ?? '').trim()
  if (!task) throw new CardInputError('missing task')
  if (!input.chain || (Array.isArray(input.chain) && !input.chain.length)) throw new CardInputError('missing chain (e.g. claude,codex)')
  let chain
  try { chain = parseChain(input.chain) } catch (err) { throw new CardInputError(err.message) }
  const modes = kv(input.mode)
  const turns = kv(input.maxTurns ?? input.max_turns)
  const fakeModes = kv(input.fakeMode ?? input.fake_mode)
  const fakeFixtures = kv(input.fakeFixture ?? input.fake_fixture)
  const fakeTargets = kv(input.fakeTarget ?? input.fake_target)
  const fakeContents = kv(input.fakeContent ?? input.fake_content)
  const approve = list(input.approve)
  chain = chain.map((e) => ({
    ...e,
    ...(modes[e.adapter] ? { mode: modes[e.adapter] } : {}),
    ...(turns[e.adapter] ? { maxTurns: parseInt(turns[e.adapter], 10) } : {}),
    ...(fakeModes[e.adapter] ? { fakeMode: fakeModes[e.adapter] } : {}),
    ...(fakeFixtures[e.adapter] ? { fakeFixture: fakeFixtures[e.adapter] } : {}),
    ...(fakeTargets[e.adapter] ? { fakeTarget: fakeTargets[e.adapter] } : {}),
    ...(fakeContents[e.adapter] ? { fakeContent: fakeContents[e.adapter] } : {}),
    ...(approve.includes(e.adapter) ? { approve: true } : {}),
  }))
  const pipelineArg = input.pipeline ?? 'build'
  let pipeline
  try {
    if (Array.isArray(pipelineArg)) pipeline = buildPipeline({ stations: pipelineArg, chain })
    else if (typeof pipelineArg === 'string' && pipelineArg.trim().startsWith('[')) pipeline = buildPipeline({ stations: JSON.parse(pipelineArg), chain })
    else if (PRESET_NAMES.includes(pipelineArg)) pipeline = buildPipeline({ preset: pipelineArg, chain })
    else pipeline = buildPipeline({ file: pipelineArg, chain })
    validatePipeline(pipeline, await loadAdapterModes())
  } catch (err) {
    throw new CardInputError(`invalid pipeline: ${err.message}`)
  }
  const landMode = input.landMode ?? input.land_mode ?? 'ff'
  if (!['ff', 'pr'].includes(landMode)) throw new CardInputError(`invalid land mode "${landMode}" (ff or pr)`)
  const leases = list(input.leases)
  const slug = (input.slug || task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)) || 'card'
  const id = ledgerCreate({
    slug, task, repo,
    chain: chain.map((e) => ({ adapter: e.adapter, mode: e.mode ?? null, max_turns: e.maxTurns ?? null })),
    pipeline, leases, trunk: input.trunk || 'main', 'land-mode': landMode,
    'test-command': input.testCommand ?? input.test_command ?? null, title: input.title || null,
    actor: JSON.stringify(actor),
  })
  if (input.queue) humanAction(id, 'enqueue', {}, actor)
  return readCard(id)
}
