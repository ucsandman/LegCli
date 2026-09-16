import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readGrokToken,
  fetchGrokUsage,
  scanLog,
  promptsSince,
} from '../src/taps/grok.mjs'
import grokAdapter from '../src/adapters/grok.mjs'

test('readGrokToken: parses scoped map, direct object, expired tokens, and handles missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-auth-test-'))

  // Missing file
  assert.equal(readGrokToken(dir), null)

  // Scoped format (actual ~/.grok/auth.json format)
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: 'test-scoped-token-123',
      expires_at: '2099-01-01T00:00:00Z',
    },
  }))
  const scoped = readGrokToken(dir)
  assert.equal(scoped.token, 'test-scoped-token-123')
  assert.equal(scoped.expired, false)

  // Direct object format
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    key: 'test-direct-token-456',
    expires_at: '2099-01-01T00:00:00Z',
  }))
  const direct = readGrokToken(dir)
  assert.equal(direct.token, 'test-direct-token-456')
  assert.equal(direct.expired, false)

  // Expired token
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    key: 'test-expired-token',
    expires_at: '2020-01-01T00:00:00Z',
  }))
  const expired = readGrokToken(dir)
  assert.equal(expired.token, 'test-expired-token')
  assert.equal(expired.expired, true)

  // Malformed JSON
  writeFileSync(join(dir, 'auth.json'), 'not-json')
  assert.equal(readGrokToken(dir), null)
})

test('fetchGrokUsage: polls billing and user endpoints, surfaces usage percentage and period resets', async () => {
  let billingHits = 0
  let userHits = 0

  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer mock-grok-token')
    if (req.url?.includes('/billing')) {
      billingHits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        config: {
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-09-14T10:35:21Z',
            end: '2026-09-21T10:35:21Z',
          },
          creditUsagePercent: 12,
          billingPeriodEnd: '2026-09-21T10:35:21Z',
        },
      }))
      return
    }
    if (req.url?.includes('/user')) {
      userHits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        subscriptionTier: 'XPremium',
        userId: 'usr-123',
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const dir = mkdtempSync(join(tmpdir(), 'grok-usage-server-'))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    key: 'mock-grok-token',
    expires_at: '2099-01-01T00:00:00Z',
  }))

  try {
    const r = await fetchGrokUsage({
      configDir: dir,
      billingUrl: `${base}/billing?format=credits`,
      userUrl: `${base}/user?include=subscription`,
    })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.equal(r.limits.seven_day.pct, 12)
    assert.equal(r.limits.seven_day.resets_at, Math.floor(Date.parse('2026-09-21T10:35:21Z') / 1000))
    assert.equal(r.limits.five_hour, null)
    assert.equal(r.tier, 'XPremium')
    assert.equal(billingHits, 1)
    assert.equal(userHits, 1)
  } finally {
    server.close()
  }
})

test('fetchGrokUsage: handles 401 token expiry gracefully without throwing', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized', message: 'token expired' }))
  })

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const dir = mkdtempSync(join(tmpdir(), 'grok-usage-401-'))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    key: 'expired-or-revoked-token',
    expires_at: '2099-01-01T00:00:00Z',
  }))

  try {
    const r = await fetchGrokUsage({
      configDir: dir,
      billingUrl: `${base}/billing?format=credits`,
      userUrl: `${base}/user?include=subscription`,
    })
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
    assert.equal(r.expired, true)
    assert.equal(r.limits, null)
  } finally {
    server.close()
  }
})

test('fetchGrokUsage: handles non-200 and non-JSON responses gracefully', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('internal server error')
  })

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const dir = mkdtempSync(join(tmpdir(), 'grok-usage-500-'))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    key: 'token',
    expires_at: '2099-01-01T00:00:00Z',
  }))

  try {
    const r = await fetchGrokUsage({
      configDir: dir,
      billingUrl: `${base}/billing?format=credits`,
      userUrl: `${base}/user?include=subscription`,
    })
    assert.equal(r.ok, false)
    assert.equal(r.status, 500)
    assert.equal(r.limits, null)
  } finally {
    server.close()
  }
})

test('scanLog: detects exact rate limit signals cited from xai-org/grok-build', () => {
  // crates/codegen/xai-grok-shell/src/sampling/error.rs:18
  const hit1 = scanLog("Error: You've hit the rate limit for your plan. Try again later.")
  assert.equal(hit1.signal, 'grok-rate-limit-oauth')
  assert.ok(hit1.detail.includes("You've hit the rate limit for your plan"))

  // crates/codegen/xai-grok-shell/src/sampling/error.rs:21
  const hit2 = scanLog("Error: You've hit the rate limit for your API key. Try again later.")
  assert.equal(hit2.signal, 'grok-rate-limit-api-key')

  // crates/codegen/xai-grok-pager/src/app/error_display.rs:263
  const hit3 = scanLog("Rate limited (429)\nYou've hit the rate limit for your plan. Try again later.")
  assert.equal(hit3.signal, 'grok-rate-limit-oauth')

  const hit3b = scanLog("Headline: Rate limited (429)")
  assert.equal(hit3b.signal, 'grok-rate-limit-429')

  // crates/codegen/xai-grok-shell/src/sampling/error.rs:15
  const hit4 = scanLog('{"jsonrpc":"2.0","error":{"code":-32003,"message":"rate limited"}}')
  assert.equal(hit4.signal, 'grok-rate-limit-code')

  // crates/codegen/xai-grok-hooks/src/event.rs:306
  const hit5 = scanLog('StopFailure event payload: {"kind":"rate_limit"}')
  assert.equal(hit5.signal, 'grok-rate-limit-event')

  // crates/codegen/xai-grok-shell/src/sampling/error.rs:30, 33
  const hit6 = scanLog("subscription:free-usage-exhausted: You've used all of your free queries.")
  assert.equal(hit6.signal, 'grok-free-usage-exhausted')

  // crates/codegen/xai-grok-sampling-types/src/error.rs:304
  const hit7 = scanLog("API error status: StatusCode::TOO_MANY_REQUESTS")
  assert.equal(hit7.signal, 'grok-too-many-requests')

  // parses reset duration
  const hit8 = scanLog("You've hit the rate limit for your plan. Try again in 2h30m.")
  assert.equal(hit8.signal, 'grok-rate-limit-oauth')
  assert.ok(hit8.resets_at > Math.floor(Date.now() / 1000) + 7200)

  // clean log returns null
  assert.equal(scanLog("Building project... compiled successfully."), null)
  assert.equal(scanLog(""), null)
  assert.equal(scanLog(null), null)
})

test('promptsSince: reads prompt_history.jsonl in encoded cwd directory', () => {
  const grokHome = mkdtempSync(join(tmpdir(), 'grok-prompts-'))
  const cwd = join(tmpdir(), 'mock-repo-dir')
  const encoded = encodeURIComponent(cwd)
  const sessionDir = join(grokHome, 'sessions', encoded)
  mkdirSync(sessionDir, { recursive: true })

  const now = Date.now()
  const history = [
    JSON.stringify({ timestamp: new Date(now - 10000).toISOString(), session_id: 's-old', prompt: 'old prompt' }),
    JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), session_id: 's-recent', prompt: 'recent prompt' }),
  ].join('\n')
  writeFileSync(join(sessionDir, 'prompt_history.jsonl'), history)

  const recent = promptsSince({ grokHome, cwd, sinceMs: now - 5000 })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].text, 'recent prompt')
  assert.equal(recent[0].sessionId, 's-recent')
})

test('grok adapter common export shape and configuration', () => {
  assert.equal(grokAdapter.name, 'grok')
  assert.equal(grokAdapter.stdin, 'ignore')
  assert.ok(grokAdapter.modes.allowed.includes('acceptEdits'))
  assert.ok(grokAdapter.forbiddenFlags.includes('--always-approve'))
})
