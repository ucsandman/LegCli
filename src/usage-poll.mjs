// usage polling: one poller per LOGIN, living in the board process.
//
// Why here and not in the terminal: every attached terminal used to ask its
// agent's usage endpoint once a minute (src/attach.mjs). Three claude
// terminals on one login, next to Claude Code's own polling, drew a 429 every
// other minute, and each failure wrote a session event, so the timeline read as
// a wall of rate-limit payloads. A login has ONE poller now, wherever its
// terminals are, and what it reads is pushed onto every active session of that
// login exactly as the terminal used to write it.
//
// Backoff is per login: an answer that is not usable doubles the wait up to
// USAGE_POLL_MAX_MS, and the first usable one puts it straight back to the base
// interval. The failure is recorded ONCE, on the usage record (`error`,
// `error_since`, src/usage.mjs), with one status event on that login's
// sessions when it starts and one when it ends.
//
// What stays in the terminal: anything measured from that terminal's own files
// (the codex rollout scan, the transcript's model line). Only the per-login
// endpoint reads moved here.
import { LAYOUT, readAccounts, envFor } from './accounts.mjs'
import { listSessions, isActive, updateSession, appendEvent } from './sessions.mjs'
import { recordUsage, noteUsageError } from './usage.mjs'
import { fetchClaudeUsage } from './taps/claude-usage.mjs'
import { fetchGrokUsage } from './taps/grok.mjs'
import { readCodexUsage } from './taps/codex.mjs'

// The interval is a knob a human types, so it arrives as "5m", "60_000" or
// "60 000" as readily as a number. Number() turns all three into NaN, every
// timer was then armed with NaN, Node rounds that to 1ms, and the board asked
// the usage endpoint about a thousand times a second per login — with a backoff
// that could never rescue it, because Math.max(NaN, delay) * 2 is NaN too.
// A value Leg cannot read is the default; a value under the floor is the floor,
// because no reading of a plan's percentages is worth a request every second.
export const USAGE_POLL_FLOOR_MS = 5000

export function clampPollMs(raw, fallback, floorMs = USAGE_POLL_FLOOR_MS) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(floorMs, n)
}

const rawInterval = process.env.LEG_USAGE_POLL_MS || process.env.BATON_USAGE_POLL_MS
const rawMax = process.env.LEG_USAGE_POLL_MAX_MS || process.env.BATON_USAGE_POLL_MAX_MS
export const USAGE_POLL_MS = clampPollMs(rawInterval, 60000)
export const USAGE_POLL_MAX_MS = clampPollMs(rawMax, 10 * 60 * 1000, USAGE_POLL_MS)

// A knob that was typed and not used says so once on the board's log: silence
// there is how a user learns nothing, and keeps typing "5m".
const unread = (name, raw, used) => (raw === undefined || raw === null || raw === '' || (Number.isFinite(Number(raw)) && Number(raw) > 0)
  ? null
  : `${name}=${String(raw).slice(0, 40)} is not a number of milliseconds; reading usage every ${used}ms instead`)
export const USAGE_POLL_NOTES = [
  unread('LEG_USAGE_POLL_MS', rawInterval, USAGE_POLL_MS),
  unread('LEG_USAGE_POLL_MAX_MS', rawMax, USAGE_POLL_MAX_MS),
].filter(Boolean)
const said = new Set()

export const USAGE_AGENTS = ['claude', 'codex', 'grok']

// The wording on the card and in the record: one name per reading source, the
// same strings the terminals wrote before this moved.
const SOURCE = {
  claude: 'claude usage endpoint',
  codex: 'codex app-server account/rateLimits/read',
  grok: 'grok billing proxy',
}

// "9:03 AM": the time a human reads on a card, not an ISO stamp.
export function clockTime(iso) {
  const ms = Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return 'just now'
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function configDirFor(agent, account) {
  const l = LAYOUT[agent]
  if (!l) return null
  return (l.env ? envFor(agent, account)[l.env] : null) || l.home()
}

// One reading for one login → { ok, error } or { ok: true, patch }, where the
// patch is what every active session of that login gets.
// `halted` is the answer when the board stopped while the endpoint was still
// thinking: the reading is thrown away rather than recorded, because every
// write it would make (the usage record, a session's percentages, a line on a
// timeline, an SSE push) belongs to a board that no longer exists.
async function readLogin(agent, account, { read, timeoutMs, signal, stopped = () => false }) {
  const configDir = configDirFor(agent, account)
  if (agent === 'codex') {
    const r = await read.codex({ codexHome: configDir, timeoutMs, signal })
    if (stopped()) return { halted: true }
    if (!r.ok) return { ok: false, error: r.error ?? 'the codex app server answered with no rate limits' }
    const u = recordUsage('codex', account, { ...r.limits, facts: r.facts }, SOURCE.codex, { observed_at: r.observed_at, available: r.available })
    const patch = { limits: r.limits, usage_source: SOURCE.codex }
    // an explicit "ordinary usage is unavailable" is the wall itself, and the
    // terminal hands off on it (src/attach.mjs reads status from the record)
    if (r.available === false) {
      patch.status = 'limit'
      patch.limit = { reason: 'usage_limit_exceeded', detail: 'Codex reports ordinary usage is unavailable', resets_at: u.limited_until, at: r.observed_at ?? new Date().toISOString() }
    }
    return { ok: true, patch }
  }
  const r = agent === 'claude'
    ? await read.claude({ configDir, timeoutMs })
    : await read.grok({ configDir, timeoutMs })
  // neither reader takes an AbortSignal, so the wait is not cut short by stop();
  // what it must not do is come back and write
  if (stopped()) return { halted: true }
  const usable = r.ok && r.limits && (r.limits.five_hour || r.limits.seven_day)
  if (!usable) return { ok: false, error: r.error ?? 'the usage endpoint answered with no window' }
  recordUsage(agent, account, r.limits, SOURCE[agent])
  // the session record keeps the two windows it always had: the buckets live on
  // the usage record, which is per login and not per terminal
  const limits = agent === 'claude' ? { five_hour: r.limits.five_hour, seven_day: r.limits.seven_day } : r.limits
  return { ok: true, patch: { limits, usage_source: SOURCE[agent] } }
}

// → { start, stop, pollNow, delayOf, logins }
// `schedule`/`cancel` are seams: a test drives the clock by hand instead of
// waiting minutes for a backoff to prove itself.
export function createUsagePollers({
  agents = USAGE_AGENTS,
  fetchers = {},
  intervalMs = USAGE_POLL_MS,
  maxMs = USAGE_POLL_MAX_MS,
  timeoutMs = 8000,
  onChange = () => {},
  onLog = () => {},
  accounts = readAccounts,
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  cancel = (t) => clearTimeout(t),
} = {}) {
  const read = { claude: fetchClaudeUsage, grok: fetchGrokUsage, codex: readCodexUsage, ...fetchers }
  const state = new Map()
  let stopped = false
  let controller = new AbortController()

  const key = (agent, account) => `${agent}--${account}`
  function slot(agent, account) {
    const k = key(agent, account)
    if (!state.has(k)) state.set(k, { agent, account, delay: intervalMs, timer: null, inFlight: null })
    return state.get(k)
  }

  function sessionsOf(agent, account) {
    try { return listSessions().filter((s) => s && s.agent === agent && s.account === account && isActive(s)) } catch { return [] }
  }

  // Write to one terminal of this login. The leg can hand off between the read
  // and the write, so the patch is applied inside the record's own lock and
  // only while the record still names this login: claude's percentages, and
  // claude's failure line, must never follow codex onto the card. The event is
  // written after, and only if the patch was the right terminal's.
  function pushToSession(id, agent, account, patch, event) {
    const next = updateSession(id, (cur) => (cur.agent === agent && cur.account === account && isActive(cur) ? patch : {}))
    if (event && next && next.agent === agent && next.account === account) appendEvent(id, event)
    return next
  }

  // One reading, then the fan-out. Single-flight per login: a slow endpoint
  // never stacks two requests on one login, whatever the timer does.
  function tick(agent, account) {
    const st = slot(agent, account)
    if (st.inFlight) return st.inFlight
    const run = (async () => {
      let r
      try {
        r = await readLogin(agent, account, { read, timeoutMs, signal: controller.signal, stopped: () => stopped })
      } catch (err) {
        r = { ok: false, error: String(err?.message ?? err).slice(0, 200) }
      }
      // stop() means stop: a reading that lands after the board has gone is
      // dropped whole, so nothing is written and onChange never fires into a
      // closed SSE hub.
      if (stopped || r.halted) return { ok: Boolean(r.ok), changed: false }
      let changed = false
      if (r.ok) {
        const cleared = noteUsageError(agent, account, null)
        const event = cleared.changed ? { type: 'status', summary: `${agent} usage is back` } : null
        for (const s of sessionsOf(agent, account)) pushToSession(s.session_id, agent, account, { ...r.patch, usage_error: null }, event)
        changed = true
      } else {
        // The failure is the RECORD's, and the timeline hears about it once:
        // the event is written on the transition alone, so a long outage is one
        // line and not one line per refusal.
        //
        // The CARD is a different question. A reason that changes mid-outage
        // (logged out, then a stale token answering 401) left every card naming
        // the first cause for the rest of the outage, sending the user to fix
        // something already fixed. The text is pushed whenever it differs from
        // what the row carries; the event stays null, so the timeline is still
        // one line per outage while the card stays truthful.
        const noted = noteUsageError(agent, account, r.error)
        const event = noted.changed ? { type: 'status', summary: `${agent} usage unavailable since ${clockTime(noted.error_since)}: ${r.error}` } : null
        for (const s of sessionsOf(agent, account)) {
          if (noted.changed || s.usage_error !== noted.error) pushToSession(s.session_id, agent, account, { usage_error: noted.error }, event)
        }
        changed = noted.changed
        if (noted.changed) onLog(`${agent}/${account} usage: ${r.error}`)
      }
      st.delay = r.ok ? intervalMs : Math.min(maxMs, Math.max(intervalMs, st.delay) * 2)
      return { ...r, changed }
    })()
    st.inFlight = run.finally(() => { st.inFlight = null })
    return st.inFlight
  }

  function arm(agent, account) {
    if (stopped) return
    const st = slot(agent, account)
    if (st.timer) return
    st.timer = schedule(() => { st.timer = null; return cycle(agent, account) }, st.delay)
  }

  // A login added while the board is up (leg account add) starts polling on the
  // next round rather than on the next restart.
  function adopt(agent) {
    if (stopped) return
    for (const account of accounts()[agent] ?? ['default']) if (!state.has(key(agent, account))) cycle(agent, account)
  }

  async function cycle(agent, account) {
    let r = null
    try {
      r = await tick(agent, account)
      if (r?.changed) onChange()
    } catch (err) {
      onLog(`${agent}/${account} usage poll: ${err.message}`)
    }
    adopt(agent)
    arm(agent, account)
    return r
  }

  return {
    // → a promise for the FIRST round, so a caller (or a test) can wait for one
    // complete reading of every login without knowing the timer.
    start() {
      stopped = false
      controller = new AbortController()
      for (const note of USAGE_POLL_NOTES) if (!said.has(note)) { said.add(note); onLog(note) }
      const acc = accounts()
      const first = []
      for (const agent of agents) for (const account of acc[agent] ?? ['default']) first.push(cycle(agent, account))
      return Promise.all(first)
    },
    stop() {
      stopped = true
      for (const st of state.values()) { if (st.timer) cancel(st.timer); st.timer = null }
      try { controller.abort() } catch {}
      state.clear()
    },
    pollNow: (agent, account = 'default') => cycle(agent, account),
    delayOf: (agent, account = 'default') => state.get(key(agent, account))?.delay ?? null,
    logins: () => [...state.values()].map((s) => ({ agent: s.agent, account: s.account, delay: s.delay })),
  }
}
