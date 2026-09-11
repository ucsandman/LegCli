// usage — per (agent, account) limit state and the handoff chooser.
// $BATON_HOME/usage/<agent>--<account>.json:
//   { agent, account, five_hour: {pct, resets_at}|null, seven_day: {...}|null,
//     limited_until: epoch-seconds|null, limited_reason, source, updated_at }
// Sources: claude statusline JSON (rate_limits.*) and StopFailure rate_limit;
// codex rollout token_count.rate_limits (primary=5h, secondary=7d) and the
// usage-limit error; agy only the wall itself (no percent exposed).
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'
import { AGENTS } from './sessions.mjs'

export const WARN_PCT = Number(process.env.BATON_WARN_PCT || 85)
// A limit hit with no reset time from the agent: assume the 5-hour window.
const DEFAULT_LIMIT_S = 5 * 3600

export function usageDir() { return join(home(), 'usage') }
export function usageFile(agent, account = 'default') { return join(usageDir(), `${agent}--${account}.json`) }

export function readUsage(agent, account = 'default') {
  const f = usageFile(agent, account)
  if (!existsSync(f)) return { agent, account, five_hour: null, seven_day: null, limited_until: null, limited_reason: null, source: null, updated_at: null }
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return { agent, account, five_hour: null, seven_day: null, limited_until: null, limited_reason: null, source: null, updated_at: null } }
}

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
    const out = fn(u) ?? u
    write(out)
    return out
  })
}

// windows: { five_hour: {pct, resets_at}|null, seven_day: ... }
export function recordUsage(agent, account, windows, source) {
  return mutate(agent, account, (u) => {
    if (windows.five_hour !== undefined) u.five_hour = windows.five_hour
    if (windows.seven_day !== undefined) u.seven_day = windows.seven_day
    u.source = source
    // A window that has reset clears an old wall.
    const nowS = Math.floor(Date.now() / 1000)
    if (u.limited_until && u.limited_until <= nowS) { u.limited_until = null; u.limited_reason = null }
    return u
  })
}

export function markLimited(agent, account, { resets_at = null, reason = 'limit', source } = {}) {
  return mutate(agent, account, (u) => {
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
    if (source) u.source = source
    return u
  })
}

export function clearLimited(agent, account) {
  return mutate(agent, account, (u) => { u.limited_until = null; u.limited_reason = null; return u })
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
// then the next agents in order, wrapping so every option is tried once.
// accounts: { claude: ['default', 'work'], codex: ['default'], agy: ['default'] }
export function candidates({ agent, account = 'default', accounts, order = AGENTS }) {
  const out = []
  for (const a of accounts[agent] ?? ['default']) if (a !== account) out.push({ agent, account: a })
  const i = order.indexOf(agent)
  const rest = i === -1 ? order : [...order.slice(i + 1), ...order.slice(0, i)]
  for (const ag of rest) for (const a of accounts[ag] ?? ['default']) out.push({ agent: ag, account: a })
  return out
}

// → { next: {agent, account} | null, out: [{agent, account, resets_at}] sorted by reset }
export function chooseNext({ agent, account, accounts, installed, order = AGENTS, nowS = Math.floor(Date.now() / 1000) }) {
  const out = []
  for (const c of candidates({ agent, account, accounts, order })) {
    if (installed && installed[c.agent] === false) continue
    const u = readUsage(c.agent, c.account)
    if (isAvailable(u, nowS)) return { next: c, out }
    out.push({ ...c, resets_at: u.limited_until, reason: u.limited_reason })
  }
  out.sort((a, b) => (a.resets_at ?? Infinity) - (b.resets_at ?? Infinity))
  return { next: null, out }
}

export function fmtReset(epochS) {
  if (!Number.isFinite(epochS)) return 'unknown'
  const d = new Date(epochS * 1000)
  const mins = Math.round((epochS * 1000 - Date.now()) / 60000)
  const rel = mins < 60 ? `${Math.max(0, mins)}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${Math.floor(mins / 1440)}d`
  return `${d.toLocaleString()} (in ${rel})`
}
