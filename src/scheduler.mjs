// scheduler — every tick reads the ledger (card.json files are truth, never
// in-memory state), starts queued cards whose path leases do not overlap any
// running card's leases, up to BATON_MAX_CONCURRENT, and records one
// blocked_by event per blocker change. Cards run inside this process via
// orchestrator.runCard (async, non-blocking).
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { conflicts } from './leases.mjs'
import { runCard } from './orchestrator.mjs'
import { listCards, ledgerAppend, ledgerLog, home, sleep } from './store.mjs'

export const MAX_CONCURRENT = Math.max(1, parseInt(process.env.BATON_MAX_CONCURRENT || '2', 10) || 2)
const ACTIVE = ['running', 'handing_off']

// Pure: which queued cards may start now, and why the others cannot.
export function pickRunnable(cards, { max = MAX_CONCURRENT, landing = new Set() } = {}) {
  const running = cards.filter((c) => ACTIVE.includes(c.status))
  const queued = cards.filter((c) => c.status === 'queued').sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  const start = []
  const blocked = []
  for (const c of queued) {
    if (running.length + start.length >= max) { blocked.push({ card: c, conflicts: [], reason: `concurrency cap ${max}` }); continue }
    if (landing.has(c.repo)) { blocked.push({ card: c, conflicts: [], reason: 'repo is landing' }); continue }
    const cf = conflicts({ card_id: c.card_id, leases: c.leases }, [...running, ...start].filter((r) => r.repo === c.repo))
    if (cf.length) { blocked.push({ card: c, conflicts: cf, reason: 'lease overlap' }); continue }
    start.push(c)
  }
  return { start, blocked, running }
}

export function pidfile() { return join(home(), 'scheduler.pid') }

export function createScheduler({ max = MAX_CONCURRENT, intervalMs = 1000, actor = { type: 'baton' } } = {}) {
  const state = { blockedKeys: new Map(), inflight: new Map(), stopped: false, ticks: 0 }

  async function tick() {
    state.ticks += 1
    const cards = listCards()
    const landing = new Set(cards.filter((c) => c.status === 'running' && c.station === 'land').map((c) => c.repo))
    const { start, blocked } = pickRunnable(cards, { max, landing })
    for (const b of blocked) {
      const key = b.conflicts.length ? b.conflicts.map((x) => `${x.holder}:${x.lease}`).join(',') : b.reason
      if (state.blockedKeys.get(b.card.card_id) === key) continue
      state.blockedKeys.set(b.card.card_id, key)
      const summary = b.conflicts.length
        ? `blocked by ${b.conflicts[0].holder} on ${b.conflicts[0].lease} (against ${b.conflicts[0].against})`
        : `blocked: ${b.reason}`
      ledgerAppend(b.card.card_id, { actor, type: 'blocked_by', summary, station: b.card.station, leg: b.card.leg })
    }
    for (const c of start) {
      if (state.inflight.has(c.card_id)) continue
      state.blockedKeys.delete(c.card_id)
      const p = runCard(c.card_id, { actor }).catch((err) => {
        try { ledgerAppend(c.card_id, { actor, type: 'error', summary: `orchestrator crashed: ${String(err.message).slice(0, 300)}`, station: c.station, leg: c.leg }) } catch {}
      }).finally(() => state.inflight.delete(c.card_id))
      state.inflight.set(c.card_id, p)
    }
    return { started: start.map((c) => c.card_id), blocked: blocked.map((b) => b.card.card_id), inflight: [...state.inflight.keys()] }
  }

  async function run({ ticks = Infinity } = {}) {
    writeFileSync(pidfile(), String(process.pid))
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
