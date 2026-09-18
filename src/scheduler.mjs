// scheduler — every tick reads the ledger (card.json files are truth, never
// in-memory state), starts queued cards whose path leases do not overlap any
// running card's leases, up to BATON_MAX_CONCURRENT, and records one
// blocked_by event per blocker change. Cards run inside this process via
// orchestrator.runCard (async, non-blocking).
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { conflicts } from './leases.mjs'
import { canonPath } from './fsx.mjs'
import { runCard, orphanedRun, unsettledRun, driverAlive } from './orchestrator.mjs'
import { listCards, ledgerAppend, ledgerLog, home, sleep } from './store.mjs'
import { readSession, isActive } from './sessions.mjs'

export const MAX_CONCURRENT = Math.max(1, parseInt((process.env.LEG_MAX_CONCURRENT || process.env.BATON_MAX_CONCURRENT) || '2', 10) || 2)
const ACTIVE = ['running', 'handing_off']

// Two cards on one repo compare by the canonical path, so two spellings of a
// checkout (short name, symlink, case) never look like two repos.
const repoKey = (c) => { try { return canonPath(c.repo) } catch { return String(c.repo) } }
const stationKind = (c) => (c.pipeline ?? []).find((s) => s.name === c.station)?.kind

// Repos with a land station running right now (by station KIND: a land
// station can be named anything).
export function landingRepos(cards) {
  return new Set(cards.filter((c) => c.status === 'running' && stationKind(c) === 'land').map(repoKey))
}

// Pure: which queued cards may start now, and why the others cannot.
export function pickRunnable(cards, { max = MAX_CONCURRENT, landing = new Set() } = {}) {
  const running = cards.filter((c) => ACTIVE.includes(c.status))
  const queued = cards.filter((c) => c.status === 'queued').sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  const keys = new Map(cards.map((c) => [c.card_id, repoKey(c)]))
  const landingKeys = new Set([...landing].map((repo) => repoKey({ repo })))
  const start = []
  const blocked = []
  for (const c of queued) {
    if (running.length + start.length >= max) { blocked.push({ card: c, conflicts: [], reason: `concurrency cap ${max}` }); continue }
    // a landing repo only holds back other cards that want to land; build stations keep running
    const wantsLand = stationKind(c) === 'land'
    if (wantsLand && landingKeys.has(keys.get(c.card_id))) { blocked.push({ card: c, conflicts: [], reason: 'repo is landing' }); continue }
    const cf = conflicts({ card_id: c.card_id, leases: c.leases }, [...running, ...start].filter((r) => keys.get(r.card_id) === keys.get(c.card_id)))
    if (cf.length) { blocked.push({ card: c, conflicts: cf, reason: 'lease overlap' }); continue }
    start.push(c)
  }
  return { start, blocked, running }
}

// A card born from "End, and keep going as a card" runs in the terminal's own
// checkout. The board waits for that terminal to stop before it queues the
// card, but a card queued by hand (Run), by a rerun, or by an older board must
// not start a headless agent in a working tree an interactive one is still
// writing to. The record is the same one the board reads to know a terminal
// ended.
export function heldByLiveTerminal(card) {
  const from = card?.lineage?.from
  if (!from || !card.worktree_adopted) return null
  try {
    const s = readSession(from)
    return s && isActive(s) ? from : null
  } catch { return null }
}

export function pidfile() { return join(home(), 'scheduler.pid') }

export function createScheduler({ max = MAX_CONCURRENT, intervalMs = 1000, actor = { type: 'leg' } } = {}) {
  const state = { blockedKeys: new Map(), inflight: new Map(), stopped: false, ticks: 0 }

  async function tick() {
    state.ticks += 1
    const cards = listCards()
    const landing = landingRepos(cards)
    const picked = pickRunnable(cards, { max, landing })
    const start = []
    const blocked = [...picked.blocked]
    for (const c of picked.start) {
      const terminal = heldByLiveTerminal(c)
      if (terminal) blocked.push({ card: c, conflicts: [], reason: `terminal ${terminal} is still running in this card's checkout` })
      else start.push(c)
    }
    for (const b of blocked) {
      const key = b.conflicts.length ? b.conflicts.map((x) => `${x.holder}:${x.lease}`).join(',') : b.reason
      if (state.blockedKeys.get(b.card.card_id) === key) continue
      state.blockedKeys.set(b.card.card_id, key)
      const summary = b.conflicts.length
        ? `blocked by ${b.conflicts[0].holder} on ${b.conflicts[0].lease} (against ${b.conflicts[0].against})`
        : `blocked: ${b.reason}`
      ledgerAppend(b.card.card_id, { actor, type: 'blocked_by', summary, station: b.card.station, leg: b.card.leg })
    }
    // Running cards nobody alive is driving (their orchestrator died with the
    // last server) get re-attached so a finished run's verdict is applied, a
    // test or land station left mid-way runs again, and a card that crashed
    // between `start` and its launch gets its leg. A card a live `card run`
    // is driving (its driver.lock names a live pid) is left to that process.
    const reattach = cards.filter((c) => ACTIVE.includes(c.status) && !state.inflight.has(c.card_id) && !driverAlive(c.card_id)
      && (c.status === 'handing_off' || stationKind(c) !== 'agent' || !unsettledRun(c.card_id) || orphanedRun(c.card_id)))
    for (const c of [...start, ...reattach]) {
      if (state.inflight.has(c.card_id)) continue
      state.blockedKeys.delete(c.card_id)
      const p = runCard(c.card_id, { actor }).catch((err) => {
        try { ledgerAppend(c.card_id, { actor, type: 'error', summary: `orchestrator crashed: ${String(err.message).slice(0, 300)}`, station: c.station, leg: c.leg }) } catch {}
      }).finally(() => state.inflight.delete(c.card_id))
      state.inflight.set(c.card_id, p)
    }
    return { started: start.map((c) => c.card_id), reattached: reattach.map((c) => c.card_id), blocked: blocked.map((b) => b.card.card_id), inflight: [...state.inflight.keys()] }
  }

  async function run({ ticks = Infinity } = {}) {
    // one scheduler per home: the pidfile is created atomically, and a live
    // holder (the board's in-process scheduler, or a CLI one) wins
    try { writeFileSync(pidfile(), String(process.pid), { flag: 'wx' }) } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const st = schedulerStatus()
      if (st.running && st.pid !== process.pid) throw new Error(`scheduler already running (pid ${st.pid})`)
      writeFileSync(pidfile(), String(process.pid))
    }
    ledgerLog({ actor, type: 'scheduler_started', summary: `scheduler started (max ${max}, pid ${process.pid})` })
    try {
      for (let i = 0; i < ticks && !state.stopped; i++) {
        await tick()
        if (i + 1 < ticks && !state.stopped) await sleep(intervalMs)
      }
      await Promise.allSettled([...state.inflight.values()])
    } finally {
      ledgerLog({ actor, type: 'scheduler_stopped', summary: `scheduler stopped after ${state.ticks} tick(s)` })
      try { if (existsSync(pidfile()) && readFileSync(pidfile(), 'utf8').trim() === String(process.pid)) unlinkSync(pidfile()) } catch {}
    }
  }

  function stop() { state.stopped = true }

  return { tick, run, stop, state }
}

export function schedulerStatus() {
  const f = pidfile()
  if (!existsSync(f)) return { running: false, pid: null }
  const pid = parseInt(readFileSync(f, 'utf8').trim(), 10)
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  return { running: alive, pid, stale: !alive }
}
