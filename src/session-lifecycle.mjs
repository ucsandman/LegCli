// session-lifecycle — the interactive terminal's state machine, as data. One
// session.json `status` per terminal under `leg claude|codex|agy|grok`, written
// by four processes (the runner in src/attach.mjs, Claude Code's hooks in
// src/taps/claude.mjs, the board's usage poller in src/usage-poll.mjs, and
// reapLost in src/sessions.mjs). SESSION_EDGES is every move any of them may
// make; updateSession checks a status write against it inside .session.lock
// when the writer passes `onIllegal`, and the board, the HTTP routes and the
// CLI read what a human may do from sessionActions().
//
// ZERO imports, on purpose: src/sessions.mjs imports this file, and
// sessions.mjs is imported by usage.mjs, hook.mjs and a dozen others. An import
// cycle through it is the ESM trap that exits 13 with no message.

export const SESSION_STATES = Object.freeze(['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting', 'handed_off', 'ended', 'lost'])
export const SESSION_ACTIVE_STATES = Object.freeze(['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting'])
// handed_off is legacy: it may be read from disk (a record from an older Leg),
// never entered, so no row leads into it

// [from, to, actor, note]. actor: user (a human on the board or the CLI),
// agent (the agent's own signal: a hook, a log line, a rollout), cron (the
// board's usage poller), system (the runner itself). createSession writes the
// first 'starting' (src/sessions.mjs) and is outside the table.
export const SESSION_EDGES = Object.freeze([
  ['starting', 'running', 'agent', 'claude SessionStart/Stop hooks (taps/claude.mjs); agy/grok first prompt (attach.mjs tick)'],
  ['starting', 'running', 'system', 'a non-claude first leg starts running (attach.mjs runLeg)'],
  ['starting', 'warning', 'agent', 'agy/grok first prompt and the warning threshold in the same tick (attach.mjs)'],
  ['starting', 'limit', 'agent', 'claude StopFailure (taps/claude.mjs); codex/agy/grok wall in the tick (attach.mjs)'],
  ['starting', 'limit', 'cron', 'codex reports ordinary usage unavailable (usage-poll.mjs)'],
  ['starting', 'handing_off', 'user', 'Hand off now or Approve, written by the runner (attach.mjs tick)'],
  ['starting', 'ended', 'user', 'End (attach.mjs tick, then the final write)'],
  ['starting', 'ended', 'system', 'the spawn throws, or the agent exits (attach.mjs)'],
  ['starting', 'lost', 'system', 'the runner pid is gone (sessions.mjs reapLost)'],
  ['running', 'warning', 'agent', 'a usage window crossed the warning threshold (taps/claude.mjs status line, attach.mjs tick)'],
  ['running', 'limit', 'agent', 'claude StopFailure; codex/agy/grok wall in the tick'],
  ['running', 'limit', 'cron', 'codex reports ordinary usage unavailable (usage-poll.mjs)'],
  ['running', 'handing_off', 'user', 'Hand off now or Approve (attach.mjs tick)'],
  ['running', 'ended', 'user', 'End'],
  ['running', 'ended', 'system', 'the agent exits (attach.mjs final write)'],
  ['running', 'lost', 'system', 'reapLost'],
  ['warning', 'running', 'agent', 'the window dropped back under the threshold (taps/claude.mjs status line)'],
  ['warning', 'limit', 'agent', 'claude StopFailure; codex/agy/grok wall in the tick'],
  ['warning', 'limit', 'cron', 'codex reports ordinary usage unavailable (usage-poll.mjs)'],
  ['warning', 'handing_off', 'user', 'Hand off now or Approve (attach.mjs tick)'],
  ['warning', 'ended', 'user', 'End'],
  ['warning', 'ended', 'system', 'the agent exits (attach.mjs final write)'],
  ['warning', 'lost', 'system', 'reapLost'],
  ['limit', 'handing_off', 'system', 'the next option is claimed (attach.mjs claimHandoffChoice)'],
  ['limit', 'handing_off', 'user', 'Hand off now while claude stood down at its own limit (attach.mjs tick)'],
  ['limit', 'waiting', 'system', 'every option is out (attach.mjs all-out wait)'],
  ['limit', 'ended', 'user', 'End'],
  ['limit', 'ended', 'system', 'LEG_NO_HANDOFF=1, or a stood-down claude exits (attach.mjs final write)'],
  ['limit', 'lost', 'system', 'reapLost'],
  ['handing_off', 'starting', 'system', 'the next leg starts, claude (attach.mjs runLeg)'],
  ['handing_off', 'running', 'system', 'the next leg starts, codex/agy/grok (attach.mjs runLeg)'],
  ['handing_off', 'waiting', 'system', 'no destination is open after a board request (attach.mjs all-out wait)'],
  ['handing_off', 'ended', 'system', 'the next spawn throws, the strict harness refuses every destination (exit 5), or the 12-leg cap (exit 3)'],
  ['handing_off', 'ended', 'user', 'End, honored at the leg boundary before the next leg starts (attach.mjs legBoundary)'],
  ['handing_off', 'lost', 'system', 'reapLost'],
  ['waiting', 'handing_off', 'system', 'the first reset arrived and the next option is claimed (attach.mjs claimHandoffChoice)'],
  ['waiting', 'ended', 'user', 'End or Ctrl-C during the countdown (attach.mjs, exit 3)'],
  ['waiting', 'ended', 'system', 'the runner exits (attach.mjs final write)'],
  ['waiting', 'lost', 'system', 'reapLost'],
  ['lost', 'ended', 'system', 'a runner the board reaped as lost exits after all (attach.mjs final write)'],
].map((row) => Object.freeze(row)))

const uniq = (xs) => [...new Set(xs)]

export const SESSION_TRANSITIONS = Object.freeze(Object.fromEntries(SESSION_STATES.map((from) => [
  from, Object.freeze(uniq(SESSION_EDGES.filter((e) => e[0] === from).map((e) => e[1]))),
])))

// the hand-off order may change until a destination is committed
export const ORDER_EDITABLE_STATES = Object.freeze(SESSION_ACTIVE_STATES.filter((s) => s !== 'handing_off'))

// the board's nine words (src/board/sessions.js STATUS, which mirrors these)
export const SESSION_STATE_LABELS = Object.freeze({
  starting: 'starting', running: 'running', warning: 'near limit', limit: 'limit hit', handing_off: 'handing off',
  waiting: 'waiting for reset', handed_off: 'handed off', ended: 'ended', lost: 'lost',
})

export class IllegalSessionTransition extends Error {
  constructor(message, { current, requested, allowed = [], actions = [] } = {}) {
    super(message)
    this.name = 'IllegalSessionTransition'
    this.code = 'illegal_transition'
    this.current = current ?? null
    this.requested = requested ?? null
    this.allowed = [...allowed]
    this.actions = [...actions]
  }
}

// A same-status write is not a transition: no row is a self-loop, so this is
// false for it, and updateSession never asks.
export function canTransition(current, requested, { actor } = {}) {
  return SESSION_EDGES.some((e) => e[0] === current && e[1] === requested && (actor === undefined || e[2] === actor))
}

export function nextStates(current, { actor } = {}) {
  if (actor === undefined) return SESSION_TRANSITIONS[current] ?? Object.freeze([])
  return Object.freeze(uniq(SESSION_EDGES.filter((e) => e[0] === current && e[2] === actor).map((e) => e[1])))
}

// What a human may do to this terminal now, in the board's button order.
export function sessionActions(s) {
  const status = s?.status
  const out = []
  if (canTransition(status, 'handing_off', { actor: 'user' })) out.push('handoff', 'approve_request')
  const end = canTransition(status, 'ended', { actor: 'user' })
  if (end) out.push('end')
  // the runner's own bundle save is in flight while handing_off
  // (attach.mjs, after runLeg returns), and two saves on one slug collide
  if (end && status !== 'handing_off') out.push('end_as_card')
  if (ORDER_EDITABLE_STATES.includes(status)) out.push('edit_order')
  if (!SESSION_ACTIVE_STATES.includes(status)) out.push('remove')
  return out
}

const VERB_TARGET = { handoff: 'handing_off', approve_request: 'handing_off', end: 'ended', end_as_card: 'ended', edit_order: null, remove: null }
const VERB_WORDS = { handoff: 'Hand off now', approve_request: 'Approve', end: 'End', end_as_card: 'End, and keep going as a card', edit_order: 'Changing the hand-off order', remove: 'Remove' }

export function assertAction(s, verb) {
  if (!(verb in VERB_TARGET)) throw new TypeError(`unknown session action: ${verb}`)
  const actions = sessionActions(s)
  if (actions.includes(verb)) return
  const status = s?.status ?? null
  const id = s?.session_id
  const message = SESSION_ACTIVE_STATES.includes(status)
    ? `session ${id} is ${SESSION_STATE_LABELS[status]}: ${VERB_WORDS[verb]} is not available now (it can: ${actions.join(', ') || 'nothing'})`
    : `session ${id} is not active`
  throw new IllegalSessionTransition(message, {
    current: status,
    requested: VERB_TARGET[verb] ?? status,
    allowed: nextStates(status, { actor: 'user' }),
    actions,
  })
}
