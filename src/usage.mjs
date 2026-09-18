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
import { ACCOUNT_NAME_RE } from './accounts.mjs'
import { rungCost, staticCost } from './preferences.mjs'

export const WARN_PCT = Number((process.env.LEG_WARN_PCT || process.env.BATON_WARN_PCT) || 85)
// A limit hit with no reset time from the agent: assume the 5-hour window.
const DEFAULT_LIMIT_S = 5 * 3600

export function usageDir() { return join(home(), 'usage') }
// The file name is built from two names, so both are names: `claude--<account>`
// with `../../..` in it resolves to a fully chosen path with a .json suffix,
// written by every recordUsage and markLimited call. A rung's account is
// validated where it is saved (src/preferences.mjs); this is the second latch.
export function usageFile(agent, account = 'default') {
  if (!ACCOUNT_NAME_RE.test(String(agent ?? ''))) throw new TypeError(`invalid agent name "${agent}"`)
  if (!ACCOUNT_NAME_RE.test(String(account ?? ''))) throw new TypeError(`invalid account name "${account}"`)
  return join(usageDir(), `${agent}--${account}.json`)
}

export function readUsage(agent, account = 'default') {
  const f = usageFile(agent, account)
  if (!existsSync(f)) return emptyUsage(agent, account)
  try { return { ...emptyUsage(agent, account), ...JSON.parse(readFileSync(f, 'utf8')) } } catch { return emptyUsage(agent, account) }
}

function emptyUsage(agent, account) {
  return { agent, account, five_hour: null, seven_day: null, limited_until: null, limited_reason: null, limited_at: null, source: null, observed_at: null, available_at: null, updated_at: null, buckets: [], walls: {}, history: {}, extra_usage: null, facts: null, error: null, error_since: null }
}

// The READING's health, which is not the login's health: a 429 from the usage
// endpoint says nothing about how much of the plan is left, so it never touches
// the windows, the buckets or a wall. It is written once — `error_since` keeps
// the moment it started — and cleared by the first reading that works, so the
// board can say "unavailable since 9:03 AM" instead of one line per failed
// poll (src/usage-poll.mjs).
// → { error, error_since, changed } — `changed` is the transition only, which
// is what decides whether a session event is worth writing.
export function noteUsageError(agent, account, error, { at = new Date().toISOString() } = {}) {
  let changed = false
  const value = mutate(agent, account, (u) => {
    if (!error) {
      if (!u.error && !u.error_since) return false
      u.error = null
      u.error_since = null
      changed = true
      return u
    }
    const why = String(error).slice(0, 300)
    if (u.error) {
      if (u.error === why) return false
      u.error = why
      return u
    }
    u.error = why
    u.error_since = at
    changed = true
    return u
  })
  return { error: value.error ?? null, error_since: value.error_since ?? null, changed }
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
      if (windows.buckets.length) {
        u.history = recordHistory(u.history ?? {}, u.buckets ?? [], windows.buckets, atS)
        u.buckets = windows.buckets
      } else {
        // An empty list is no information, not "this login has no buckets": an
        // older endpoint answers the two windows and no `limits` key at all
        // (src/taps/claude-usage.mjs), and erasing the measured buckets on it
        // loses the wall clock, the ring and the binding bucket in one write.
        // The one thing an empty reading does settle is a window that has run
        // out: a bucket whose reset has passed is dropped rather than kept.
        const kept = (u.buckets ?? []).filter((b) => !(Number.isFinite(b?.resets_at) && b.resets_at <= atS))
        for (const b of u.buckets ?? []) if (!kept.includes(b)) delete u.history?.[bucketKey(b)]
        u.buckets = kept
      }
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

// One ring per bucket, capped by TIME first and by HISTORY_MAX second: a new
// entry at most once per HISTORY_MIN_GAP_S, and never one older than the
// window it was measured in. A window that has reset starts its ring again: a
// rate computed across a reset is a wrong number, and a wrong number is worse
// than none.
//
// Why time and not writes: every attached terminal runs its own poller against
// the same per-login record, so three terminals write three times as often. A
// ring capped only by count then spans a third of the wall clock, falls under
// the 10-minute burn gate, and the forecast disappears from exactly the login
// the board's headline is about.
//
// The "only when it changed" rule is about NOISE (a status line writing the
// same 63 every second fills a 24-entry ring in half a minute), not about
// starving the forecast: a percentage that holds for an hour is a measured
// zero rate, and a ring that refuses to record it can never say so. One sample
// per ten minutes while the figure holds keeps both facts.
export const HISTORY_FLAT_S = 10 * 60
export const HISTORY_MIN_GAP_S = 60
// How long a bucket's own window runs, which is how far back its ring may
// reach. Weekly buckets run seven days; a session (5-hour) window runs five.
const WEEK_S = 7 * 24 * 3600
function windowLength(b) {
  if (b?.group === 'weekly' || String(b?.kind ?? '').startsWith('weekly')) return WEEK_S
  return DEFAULT_LIMIT_S
}
function recordHistory(history, oldBuckets, newBuckets, atS) {
  const out = { ...history }
  const before = new Map((oldBuckets ?? []).map((b) => [bucketKey(b), b]))
  for (const b of newBuckets) {
    if (!Number.isFinite(b?.percent)) continue
    const key = bucketKey(b)
    const prev = before.get(key)
    const resets = b.resets_at ?? null
    let ring = out[key] ?? []
    // The window a ring belongs to is remembered ON the ring, not derived from
    // the previous write: a bucket that was missing from one reading has no
    // `prev`, and deriving it there carried the old window's samples into the
    // new one and printed a forecast twice as long as the truth.
    const lastWindow = ring.length ? ring[ring.length - 1].resets_at : undefined
    const moved = lastWindow !== undefined ? lastWindow !== resets : Boolean(prev && prev.resets_at !== resets)
    if (moved) ring = []
    const last = ring.at(-1)
    if (last && Number.isFinite(last.at)) {
      const held = last.percent === b.percent
      if (atS - last.at < (held ? HISTORY_FLAT_S : HISTORY_MIN_GAP_S)) { out[key] = ring; continue }
    }
    const maxAge = windowLength(b)
    out[key] = [...ring, { percent: b.percent, at: atS, resets_at: resets }]
      .filter((e) => Number.isFinite(e.at) && atS - e.at <= maxAge)
      .slice(-HISTORY_MAX)
  }
  return out
}

// The forecast (spec A.5 row 4, E rule 6): how long the bucket behind `key`
// lasts at the rate its own ring has been measured moving.
//
// The gate is 3 samples spanning 10 minutes, and it is the point of the whole
// function: a slope drawn through two readings a minute apart is a guess, and
// this number is printed in the largest type on the page. Every sample is
// inside the window that is running now, because the ring is emptied whenever
// `resets_at` moves.
//
// Endpoint slope, not least squares: the series is a counter that only rises,
// the two ends are what a human would draw through it, and the sentence that
// explains it ("from 9 samples over 4h") is the truth about it rather than a
// description of a fit nobody can check.
// → { seconds_left, samples, span_s, rate_pct_per_h } | null
export const BURN_MIN_SAMPLES = 3
export const BURN_MIN_SPAN_S = 10 * 60
export function burn(u, key, nowS = Math.floor(Date.now() / 1000)) {
  const bucket = (Array.isArray(u?.buckets) ? u.buckets : []).find((x) => x && bucketKey(x) === key)
  const ring = (Array.isArray(u?.history?.[key]) ? u.history[key] : [])
    .filter((e) => e && Number.isFinite(e.percent) && Number.isFinite(e.at))
    // a sample that names a different window than the bucket now standing is
    // not part of this rate, whoever wrote it (an older record names none)
    .filter((e) => e.resets_at === undefined || !bucket || e.resets_at === (bucket.resets_at ?? null))
  if (ring.length < BURN_MIN_SAMPLES) return null
  const first = ring[0]
  const last = ring[ring.length - 1]
  const span = last.at - first.at
  if (span < BURN_MIN_SPAN_S) return null
  const rate = (last.percent - first.percent) / span
  // A flat line is a measured zero: real, and not a time. A falling percentage
  // inside one window is a data error, not a refund, and a negative rate would
  // print a time running backwards.
  if (!(rate > 0)) return null
  const resets = Number.isFinite(bucket?.resets_at) ? bucket.resets_at : null
  // Never extrapolate across a reset. Past `resets_at` the percentage belongs
  // to a window this rate says nothing about, so the time is capped there; a
  // reset already behind us means the ring is waiting to be cleared by the next
  // reading, and until it arrives there is no forecast at all.
  if (resets !== null && resets <= nowS) return null
  const toWall = (100 - last.percent) / rate
  return {
    seconds_left: Math.max(0, resets === null ? toWall : Math.min(toWall, resets - nowS)),
    samples: ring.length,
    span_s: span,
    rate_pct_per_h: rate * 3600,
  }
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
// → { kind, model, percent, resets_at, scope: 'model'|'account', forecast } | null
// `scope` is what decides whether another model on the same login can help.
// `forecast` is burn() for that same bucket, null whenever the sample gate
// fails, and it rides this object everywhere the binding bucket already goes
// (src/server.mjs puts it on each session as `capacity`), so the time figure on
// the board costs no second endpoint.
export function binding(u, model = null, nowS = Math.floor(Date.now() / 1000)) {
  const buckets = Array.isArray(u?.buckets) ? u.buckets.filter((b) => b && Number.isFinite(b.percent)) : []
  const pick = (list) => (list.length ? [...list].sort((a, b) => b.percent - a.percent)[0] : null)
  const want = model ? String(model).toLowerCase() : null
  // The active row answers for the model that was asked about, never for
  // another one: a fable row at 100% is not the sonnet rung's percentage, and
  // judging sonnet by it skips the whole downshift ladder (B.5). An
  // account-scoped active row carries no model, so it still wins for every one.
  const b = pick(buckets.filter((x) => x.is_active && (!want || !x.model || x.model === want)))
    ?? (want ? pick(buckets.filter((x) => x.model === want)) : null)
    ?? pick(buckets.filter((x) => x.kind === 'weekly_all'))
    ?? pick(buckets.filter((x) => x.kind === 'session'))
  if (b) return { kind: b.kind, model: b.model ?? null, percent: b.percent, resets_at: b.resets_at ?? null, scope: b.model ? 'model' : 'account', forecast: burn(u, bucketKey(b), nowS) }
  const h = hottest(u ?? {})
  if (!h) return null
  // the legacy path: a record with no `buckets` has no ring under either window
  // key either, so burn() answers null and the percentage stands alone.
  return { kind: h.window === '5h' ? 'five_hour' : 'seven_day', model: null, percent: h.pct, resets_at: h.resets_at ?? null, scope: 'account', forecast: null }
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
      // No bucket of its own: date it from the WEEKLY window, not the hottest
      // one. Every wording that reaches here is a per-model limit, and a
      // per-model limit is a weekly bucket (B.1, docs/en/costs). The account
      // path's highest-used heuristic inverts for a model: the 5-hour window
      // churns past 80% several times a day, so it would hand fable back in
      // twelve minutes and re-wall it every few minutes for the rest of the week.
      const weekly = (u.buckets ?? []).find((b) => String(b?.kind ?? '').startsWith('weekly') && Number.isFinite(b.resets_at) && b.resets_at > nowS)
      if (u.seven_day && Number.isFinite(u.seven_day.resets_at) && u.seven_day.resets_at > nowS) until = u.seven_day.resets_at
      else if (weekly) until = weekly.resets_at
      else if (u.five_hour && Number.isFinite(u.five_hour.resets_at) && u.five_hour.resets_at > nowS) until = u.five_hour.resets_at
      else until = nowS + DEFAULT_LIMIT_S
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
    out.push({ agent: r.agent, account: r.account, ...(r.model ? { model: r.model } : {}), when: r.when ?? 'always', cost: r.cost ?? staticCost(r.agent) })
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
  // What `walled-only` means by "walled": a rung above that could not take this
  // hand-off in the next minute either way. The account wall and the model wall
  // are the walls themselves; a bucket at 100% is at its limit with or without
  // a recorded wall; and a rung that is not installed on this machine, or that
  // the strict harness policy refused for this hand-off, is not an open rung
  // above by any reading. The cost gate is deliberately NOT in this list: a
  // rung the human could take by allowing spending is a rung that is open.
  const walled = list.map((r) => {
    const u = usage(r)
    if (!isAvailable(u, nowS)) return true
    if (r.model && wallActive(u.walls?.[r.model], nowS)) return true
    if (installed && installed[r.agent] === false) return true
    if (exclude.some((x) => x.agent === r.agent && x.account === r.account)) return true
    const b = binding(u, r.model ?? null, nowS)
    return Boolean(b && Number.isFinite(b.percent) && b.percent >= 100)
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
    // Only a caller that says nothing at all falls back to the old inference.
    // "No destination named" is NOT "nobody asked": the plain Hand off now
    // button sends no target, and reading that as automatic applied the reserve
    // and the cost gate to a hand-off a human had just pressed (B.3).
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
