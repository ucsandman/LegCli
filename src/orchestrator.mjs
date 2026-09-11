// orchestrator — moves one card through its pipeline: worktree, contract,
// runner legs, classification (from run.json), chain transitions, handoff
// bundles, test and (stub) land stations. Every state change goes through the
// ledger with an actor; the chain machine (src/chain.mjs) decides, this file
// only executes.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { transition } from './chain.mjs'
import { stationIndex } from './pipeline.mjs'
import { ensure as ensureWorktree } from './worktree.mjs'
import { renderContract, writeContract, legPrompt } from './contract.mjs'
import { writeHandoff, loadResume } from './handoff.mjs'
import { runCommandAsync } from './commands.mjs'
import { landCard } from './land.mjs'
import { resolveTestCommand } from './mergequeue.mjs'
import {
  RUNNER, BATON_ACTOR, readCard, ledgerAppend, ledgerUpdate, cardDir, sleep,
} from './store.mjs'
import { scrub, updateRun } from './runner.mjs'
import * as agentStation from './stations/agent.mjs'
import * as testStation from './stations/test.mjs'
import * as humanStation from './stations/human.mjs'

// Station kinds that run inside runCard; land stays inline below (it drives
// the merge queue). Each handler gets the orchestrator's helpers as `ops`.
const KIND_HANDLERS = { agent: agentStation, test: testStation, human: humanStation }

const POLL_MS = Number(process.env.BATON_POLL_MS || 2000)
const WAITING = ['done', 'failed', 'killed', 'paused', 'waiting_human', 'needs_approval']
// Patchable card keys the chain machine may change; everything else is a
// named ledger flag.
const PATCH_KEYS = ['pipeline', 'leases', 'land_attempts', 'bounce_reason', 'kill_requested', 'next_leg', 'handoff_outcome', 'resume_from_bundle', 'failure', 'pr_url']

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

function latestRun(id) {
  const dir = join(cardDir(id), 'runs')
  if (!existsSync(dir)) return null
  const ns = readdirSync(dir).map(Number).filter(Number.isInteger).sort((a, b) => b - a)
  for (const n of ns) { try { return JSON.parse(readFileSync(runJsonPath(id, n), 'utf8')) } catch {} }
  return null
}

// A run whose verdict no orchestrator has consumed: the latest run has no
// settled_at. Happens after `baton down` (agents killed, the supervisor wrote
// its verdict, the server that would apply it was already gone) or a crashed
// server. runCard re-attaches to it instead of launching a fresh leg.
export function unsettledRun(id) {
  const r = latestRun(id)
  return r && !r.settled_at ? r : null
}

// A run nobody alive is driving: unsettled and its driver (the orchestrator
// process that launched or re-attached to it) is gone. The scheduler picks
// these up; a live driver is left alone so two processes never apply one verdict.
export function orphanedRun(id) {
  const r = unsettledRun(id)
  return r && !(r.driver_pid && pidAlive(r.driver_pid)) ? r : null
}

// The claim on a card: one file per card, created atomically ('wx') at the top
// of runCard and removed when it returns. run.json's driver_pid only exists
// once a leg has launched; before that (worktree add, the start step, the
// contract) a card had no owner, and a `card run` beside a scheduler tick, or
// two schedulers, could both launch a leg into one worktree.
function driverLockPath(id) { return join(cardDir(id), 'driver.lock') }

function readDriver(id) {
  try { return JSON.parse(readFileSync(driverLockPath(id), 'utf8')) } catch { return null }
}

// The pid of another live process driving this card, else null.
export function driverAlive(id) {
  const d = readDriver(id)
  return d?.pid && d.pid !== process.pid && pidAlive(d.pid) ? d.pid : null
}

function claimDriver(id) {
  const f = driverLockPath(id)
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n', { flag: 'wx' })
      return { ok: true }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const d = readDriver(id)
    if (d?.pid === process.pid) return { ok: true }
    if (d?.pid && pidAlive(d.pid)) return { ok: false, pid: d.pid }
    // the holder died, or the file is not readable yet: a claim being written
    // right now is younger than a second, a torn one from a crash is not
    let stale = Boolean(d?.pid)
    if (!stale) { try { stale = Date.now() - statSync(f).mtimeMs > 1000 } catch { stale = true } }
    if (!stale) { const t = Date.now() + 50; while (Date.now() < t) { /* spin */ } continue }
    try { unlinkSync(f) } catch {}
  }
  return { ok: false, pid: readDriver(id)?.pid ?? null }
}

function releaseDriver(id) {
  if (readDriver(id)?.pid === process.pid) { try { unlinkSync(driverLockPath(id)) } catch {} }
}

function patchRun(id, n, fields) {
  if (!n) return
  try { updateRun(id, n, (cur) => (cur ? { ...cur, ...fields } : null)) } catch {}
}

function settleRun(id, run) { patchRun(id, run?.run, { settled_at: new Date().toISOString() }) }

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const FINAL_RUN = ['exited', 'killed', 'failed', 'orphaned']

async function waitForRun(id, n, { pollMs = POLL_MS } = {}) {
  let deadSince = null
  let interrupted = null
  for (;;) {
    let run = null
    try { run = JSON.parse(readFileSync(runJsonPath(id, n), 'utf8')) } catch {}
    if (run && FINAL_RUN.includes(run.status)) {
      if (run.status === 'orphaned' && !run.outcome) return { ...run, outcome: 'failed', handoff: true, signal: 'none', reason: 'supervisor died before the leg finished' }
      return run
    }
    const supervisorAlive = Boolean(run?.supervisor_pid) && pidAlive(run.supervisor_pid)
    // A human acted on the card (kill, pause, hand off now, reassign): the leg
    // is over for us. Wait for the supervisor to finish writing (it is
    // classifying the kill) so the next leg's launch never finds this run
    // still active, then report the interruption.
    const card = readCard(id)
    if (card && card.status !== 'running') interrupted ??= { ...(run ?? {}), status: 'interrupted', outcome: 'killed', handoff: false }
    if (interrupted && (!run || !supervisorAlive)) return interrupted
    // A dead supervisor never writes `exited`; do not wait on it forever.
    if (run && ['launching', 'running'].includes(run.status) && run.supervisor_pid && !supervisorAlive) {
      deadSince ??= Date.now()
      if (Date.now() - deadSince > 5000) {
        patchRun(id, n, { status: 'orphaned' })
        return { ...run, status: 'orphaned', outcome: 'failed', handoff: true, signal: 'none', reason: `supervisor pid ${run.supervisor_pid} died before the leg finished` }
      }
    } else deadSince = null
    await sleep(pollMs)
  }
}

function changedFiles(worktree) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: worktree, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) return []
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => f && !f.startsWith('.baton'))
}

function diffStat(worktree) {
  const r = spawnSync('git', ['diff', '--stat'], { cwd: worktree, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
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
  const args = ['launch', '--card', card.card_id, '--adapter', entry.adapter, '--prompt-file', promptFile, '--cwd', worktree, '--driver-pid', String(process.pid)]
  if (entry.mode) args.push('--mode', entry.mode)
  if (entry.maxTurns) args.push('--max-turns', String(entry.maxTurns))
  if (entry.model) args.push('--model', String(entry.model))
  if (entry.network) args.push('--network', '1')
  const extraEnv = {}
  if (entry.fakeMode) {
    // "a;b;c" = one mode per landing attempt (demo: break-test on the first run, fix-test after the bounce)
    const modes = String(entry.fakeMode).split(';').map((m) => m.trim()).filter(Boolean)
    extraEnv.FAKE_MODE = modes[Math.min(card.land_attempts ?? 0, modes.length - 1)]
  }
  if (entry.fakeFixture) extraEnv.FAKE_LIMIT_FIXTURE = entry.fakeFixture
  if (entry.fakeTarget) extraEnv.FAKE_TARGET = entry.fakeTarget
  if (entry.fakeContent) extraEnv.FAKE_CONTENT = entry.fakeContent
  extraEnv.FAKE_TRUNK = card.trunk || 'main'
  if (Object.keys(extraEnv).length) args.push('--env-json', JSON.stringify(extraEnv))
  let launch
  try {
    launch = JSON.parse(execFileSync(process.execPath, [RUNNER, ...args], { windowsHide: true, encoding: 'utf8', env: process.env }))
  } catch (err) {
    const text = String(err.stderr ?? err.stdout ?? err.message)
    return { status: 'failed', outcome: 'launch_failed', handoff: true, signal: 'none', reason: scrub(text).slice(0, 300), run: null, exit_code: null }
  }
  if (card.resume_from_bundle) ledgerUpdate(card.card_id, { patch: { resume_from_bundle: false } })
  const run = await waitForRun(card.card_id, launch.run)
  return run
}

export { resolveCommand } from './commands.mjs'
// async: the test station runs inside the board server's scheduler, and a
// long suite must not freeze the board (src/commands.mjs)
const runTestCommand = (cmd, cwd) => runCommandAsync(cmd, cwd, { tailLines: 20 })

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
  const claim = claimDriver(id)
  if (!claim.ok) {
    log(`card ${id} is driven by pid ${claim.pid}; not attaching`)
    return card
  }
  try {
    return await driveCard(id, card, actor)
  } finally { releaseDriver(id) }
}

async function driveCard(id, card, actor) {
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
    const handler = KIND_HANDLERS[st.kind]
    if (handler) {
      const r = await handler.run({ id, card, station: st, worktree: wt.path, actor, ops: OPS })
      card = r.card
      if (r.done) return card
      continue
    }
    if (st.kind === 'land') {
      const r = await landCard(card, wt.path)
      const fresh = readCard(id)
      if (fresh.status !== 'running') {
        // a human acted while the land ran; trunk may have moved anyway, and
        // the ledger must say so even though the card no longer advances
        if (r.landed) ledgerAppend(id, { type: 'landed', station: st.name, leg: 0, summary: `landed on trunk after the card was ${fresh.status}` })
        return fresh
      }
      if (r.bounced) {
        // the failure travels with the card: Open findings of the bounce bundle
        handoffOn(card, { name: st.name, chain: [] }, { outcome: `land-${r.reason}`, reason: r.detail ?? r.reason, exit_code: null, adapter: 'land' }, wt.path,
          [`land failure: ${r.reason}`, r.detail ?? '', ...(r.files?.length ? [`conflicting files: ${r.files.join(', ')}`] : [])].filter(Boolean))
      }
      if (!r.landed && !r.bounced && !r.pr) {
        ledgerAppend(id, { type: 'error', station: st.name, leg: 0, summary: `land failed: ${scrub(r.reason ?? 'unknown').slice(0, 200)}` })
        card = step(id, 'land_result', { bounced: true, reason: r.reason }, actor)
        continue
      }
      card = step(id, 'land_result', { ...r, reason: r.detail ? `${r.reason}: ${r.detail}` : r.reason }, actor)
      continue
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
// decision), not `stalled` or `failed`. A run still `launching` has no
// agent_pid yet: its supervisor is killed with its whole tree instead, so an
// agent it spawns a moment later dies with it rather than running a full leg
// under a card the board already shows as killed.
export function killActiveRun(id) {
  const runsDir = join(cardDir(id), 'runs')
  if (!existsSync(runsDir)) return false
  let killed = false
  const runs = readdirSync(runsDir).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  for (const n of runs) {
    let run
    try { run = JSON.parse(readFileSync(join(runsDir, String(n), 'run.json'), 'utf8')) } catch { continue }
    if (!['launching', 'running'].includes(run.status)) continue
    patchRun(id, n, { kill_requested: true })
    if (run.agent_pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.agent_pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
      else { try { process.kill(run.agent_pid, 'SIGKILL') } catch {} }
      killed = true
    } else if (run.supervisor_pid && pidAlive(run.supervisor_pid)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.supervisor_pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
      else { try { process.kill(-run.supervisor_pid, 'SIGKILL') } catch { try { process.kill(run.supervisor_pid, 'SIGKILL') } catch {} } }
      killed = true
    }
  }
  return killed
}

// Helpers handed to the station-kind modules (see src/stations/*.mjs).
const OPS = {
  readCard, ledgerAppend, step, apply, transition, handoffOn, runLeg, waitForRun,
  unsettledRun, settleRun, patchRun, pidAlive, log, resolveTestCommand, runTestCommand,
}
