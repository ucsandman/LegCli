// cards — create a card from loosely typed input (CLI flags or a JSON body):
// parse the chain, build and validate the pipeline, then hand the ledger the
// exact shape. Shared by bin/baton.mjs and src/server.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { canonPath } from './fsx.mjs'
import { homedir } from 'node:os'
import { buildPipeline, validatePipeline, loadAdapterModes, parseChain } from './pipeline.mjs'
import { PRESET_NAMES } from './presets.mjs'
import { ledgerCreate, readCard } from './store.mjs'
import { humanAction } from './orchestrator.mjs'

export class CardInputError extends Error {}

function samePath(a, b) {
  return canonPath(a) === canonPath(b)
}

function isParentOf(parent, child) {
  return canonPath(child).startsWith(canonPath(parent) + sep)
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
  // stored as given (resolved); every comparison below is canonical, and the
  // worktree path is derived from the real long form in src/worktree.mjs
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
  // the trunk must exist now: a card whose trunk is missing would otherwise be
  // refused by the worktree step on every scheduler tick, an error event each time
  const trunk = String(input.trunk || 'main')
  const gitq = (args) => { try { return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
  if (gitq(['rev-parse', '--verify', '--quiet', `refs/heads/${trunk}`]) === null) {
    const actual = gitq(['symbolic-ref', '--short', 'HEAD'])
    throw new CardInputError(`trunk ${trunk} does not exist in ${repo}${actual ? `; this repo's default branch is ${actual} (add the card with --trunk ${actual})` : ''}`)
  }
  const legHome = resolve(process.env.LEG_HOME || process.env.BATON_HOME || (existsSync(join(homedir(), '.leg')) ? join(homedir(), '.leg') : existsSync(join(homedir(), '.baton')) ? join(homedir(), '.baton') : join(homedir(), '.leg')))
  if (samePath(repo, legHome) || isParentOf(repo, legHome)) throw new CardInputError('repo cannot contain LEG_HOME')
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
  const models = kv(input.model)
  const approve = list(input.approve)
  chain = chain.map((e) => ({
    ...e,
    ...(modes[e.adapter] ? { mode: modes[e.adapter] } : {}),
    ...(turns[e.adapter] ? { maxTurns: parseInt(turns[e.adapter], 10) } : {}),
    ...(models[e.adapter] ? { model: models[e.adapter] } : {}),
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
    chain: chain.map((e) => ({ adapter: e.adapter, mode: e.mode ?? null, max_turns: e.maxTurns ?? null, ...(e.model ? { model: e.model } : {}) })),
    pipeline, leases, trunk: input.trunk || 'main', 'land-mode': landMode,
    'test-command': input.testCommand ?? input.test_command ?? null, title: input.title || null,
    actor: JSON.stringify(actor),
  })
  if (input.queue) humanAction(id, 'enqueue', {}, actor)
  return readCard(id)
}
