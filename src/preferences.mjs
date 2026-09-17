// Machine-wide defaults for interactive Leg terminals. A new terminal takes
// a copy of these preferences when it starts; later edits do not silently
// change terminals that are already running.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'
import { MODEL_ALIASES } from './buckets.mjs'

export const HANDOFF_AGENTS = ['claude', 'codex', 'agy']
export const ALL_HANDOFF_AGENTS = ['claude', 'codex', 'agy', 'grok']

export function validHandoffOrder(value) {
  if (!Array.isArray(value)) return false
  const set = new Set(value)
  if (set.size !== value.length) return false
  if (value.length === 3 && ['claude', 'codex', 'agy'].every((a) => set.has(a))) return true
  if (value.length === 4 && ['claude', 'codex', 'agy', 'grok'].every((a) => set.has(a))) return true
  return false
}

export function normalizeHandoffOrder(value) {
  return validHandoffOrder(value) ? [...value] : [...HANDOFF_AGENTS]
}

export function requireHandoffOrder(value) {
  if (!validHandoffOrder(value)) throw new TypeError('handoff_order must contain claude, codex, and agy exactly once')
  return [...value]
}

// ---- the fallback ladder (docs/redesign-2026-09-17.md B.3) ----
// A rung is a destination, not an agent: { agent, account, model, when, cost }.
// `handoff_order` stays on the file and stays derived from the ladder's
// distinct agent order, so `validHandoffOrder`, `requireHandoffOrder` and every
// older reader of this file keep working unchanged.
export const CLIMB_BACK_POLICIES = ['next-handoff', 'never'] // `when-quiet` is deliberately not shipped (B.7)
export const RUNG_COSTS = ['free', 'plan', 'credits', 'metered']
const WHEN_RE = /^(?:always|walled-only|below:(100|[0-9]{1,2}))$/

// The word for what a rung spends when nothing about the login is known yet.
// agy is free, grok bills metered credits through its proxy, a subscription
// login is `plan`. Deliberately not a function of live state: a word persisted
// in preferences.json must not be able to go stale (rungCost does the live part).
export function staticCost(agent) {
  return agent === 'agy' ? 'free' : agent === 'grok' ? 'metered' : 'plan'
}

// What this rung spends RIGHT NOW. `credits` is the one cost that depends on
// live state: claude/fable bills usage credits only once the login has them
// enabled (extra_usage.enabled), and until then it is ordinary plan usage.
// Computed, never persisted, so the cost gate can never act on a stale word.
export function rungCost(rung, usage = null) {
  if (!rung) return 'plan'
  if (rung.agent === 'claude' && rung.model === 'fable' && usage?.extra_usage?.enabled === true) return 'credits'
  if (RUNG_COSTS.includes(rung.cost)) return rung.cost
  return staticCost(rung.agent)
}

export function normalizeRung(value) {
  const agent = String(value?.agent ?? '')
  const model = value?.model === undefined || value?.model === null || value?.model === '' ? null : String(value.model).toLowerCase()
  return {
    agent,
    account: value?.account ? String(value.account) : 'default',
    model,
    when: typeof value?.when === 'string' && WHEN_RE.test(value.when) ? value.when : 'always',
    cost: RUNG_COSTS.includes(value?.cost) ? value.cost : staticCost(agent),
  }
}

export const rungKey = (r) => `${r.agent}--${r.account}--${r.model ?? ''}`

// One rung per agent, model null, cost plan: what an existing `handoff_order`
// means, written out long-hand. Behaviour is bit-identical to the order it came
// from until a human edits a rung.
export function ladderFromOrder(order) {
  return normalizeHandoffOrder(order).map((agent) => ({ agent, account: 'default', model: null, when: 'always', cost: 'plan' }))
}

// A fresh install: the claude models first (a same-login switch keeps the
// conversation, B.5), then every other agent of the default order (G2).
export function defaultLadder() {
  const rungs = MODEL_ALIASES.claude.slice(0, 3).map((model) => ({ agent: 'claude', account: 'default', model, when: 'always', cost: 'plan' }))
  for (const agent of HANDOFF_AGENTS) if (agent !== 'claude') rungs.push({ agent, account: 'default', model: null, when: 'always', cost: staticCost(agent) })
  return rungs
}

export function validHandoffLadder(value) {
  try { requireHandoffLadder(value); return true } catch { return false }
}

export function requireHandoffLadder(value) {
  if (!Array.isArray(value) || !value.length) throw new TypeError('handoff_ladder must be a non-empty array of rungs')
  const seen = new Set()
  const out = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new TypeError('each rung must be an object: {agent, account, model, when, cost}')
    if (!ALL_HANDOFF_AGENTS.includes(raw.agent)) throw new TypeError(`unknown agent "${raw.agent}" in handoff_ladder (${ALL_HANDOFF_AGENTS.join(', ')})`)
    const rung = normalizeRung(raw)
    if (rung.model && !(MODEL_ALIASES[rung.agent] ?? []).includes(rung.model)) {
      const known = (MODEL_ALIASES[rung.agent] ?? []).join(', ')
      throw new TypeError(`${rung.agent} has no model "${rung.model}"${known ? ` (${known})` : ': Leg knows no model names for it'}`)
    }
    if (raw.when !== undefined && !(typeof raw.when === 'string' && WHEN_RE.test(raw.when))) throw new TypeError(`rung "when" must be always, below:N or walled-only (got "${raw.when}")`)
    if (raw.cost !== undefined && !RUNG_COSTS.includes(raw.cost)) throw new TypeError(`rung "cost" must be one of ${RUNG_COSTS.join(', ')}`)
    const key = rungKey(rung)
    if (seen.has(key)) throw new TypeError(`handoff_ladder names ${rung.agent}/${rung.account}${rung.model ? '/' + rung.model : ''} twice`)
    seen.add(key)
    out.push(rung)
  }
  return out
}

// The ladder's distinct agents, in the order the ladder first names them, then
// whatever the old three- or four-agent contract still needs so that
// `validHandoffOrder` stays true for every older reader of this file.
export function orderFromLadder(ladder) {
  const out = []
  for (const r of ladder) if (!out.includes(r.agent)) out.push(r.agent)
  const wanted = out.includes('grok') ? ALL_HANDOFF_AGENTS : HANDOFF_AGENTS
  for (const a of wanted) if (!out.includes(a)) out.push(a)
  return out.filter((a) => wanted.includes(a))
}

// The ladder a preferences object means: its own, else the long-hand form of
// its `handoff_order`, else the default ladder.
export function normalizeHandoffLadder(prefs) {
  const value = Array.isArray(prefs) ? prefs : prefs?.handoff_ladder
  if (Array.isArray(value) && value.length) { try { return requireHandoffLadder(value) } catch { /* fall through to the order */ } }
  if (!Array.isArray(prefs) && validHandoffOrder(prefs?.handoff_order)) return ladderFromOrder(prefs.handoff_order)
  if (Array.isArray(prefs)) return defaultLadder()
  return defaultLadder()
}

// The ladder a RECORD means, where the record carries both keys and something
// that never heard of ladders may have written one of them. `handoff_order` is
// the older, narrower statement of the same intent: when the two disagree, the
// order wins and the ladder is rebuilt from it, because the writer that set an
// order alone is the one that did not know the ladder was there. Leg's own
// writers always set both, so this only ever fires for an outside edit.
export function ladderFor(record) {
  const ladder = normalizeHandoffLadder({ handoff_ladder: record?.handoff_ladder, handoff_order: record?.handoff_order })
  if (!Array.isArray(record?.handoff_ladder) || !record.handoff_ladder.length) return ladder
  if (!validHandoffOrder(record?.handoff_order)) return ladder
  const derived = orderFromLadder(ladder)
  const same = derived.length === record.handoff_order.length && derived.every((a, i) => a === record.handoff_order[i])
  return same ? ladder : ladderFromOrder(record.handoff_order)
}

export function normalizeClimbBack(value) {
  return CLIMB_BACK_POLICIES.includes(value) ? value : 'next-handoff'
}

export function requireClimbBack(value) {
  if (!CLIMB_BACK_POLICIES.includes(value)) throw new TypeError(`climb_back must be one of ${CLIMB_BACK_POLICIES.join(', ')}`)
  return value
}

// Per login, the share of a window an automatic hand-off may not eat into, so a
// background card cannot spend the last of what the human wants for their own
// terminal. `{}` by default: a floor nobody asked for is a wrong number.
export function normalizeReserve(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [agent, pct] of Object.entries(value)) {
    if (!ALL_HANDOFF_AGENTS.includes(agent)) continue
    const n = Number(pct)
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue
    out[agent] = Math.round(n)
  }
  return out
}

export function requireReserve(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('reserve must be an object of {agent: percent}')
  for (const [agent, pct] of Object.entries(value)) {
    if (!ALL_HANDOFF_AGENTS.includes(agent)) throw new TypeError(`unknown agent "${agent}" in reserve (${ALL_HANDOFF_AGENTS.join(', ')})`)
    const n = Number(pct)
    if (!Number.isFinite(n) || n <= 0 || n > 100) throw new TypeError(`reserve.${agent} must be a percentage between 1 and 100`)
  }
  return normalizeReserve(value)
}

// Portable harness (src/harness/): off for every existing install. `enabled`
// is the explicit consent `leg harness enable` records; `policy` is what an
// unattended hand-off may do (warn: report only; sync: write managed state
// when it is safe; strict: refuse a destination that cannot be made safe);
// `source` is the client whose harness is the one being carried.
export const HARNESS_POLICIES = ['warn', 'sync', 'strict']
export const HARNESS_SOURCES = ['claude', 'codex']
export const HARNESS_DEFAULTS = Object.freeze({ enabled: false, policy: 'warn', source: null })

export function normalizeHarness(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    enabled: v.enabled === true,
    policy: HARNESS_POLICIES.includes(v.policy) ? v.policy : HARNESS_DEFAULTS.policy,
    source: HARNESS_SOURCES.includes(v.source) ? v.source : null,
  }
}

export function requireHarness(patch, current = HARNESS_DEFAULTS) {
  const next = { ...normalizeHarness(current) }
  if (patch?.enabled !== undefined) next.enabled = Boolean(patch.enabled)
  if (patch?.policy !== undefined) {
    if (!HARNESS_POLICIES.includes(patch.policy)) throw new TypeError(`harness policy must be one of ${HARNESS_POLICIES.join(', ')}`)
    next.policy = patch.policy
  }
  if (patch?.source !== undefined) {
    if (patch.source !== null && !HARNESS_SOURCES.includes(patch.source)) throw new TypeError(`harness source must be one of ${HARNESS_SOURCES.join(', ')}`)
    next.source = patch.source
  }
  return next
}

export function preferencesFile() { return join(home(), 'preferences.json') }

export function resolveAutoApprove({ env = process.env, preferences = null, cliFlag = null } = {}) {
  if (cliFlag !== null && cliFlag !== undefined) return Boolean(cliFlag)
  const envVal = env.LEG_AUTO_APPROVE ?? env.BATON_AUTO_APPROVE
  if (envVal !== undefined) return envVal !== '0' && envVal !== 'false' && envVal !== 'off'
  if ((env.LEG_NO_AUTO_APPROVE ?? env.BATON_NO_AUTO_APPROVE) === '1') return false
  const prefs = preferences ?? readPreferences()
  if (typeof prefs?.auto_approve === 'boolean') return prefs.auto_approve
  return true
}

// Where a terminal that is waiting on a human says so. `notify_terminal` is on
// by default: the OSC 9 toast reaches the window the human is already in, with
// no browser and no permission prompt (docs/redesign-2026-09-17.md E, the
// notifications table). `notify_board` is off by default because the browser's
// own Notification permission has to be granted first, and a toggle that asks
// for a permission nobody wanted is worse than no toggle.
const defaults = () => {
  const ladder = defaultLadder()
  return { handoff_order: orderFromLadder(ladder), handoff_ladder: ladder, climb_back: 'next-handoff', may_spend: false, reserve: {}, auto_approve: true, notify_terminal: true, notify_board: false, harness: { ...HARNESS_DEFAULTS } }
}

export function readPreferences() {
  const file = preferencesFile()
  if (!existsSync(file)) return defaults()
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    // The ladder is the richer key, so it decides the order when the file
    // carries both; a file written by an older Leg carries only the order, and
    // the ladder it means is that order written out long-hand.
    const ladder = normalizeHandoffLadder(value)
    return {
      handoff_order: Array.isArray(value?.handoff_ladder) && value.handoff_ladder.length ? orderFromLadder(ladder) : normalizeHandoffOrder(value?.handoff_order),
      handoff_ladder: ladder,
      climb_back: normalizeClimbBack(value?.climb_back),
      may_spend: value?.may_spend === true,
      reserve: normalizeReserve(value?.reserve),
      auto_approve: value?.auto_approve !== false,
      notify_terminal: value?.notify_terminal !== false,
      notify_board: value?.notify_board === true,
      harness: normalizeHarness(value?.harness),
    }
  } catch {
    return defaults()
  }
}

export function writePreferences(patch) {
  // Writing one of the two rewrites the other: the ladder is the shape Leg
  // walks, `handoff_order` is the shape every older reader knows, and they may
  // never disagree on disk.
  const ladder = patch?.handoff_ladder !== undefined ? requireHandoffLadder(patch.handoff_ladder) : undefined
  const order = patch?.handoff_order !== undefined ? requireHandoffOrder(patch.handoff_order) : undefined
  const climbBack = patch?.climb_back !== undefined ? requireClimbBack(patch.climb_back) : undefined
  const reserve = patch?.reserve !== undefined ? requireReserve(patch.reserve) : undefined
  mkdirSync(home(), { recursive: true })
  return withFileLock(preferencesFile() + '.lock', () => {
    const current = readPreferences()
    const next = { ...current }
    if (ladder !== undefined) { next.handoff_ladder = ladder; next.handoff_order = orderFromLadder(ladder) }
    if (order !== undefined) { next.handoff_order = order; if (ladder === undefined) next.handoff_ladder = ladderFromOrder(order) }
    if (climbBack !== undefined) next.climb_back = climbBack
    if (reserve !== undefined) next.reserve = reserve
    if (patch?.may_spend !== undefined) next.may_spend = Boolean(patch.may_spend)
    if (patch?.auto_approve !== undefined) next.auto_approve = Boolean(patch.auto_approve)
    if (patch?.notify_terminal !== undefined) next.notify_terminal = Boolean(patch.notify_terminal)
    if (patch?.notify_board !== undefined) next.notify_board = Boolean(patch.notify_board)
    if (patch?.harness !== undefined) next.harness = requireHarness(patch.harness, current.harness)
    writeJsonAtomic(preferencesFile(), next)
    return next
  })
}
