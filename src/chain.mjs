// chain — the card state machine. Pure: `transition(card, action, payload)`
// returns the patched card plus the ledger events to append; no I/O. Two
// machines live here: the station machine (a card moves through its pipeline)
// and the chain machine (inside an agent station, legs hand off to the next
// adapter on limit / incomplete / no_progress / stalled / failed).
// TRANSITIONS is data so tests print the table and docs embed it.
import { stationIndex } from './pipeline.mjs'

export const TERMINAL = ['done', 'failed', 'killed']
export const NON_TERMINAL = ['backlog', 'queued', 'running', 'handing_off', 'waiting_human', 'needs_approval', 'paused']

// [from, action, to, note]
export const TRANSITIONS = [
  ['backlog', 'enqueue', 'queued', 'human adds the card to the floor (or `card run`)'],
  ['queued', 'start', 'running', 'scheduler starts a leg (agent/test/land station) under the card\'s leases'],
  ['queued', 'reach_human', 'waiting_human', 'a human station is next'],
  ['running', 'leg:completed', 'queued', 'agent leg completed → next station (leg 0)'],
  ['running', 'leg:completed', 'done', 'agent leg completed and it was the last station'],
  ['running', 'leg:completed', 'waiting_human', 'agent leg completed and a human station is next'],
  ['running', 'leg:handoff', 'handing_off', 'limit | incomplete | no_progress | stalled | failed and the chain has a next leg'],
  ['running', 'leg:handoff', 'failed', 'same outcomes with the chain exhausted'],
  ['running', 'leg:auth_failed', 'failed', 'Leg/environment fault; no advance; human fixes and clicks Rerun'],
  ['running', 'leg:launch_failed', 'failed', 'same'],
  ['running', 'leg:killed', 'killed', 'the leg was killed from the board'],
  ['handing_off', 'bundle_written', 'queued', 'next leg (leg+1) queued at the same station'],
  ['handing_off', 'bundle_written', 'needs_approval', 'next chain entry has approve: true'],
  ['running', 'test:green', 'queued', 'test station passed → next station'],
  ['running', 'test:green', 'done', 'test station passed and it was last'],
  ['running', 'test:red', 'queued', 'bounce to the nearest earlier build station (or the first agent station) with bounce_reason'],
  ['running', 'land:landed', 'done', 'land station merged (phase 7: real merge queue)'],
  ['running', 'land:bounced', 'queued', 'land red/conflict → bounce to build with the failure attached (phase 7)'],
  ['running', 'land:failed', 'failed', 'land attempts exhausted (phase 7)'],
  ['running', 'pause', 'paused', 'human: kill the child, write a bundle'],
  ['paused', 'resume', 'queued', 'human: same station and leg; prompt = bundle load + contract'],
  ['*non-terminal*', 'kill', 'killed', 'human'],
  ['*non-terminal*', 'reassign', 'queued', 'human: rewrite the current station\'s chain from the current leg'],
  ['running', 'handoff_now', 'handing_off', 'human: as if the leg ended incomplete'],
  ['needs_approval', 'approve', 'queued', 'human'],
  ['waiting_human', 'approve', 'queued', 'human: the human station is done → next station'],
  ['waiting_human', 'approve', 'done', 'human station was last'],
  ['*terminal*', 'rerun', 'queued', 'human: station 0, leg 0, same worktree, new run number'],
]

export class IllegalTransition extends Error {
  constructor(from, action, to) {
    super(`illegal transition ${from} --${action}--> ${to ?? '?'}`)
    this.name = 'IllegalTransition'
  }
}

const HANDOFF_OUTCOMES = ['limit', 'incomplete', 'no_progress', 'stalled', 'failed']
const NO_ADVANCE_OUTCOMES = ['auth_failed', 'launch_failed']

function station(card) {
  const i = stationIndex(card.pipeline, card.station)
  return { i, s: card.pipeline[i] ?? null }
}

function ev(type, summary, body) {
  const e = { type, summary }
  if (body) e.body = body
  return e
}

// Where the card goes after the station at index i is done.
function advance(card, i, events) {
  const next = card.pipeline[i + 1]
  events.push(ev('station_done', `station ${card.pipeline[i].name} done${next ? ` → ${next.name}` : ''}`))
  if (!next) {
    events.push(ev('done', `card done: all ${card.pipeline.length} station(s) complete`))
    return { ...card, status: 'done', leg: 0 }
  }
  if (next.kind === 'human') return { ...card, station: next.name, leg: 0, status: 'waiting_human' }
  return { ...card, station: next.name, leg: 0, status: 'queued' }
}

// The agent station a red test or a bounced land goes back to: the nearest
// earlier `build`, else the first agent station BEFORE the failing one. An
// agent station after it is never a target: the card would skip the station
// it just failed and finish `done` with red tests.
function bounceTarget(card, i) {
  for (let k = i - 1; k >= 0; k--) {
    const s = card.pipeline[k]
    if (s.kind === 'agent' && s.name === 'build') return s
  }
  return card.pipeline.slice(0, i).find((s) => s.kind === 'agent') ?? null
}

function assertStatus(card, action, allowed) {
  if (!allowed.includes(card.status)) throw new IllegalTransition(card.status, action)
}

export function transition(card, action, payload = {}) {
  const events = []
  const { i, s } = station(card)

  switch (action) {
    case 'enqueue': {
      assertStatus(card, action, ['backlog'])
      const first = card.pipeline[0]
      if (!first) throw new IllegalTransition(card.status, action, 'queued')
      // No ledger event: the status change itself is the record (the board
      // reads card.json); events are reserved for things that happened.
      if (first.kind === 'human') return { card: { ...card, station: first.name, leg: 0, status: 'waiting_human' }, events: [] }
      return { card: { ...card, station: first.name, leg: 0, status: 'queued' }, events: [] }
    }
    case 'start': {
      assertStatus(card, action, ['queued'])
      if (!s) throw new IllegalTransition(card.status, action, 'running')
      if (s.kind === 'human') return { card: { ...card, status: 'waiting_human' }, events: [] }
      return { card: { ...card, status: 'running' }, events: [] }
    }
    case 'leg_result': {
      // payload: { outcome, handoff, signal, adapter, run }
      assertStatus(card, action, ['running'])
      if (!s || s.kind !== 'agent') throw new IllegalTransition(card.status, action)
      const { outcome } = payload
      const tag = `${payload.adapter ?? s.chain[card.leg]?.adapter} leg ${card.leg}${payload.signal && payload.signal !== 'none' ? ` (${payload.signal})` : ''}`
      if (outcome === 'completed') return { card: advance(card, i, events), events }
      if (outcome === 'killed') {
        events.push(ev('killed', `${tag} killed`))
        return { card: { ...card, status: 'killed' }, events }
      }
      if (NO_ADVANCE_OUTCOMES.includes(outcome)) {
        events.push(ev('failed', `${tag}: ${outcome}; not advancing (fix the environment and rerun)`))
        return { card: { ...card, status: 'failed', failure: outcome }, events }
      }
      if (HANDOFF_OUTCOMES.includes(outcome)) {
        const next = s.chain[card.leg + 1]
        if (!next) {
          events.push(ev('failed', `${tag}: ${outcome}; chain exhausted at ${s.name}`))
          return { card: { ...card, status: 'failed', failure: outcome }, events }
        }
        return { card: { ...card, status: 'handing_off', handoff_outcome: outcome, next_leg: card.leg + 1 }, events }
      }
      throw new Error(`unknown leg outcome "${outcome}"`)
    }
    case 'bundle_written': {
      assertStatus(card, action, ['handing_off'])
      const nextLeg = card.next_leg ?? card.leg + 1
      const entry = s?.chain?.[nextLeg]
      if (!entry) throw new IllegalTransition(card.status, action)
      const from = s.chain[card.leg]?.adapter
      if (entry.approve) {
        events.push(ev('approval_needed', `${from} → ${entry.adapter} needs approval before leg ${nextLeg}`))
        return { card: { ...card, leg: nextLeg, status: 'needs_approval', next_leg: null }, events }
      }
      // The handoff_written event (orchestrator) already names from → to; the
      // next leg_started (supervisor) names the adapter. No extra event here.
      void from
      return { card: { ...card, leg: nextLeg, status: 'queued', next_leg: null }, events }
    }
    case 'test_result': {
      assertStatus(card, action, ['running'])
      if (!s || s.kind !== 'test') throw new IllegalTransition(card.status, action)
      if (payload.green) return { card: advance(card, i, events), events }
      const target = bounceTarget(card, i)
      // test and land bounces share one counter (land_attempts) and one cap, so a
      // card that never goes green cannot loop forever
      const attempts = (card.land_attempts ?? 0) + 1
      const max = Math.max(1, parseInt((process.env.LEG_MAX_LAND_ATTEMPTS || process.env.BATON_MAX_LAND_ATTEMPTS) || '3', 10) || 3)
      if (!target || attempts >= max) {
        events.push(ev('failed', target ? `test red after ${attempts} attempt(s)` : 'test red and no agent station to bounce to', payload.reason))
        return { card: { ...card, status: 'failed', failure: 'test', land_attempts: attempts }, events }
      }
      events.push(ev('bounced', `test red (attempt ${attempts}) → ${target.name}`, payload.reason))
      // the next build leg starts from the bounce bundle (the failure is in its Open findings)
      return { card: { ...card, station: target.name, leg: 0, status: 'queued', land_attempts: attempts, bounce_reason: payload.reason ?? 'test red', resume_from_bundle: true }, events }
    }
    case 'land_result': {
      // payload: { landed, bounced, reason } — phase 7 fills the real queue
      assertStatus(card, action, ['running'])
      if (!s || s.kind !== 'land') throw new IllegalTransition(card.status, action)
      if (payload.landed) {
        events.push(ev('landed', payload.summary ?? 'landed on trunk', payload.body))
        return { card: advance(card, i, events), events }
      }
      if (payload.pr) {
        // pr land mode: the human merges; the card waits at the land station
        events.push(ev('approval_needed', payload.summary ?? `pull request opened: ${payload.url ?? ''}`))
        return { card: { ...card, status: 'waiting_human', pr_url: payload.url ?? null }, events }
      }
      const attempts = (card.land_attempts ?? 0) + 1
      const maxAttempts = Math.max(1, parseInt((process.env.LEG_MAX_LAND_ATTEMPTS || process.env.BATON_MAX_LAND_ATTEMPTS) || '3', 10) || 3)
      const target = payload.bounced ? bounceTarget(card, i) : null
      if (target && attempts < maxAttempts) {
        events.push(ev('bounced', `land bounced (attempt ${attempts}) → ${target.name}`, payload.reason))
        return { card: { ...card, station: target.name, leg: 0, status: 'queued', land_attempts: attempts, bounce_reason: payload.reason ?? 'land bounced', resume_from_bundle: true }, events }
      }
      events.push(ev('failed', payload.bounced && !target ? 'land bounced and no agent station to bounce to' : `land failed after ${attempts} attempt(s)`, payload.reason))
      return { card: { ...card, status: 'failed', land_attempts: attempts, failure: 'land' }, events }
    }
    // ---- human actions ----
    case 'pause': {
      assertStatus(card, action, ['running'])
      events.push(ev('paused', 'paused by human'))
      return { card: { ...card, status: 'paused' }, events }
    }
    case 'resume': {
      assertStatus(card, action, ['paused'])
      events.push(ev('resumed', `resumed at ${card.station} leg ${card.leg}`))
      return { card: { ...card, status: 'queued', resume_from_bundle: true }, events }
    }
    case 'kill': {
      assertStatus(card, action, NON_TERMINAL)
      events.push(ev('killed', 'killed by human'))
      return { card: { ...card, status: 'killed', kill_requested: true }, events }
    }
    case 'reassign': {
      assertStatus(card, action, NON_TERMINAL)
      if (!s || s.kind !== 'agent') throw new IllegalTransition(card.status, action)
      if (!payload.adapter) throw new Error('reassign needs an adapter')
      const entry = { adapter: payload.adapter }
      if (payload.mode) entry.mode = payload.mode
      const chain = [...s.chain.slice(0, card.leg), entry, ...s.chain.slice(card.leg + 1)]
      const pipeline = card.pipeline.map((st) => (st.name === s.name ? { ...st, chain } : st))
      events.push(ev('reassigned', `leg ${card.leg} at ${s.name} reassigned to ${payload.adapter}${payload.mode ? ` (${payload.mode})` : ''}`))
      return { card: { ...card, pipeline, status: 'queued', kill_requested: card.status === 'running' }, events }
    }
    case 'handoff_now': {
      assertStatus(card, action, ['running'])
      if (!s || s.kind !== 'agent') throw new IllegalTransition(card.status, action)
      const next = s.chain[card.leg + 1]
      if (!next) throw new IllegalTransition(card.status, action, 'handing_off')
      events.push(ev('status', 'handoff requested by human'))
      return { card: { ...card, status: 'handing_off', handoff_outcome: 'incomplete', next_leg: card.leg + 1, kill_requested: true }, events }
    }
    case 'approve': {
      assertStatus(card, action, ['needs_approval', 'waiting_human'])
      if (card.status === 'needs_approval') {
        events.push(ev('approved', `leg ${card.leg} at ${card.station} approved`))
        return { card: { ...card, status: 'queued' }, events }
      }
      events.push(ev('approved', `human station ${card.station} approved`))
      return { card: advance(card, i, events), events }
    }
    case 'rerun': {
      assertStatus(card, action, TERMINAL)
      const first = card.pipeline[0]
      events.push(ev('status', `rerun from ${first.name} leg 0`))
      return { card: { ...card, station: first.name, leg: 0, status: first.kind === 'human' ? 'waiting_human' : 'queued', land_attempts: 0, bounce_reason: null, failure: null, kill_requested: false }, events }
    }
    default:
      throw new Error(`unknown action "${action}"`)
  }
}

export const HUMAN_ACTIONS = ['pause', 'resume', 'kill', 'reassign', 'handoff_now', 'approve', 'rerun']

// Which human buttons make sense for a card right now (the board asks this).
export function availableActions(card) {
  const out = []
  const st = card.status
  const { s } = station(card)
  if (st === 'running') out.push('pause')
  // the transition refuses handoff_now without a next chain entry, so the board must not offer it
  if (st === 'running' && s?.kind === 'agent' && s.chain?.[card.leg + 1]) out.push('handoff_now')
  if (st === 'paused') out.push('resume')
  if (st === 'needs_approval' || st === 'waiting_human') out.push('approve')
  if (NON_TERMINAL.includes(st)) { out.push('kill'); if (s?.kind === 'agent') out.push('reassign') }
  if (TERMINAL.includes(st)) out.push('rerun')
  if (st === 'backlog') out.push('enqueue')
  return out
}
