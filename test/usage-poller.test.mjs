// One usage poller per LOGIN, in the board process: backoff on a refusal, one
// failure line and one recovery line on the login's terminals, and exactly one
// request per tick however many terminals share the login.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { makeHome, ROOT, sleep } from './helpers.mjs'

// BATON_HOME must be set before the store modules are imported (read once).
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const { createUsagePollers, clockTime, clampPollMs } = await import('../src/usage-poll.mjs')
const { createSession, newSessionId, readSession, readEvents } = await import('../src/sessions.mjs')
const { readUsage, noteUsageError } = await import('../src/usage.mjs')
const { fetchClaudeUsage } = await import('../src/taps/claude-usage.mjs')

const OK = {
  ok: true,
  status: 200,
  limits: { five_hour: { pct: 12, resets_at: 2_000_000_000 }, seven_day: { pct: 34, resets_at: 2_000_100_000 } },
}
const RATE_LIMITED = { ok: false, status: 429, limits: null, error: 'usage endpoint 429: rate_limit_error' }

function makeSessions(n, agent = 'claude', account = 'default') {
  return Array.from({ length: n }, () => createSession({ id: newSessionId(agent), agent, account, cwd: HOME }).session_id)
}

const statusEvents = (id, re) => readEvents(id).filter((e) => e.type === 'status' && re.test(e.summary))

test('200,429,429,200: the wait doubles to 10 minutes and snaps back, and one fetch serves every terminal on the login', async () => {
  const ids = makeSessions(3)
  const answers = [OK, RATE_LIMITED, RATE_LIMITED, OK]
  let fetches = 0
  const armed = []
  const poller = createUsagePollers({
    agents: ['claude'],
    accounts: () => ({ claude: ['default'] }),
    intervalMs: 60_000,
    maxMs: 600_000,
    fetchers: { claude: async () => { fetches += 1; return answers.shift() ?? OK } },
    schedule: (fn, ms) => { armed.push({ ms, fn }); return armed.length },
    cancel: () => {},
  })
  try {
    // 1. the first reading works: 60s to the next one, every terminal carries it
    await poller.start()
    assert.equal(fetches, 1, 'one request for the login, not one per terminal')
    assert.equal(armed.at(-1).ms, 60_000)
    for (const id of ids) {
      const s = readSession(id)
      assert.equal(s.limits.five_hour.pct, 12)
      assert.equal(s.usage_source, 'claude usage endpoint')
      assert.equal(s.usage_error, null)
    }

    // 2. a 429: the wait doubles, the failure is written once, and it says when
    await armed.at(-1).fn()
    assert.equal(fetches, 2)
    assert.equal(armed.at(-1).ms, 120_000)
    const u = readUsage('claude', 'default')
    assert.equal(u.error, 'usage endpoint 429: rate_limit_error')
    assert.ok(Date.parse(u.error_since) > 0, 'the moment it started is on the record')
    assert.equal(u.five_hour.pct, 12, 'a refusal never touches the percentages')
    for (const id of ids) {
      assert.equal(readSession(id).usage_error, 'usage endpoint 429: rate_limit_error')
      const said = statusEvents(id, /usage unavailable/)
      assert.equal(said.length, 1, `one failure line, got ${said.length}`)
      assert.match(said[0].summary, /^claude usage unavailable since \d{1,2}:\d{2} (AM|PM): usage endpoint 429: rate_limit_error$/)
      assert.ok(!said[0].summary.includes('{'), 'the body never reaches the timeline')
    }

    // 3. a second 429 doubles again and says nothing at all
    await armed.at(-1).fn()
    assert.equal(fetches, 3)
    assert.equal(armed.at(-1).ms, 240_000)
    for (const id of ids) assert.equal(statusEvents(id, /usage unavailable/).length, 1, 'still one line after the second refusal')

    // 4. it works again: back to a minute, one recovery line, the record is clean
    await armed.at(-1).fn()
    assert.equal(fetches, 4)
    assert.equal(armed.at(-1).ms, 60_000)
    const back = readUsage('claude', 'default')
    assert.equal(back.error, null)
    assert.equal(back.error_since, null)
    for (const id of ids) {
      assert.equal(readSession(id).usage_error, null)
      assert.equal(statusEvents(id, /claude usage is back/).length, 1)
    }
  } finally {
    poller.stop()
  }
})

test('the wait is capped at ten minutes, and a terminal that is not this login is left alone', async () => {
  const [mine] = makeSessions(1, 'claude', 'default')
  const [other] = makeSessions(1, 'grok', 'default')
  const armed = []
  const poller = createUsagePollers({
    agents: ['claude'],
    accounts: () => ({ claude: ['default'] }),
    intervalMs: 60_000,
    maxMs: 600_000,
    fetchers: { claude: async () => RATE_LIMITED },
    schedule: (fn, ms) => { armed.push({ ms, fn }); return armed.length },
    cancel: () => {},
  })
  try {
    await poller.start()
    for (let i = 0; i < 8; i++) await armed.at(-1).fn()
    assert.equal(armed.at(-1).ms, 600_000, 'never longer than ten minutes')
    assert.equal(poller.delayOf('claude', 'default'), 600_000)
    assert.equal(readSession(mine).usage_error, 'usage endpoint 429: rate_limit_error')
    assert.ok(!readSession(other).usage_error, 'a grok terminal knows nothing about a claude endpoint')
    assert.equal(statusEvents(mine, /usage unavailable/).length, 1, 'nine refusals, one line')
  } finally {
    poller.stop()
    noteUsageError('claude', 'default', null)
  }
})

test('a 429 body is trimmed to the status code and the error type, never the JSON', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-'))
  writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3600_000 } }))
  const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x'.repeat(400) }, request_id: 'req_abc123' })
  const srv = http.createServer((req, res) => { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(body) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${srv.address().port}/usage`
    const r = await fetchClaudeUsage({ configDir, url })
    assert.equal(r.ok, false)
    assert.equal(r.status, 429)
    assert.equal(r.error, 'usage endpoint 429: rate_limit_error')
    assert.ok(!r.error.includes('request_id'))
    assert.ok(!r.error.includes('xxx'))
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

// Finding 11: the interval is a knob a human types. "5m" made Number() NaN,
// every timer was armed with NaN, Node rounded that to 1ms, and the board asked
// the usage endpoint about a thousand times a second per login with a backoff
// that could never grow (Math.max(NaN, delay) * 2 is NaN).
test('an interval Leg cannot read is the default, and a tiny one is the floor', () => {
  for (const bad of ['5m', '60_000', '60 000', 'a minute', 'NaN', '0', '-5', 'Infinity']) {
    assert.equal(clampPollMs(bad, 60_000), 60_000, `${JSON.stringify(bad)} was taken as a number of milliseconds`)
  }
  assert.equal(clampPollMs(undefined, 60_000), 60_000)
  assert.equal(clampPollMs('', 60_000), 60_000)
  assert.equal(clampPollMs('1', 60_000), 5000, 'no reading of a plan is worth a request a second')
  assert.equal(clampPollMs('90000', 60_000), 90_000, 'a number a human meant is used as written')
  assert.equal(clampPollMs('30000', 600_000, 60_000), 60_000, 'the maximum never sits below the interval')

  // and what the module really exports with that env, read from a fresh process
  // (the constants are read once, at import)
  const src = pathToFileURL(join(ROOT, 'src', 'usage-poll.mjs')).href
  const code = `import { USAGE_POLL_MS, USAGE_POLL_MAX_MS, USAGE_POLL_NOTES } from ${JSON.stringify(src)}\nconsole.log(JSON.stringify({ ms: USAGE_POLL_MS, max: USAGE_POLL_MAX_MS, notes: USAGE_POLL_NOTES }))`
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, BATON_HOME: HOME, LEG_HOME: HOME, LEG_USAGE_POLL_MS: '5m', LEG_USAGE_POLL_MAX_MS: 'an hour' },
  })
  const got = JSON.parse(out.trim().split('\n').at(-1))
  assert.equal(got.ms, 60_000, `LEG_USAGE_POLL_MS=5m armed the timers with ${got.ms}`)
  assert.equal(got.max, 600_000)
  assert.equal(got.notes.length, 2, 'a knob that was ignored says so on the board log')
  assert.match(got.notes[0], /^LEG_USAGE_POLL_MS=5m is not a number of milliseconds; reading usage every 60000ms instead$/)
})

// Finding 20: the claude and grok readers take no AbortSignal, so a read in
// flight when the board stops still lands up to 8s later. It used to write
// percentages onto session.json, append to a timeline and push into an SSE hub
// that was already closed.
test('a read that lands after stop() writes nothing at all', async () => {
  const [id] = makeSessions(1, 'claude', 'stopper')
  let release = () => {}
  const gate = new Promise((r) => { release = r })
  const poller = createUsagePollers({
    agents: ['claude'],
    accounts: () => ({ claude: ['stopper'] }),
    intervalMs: 60_000,
    maxMs: 600_000,
    onChange: () => { throw new Error('onChange fired after stop()') },
    fetchers: { claude: async () => { await gate; return OK } },
    schedule: () => null,
    cancel: () => {},
  })
  const first = poller.start()
  await sleep(20)
  assert.equal(readSession(id).usage_source ?? null, null, 'the read is still in flight')
  poller.stop()
  release()
  await first
  await sleep(20)
  const s = readSession(id)
  assert.equal(s.usage_source ?? null, null, 'a read that landed after stop() wrote to the card')
  assert.equal(s.limits ?? null, null)
  assert.equal(readUsage('claude', 'stopper').five_hour, null, 'and it wrote the login record too')
  assert.equal(statusEvents(id, /usage/).length, 0, 'and it wrote a line onto a timeline no board is watching')
})

// Finding 21: the reason a login is unreadable can change mid-outage (logged
// out, then a stale token answering 401). The card kept naming the first cause
// for the rest of the outage, sending the user to fix what was already fixed.
test('a reason that changes mid-outage reaches the card, and the timeline still gets one line', async () => {
  const [id] = makeSessions(1, 'claude', 'reasons')
  const answers = [
    { ok: false, limits: null, error: 'no claude.ai login found in C:/x' },
    { ok: false, limits: null, error: 'usage endpoint 401' },
    { ok: false, limits: null, error: 'usage endpoint 401' },
  ]
  const armed = []
  const poller = createUsagePollers({
    agents: ['claude'],
    accounts: () => ({ claude: ['reasons'] }),
    intervalMs: 60_000,
    maxMs: 600_000,
    fetchers: { claude: async () => answers.shift() ?? { ok: false, limits: null, error: 'usage endpoint 401' } },
    schedule: (fn, ms) => { armed.push({ ms, fn }); return armed.length },
    cancel: () => {},
  })
  try {
    await poller.start()
    assert.equal(readSession(id).usage_error, 'no claude.ai login found in C:/x')
    await armed.at(-1).fn()
    assert.equal(readUsage('claude', 'reasons').error, 'usage endpoint 401')
    assert.equal(readSession(id).usage_error, 'usage endpoint 401', 'the card kept naming the cause that was already fixed')
    await armed.at(-1).fn()
    const said = statusEvents(id, /usage unavailable/)
    assert.equal(said.length, 1, `one line per outage, whatever the reason does; got ${said.length}`)
    assert.match(said[0].summary, /no claude\.ai login found/, 'and the line names when and why the outage started')
  } finally {
    poller.stop()
    noteUsageError('claude', 'reasons', null)
  }
})

test('the failure line names the clock time it started', () => {
  assert.equal(clockTime(new Date(2026, 8, 18, 9, 3).toISOString()), '9:03 AM')
  assert.equal(clockTime(new Date(2026, 8, 18, 13, 40).toISOString()), '1:40 PM')
  assert.equal(clockTime(new Date(2026, 8, 18, 0, 5).toISOString()), '12:05 AM')
  assert.equal(clockTime('not a time'), 'just now')
})
