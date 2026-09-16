// grok tap - how Baton supervises the xAI grok CLI (xai-org/grok-build).
// Usage percentages tap: Grok CLI exposes no usage command. Baton reads the
// login token from ~/.grok/auth.json and polls:
//   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//   GET https://cli-chat-proxy.grok.com/v1/user?include=subscription
// Every 60s, same cadence as Claude Code tap.
// Wall tap: exact signals cited from xai-org/grok-build (Apache 2.0, Rust):
//   - crates/codegen/xai-grok-sampling-types/src/error.rs:304:
//     SamplingError::Api { status: StatusCode::TOO_MANY_REQUESTS, .. }
//   - crates/codegen/xai-grok-shell/src/sampling/error.rs:15, 18-33, 132:
//     RATE_LIMITED_ERROR_CODE = -32003
//     RATE_LIMITED_USER_MESSAGE_OAUTH ("You've hit the rate limit for your plan. Try again later.")
//     RATE_LIMITED_USER_MESSAGE_API_KEY ("You've hit the rate limit for your API key. Try again later.")
//     FREE_USAGE_USER_MESSAGE ("You've used all of your free queries. Upgrade to a paid plan for more access.")
//     FREE_USAGE_EXHAUSTED_ERROR_CODE ("subscription:free-usage-exhausted")
//   - crates/codegen/xai-grok-hooks/src/event.rs:306-315:
//     StopFailureKind::RateLimit serializes to "rate_limit"
//   - crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn_end.rs:118, 125:
//     maps -32003 to StopFailureKind::RateLimit ("rate_limit") on StopFailure
//   - crates/codegen/xai-grok-pager/src/app/error_display.rs:263-267:
//     HTTP 429 maps to headline "Rate limited (429)" and "You've hit the rate limit for your plan. Try again later."
//   - crates/codegen/xai-grok-pager/src/headless.rs:84, 1512:
//     headless mode emits {"type":"error","message": ...} on -32003
// Native https and http, not fetch (test/lessons.test.mjs no-global-fetch).
import https from 'node:https'
import http from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { LAYOUT } from '../accounts.mjs'

export const GROK_BILLING_URL = (process.env.LEG_GROK_BILLING_URL || process.env.BATON_GROK_BILLING_URL) || 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const GROK_USER_URL = (process.env.LEG_GROK_USER_URL || process.env.BATON_GROK_USER_URL) || 'https://cli-chat-proxy.grok.com/v1/user?include=subscription'

export function defaultGrokHome() {
  return process.env.GROK_HOME || LAYOUT.grok?.home() || join(homedir(), '.grok')
}

// Read login token from ~/.grok/auth.json. Re-read on each poll so refreshed tokens
// take effect. Handles token expiry gracefully.
export function readGrokToken(configDir = defaultGrokHome()) {
  const f = join(configDir, 'auth.json')
  if (!existsSync(f)) return null
  try {
    const raw = readFileSync(f, 'utf8')
    const j = JSON.parse(raw)
    let entry = null
    if (typeof j === 'object' && j !== null) {
      if (typeof j.key === 'string' && j.key) {
        entry = j
      } else if (typeof j.token === 'string' && j.token) {
        entry = { key: j.token, expires_at: j.expires_at }
      } else {
        const scopeKey = Object.keys(j).find((k) => k.startsWith('https://auth.x.ai') && j[k]?.key)
        if (scopeKey) {
          entry = j[scopeKey]
        } else {
          for (const k of Object.keys(j)) {
            if (j[k] && typeof j[k] === 'object' && typeof j[k].key === 'string' && j[k].key) {
              entry = j[k]
              break
            }
          }
        }
      }
    }
    if (!entry?.key) return null
    let expired = false
    if (entry.expires_at) {
      const expMs = Date.parse(entry.expires_at)
      if (Number.isFinite(expMs) && Date.now() > expMs) expired = true
    }
    return { token: entry.key, expired, expires_at: entry.expires_at ?? null }
  } catch {
    return null
  }
}

function getJson(url, headers, timeoutMs) {
  return new Promise((resolvePromise) => {
    const u = new URL(url)
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
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

// → { ok, limits: { five_hour, seven_day }|null, status, tier, expired, error }
export async function fetchGrokUsage({
  configDir = defaultGrokHome(),
  timeoutMs = 8000,
  billingUrl = GROK_BILLING_URL,
  userUrl = GROK_USER_URL,
} = {}) {
  const t = readGrokToken(configDir)
  if (!t) return { ok: false, limits: null, error: `no grok login found in ${configDir}` }
  if (t.expired) {
    return { ok: false, limits: null, status: 401, expired: true, error: 'grok auth token is expired' }
  }

  const headers = {
    Authorization: `Bearer ${t.token}`,
    Accept: 'application/json',
    'User-Agent': 'legcli',
  }

  const billingRes = await getJson(billingUrl, headers, timeoutMs)
  if (billingRes.error) return { ok: false, limits: null, status: 0, error: billingRes.error }
  if (billingRes.status === 401) {
    return { ok: false, limits: null, status: 401, expired: true, error: 'grok authentication failed (401)' }
  }
  if (billingRes.status !== 200) {
    return { ok: false, limits: null, status: billingRes.status, expired: false, error: `billing endpoint ${billingRes.status}: ${billingRes.text.slice(0, 120)}` }
  }

  let billingJson
  try {
    billingJson = JSON.parse(billingRes.text)
  } catch {
    return { ok: false, limits: null, status: billingRes.status, error: 'billing endpoint returned no JSON' }
  }

  const config = billingJson.config || billingJson
  const pct = Number(config.creditUsagePercent ?? billingJson.creditUsagePercent)
  if (!Number.isFinite(pct)) {
    return { ok: false, limits: null, status: billingRes.status, error: 'no creditUsagePercent found in billing response' }
  }

  let resetsAt = null
  const resetStr = config.currentPeriod?.end || config.billingPeriodEnd || billingJson.billingPeriodEnd || null
  if (typeof resetStr === 'string') {
    const tMs = Date.parse(resetStr)
    if (Number.isFinite(tMs)) resetsAt = Math.floor(tMs / 1000)
  }

  const periodType = String(config.currentPeriod?.type || '')
  const isShort = periodType.includes('HOUR') || periodType.includes('DAILY')
  const windowObj = { pct, resets_at: resetsAt }
  const limits = {
    five_hour: isShort ? windowObj : null,
    seven_day: !isShort ? windowObj : null,
  }

  let tier = null
  try {
    const userRes = await getJson(userUrl, headers, timeoutMs)
    if (userRes.status === 200) {
      const userJson = JSON.parse(userRes.text)
      tier = userJson.subscriptionTier || userJson.subscription?.tier || null
    }
  } catch {}

  return {
    ok: true,
    limits,
    status: billingRes.status,
    tier,
    expired: false,
    raw_keys: Object.keys(billingJson),
  }
}

// Exact signals cited from xai-org/grok-build source code:
const LIMIT_RES = [
  ['grok-rate-limit-oauth', /You've hit the rate limit for your plan/i],
  ['grok-rate-limit-api-key', /You've hit the rate limit for your API key/i],
  ['grok-rate-limit-429', /Rate limited \(429\)/i],
  ['grok-rate-limit-code', /-32003/],
  ['grok-rate-limit-event', /"rate_limit"/i],
  ['grok-free-usage-exhausted', /subscription:free-usage-exhausted|You've used all of your free queries/i],
  ['grok-too-many-requests', /TOO_MANY_REQUESTS/],
]

// Scans log or stream text for Grok rate limit signals.
// → { signal, detail, resets_at } | null
export function scanLog(text) {
  if (!text) return null
  const s = String(text)
  for (const [id, re] of LIMIT_RES) {
    const m = re.exec(s)
    if (!m) continue
    const at = s.lastIndexOf(m[0])
    const detail = s.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim()
    let resets_at = null
    const dm = /(?:try again in|resets in)\s+((?:\d+\s*[smhd])+)/i.exec(s.slice(at))
    if (dm) {
      let secs = 0
      for (const [, n, u] of dm[1].matchAll(/(\d+)\s*([smhd])/gi)) {
        secs += parseInt(n, 10) * { s: 1, m: 60, h: 3600, d: 86400 }[u.toLowerCase()]
      }
      if (secs) resets_at = Math.floor(Date.now() / 1000) + secs
    }
    return { signal: id, detail, resets_at }
  }
  return null
}

export function logSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

export function sessionsRootFor(grokHome = defaultGrokHome()) {
  return join(grokHome, 'sessions')
}

// Prompts typed into grok in `cwd` since `sinceMs`.
// Grok stores sessions under ~/.grok/sessions/<encoded-cwd>/<session-id>/
// with prompt_history.jsonl in the cwd dir and summary.json in each session dir.
export function promptsSince({ grokHome = defaultGrokHome(), cwd, sinceMs }) {
  const root = sessionsRootFor(grokHome)
  if (!existsSync(root)) return []
  const encoded = encodeURIComponent(cwd)
  const dir = join(root, encoded)
  if (!existsSync(dir)) return []

  const histFile = join(dir, 'prompt_history.jsonl')
  const out = []
  if (existsSync(histFile)) {
    try {
      const lines = readFileSync(histFile, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const j = JSON.parse(line)
          const tsMs = Date.parse(j.timestamp)
          if (Number.isFinite(tsMs) && tsMs >= sinceMs - 2000) {
            out.push({
              text: String(j.prompt ?? ''),
              ts: tsMs,
              sessionId: j.session_id ?? null,
            })
          }
        } catch {}
      }
    } catch {}
  }
  return out
}
