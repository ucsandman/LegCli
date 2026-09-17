// usage — per (agent, account) limit state and the handoff chooser.
// $BATON_HOME/usage/<agent>--<account>.json:
//   { agent, account, five_hour: {pct, resets_at}|null, seven_day: {...}|null,
//     limited_until: epoch-seconds|null, limited_reason, limited_at,
//     source, observed_at, available_at, updated_at,
//     buckets: [{kind, group, model, percent, resets_at, is_active, severity}],
//     walls: { <model>: {limited_until, limited_reason, limited_at, source, evidence} },
//     history: { '<kind>:<model>': [{percent, at}] },  // max 24, per bucket
//     extra_usage: {enabled, reason, can_toggle, limit_minor, used_minor}|null,
//     facts: { … }|null }                              // measured, agent-specific
// The record itself is the account bucket and keeps every field it had; the
// five new keys are additive, and an older Leg reading this file ignores them.
// `buckets` is measured (numbers); `walls` is attributed from wording
// (src/buckets.mjs). They stay apart because one is a number and the other is
// a word, and one must never be printed as the other.
// Sources: claude statusline JSON (rate_limits.*) and StopFailure rate_limit;
// codex app-server/rollout rate limits (identified by window duration) and
// the usage-limit error; agy only the wall itself (no percent exposed).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'
import { AGENTS } from './sessions.mjs'
import { rungCost } from './preferences.mjs'

export const WARN_PCT = Number((process.env.LEG_WARN_PCT || process.env.BATON_WARN_PCT) || 85)
// A limit hit with no reset time from the agent: assume the 5-hour window.
const DEFAULT_LIMIT_S = 5 * 3600

export function usageDir() { return join(home(), 'usage') }
export function usageFile(agent, account = 'default') { return join(usageDir(), `${agent}--${account}.json`) }

export function readUsage(agent, account = 'default') {
  const f = usageFile(agent, account)
  if (!existsSync(f)) return emptyUsage(agent, account)
  try { return { ...emptyUsage(agent, account), ...JSON.parse(readFileSync(f, 'utf8')) } } catch { return emptyUsage(agent, account) }
}

function emptyUsage(agent, account) {
  return { agent, account, five_hour: null, seven_day: null, limited_until: null, limited_reason: null, limited_at: null, source: null, observed_at: null, available_at: null, updated_at: null, buckets: [], walls: {}, history: {}, extra_usage: null, facts: null }
}

// The ring key for a bucket: the kind alone when it is account-wide, the kind
// and the model when it is scoped ('weekly_scoped:fable').
export function bucketKey(b) {
  return b.model ? `${b.kind}:${b.model}` : String(b.kind)
}

export const HISTORY_MAX = 24

export function listUsage() {
  const dir = usageDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => { try { return JSON.parse(readFileSync(join(dir, n), 'utf8')) } catch { return null } }).filter(Boolean)
}

function write(u) {
  mkdirSync(usageDir(), { recursive: true })
  writeJsonAtomic(usageFile(u.agent, u.account), { ...u, updated_at: new Date().toISOString() })
}

// read → mutate → write under one cross-process lock, so a percentage write
// from the poller/status-line never erases a wall a hook set in the same moment
// (that race handed the baton straight back to a walled login).
function mutate(agent, account, fn) {
  mkdirSync(usageDir(), { recursive: true })
  return withFileLock(usageFile(agent, account) + '.lock', () => {
    const u = readUsage(agent, account)
    const out = fn(u)
    if (out === false) return u
    const next = out ?? u
    write(next)
    return next
  })
}

// windows: { five_hour: {pct, resets_at}|null, seven_day: …,
//            buckets: [...]|undefined, extra_usage: {...}|undefined,
//            facts: {...}|undefined }
// `available` must be an explicit backend answer. Percentages cannot clear a
// wall: Codex's rate-limit schema says null availability is unknown, even when
// a window is below 100%.
export function recordUsage(agent, account, windows, source, { observed_at = new Date().toISOString(), available = null } = {}) {
  let applied = false
  const value = mutate(agent, account, (u) => {
    const seenMs = Date.parse(observed_at)
    const currentMs = Date.parse(u.observed_at ?? u.updated_at ?? 0)
    if (Number.isFinite(seenMs) && Number.isFinite(currentMs) && seenMs < currentMs) return false
    if (windows.five_hour !== undefined) u.five_hour = windows.five_hour
    if (windows.seven_day !== undefined) u.seven_day = windows.seven_day
    if (Array.isArray(windows.buckets)) {
      const atS = Number.isFinite(seenMs) ? Math.floor(seenMs / 1000) : Math.floor(Date.now() / 1000)
      u.history = recordHistory(u.history ?? {}, u.buckets ?? [], windows.buckets, atS)
      u.buckets = windows.buckets
    }
    if (windows.extra_usage !== undefined) u.extra_usage = windows.extra_usage
    if (windows.facts && typeof windows.facts === 'object') {
      const next = { ...(u.facts ?? {}) }
      for (const [k, v] of Object.entries(windows.facts)) if (v !== undefined && v !== null) next[k] = v
      u.facts = Object.keys(next).length ? next : null
    }
    u.source = source
    u.observed_at = Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : new Date().toISOString()
    applied = true
    if (available === true) u.available_at = u.observed_at
    // A window that has reset clears an old wall.
    const nowS = Math.floor(Date.now() / 1000)
    if (u.limited_until && u.limited_until <= nowS) { u.limited_until = null; u.limited_reason = null; u.limited_at = null }
    // …and a model's own wall, the same way: a Fable wall whose clock has run
    // out must not keep claude/fable off the ladder for the rest of the week.
    for (const [m, w] of Object.entries(u.walls ?? {})) if (!wallActive(w, nowS)) delete u.walls[m]
    const wallMs = Date.parse(u.limited_at ?? u.updated_at ?? 0)
    if (u.limited_until && available === true && (!Number.isFinite(wallMs) || !Number.isFinite(seenMs) || seenMs >= wallMs)) {
      u.limited_until = null
      u.limited_reason = null
      u.limited_at = null
    } else if (available === false) {
      const windows = [u.five_hour, u.seven_day].filter((w) => w && Number.isFinite(w.resets_at) && w.resets_at > nowS)
      windows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
      u.limited_until = windows.length ? windows[0].resets_at : nowS + DEFAULT_LIMIT_S
      u.limited_reason = 'usage_limit_exceeded'
      u.limited_at = u.observed_at
    }
    return u
  })
  return { ...value, usage_applied: applied }
}

// One ring per bucket, max HISTORY_MAX, a new entry only when the percentage
// moved. A window that has reset starts its ring again: a rate computed across
// a reset is a wrong number, and a wrong number is worse than none.
function recordHistory(history, oldBuckets, newBuckets, atS) {
  const out = { ...history }
  const before = new Map((oldBuckets ?? []).map((b) => [bucketKey(b), b]))
  for (const b of newBuckets) {
    if (!Number.isFinite(b?.percent)) continue
    const key = bucketKey(b)
    const prev = before.get(key)
    if (prev && prev.resets_at !== b.resets_at) out[key] = []
    else if (prev && prev.percent === b.percent) continue
    out[key] = [...(out[key] ?? []), { percent: b.percent, at: atS }].slice(-HISTORY_MAX)
  }
  return out
}

// Is this model's own wall still standing? A wall with no clock, or one whose
// clock has passed, is not.
export function wallActive(wall, nowS = Math.floor(Date.now() / 1000)) {
  return Boolean(wall && Number.isFinite(wall.limited_until) && wall.limited_until > nowS)
}

// The bucket that will actually stop this terminal: the one the endpoint says
// is active, else the one scoped to the model being asked about, else the
// account's weekly, else its session, else the legacy hottest window (which is
// all an older record, or a login with no `limits[]`, has).
// → { kind, model, percent, resets_at, scope: 'model'|'account' } | null
// `scope` is what decides whether another model on the same login can help.
export function binding(u, model = null) {
  const buckets = Array.isArray(u?.buckets) ? u.buckets.filter((b) => b && Number.isFinite(b.percent)) : []
  const pick = (list) => (list.length ? [...list].sort((a, b) => b.percent - a.percent)[0] : null)
  const want = model ? String(model).toLowerCase() : null
  const b = pick(buckets.filter((x) => x.is_active))
    ?? (want ? pick(buckets.filter((x) => x.model === want)) : null)
    ?? pick(buckets.filter((x) => x.kind === 'weekly_all'))
    ?? pick(buckets.filter((x) => x.kind === 'session'))
  if (b) return { kind: b.kind, model: b.model ?? null, percent: b.percent, resets_at: b.resets_at ?? null, scope: b.model ? 'model' : 'account' }
  const h = hottest(u ?? {})
  if (!h) return null
  return { kind: h.window === '5h' ? 'five_hour' : 'seven_day', model: null, percent: h.pct, resets_at: h.resets_at ?? null, scope: 'account' }
}

// `scope: 'model'` walls one model family and leaves the login open, so a
// Fable wall never stops claude/sonnet. `scope: 'account'` (the default, and
// what every caller did before) walls the login exactly as it always has.
export function markLimited(agent, account, { resets_at = null, reason = 'limit', source, observed_at = new Date().toISOString(), scope = 'account', model = null, evidence = null } = {}) {
  if (scope === 'model' && model) return markModelLimited(agent, account, { resets_at, reason, source, observed_at, model: String(model).toLowerCase(), evidence })
  let applied = false
  const value = mutate(agent, account, (u) => {
    const seenMs = Date.parse(observed_at)
    const currentMs = Math.max(Date.parse(u.limited_at ?? 0) || 0, Date.parse(u.available_at ?? 0) || 0)
    if (Number.isFinite(seenMs) && Number.isFinite(currentMs) && seenMs < currentMs) return false
    const nowS = Math.floor(Date.now() / 1000)
    let until = Number.isFinite(resets_at) && resets_at > nowS ? resets_at : null
    if (!until) {
      // Prefer the window that actually walled (highest used %) over the soonest
      // reset: a weekly wall (100% / days away) must not be recorded as the
      // 5-hour window's near reset, or the account is handed back and re-walls.
      const windows = [u.five_hour, u.seven_day].filter((w) => w && Number.isFinite(w.resets_at) && w.resets_at > nowS)
      windows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
      until = windows.length ? windows[0].resets_at : nowS + DEFAULT_LIMIT_S
    }
    u.limited_until = until
    u.limited_reason = reason
    u.limited_at = Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : new Date().toISOString()
    u.observed_at = u.limited_at
    if (source) u.source = source
    applied = true
    return u
  })
  return { ...value, wall_applied: applied }
}

function markModelLimited(agent, account, { resets_at, reason, source, observed_at, model, evidence }) {
  let applied = false
  const value = mutate(agent, account, (u) => {
    const seenMs = Date.parse(observed_at)
    const currentMs = Date.parse(u.walls?.[model]?.limited_at ?? 0) || 0
    if (Number.isFinite(seenMs) && currentMs && seenMs < currentMs) return false
    const nowS = Math.floor(Date.now() / 1000)
    let until = Number.isFinite(resets_at) && resets_at > nowS ? resets_at : null
    if (!until) {
      // this model's own bucket knows when it comes back; the account windows
      // are the fallback, exactly as they are for an account wall.
      const own = (u.buckets ?? []).find((b) => b?.model === model && Number.isFinite(b.resets_at) && b.resets_at > nowS)
      if (own) until = own.resets_at
    }
    if (!until) {
      const windows = [u.five_hour, u.seven_day].filter((w) => w && Number.isFinite(w.resets_at) && w.resets_at > nowS)
      windows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
      until = windows.length ? windows[0].resets_at : nowS + DEFAULT_LIMIT_S
    }
    u.walls = { ...(u.walls ?? {}) }
    u.walls[model] = {
      limited_until: until,
      limited_reason: reason,
      limited_at: Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : new Date().toISOString(),
      source: source ?? null,
      evidence: evidence ? String(evidence).slice(0, 300) : null,
    }
    applied = true
    return u
  })
  return { ...value, wall_applied: applied, wall_scope: 'model', wall_model: model }
}

export function clearLimited(agent, account) {
  return mutate(agent, account, (u) => { u.limited_until = null; u.limited_reason = null; u.limited_at = null; return u })
}

export function usageIsStale(u, nowMs = Date.now(), maxAgeMs = 5 * 60 * 1000) {
  const observedMs = Date.parse(u?.observed_at ?? u?.updated_at ?? 0)
  return !Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMs
}

export function isAvailable(u, nowS = Math.floor(Date.now() / 1000)) {
  return !(u.limited_until && u.limited_until > nowS)
}

// Highest used percentage across the windows we know (for warnings).
export function pressure(u) {
  const p = [u.five_hour?.pct, u.seven_day?.pct].filter((x) => Number.isFinite(x))
  return p.length ? Math.max(...p) : null
}

// Which window is closest to the wall, for the warning text.
export function hottest(u) {
  const w = [['5h', u.five_hour], ['7d', u.seven_day]].filter(([, x]) => x && Number.isFinite(x.pct))
  w.sort((a, b) => b[1].pct - a[1].pct)
  return w.length ? { window: w[0][0], ...w[0][1] } : null
}

// The chain after (agent, account): other accounts of the same agent first,
// then every other agent in the saved order. The order is an absolute priority
// list, not a rotation anchored on the current agent: an agent parked last
// stays last whichever agent the terminal started on (codex → claude → agy
// hands claude to codex, never to agy first).
// accounts: { claude: ['default', 'work'], codex: ['default'], agy: ['default'] }
// A ladder walks the same way, one RUNG at a time. A rung is a destination
// ({agent, account, model}), so `claude/opus` after `claude/fable` is a real
// move, which an order of agent names could not express. The account fallback
// the order always had is kept around each rung: a login with two accounts
// still tries its other account, and the source agent's other accounts still
// come first. `model` is only ever on a rung that names one, so a ladder
// expanded from a bare order produces exactly the objects the order did.
export function candidates({ agent, account = 'default', accounts, order = AGENTS, ladder = null, model = null }) {
  const out = []
  if (!ladder) {
    for (const a of accounts[agent] ?? ['default']) if (a !== account) out.push({ agent, account: a })
    for (const ag of order) if (ag !== agent) for (const a of accounts[ag] ?? ['default']) out.push({ agent: ag, account: a })
    return out
  }
  const seen = new Set()
  const from = { agent, account, model: model ?? null }
  const push = (r) => {
    const key = `${r.agent}--${r.account}--${r.model ?? ''}`
    if (seen.has(key)) return
    // The same login is a destination only when the rung names a DIFFERENT
    // model. Itself is not a hand-off, and neither is a rung with no model at
    // all: "claude, whatever model it defaults to" on the login that just
    // stopped is the walled model again as often as not, and Leg cannot know
    // which. This is also what the agent order did before rungs existed.
    if (r.agent === from.agent && r.account === from.account && (!r.model || r.model === from.model)) return
    seen.add(key)
    out.push({ agent: r.agent, account: r.account, ...(r.model ? { model: r.model } : {}), when: r.when ?? 'always', cost: r.cost ?? 'plan' })
  }
  for (const a of accounts[agent] ?? ['default']) if (a !== account) push({ agent, account: a, model: null })
  for (const r of ladder) {
    push(r)
    for (const a of accounts[r.agent] ?? ['default']) if (a !== r.account) push({ agent: r.agent, account: a, model: r.model ?? null, when: r.when, cost: r.cost })
  }
  return out
}

// The label a human reads for a rung: `claude/fable`, `codex`, `claude/work/opus`.
export function rungLabel(r) {
  if (!r) return 'nothing'
  return `${r.agent}${r.account && r.account !== 'default' ? '/' + r.account : ''}${r.model ? '/' + r.model : ''}`
}

// One ledger line for a rung that was passed over. Exact wording matters: this
// is what the terminal and the card say instead of going somewhere unexplained.
export function skipLine(r) {
  return `skipped ${rungLabel(r)}: ${r.reason}`
}

const COST_REASON = {
  credits: 'it spends usage credits and you have not allowed that',
  metered: 'it spends metered credits and you have not allowed that',
}

// Is this rung a destination right now, and if not, why not (B.3). One pass
// over the list, so the chooser, the board's picker and `leg ladder` all read
// the same answers and the same words.
// → [{ agent, account, model, cost, ok, reason, resets_at }]
export function evaluateLadder({
  from, list, installed = null, nowS = Math.floor(Date.now() / 1000), exclude = [],
  maySpend = false, reserve = {}, automatic = true, climbBack = 'next-handoff', ladder = null, read = readUsage,
} = {}) {
  const usageOf = new Map()
  const usage = (r) => {
    const key = `${r.agent}--${r.account}`
    if (!usageOf.has(key)) usageOf.set(key, read(r.agent, r.account))
    return usageOf.get(key)
  }
  const walled = list.map((r) => {
    const u = usage(r)
    return !isAvailable(u, nowS) || Boolean(r.model && wallActive(u.walls?.[r.model], nowS))
  })
  const rank = (r) => (ladder ?? []).findIndex((x) => x.agent === r.agent && x.account === r.account && (x.model ?? null) === (r.model ?? null))
  const fromRank = from ? rank(from) : -1
  return list.map((r, i) => {
    const u = usage(r)
    const cost = rungCost(r, u)
    const row = { agent: r.agent, account: r.account, model: r.model ?? null, cost, ok: true, reason: null, resets_at: null }
    if (installed && installed[r.agent] === false) return { ...row, ok: false, reason: 'not installed on this machine' }
    if (exclude.some((x) => x.agent === r.agent && x.account === r.account)) return { ...row, ok: false, reason: 'refused for this hand-off' }
    // The cost gate. `-p` mode bills a credits request without asking and an
    // interactive one stalls five minutes at a consent prompt nobody is there
    // to answer (B.5), so an unattended hand-off never takes one unless the
    // human turned spending on.
    if (!['free', 'plan'].includes(cost) && !maySpend) return { ...row, ok: false, reason: COST_REASON[cost] ?? `it spends ${cost} and you have not allowed that` }
    const b = binding(u, r.model ?? null)
    const sameLogin = Boolean(from && r.agent === from.agent && r.account === from.account)
    // The wasted switch: the same login as the terminal that stopped, and what
    // is out is the account's own window, which every model shares
    // (docs/en/costs). Another model here cannot help, and offering it would be
    // a lie with a button on it. Said with the account wall's own words,
    // because on this login that IS what the wall means.
    if (sameLogin && (!isAvailable(u, nowS) || (b && b.scope === 'account' && b.percent >= 100))) {
      return { ...row, ok: false, reason: 'shares the window that is out, buys nothing', resets_at: u.limited_until ?? null }
    }
    if (!isAvailable(u, nowS)) return { ...row, ok: false, reason: 'at its usage limit', resets_at: u.limited_until ?? null }
    if (r.model && wallActive(u.walls?.[r.model], nowS)) return { ...row, ok: false, reason: `the ${r.model} window is out`, resets_at: u.walls[r.model].limited_until ?? null }
    if (automatic && climbBack === 'never' && from && r.agent === from.agent && r.account === from.account && fromRank >= 0 && rank(r) >= 0 && rank(r) < fromRank) {
      return { ...row, ok: false, reason: 'climb-back is off; Back to the top rung does it by hand' }
    }
    const floor = Number(reserve?.[r.agent])
    if (Number.isFinite(floor) && b && Number.isFinite(b.percent) && b.percent > 100 - floor) {
      // A human pressing Hand off > ignores the reserve; the row still says so
      // rather than hiding, because a floor you cannot see is a floor you swear at.
      if (automatic) return { ...row, ok: false, reason: `past your ${floor}% reserve` }
      return { ...row, reason: `past your ${floor}% reserve` }
    }
    const when = r.when ?? 'always'
    if (when.startsWith('below:')) {
      const n = Number(when.slice('below:'.length))
      if (!b || !Number.isFinite(b.percent)) return { ...row, ok: false, reason: `no reading, so "below ${n}%" cannot be checked` }
      if (!(b.percent < n)) return { ...row, ok: false, reason: `at ${Math.round(b.percent)}%, not below ${n}%` }
    }
    if (when === 'walled-only') {
      const aboveOpen = list.slice(0, i).some((_, j) => !walled[j])
      if (aboveOpen) return { ...row, ok: false, reason: 'only when every rung above it is walled' }
    }
    return row
  })
}

// → { next: {agent, account} | null, out: [{agent, account, resets_at}] sorted
//     by reset, preferred_taken: bool }
// `exclude` names (agent, account) pairs this choice must skip: a destination
// the strict harness policy refused is neither available nor out, it is off
// the list for this hand-off.
// `prefer` is a human's pick from the board ("Hand off now to codex"). It wins
// over the saved order when it is installed, available and not excluded. When
// it is none of those the order decides instead and `preferred_taken` is false,
// which is what the session event says: a pick made a minute ago must not leave
// a terminal stopped because that account walled in the meantime.
export function chooseNext({
  agent, account, accounts, installed, order = AGENTS, nowS = Math.floor(Date.now() / 1000), exclude = [], prefer = null,
  ladder = null, model = null, maySpend = false, reserve = {}, automatic = null, climbBack = 'next-handoff',
}) {
  const out = []
  if (ladder) {
    // The ladder walk. `reasons` carries one line per rung that was passed
    // over, so the ledger and the picker can say what was skipped and why
    // instead of a terminal turning up somewhere unexplained.
    const reasons = []
    const list = candidates({ agent, account, accounts, order, ladder, model })
    const auto = automatic === null ? !prefer : automatic
    const rows = evaluateLadder({ from: { agent, account, model: model ?? null }, list, installed, nowS, exclude, maySpend, reserve, automatic: auto, climbBack, ladder })
    const trim = (r) => ({ agent: r.agent, account: r.account, ...(r.model ? { model: r.model } : {}) })
    const noteOut = (r) => { if (Number.isFinite(r.resets_at) && !out.some((x) => x.agent === r.agent && x.account === r.account)) out.push({ agent: r.agent, account: r.account, resets_at: r.resets_at, reason: r.reason }) }
    if (prefer) {
      const want = { agent: prefer.agent, account: prefer.account ?? 'default', model: prefer.model ?? null }
      const hit = rows.find((r) => r.agent === want.agent && r.account === want.account && (want.model ? r.model === want.model : true))
      if (hit && hit.ok) return { next: trim(hit), out, reasons, preferred_taken: true }
    }
    for (const r of rows) {
      if (r.ok) return { next: trim(r), out, reasons, preferred_taken: false }
      reasons.push({ agent: r.agent, account: r.account, model: r.model, reason: r.reason })
      noteOut(r)
    }
    out.sort((a, b) => (a.resets_at ?? Infinity) - (b.resets_at ?? Infinity))
    return { next: null, out, reasons, preferred_taken: false }
  }
  const list = candidates({ agent, account, accounts, order })
  const eligible = (c) => {
    if (installed && installed[c.agent] === false) return false
    if (exclude.some((x) => x.agent === c.agent && x.account === c.account)) return false
    return isAvailable(readUsage(c.agent, c.account), nowS)
  }
  if (prefer) {
    const hit = list.find((c) => c.agent === prefer.agent && c.account === (prefer.account ?? 'default'))
    if (hit && eligible(hit)) return { next: hit, out, reasons: [], preferred_taken: true }
  }
  for (const c of list) {
    if (installed && installed[c.agent] === false) continue
    if (exclude.some((x) => x.agent === c.agent && x.account === c.account)) continue
    const u = readUsage(c.agent, c.account)
    if (isAvailable(u, nowS)) return { next: c, out, reasons: [], preferred_taken: false }
    out.push({ ...c, resets_at: u.limited_until, reason: u.limited_reason })
  }
  out.sort((a, b) => (a.resets_at ?? Infinity) - (b.resets_at ?? Infinity))
  return { next: null, out, reasons: [], preferred_taken: false }
}

export function fmtReset(epochS) {
  if (!Number.isFinite(epochS)) return 'unknown'
  const d = new Date(epochS * 1000)
  const mins = Math.round((epochS * 1000 - Date.now()) / 60000)
  const rel = mins < 60 ? `${Math.max(0, mins)}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${Math.floor(mins / 1440)}d`
  return `${d.toLocaleString()} (in ${rel})`
}
