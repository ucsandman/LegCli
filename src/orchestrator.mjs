// orchestrator — moves one card through its pipeline: worktree, contract,
// runner legs, classification (from run.json), chain transitions, handoff
// bundles, test and (stub) land stations. Every state change goes through the
// ledger with an actor; the chain machine (src/chain.mjs) decides, this file
// only executes.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { transition } from './chain.mjs'
import { stationIndex } from './pipeline.mjs'
import { ensure as ensureWorktree } from './worktree.mjs'
import { renderContract, writeContract, legPrompt } from './contract.mjs'
import { writeHandoff, loadResume } from './handoff.mjs'
import { resolveNpmCliEntry } from './adapters/resolve.mjs'
import { landCard } from './land.mjs'
import {
  RUNNER, BATON_ACTOR, readCard, ledgerAppend, ledgerUpdate, cardDir, sleep,
} from './store.mjs'
import { scrub } from './runner.mjs'

const POLL_MS = Number(process.env.BATON_POLL_MS || 2000)
const WAITING = ['done', 'failed', 'killed', 'paused', 'waiting_human', 'needs_approval']
// Patchable card keys the chain machine may change; everything else is a
// named ledger flag.
const PATCH_KEYS = ['pipeline', 'leases', 'land_attempts', 'bounce_reason', 'kill_requested', 'next_leg', 'handoff_outcome', 'resume_from_bundle', 'failure']

const log = (msg) => { if (process.env.BATON_QUIET !== '1') process.stderr.write(`[baton] ${msg}\n`) }

// Persist a chain transition: card fields via ledger update, events via append.
export function apply(id, before, result, actor = BATON_ACTOR) {
  const next = result.card
  const patch = {}
  for (const k of PATCH_KEYS) {
    if (JSON.stringify(next[k]) !== JSON.stringify(before[k])) patch[k] = next[k] ?? null
  }
  ledgerUpdate(id, {
    status: next.status !== before.status ? next.status : undefined,
    station: next.station !== before.station ? next.station : undefined,
    leg: next.leg !== before.leg ? next.leg : undefined,
    patch,
  })
  for (const e of result.events) {
    ledgerAppend(id, { actor, type: e.type, summary: e.summary, body: e.body, station: next.station, leg: next.leg })
  }
  return readCard(id)
}

export function step(id, action, payload, actor = BATON_ACTOR) {
  const card = readCard(id)
  if (!card) throw new Error(`card not found: ${id}`)
  return apply(id, card, transition(card, action, payload), actor)
}

function runJsonPath(id, n) { return join(cardDir(id), 'runs', String(n), 'run.json') }

async function waitForRun(id, n, { pollMs = POLL_MS } = {}) {
  for (;;) {
    let run = null
    try { run = JSON.parse(readFileSync(runJsonPath(id, n), 'utf8')) } catch {}
    if (run && ['exited', 'killed', 'failed', 'orphaned'].includes(run.status)) return run
    const card = readCard(id)
    if (card && ['killed', 'paused'].includes(card.status)) return { ...(run ?? {}), status: 'interrupted', outcome: 'killed', handoff: false }
    await sleep(pollMs)
  }
}

function changedFiles(worktree) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) return []
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => f && !f.startsWith('.baton'))
}

function diffStat(worktree) {
  const r = spawnSync('git', ['diff', '--stat'], { cwd: worktree, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return r.status === 0 ? r.stdout : ''
}

async function runLeg(card, station, worktree) {
  const entry = station.chain[card.leg]
  if (!entry) throw new Error(`no chain entry for leg ${card.leg} at ${station.name}`)
  const resumed = card.leg > 0 || card.resume_from_bundle === true
  const contractText = await renderContract({ card, station, leg: card.leg, entry, worktree, resumed, bounceReason: card.bounce_reason })
  writeContract(worktree, contractText)
  let resumeText = null
  if (resumed) {
    try { resumeText = loadResume(worktree) } catch (err) { log(`no bundle to resume from: ${err.message}`) }
  }
  const prompt = legPrompt({ contractText, resumeText })
  const promptFile = join(cardDir(card.card_id), `prompt-${station.name}-leg${card.leg}.txt`)
  writeFileSync(promptFile, prompt)
  const args = ['launch', '--card', card.card_id, '--adapter', entry.adapter, '--prompt-file', promptFile, '--cwd', worktree]
  if (entry.mode) args.push('--mode', entry.mode)
  if (entry.maxTurns) args.push('--max-turns', String(entry.maxTurns))
  const extraEnv = {}
  if (entry.fakeMode) extraEnv.FAKE_MODE = entry.fakeMode
  if (entry.fakeFixture) extraEnv.FAKE_LIMIT_FIXTURE = entry.fakeFixture
  if (Object.keys(extraEnv).length) args.push('--env-json', JSON.stringify(extraEnv))
  let launch
  try {
    launch = JSON.parse(execFileSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: process.env }))
  } catch (err) {
    const text = String(err.stderr ?? err.stdout ?? err.message)
    return { status: 'failed', outcome: 'launch_failed', handoff: true, signal: 'none', reason: scrub(text).slice(0, 300), run: null, exit_code: null }
  }
  if (card.resume_from_bundle) ledgerUpdate(card.card_id, { patch: { resume_from_bundle: false } })
  const run = await waitForRun(card.card_id, launch.run)
  return run
}

function tokenize(cmd) {
  return cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
}

// A test command runs as argv, never through a shell; `npm`/`npx` resolve to
// node + their JS entry so the Windows .cmd shim is never needed.
export function resolveCommand(cmd) {
  const tokens = tokenize(cmd)
  if (!tokens.length) throw new Error('empty test command')
  const [bin, ...rest] = tokens
  if (bin === 'node') return { bin: process.execPath, args: rest }
  if (bin === 'npm' || bin === 'npx') {
    const entry = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${bin}-cli.js`)
    const found = existsSync(entry) ? entry : resolveNpmCliEntry('npm', bin)
    if (!found) throw new Error(`cannot resolve ${bin}'s JS entry`)
    return { bin: process.execPath, args: [found, ...rest] }
  }
  return { bin, args: rest }
}

export function runTestCommand(cmd, cwd, { timeoutMs = 600000 } = {}) {
  const { bin, args } = resolveCommand(cmd)
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, MSYS_NO_PATHCONV: '1', CI: '1' } })
  const tail = (s) => scrub(String(s ?? '')).trim().split('\n').slice(-20).join('\n')
  return {
    green: r.status === 0,
    status: r.status,
    timedOut: r.error?.code === 'ETIMEDOUT',
    tail: tail(`${r.stdout}\n${r.stderr}`),
    command: `${bin} ${args.join(' ')}`,
  }
}

function handoffOn(card, station, run, worktree, extra = []) {
  const entry = station.chain[card.leg]
  const runDir = run?.run ? join(cardDir(card.card_id), 'runs', String(run.run)) : null
  try {
    const h = writeHandoff({ card, station, leg: card.leg, entry, run, worktree, runDir, extra, changedFiles: changedFiles(worktree), diffStat: diffStat(worktree) })
    ledgerUpdate(card.card_id, { patch: { last_bundle: h.bundle_id } })
    ledgerAppend(card.card_id, {
      type: 'handoff_written', station: station.name, leg: card.leg,
      summary: `handoff bundle ${h.bundle_id} (${h.quality ?? 'unscored'}) after ${run?.outcome ?? 'handoff'}; next: ${station.chain[card.leg + 1]?.adapter ?? 'none'}`,
      body: `notes: ${h.notes_path}`,
    })
    return h
  } catch (err) {
    ledgerAppend(card.card_id, { type: 'error', station: station.name, leg: card.leg, summary: `handoff bundle failed: ${scrub(err.message).slice(0, 200)}` })
    return null
  }
}

// Run a card until it reaches a waiting or terminal state. Returns the card.
export async function runCard(id, { actor = BATON_ACTOR } = {}) {
  let card = readCard(id)
  if (!card) throw new Error(`card not found: ${id}`)
  if (card.status === 'backlog') card = step(id, 'enqueue', {}, actor)
  const wt = ensureWorktree(card.repo, card.card_id, { trunk: card.trunk || 'main' })
  if (card.worktree !== wt.path) {
    ledgerUpdate(id, { patch: { worktree: wt.path } })
    card = readCard(id)
  }
  for (;;) {
    card = readCard(id)
    if (WAITING.includes(card.status)) return card
    if (card.status === 'handing_off') {
      // Recovering a crash mid-handoff: finish the handoff step.
      const st = card.pipeline[stationIndex(card.pipeline, card.station)]
      card = step(id, 'bundle_written', {}, actor)
      void st
      continue
    }
    if (card.status === 'queued') {
      card = step(id, 'start', {}, actor)
      if (card.status !== 'running') return card
    }
    if (card.status !== 'running') return card
    const st = card.pipeline[stationIndex(card.pipeline, card.station)]
    if (!st) throw new Error(`card ${id}: unknown station ${card.station}`)
    if (st.kind === 'agent') {
      const run = await runLeg(card, st, wt.path)
      const fresh = readCard(id)
      if (['killed', 'paused'].includes(fresh.status)) {
        if (fresh.status === 'paused') handoffOn(fresh, st, run, wt.path, ['paused by a human; resume continues from this bundle'])
        return fresh
      }
      const before = readCard(id)
      const result = transition(before, 'leg_result', { outcome: run.outcome, handoff: run.handoff, signal: run.signal, adapter: st.chain[before.leg]?.adapter, run: run.run })
      card = apply(id, before, result, actor)
      if (card.status === 'handing_off') {
        handoffOn(card, st, run, wt.path)
        card = step(id, 'bundle_written', {}, actor)
      }
      continue
    }
    if (st.kind === 'test') {
      const cmd = st.command ?? card.test_command
      if (!cmd) {
        ledgerAppend(id, { type: 'status', station: st.name, leg: 0, summary: 'test station: no test command configured; treating as green' })
        card = step(id, 'test_result', { green: true }, actor)
        continue
      }
      const t = runTestCommand(cmd, wt.path)
      ledgerAppend(id, { type: 'status', station: st.name, leg: 0, summary: `test ${t.green ? 'green' : 'red'}: ${t.command}${t.timedOut ? ' (timed out)' : ''}`, body: t.tail })
      if (!t.green) {
        const bounced = transition(card, 'test_result', { green: false, reason: `test red (${t.command}, exit ${t.status}): ${t.tail.split('\n').slice(-5).join(' | ')}` })
        // Attach the failure to a bundle so the next build leg starts from it.
        handoffOn(card, { name: st.name, chain: [] }, { outcome: 'test_red', reason: t.tail, exit_code: t.status, adapter: 'test' }, wt.path, [`test red: ${t.command}`, t.tail.slice(0, 1500)])
        card = apply(id, card, bounced, actor)
        continue
      }
      card = step(id, 'test_result', { green: true }, actor)
      continue
    }
    if (st.kind === 'land') {
      const r = await landCard(card, wt.path)
      if (r.bounced) {
        handoffOn(card, { name: st.name, chain: [] }, { outcome: 'land_bounced', reason: r.reason, exit_code: null, adapter: 'land' }, wt.path, [`land bounced: ${r.reason}`, r.tail ?? ''])
      }
      card = step(id, 'land_result', r, actor)
      continue
    }
    if (st.kind === 'human') {
      card = step(id, 'start', {}, actor)
      return card
    }
    throw new Error(`unknown station kind ${st.kind}`)
  }
}

// Human actions from the CLI or the board. Returns the updated card.
export function humanAction(id, action, payload = {}, actor = { type: 'human', id: 'local' }) {
  const card = readCard(id)
  if (!card) throw new Error(`card not found: ${id}`)
  const result = transition(card, action, payload)
  const next = apply(id, card, result, actor)
  if (['kill', 'pause', 'reassign', 'handoff_now'].includes(action) && card.status === 'running') killActiveRun(id)
  return next
}

// Kill the agent process of the active run. The run record gets
// kill_requested so the supervisor classifies the exit as `killed` (a human
// decision), not `stalled` or `failed`.
export function killActiveRun(id) {
  const runsDir = join(cardDir(id), 'runs')
  if (!existsSync(runsDir)) return false
  let killed = false
  const runs = readdirSync(runsDir).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  for (const n of runs) {
    let run
    try { run = JSON.parse(readFileSync(join(runsDir, String(n), 'run.json'), 'utf8')) } catch { continue }
    if (!['launching', 'running'].includes(run.status)) continue
    try { writeFileSync(join(runsDir, String(n), 'run.json'), JSON.stringify({ ...run, kill_requested: true }, null, 2) + '\n') } catch {}
    if (run.agent_pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.agent_pid), '/T', '/F'], { encoding: 'utf8' })
      else { try { process.kill(run.agent_pid, 'SIGKILL') } catch {} }
      killed = true
    }
  }
  return killed
}
