// claude usage — the 5h / 7d percentages for a Claude Code login, from the
// same endpoint Claude Code's own /usage and built-in status line read.
// Why not the status line: Claude Code 2.1.268 and 2.1.278 render their
// built-in status line and do not run a custom `statusLine` command passed
// via --settings or a project settings file (verified 2026-09-11 and
// 2026-09-19 with an `echo` command at both levels; hooks from the same
// --settings file do run). So Leg asks the
// usage endpoint directly with the OAuth token Claude Code stored at login.
// The token is read by this process only, sent only to api.anthropic.com,
// and never written anywhere (the ledger scrubs bearer tokens regardless).
// Native https, not fetch: Node 24 on Windows can crash at exit with an open
// fetch (test/lessons.test.mjs no-global-fetch).
import https from 'node:https'
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT } from '../accounts.mjs'
import { MODEL_ALIASES } from '../buckets.mjs'

export const USAGE_URL = (process.env.LEG_CLAUDE_USAGE_URL || process.env.BATON_CLAUDE_USAGE_URL) || 'https://api.anthropic.com/api/oauth/usage'

function readToken(configDir) {
  const f = join(configDir, '.credentials.json')
  if (!existsSync(f)) return null
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const o = j.claudeAiOauth ?? j.oauth ?? null
    if (!o?.accessToken) return null
    return { token: o.accessToken, expired: Boolean(o.expiresAt && Date.now() > o.expiresAt) }
  } catch { return null }
}

function window(x) {
  if (!x || typeof x !== 'object') return null
  const pct = Number(x.utilization ?? x.used_percentage ?? x.used_percent)
  if (!Number.isFinite(pct)) return null
  let resets = x.resets_at ?? x.resetsAt ?? null
  if (typeof resets === 'string') { const t = Date.parse(resets); resets = Number.isFinite(t) ? Math.floor(t / 1000) : null }
  return { pct, resets_at: resets }
}

function epoch(x) {
  if (x === null || x === undefined) return null
  if (typeof x === 'number') return Number.isFinite(x) ? Math.floor(x > 1e12 ? x / 1000 : x) : null
  const t = Date.parse(x)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

// The model a limit row is scoped to, lowercased, or null when the row is an
// account-wide bucket. The endpoint is undocumented, so the scope is read by
// shape (a `model` object carrying a display name) rather than by a type word.
// A display name carries a version the rest of Leg never says ("Fable 5.1",
// "Claude Opus 5"), and every other model name in the system is an alias: the
// walls (src/buckets.mjs), the rungs (src/preferences.mjs) and the board all
// join on one. So the name is matched word by word against the alias list and
// the alias is what is stored; a name Leg does not know keeps its own
// lowercased text, because inventing a model is worse than printing an unknown
// one.
function scopeModel(scope) {
  const name = scope?.model?.display_name ?? scope?.model?.displayName ?? null
  if (typeof name !== 'string' || !name.trim()) return null
  const raw = name.trim().toLowerCase()
  for (const alias of MODEL_ALIASES.claude) {
    if (raw.split(/[^a-z0-9]+/).includes(alias)) return alias
  }
  return raw
}

function groupOf(kind) {
  const k = String(kind ?? '')
  if (k.startsWith('weekly')) return 'weekly'
  if (k.startsWith('session') || k.startsWith('five_hour')) return 'session'
  if (k.startsWith('spend') || k.startsWith('extra')) return 'spend'
  return k || 'unknown'
}

// One `limits[]` row → a bucket. Percentages only: what a row *means* (whether
// a model switch helps) is decided in src/buckets.mjs from the wall wording,
// never from a number.
export function bucketOf(x) {
  if (!x || typeof x !== 'object') return null
  const kind = x.type ?? x.kind ?? x.name ?? null
  if (!kind) return null
  const percent = Number(x.utilization ?? x.used_percentage ?? x.used_percent ?? x.percent)
  if (!Number.isFinite(percent)) return null
  return {
    kind: String(kind),
    group: groupOf(kind),
    model: scopeModel(x.scope),
    percent,
    resets_at: epoch(x.resets_at ?? x.resetsAt ?? null),
    is_active: Boolean(x.is_active ?? x.isActive ?? false),
    severity: typeof x.severity === 'string' ? x.severity : 'normal',
  }
}

export function bucketsFrom(j) {
  if (!Array.isArray(j?.limits)) return []
  return j.limits.map(bucketOf).filter(Boolean)
}

// `extra_usage` / `spend`, the two sentences the capacity drawer prints. Only
// the fields that exist are carried; the eighteen codename keys the payload
// also holds (tangelo, iguana_necktie, ...) are never read.
export function extraUsageFrom(j) {
  const e = j?.extra_usage
  const s = j?.spend
  if ((!e || typeof e !== 'object') && (!s || typeof s !== 'object')) return null
  const out = {}
  const enabled = e?.is_enabled ?? e?.enabled
  if (typeof enabled === 'boolean') out.enabled = enabled
  const reason = e?.disabled_reason ?? e?.reason
  if (typeof reason === 'string') out.reason = reason
  const canToggle = s?.can_toggle ?? e?.can_toggle
  if (typeof canToggle === 'boolean') out.can_toggle = canToggle
  const limitMinor = Number(e?.monthly_limit ?? e?.limit ?? s?.monthly_limit)
  if (Number.isFinite(limitMinor)) out.limit_minor = limitMinor
  const usedMinor = Number(e?.monthly_used ?? e?.used ?? s?.monthly_used ?? s?.used)
  if (Number.isFinite(usedMinor)) out.used_minor = usedMinor
  return Object.keys(out).length ? out : null
}

// What a failing answer is allowed to say: the status code and the `type` the
// body names ('rate_limit_error'), never the body itself. A login shared by
// several terminals answers 429 often, and the whole JSON on every one of them
// turned the terminal's timeline into a wall of payloads.
function errorType(text) {
  try {
    const j = JSON.parse(text)
    const t = j?.error?.type ?? j?.type
    return typeof t === 'string' && t && t !== 'error' ? t : null
  } catch { return null }
}

function getJson(url, headers, timeoutMs) {
  return new Promise((resolvePromise) => {
    const u = new URL(url)
    // http only for a local test double through BATON_CLAUDE_USAGE_URL
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request({ host: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { d += c })
      res.on('end', () => resolvePromise({ status: res.statusCode, text: d }))
    })
    req.on('timeout', () => { req.destroy(new Error('usage endpoint timed out')) })
    req.on('error', (err) => resolvePromise({ status: 0, text: '', error: err.message }))
    req.end()
  })
}

// → { ok, limits: {five_hour, seven_day, buckets, extra_usage}|null, status, error, expired }
// The two windows keep their shape and their place: every older reader of this
// function still gets exactly what it got before. `buckets` is OMITTED when the
// payload has no `limits` array, which is what an older endpoint answers: that
// is no information about buckets, and recordUsage's `Array.isArray` guard then
// leaves the last measured ones in place instead of erasing them.
export async function fetchClaudeUsage({ configDir = LAYOUT.claude.home(), timeoutMs = 8000, url = USAGE_URL } = {}) {
  const t = readToken(configDir)
  if (!t) return { ok: false, limits: null, error: 'no claude.ai login found in ' + configDir }
  const r = await getJson(url, { Authorization: `Bearer ${t.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'legcli' }, timeoutMs)
  if (r.error) return { ok: false, limits: null, status: 0, error: r.error }
  if (r.status !== 200) {
    const kind = errorType(r.text)
    return { ok: false, limits: null, status: r.status, expired: t.expired, error: `usage endpoint ${r.status}${kind ? `: ${kind}` : ''}` }
  }
  let j
  try { j = JSON.parse(r.text) } catch { return { ok: false, limits: null, status: r.status, error: 'usage endpoint returned no JSON' } }
  const limits = { five_hour: window(j.five_hour), seven_day: window(j.seven_day), extra_usage: extraUsageFrom(j) }
  if (Array.isArray(j.limits)) limits.buckets = bucketsFrom(j)
  return { ok: true, limits, status: r.status, expired: t.expired, raw_keys: Object.keys(j) }
}
