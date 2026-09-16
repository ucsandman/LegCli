// claude usage — the 5h / 7d percentages for a Claude Code login, from the
// same endpoint Claude Code's own /usage and built-in status line read.
// Why not the status line: Claude Code 2.1.268 renders its built-in status
// line and does not run a custom `statusLine` command passed via --settings
// or a project settings file (verified 2026-09-11 with an `echo` command at
// both levels; hooks from the same --settings file do run). So Leg asks the
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

// → { ok, limits: {five_hour, seven_day}|null, status, error, expired }
export async function fetchClaudeUsage({ configDir = LAYOUT.claude.home(), timeoutMs = 8000, url = USAGE_URL } = {}) {
  const t = readToken(configDir)
  if (!t) return { ok: false, limits: null, error: 'no claude.ai login found in ' + configDir }
  const r = await getJson(url, { Authorization: `Bearer ${t.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'legcli' }, timeoutMs)
  if (r.error) return { ok: false, limits: null, status: 0, error: r.error }
  if (r.status !== 200) return { ok: false, limits: null, status: r.status, expired: t.expired, error: `usage endpoint ${r.status}: ${r.text.slice(0, 120)}` }
  let j
  try { j = JSON.parse(r.text) } catch { return { ok: false, limits: null, status: r.status, error: 'usage endpoint returned no JSON' } }
  return { ok: true, limits: { five_hour: window(j.five_hour), seven_day: window(j.seven_day) }, status: r.status, expired: t.expired, raw_keys: Object.keys(j) }
}
