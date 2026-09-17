// audit — one list of who did what on this board, across every terminal and
// every card, newest first.
//
// The ledger already names an actor on every event; until now you could only
// read that one session or one card at a time, which is no use when the
// question is "who landed that?" or "who handed my terminal off last night".
// Nothing new is recorded here: this reads what is already on disk.
//
// Owner only (src/server.mjs): the trail names repositories and people.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { listSessions, readEvents as readSessionEvents } from './sessions.mjs'
import { readEvents as readCardEvents } from './ledger.mjs'

// The types worth a line in an audit: something a person or an agent DID, not
// the running commentary. A `status` line is commentary; a hand-off is not.
export const AUDITED = [
  'handoff', 'handoff_requested', 'handed_off', 'landed', 'land', 'bounced', 'killed',
  'approved', 'approval_needed', 'reassigned', 'paused', 'resumed', 'ended', 'done',
  'failed', 'trust', 'harness', 'worktree', 'station_done', 'leg_started', 'rerun',
]

export const ACTOR_KINDS = ['human', 'agent', 'leg']

function actorOf(ev) {
  // a card event carries a structured actor; a session event carries `by`
  if (ev.actor && typeof ev.actor === 'object') {
    if (ev.actor.type === 'human') return { kind: 'human', name: String(ev.actor.id ?? 'unknown') }
    if (ev.actor.type === 'agent') return { kind: 'agent', name: String(ev.actor.adapter ?? 'agent') }
    return { kind: 'leg', name: 'leg' }
  }
  if (ev.by) return { kind: 'human', name: String(ev.by) }
  return { kind: 'leg', name: 'leg' }
}

function cardIds() {
  const root = join(home(), 'cards')
  if (!existsSync(root)) return []
  try { return readdirSync(root).filter((d) => existsSync(join(root, d, 'card.json'))) } catch { return [] }
}

function cardMeta(id) {
  try { return JSON.parse(readFileSync(join(home(), 'cards', id, 'card.json'), 'utf8')) } catch { return null }
}

// → { entries: [...], truncated, scanned: { sessions, cards, events } }
// `scanned` is on the record deliberately: an empty audit from a board that
// looked at nothing reads exactly like a quiet week, and the two are not the
// same thing.
export function auditTrail({ limit = 200, since = null, who = null, kind = null, types = null } = {}) {
  const sinceMs = since ? Date.parse(since) : null
  const wanted = Array.isArray(types) && types.length ? new Set(types) : new Set(AUDITED)
  const rows = []
  let events = 0

  const sessions = listSessions()
  for (const s of sessions) {
    for (const ev of readSessionEvents(s.session_id)) {
      events++
      if (!wanted.has(ev.type)) continue
      const at = Date.parse(ev.ts)
      if (sinceMs && Number.isFinite(at) && at < sinceMs) continue
      const actor = actorOf(ev)
      rows.push({
        at: ev.ts,
        who: actor.name,
        kind: actor.kind,
        what: ev.type,
        summary: String(ev.summary ?? ''),
        where: 'terminal',
        id: s.session_id,
        agent: s.agent ?? null,
        repo: s.repo ?? null,
        branch: s.branch ?? null,
      })
    }
  }

  const ids = cardIds()
  for (const id of ids) {
    const card = cardMeta(id)
    for (const ev of readCardEvents(id)) {
      events++
      if (!wanted.has(ev.type)) continue
      const at = Date.parse(ev.ts)
      if (sinceMs && Number.isFinite(at) && at < sinceMs) continue
      const actor = actorOf(ev)
      rows.push({
        at: ev.ts,
        who: actor.name,
        kind: actor.kind,
        what: ev.type,
        summary: String(ev.summary ?? ''),
        where: 'card',
        id,
        agent: ev.actor?.type === 'agent' ? ev.actor.adapter : null,
        repo: card?.repo ?? null,
        branch: card?.branch ?? null,
      })
    }
  }

  let filtered = rows
  if (who) filtered = filtered.filter((r) => r.who.toLowerCase() === String(who).toLowerCase())
  if (kind) filtered = filtered.filter((r) => r.kind === kind)
  filtered.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  const capped = filtered.slice(0, Math.max(1, Math.min(limit, 1000)))

  return {
    entries: capped,
    truncated: filtered.length > capped.length,
    matched: filtered.length,
    // L2: a verdict carries the volume it processed
    scanned: { sessions: sessions.length, cards: ids.length, events },
    people: [...new Set(rows.filter((r) => r.kind === 'human').map((r) => r.who))].sort(),
  }
}
