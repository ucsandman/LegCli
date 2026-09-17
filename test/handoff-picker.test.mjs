// Hand off now TO a destination you name, rather than to whatever is next in
// the order. The risk this file covers is a pick that is silently ignored: a
// picked account can wall between the click and the hand-off, and the terminal
// must say where it went and why, never just go somewhere else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeHome, initRepo, licenseHome, testEnv, batonSpawn, sleep, LEG } from './helpers.mjs'
import { canonPath } from '../src/fsx.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

const usage = await import('../src/usage.mjs')
const sessions = await import('../src/sessions.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { claimHandoffChoice, spawnSpec } = await import('../src/attach.mjs')
const buckets = await import('../src/buckets.mjs')

const ACCOUNTS = { claude: ['default'], codex: ['default'], agy: ['default'] }
const ORDER = ['claude', 'codex', 'agy']
const INSTALLED = { claude: true, codex: true, agy: true }

async function api(base, path, { method = 'GET', body } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {}
    const req = http.request(base + path, { method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolvePromise({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test('chooseNext takes the pick over the order when the pick is available', () => {
  const nowS = Math.floor(Date.now() / 1000)
  // the order would send claude to codex; the human picked agy
  const picked = usage.chooseNext({ agent: 'claude', account: 'default', accounts: ACCOUNTS, order: ORDER, installed: INSTALLED, nowS, prefer: { agent: 'agy', account: 'default' } })
  assert.deepEqual(picked.next, { agent: 'agy', account: 'default' })
  assert.equal(picked.preferred_taken, true)

  // with no pick the order decides, exactly as before
  const plain = usage.chooseNext({ agent: 'claude', account: 'default', accounts: ACCOUNTS, order: ORDER, installed: INSTALLED, nowS })
  assert.deepEqual(plain.next, { agent: 'codex', account: 'default' })
  assert.equal(plain.preferred_taken, false)
})

test('a pick that walled between the click and the hand-off falls back to the order, and says so', () => {
  const nowS = Math.floor(Date.now() / 1000)
  usage.markLimited('agy', 'default', { resets_at: nowS + 900, reason: 'test-wall' })
  try {
    const r = usage.chooseNext({ agent: 'claude', account: 'default', accounts: ACCOUNTS, order: ORDER, installed: INSTALLED, nowS, prefer: { agent: 'agy', account: 'default' } })
    assert.deepEqual(r.next, { agent: 'codex', account: 'default' }, 'the work continues down the order')
    assert.equal(r.preferred_taken, false, 'and the caller can tell the pick was not taken')
  } finally { usage.clearLimited('agy', 'default') }
})

test('a pick that is not a destination for this terminal, or is uninstalled, is not taken', () => {
  const nowS = Math.floor(Date.now() / 1000)
  // "muse" is a card adapter, never a terminal destination
  const bogus = usage.chooseNext({ agent: 'claude', account: 'default', accounts: ACCOUNTS, order: ORDER, installed: INSTALLED, nowS, prefer: { agent: 'muse', account: 'default' } })
  assert.deepEqual(bogus.next, { agent: 'codex', account: 'default' })
  assert.equal(bogus.preferred_taken, false)

  const missing = usage.chooseNext({ agent: 'claude', account: 'default', accounts: ACCOUNTS, order: ORDER, installed: { ...INSTALLED, agy: false }, nowS, prefer: { agent: 'agy', account: 'default' } })
  assert.deepEqual(missing.next, { agent: 'codex', account: 'default' })
  assert.equal(missing.preferred_taken, false)
})

test('claimHandoffChoice commits the pick and records what was asked for', () => {
  const repo = initRepo('picker-claim-')
  sessions.createSession({ id: 's-pick-1', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: INSTALLED, runtimeCapabilities: [sessions.HANDOFF_ORDER_CAPABILITY] })
  sessions.updateSession('s-pick-1', { status: 'running' })
  const claim = claimHandoffChoice({ sid: 's-pick-1', agent: 'claude', account: 'default', installed: INSTALLED, reason: 'requested', prefer: { agent: 'agy', account: 'default' } })
  assert.deepEqual(claim.choice.next, { agent: 'agy', account: 'default' })
  assert.equal(claim.claimed, true)
  const s = sessions.readSession('s-pick-1')
  assert.deepEqual(s.handoff.to, { agent: 'agy', account: 'default' })
  assert.deepEqual(s.handoff.requested_to, { agent: 'agy', account: 'default' })
  assert.equal(s.handoff.reason, 'requested')
})

test('the board is told every destination and why a greyed one cannot be picked', async () => {
  const repo = initRepo('picker-view-')
  sessions.createSession({ id: 's-pick-view', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: { claude: true, codex: true, agy: false } })
  sessions.updateSession('s-pick-view', { status: 'running' })
  const nowS = Math.floor(Date.now() / 1000)
  usage.markLimited('codex', 'default', { resets_at: nowS + 1200, reason: 'test-wall' })
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const view = await api(base, '/api/sessions')
    const s = view.json.sessions.find((x) => x.session_id === 's-pick-view')
    const byName = Object.fromEntries(s.handoff_targets.map((t) => [t.agent, t]))
    assert.equal(byName.codex.available, false)
    assert.equal(byName.codex.reason, 'at its usage limit')
    assert.ok(Number.isFinite(byName.codex.resets_at))
    assert.equal(byName.agy.available, false)
    assert.equal(byName.agy.reason, 'not installed on this machine')
    assert.equal(byName.agy.resets_at, null)
  } finally {
    usage.clearLimited('codex', 'default')
    await server.stop()
  }
})

test('POST /handoff: a destination is validated, then carried on the control record', async () => {
  const repo = initRepo('picker-api-')
  const control = (id) => {
    const f = join(sessions.sessionDir(id), 'control.json')
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  }
  sessions.createSession({ id: 's-pick-api', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: INSTALLED })
  sessions.updateSession('s-pick-api', { status: 'running' })
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    // not a destination for this terminal at all
    const bogus = await api(base, '/api/sessions/s-pick-api/handoff', { method: 'POST', body: { agent: 'muse' } })
    assert.equal(bogus.status, 400)
    assert.match(bogus.json.error, /is not a destination for this terminal/)
    assert.equal(control('s-pick-api'), null, 'a refused pick never reaches the terminal')

    // a destination at its wall is refused at the click, with the reset time
    const nowS = Math.floor(Date.now() / 1000)
    usage.markLimited('codex', 'default', { resets_at: nowS + 1200, reason: 'test-wall' })
    const walled = await api(base, '/api/sessions/s-pick-api/handoff', { method: 'POST', body: { agent: 'codex' } })
    usage.clearLimited('codex', 'default')
    assert.equal(walled.status, 409)
    assert.match(walled.json.error, /at its usage limit until/)
    assert.equal(control('s-pick-api'), null)

    // a good pick
    const ok = await api(base, '/api/sessions/s-pick-api/handoff', { method: 'POST', body: { agent: 'agy' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json.target, { agent: 'agy', account: 'default' })
    assert.deepEqual(control('s-pick-api').target, { agent: 'agy', account: 'default' })
    assert.equal(control('s-pick-api').handoff, true)

    // and the old one-click path still means "whatever is next"
    sessions.takeControl('s-pick-api')
    const plain = await api(base, '/api/sessions/s-pick-api/handoff', { method: 'POST' })
    assert.equal(plain.status, 200)
    assert.equal(plain.json.target, null)
    assert.equal(control('s-pick-api').target, undefined)
    assert.equal(control('s-pick-api').handoff, true)
  } finally {
    await server.stop()
  }
})

test('leg sessions handoff --to validates the same way the board does', () => {
  const home = licenseHome(makeHome())
  const env = testEnv(home)
  const repo = initRepo('picker-cli-')
  const run = (...argv) => execFileSync(process.execPath, [LEG, 'sessions', ...argv], { encoding: 'utf8', env })
  const fail = (...argv) => {
    try {
      execFileSync(process.execPath, [LEG, 'sessions', ...argv], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: 0, stderr: '' }
    } catch (err) { return { status: err.status, stderr: String(err.stderr) } }
  }
  // the session has to live in the CLI's own home, so it is made through it
  const mk = execFileSync(process.execPath, ['-e', `
    process.env.LEG_HOME = ${JSON.stringify(home)}
    const s = await import(${JSON.stringify(new URL('../src/sessions.mjs', import.meta.url).href)})
    s.createSession({ id: 's-cli-pick', agent: 'claude', cwd: ${JSON.stringify(repo)}, repo: ${JSON.stringify(repo)}, owner: 'wes', handoffOrder: ORDER_PLACEHOLDER, installed: { claude: true, codex: true, agy: true } })
    s.updateSession('s-cli-pick', { status: 'running' })
    process.stdout.write('ok')
  `.replace('ORDER_PLACEHOLDER', JSON.stringify(ORDER))], { encoding: 'utf8', env, cwd: process.cwd() })
  assert.equal(mk.trim(), 'ok')

  const bogus = fail('handoff', 's-cli-pick', '--to', 'muse')
  assert.equal(bogus.status, 2)
  assert.match(bogus.stderr, /is not a destination for this terminal/)

  const ok = run('handoff', 's-cli-pick', '--to', 'agy')
  assert.match(ok, /handoff to agy requested/)

  // and with no --to it is the old behaviour, unchanged
  assert.match(run('handoff', 's-cli-pick'), /handoff requested for s-cli-pick/)
})

// ---- the ladder (docs/redesign-2026-09-17.md B.3 to B.7) --------------------
// A destination is a rung ({agent, account, model}), so "switch from fable to
// opus" is a hand-off. These cases are the rules that decide which rung an
// unattended terminal is allowed to fall to at 3am.
const LADDER = [
  { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'sonnet', when: 'always', cost: 'plan' },
  { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
  { agent: 'agy', account: 'default', model: null, when: 'always', cost: 'free' },
]
const nowS = () => Math.floor(Date.now() / 1000)
function writeUsage(agent, account, record) {
  mkdirSync(join(HOME, 'usage'), { recursive: true })
  writeFileSync(join(HOME, 'usage', `${agent}--${account}.json`), JSON.stringify({ agent, account, observed_at: new Date().toISOString(), ...record }))
}
const clearUsage = () => { for (const a of ['claude', 'codex', 'agy']) rmSync(join(HOME, 'usage', `${a}--default.json`), { force: true }) }
const walk = (over = {}) => usage.chooseNext({ accounts: ACCOUNTS, order: ORDER, ladder: LADDER, installed: INSTALLED, nowS: nowS(), ...over })

test('a Fable wall leaves the rest of the login open: the next rung is claude/opus, not another agent', () => {
  const resets = nowS() + 3600
  writeUsage('claude', 'default', {
    five_hour: { pct: 29, resets_at: resets }, seven_day: { pct: 47, resets_at: resets },
    buckets: [{ kind: 'weekly_scoped', group: 'weekly', model: 'fable', percent: 63, resets_at: resets, is_active: true }],
    walls: { fable: { limited_until: resets, limited_reason: 'model_limit' } },
  })
  try {
    const c = walk({ agent: 'claude', account: 'default', model: 'fable' })
    assert.deepEqual(c.next, { agent: 'claude', account: 'default', model: 'opus' }, 'a model wall walls one model, not the login')
    // a terminal whose ladder still names claude without a model is not sent
    // back to the login it just left: "whatever claude defaults to" is the
    // walled model as often as not, and that is the loop rungs exist to stop
    const bare = usage.candidates({ agent: 'claude', account: 'default', model: 'fable', accounts: ACCOUNTS, order: ORDER, ladder: [{ agent: 'claude', account: 'default', model: null }, { agent: 'codex', account: 'default', model: null }] })
    assert.deepEqual(bare.map((r) => r.agent), ['codex'])
    // and the rung the terminal came from is not offered back to it
    const rows = usage.evaluateLadder({ from: { agent: 'claude', account: 'default', model: 'fable' }, list: LADDER, ladder: LADDER })
    assert.equal(rows.find((r) => r.model === 'fable').reason, 'the fable window is out')
    assert.equal(rows.find((r) => r.model === 'opus').ok, true)
  } finally { clearUsage() }
})

test('an account wall makes every claude rung ineligible, and each says it buys nothing', () => {
  const resets = nowS() + 1200
  writeUsage('claude', 'default', { five_hour: { pct: 100, resets_at: resets }, limited_until: resets, limited_reason: 'rate_limit' })
  try {
    const c = walk({ agent: 'claude', account: 'default', model: 'fable' })
    assert.deepEqual(c.next, { agent: 'codex', account: 'default' })
    assert.deepEqual(c.reasons.map((r) => `${r.model}: ${r.reason}`), [
      'opus: shares the window that is out, buys nothing',
      'sonnet: shares the window that is out, buys nothing',
    ])
    assert.deepEqual(c.out.map((o) => `${o.agent}/${o.account}`), ['claude/default'], 'the walled login is named once for the all-out wait, not once per rung')
  } finally { clearUsage() }
})

test('may_spend off skips a credits rung with its ledger line; on, the rung is taken', () => {
  writeUsage('claude', 'default', { extra_usage: { enabled: true, reason: null, can_toggle: true } })
  try {
    const off = walk({ agent: 'codex', account: 'default', maySpend: false })
    assert.deepEqual(off.next, { agent: 'claude', account: 'default', model: 'opus' })
    assert.equal(usage.skipLine(off.reasons[0]), 'skipped claude/fable: it spends usage credits and you have not allowed that')
    const on = walk({ agent: 'codex', account: 'default', maySpend: true })
    assert.deepEqual(on.next, { agent: 'claude', account: 'default', model: 'fable' })
    // with credits off at the login, fable is ordinary plan usage again
    writeUsage('claude', 'default', { extra_usage: { enabled: false, reason: 'out_of_credits', can_toggle: false } })
    assert.deepEqual(walk({ agent: 'codex', account: 'default', maySpend: false }).next, { agent: 'claude', account: 'default', model: 'fable' })
  } finally { clearUsage() }
})

test('the reserve stops an automatic hand-off and never a human pick', () => {
  const resets = nowS() + 3600
  writeUsage('claude', 'default', { buckets: [{ kind: 'weekly_all', group: 'weekly', model: null, percent: 95, resets_at: resets, is_active: true }] })
  try {
    const auto = walk({ agent: 'codex', account: 'default', reserve: { claude: 10 }, automatic: true })
    assert.deepEqual(auto.next, { agent: 'agy', account: 'default' }, 'a card may not eat the last 10% Wes kept for himself')
    assert.deepEqual(new Set(auto.reasons.map((r) => r.reason)), new Set(['past your 10% reserve']))
    const picked = walk({ agent: 'codex', account: 'default', reserve: { claude: 10 }, prefer: { agent: 'claude', account: 'default', model: 'opus' } })
    assert.deepEqual(picked.next, { agent: 'claude', account: 'default', model: 'opus' })
    assert.equal(picked.preferred_taken, true, 'a human pressing Hand off > ignores the floor')
    // and the picker still prints the floor on that row rather than hiding it
    const rows = usage.evaluateLadder({ from: { agent: 'codex', account: 'default' }, list: LADDER, ladder: LADDER, reserve: { claude: 10 }, automatic: false })
    const opus = rows.find((r) => r.model === 'opus')
    assert.equal(opus.ok, true)
    assert.equal(opus.reason, 'past your 10% reserve')
  } finally { clearUsage() }
})

test('below:N with no reading is skipped, and walled-only waits until everything above it is walled', () => {
  const resets = nowS() + 1800
  const ladder = [
    { agent: 'claude', account: 'default', model: 'opus', when: 'below:50', cost: 'plan' },
    { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
    { agent: 'grok', account: 'default', model: null, when: 'walled-only', cost: 'metered' },
  ]
  const accounts = { ...ACCOUNTS, grok: ['default'] }
  const installed = { ...INSTALLED, grok: true }
  try {
    // no reading at all: a threshold on a login with no figure is a wrong number in disguise
    let c = usage.chooseNext({ agent: 'agy', account: 'default', accounts, order: ORDER, ladder, installed, nowS: nowS(), maySpend: true })
    assert.deepEqual(c.next, { agent: 'codex', account: 'default' })
    assert.equal(c.reasons[0].reason, 'no reading, so "below 50%" cannot be checked')
    // a reading above the threshold is skipped by the number it actually has
    writeUsage('claude', 'default', { buckets: [{ kind: 'weekly_all', group: 'weekly', model: null, percent: 72, resets_at: resets, is_active: true }] })
    c = usage.chooseNext({ agent: 'agy', account: 'default', accounts, order: ORDER, ladder, installed, nowS: nowS(), maySpend: true })
    assert.equal(c.reasons[0].reason, 'at 72%, not below 50%')
    // below it, it is taken
    writeUsage('claude', 'default', { buckets: [{ kind: 'weekly_all', group: 'weekly', model: null, percent: 31, resets_at: resets, is_active: true }] })
    c = usage.chooseNext({ agent: 'agy', account: 'default', accounts, order: ORDER, ladder, installed, nowS: nowS(), maySpend: true })
    assert.deepEqual(c.next, { agent: 'claude', account: 'default', model: 'opus' })
    // walled-only: grok waits while codex is merely slow, and is taken once nothing above it is open
    writeUsage('claude', 'default', { limited_until: resets, limited_reason: 'rate_limit' })
    writeUsage('codex', 'default', { limited_until: resets, limited_reason: 'usage_limit_exceeded' })
    c = usage.chooseNext({ agent: 'agy', account: 'default', accounts, order: ORDER, ladder, installed, nowS: nowS(), maySpend: true })
    assert.deepEqual(c.next, { agent: 'grok', account: 'default' })
    // and with spending off it is not taken even then: it bills metered credits
    c = usage.chooseNext({ agent: 'agy', account: 'default', accounts, order: ORDER, ladder, installed, nowS: nowS(), maySpend: false })
    assert.equal(c.next, null)
    assert.equal(usage.skipLine(c.reasons[c.reasons.length - 1]), 'skipped grok: it spends metered credits and you have not allowed that')
  } finally { clearUsage(); rmSync(join(HOME, 'usage', 'grok--default.json'), { force: true }) }
})

test('a rung picked on the board is committed with its model (Back to fable is this path)', () => {
  const repo = initRepo('picker-claim-rung-')
  sessions.createSession({ id: 's-pick-rung', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: INSTALLED, model: 'sonnet' })
  sessions.updateSession('s-pick-rung', { status: 'running', handoff_ladder: LADDER })
  const claim = claimHandoffChoice({ sid: 's-pick-rung', agent: 'claude', account: 'default', model: 'sonnet', installed: INSTALLED, reason: 'requested', prefer: { agent: 'claude', account: 'default', model: 'fable' } })
  assert.deepEqual(claim.choice.next, { agent: 'claude', account: 'default', model: 'fable' })
  assert.equal(claim.choice.preferred_taken, true)
  const s = sessions.readSession('s-pick-rung')
  assert.deepEqual(s.handoff.to, { agent: 'claude', account: 'default', model: 'fable' })
  assert.deepEqual(s.handoff.requested_to, { agent: 'claude', account: 'default', model: 'fable' })
})

test('climb_back never keeps an automatic hand-off from walking back up the same login', () => {
  try {
    const auto = walk({ agent: 'claude', account: 'default', model: 'sonnet', climbBack: 'never', automatic: true })
    assert.deepEqual(auto.next, { agent: 'codex', account: 'default' }, 'a lower rung stays put until a human says otherwise')
    const picked = walk({ agent: 'claude', account: 'default', model: 'sonnet', climbBack: 'never', prefer: { agent: 'claude', account: 'default', model: 'fable' } })
    assert.deepEqual(picked.next, { agent: 'claude', account: 'default', model: 'fable' }, 'Back to fable is a human pick and always works')
    const dflt = walk({ agent: 'claude', account: 'default', model: 'sonnet' })
    assert.deepEqual(dflt.next, { agent: 'claude', account: 'default', model: 'fable' }, 'next-handoff climbs on its own: chooseNext walks from rung 1')
  } finally { clearUsage() }
})

test('a claude downshift resumes the conversation; an upshift and every other rung take the bundle', async () => {
  const repo = initRepo('picker-argv-')
  const stub = join(repo, 'claude-stub.mjs')
  writeFileSync(stub, 'process.exit(0)\n')
  const before = process.env.BATON_CLAUDE_BIN
  process.env.BATON_CLAUDE_BIN = stub
  sessions.createSession({ id: 's-argv', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: INSTALLED, model: 'fable' })
  try {
    assert.equal(buckets.isDownshift({ agent: 'claude', account: 'default', model: 'fable' }, { agent: 'claude', account: 'default', model: 'opus' }), true)
    assert.equal(buckets.isDownshift({ agent: 'claude', account: 'default', model: 'opus' }, { agent: 'claude', account: 'default', model: 'fable' }), false, 'an upshift is not a downshift')
    assert.equal(buckets.isDownshift({ agent: 'claude', account: 'default', model: 'fable' }, { agent: 'codex', account: 'default', model: null }), false)

    const down = await spawnSpec('claude', { account: 'default', args: [], sessionId: 's-argv', prompt: null, cwd: repo, autoApprove: false, model: 'opus', resume: 'cs-77' })
    assert.match(down.args.join(' '), /--resume cs-77 --model opus/, `argv was ${down.args.join(' ')}`)
    assert.equal(down.args.some((a) => /taking over an interactive coding session/.test(String(a))), false, 'a kept conversation is never re-primed from the bundle')

    const up = await spawnSpec('claude', { account: 'default', args: [], sessionId: 's-argv', prompt: 'You are taking over an interactive coding session from claude.', cwd: repo, autoApprove: false, model: 'fable' })
    assert.equal(up.args.includes('--resume'), false, 'an upshift takes the bundle')
    assert.match(up.args.join(' '), /--model fable/)
    assert.match(String(up.args[up.args.length - 1]), /taking over an interactive coding session/)

    // the model the human typed is never overwritten by a rung
    const mine = await spawnSpec('claude', { account: 'default', args: ['--model', 'haiku'], sessionId: 's-argv', prompt: null, cwd: repo, autoApprove: false, model: 'opus' })
    assert.equal(mine.args.filter((a) => a === '--model').length, 1)
    assert.match(mine.args.join(' '), /--model haiku/)
  } finally {
    if (before === undefined) delete process.env.BATON_CLAUDE_BIN; else process.env.BATON_CLAUDE_BIN = before
  }
})

test('the picker is told each rung, what it costs, and whether it keeps the conversation', async () => {
  const repo = initRepo('picker-rungs-')
  const resets = nowS() + 3600
  writeUsage('claude', 'default', {
    buckets: [{ kind: 'weekly_scoped', group: 'weekly', model: 'fable', percent: 63, resets_at: resets, is_active: true }],
    walls: { fable: { limited_until: resets, limited_reason: 'model_limit' } },
  })
  sessions.createSession({ id: 's-rungs', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: { claude: true, codex: true, agy: false }, model: 'fable' })
  sessions.updateSession('s-rungs', { status: 'running', agent_session_id: 'cs-88', handoff_ladder: LADDER })
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  try {
    const view = await api(`http://127.0.0.1:${port}`, '/api/sessions')
    const s = view.json.sessions.find((x) => x.session_id === 's-rungs')
    const rows = s.handoff_targets
    assert.deepEqual(rows.map((r) => `${r.agent}/${r.model ?? '-'}`), ['claude/opus', 'claude/sonnet', 'codex/-', 'agy/-'], 'the rung this terminal is on is not offered back to it')
    const opus = rows[0]
    assert.equal(opus.available, true)
    assert.equal(opus.cost, 'plan')
    assert.equal(opus.keeps_conversation, true, 'a downshift on the same login keeps the conversation')
    assert.equal(rows.find((r) => r.agent === 'codex').keeps_conversation, false, 'another CLI is primed from the bundle')
    assert.equal(rows.find((r) => r.agent === 'agy').available, false)
    assert.equal(rows.find((r) => r.agent === 'agy').reason, 'not installed on this machine')
    assert.deepEqual(s.eligible_next, { agent: 'claude', account: 'default', model: 'opus' })
    // and POST /handoff takes the rung
    const ok = await api(`http://127.0.0.1:${port}`, '/api/sessions/s-rungs/handoff', { method: 'POST', body: { agent: 'claude', model: 'opus' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json.target, { agent: 'claude', account: 'default', model: 'opus' })
    const control = JSON.parse(readFileSync(join(sessions.sessionDir('s-rungs'), 'control.json'), 'utf8'))
    assert.deepEqual(control.target, { agent: 'claude', account: 'default', model: 'opus' })
    // the walled rung is refused at the click, with its clock
    sessions.takeControl('s-rungs')
    const walled = await api(`http://127.0.0.1:${port}`, '/api/sessions/s-rungs/handoff', { method: 'POST', body: { agent: 'claude', model: 'fable' } })
    assert.equal(walled.status, 400, 'the rung it is already on is not a destination')
  } finally {
    clearUsage()
    await server.stop()
  }
})

test('the settings route saves a ladder and derives the order every older reader needs', async () => {
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const saved = await api(base, '/api/settings', { method: 'PATCH', body: { handoff_ladder: LADDER, may_spend: true, climb_back: 'never', reserve: { claude: 10 } } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.preferences.handoff_order, ['claude', 'codex', 'agy'])
    assert.equal(saved.json.preferences.handoff_ladder.length, 5)
    assert.equal(saved.json.preferences.may_spend, true)
    assert.equal(saved.json.preferences.climb_back, 'never')
    assert.deepEqual(saved.json.preferences.reserve, { claude: 10 })
    const bad = await api(base, '/api/settings', { method: 'PATCH', body: { handoff_ladder: [{ agent: 'claude', model: 'gpt-5' }] } })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /no model/)
    const badClimb = await api(base, '/api/settings', { method: 'PATCH', body: { climb_back: 'when-quiet' } })
    assert.equal(badClimb.status, 400)
  } finally {
    await api(base, '/api/settings', { method: 'PATCH', body: { handoff_order: ORDER, may_spend: false, climb_back: 'next-handoff', reserve: {} } })
    await server.stop()
  }
})

// End to end, through the real limit path: a Fable wall arrives the way Claude
// Code sends one (src/hook.mjs, the wording from
// fixtures/live/claude/limit-rate_limit.json), and the next process in the same
// terminal is claude on opus, with the conversation it already had.
test('a simulated Fable wall lands the same terminal on claude --model opus', async (t) => {
  const stubs = mkdtempSync(join(tmpdir(), 'picker-stubs-'))
  const records = mkdtempSync(join(tmpdir(), 'picker-records-'))
  writeFileSync(join(stubs, 'claude.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/claude-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), session: process.env.BATON_SESSION }))
setTimeout(() => {}, 120000)
`)
  clearUsage()
  const prefs = await import('../src/preferences.mjs')
  prefs.writePreferences({ handoff_ladder: LADDER, may_spend: false, climb_back: 'next-handoff' })
  const repo = initRepo('picker-e2e-')
  const env = testEnv(HOME, {
    BATON_CLAUDE_BIN: join(stubs, 'claude.mjs'), BATON_NO_BOARD: '1', BATON_NO_OPEN: '1',
    BATON_ATTACH_POLL_MS: '200', BATON_USAGE_POLL_MS: '600000', STUB_DIR: records,
  })
  const child = batonSpawn(['claude', '--no-worktree'], env, { cwd: repo })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  child.stdout.resume()
  const exited = new Promise((r) => child.on('exit', r))
  let session = null
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    session = sessions.listSessions().find((s) => s.repo && canonPath(s.repo) === canonPath(repo) && s.pid)
    if (session) break
    await sleep(100)
  }
  try {
    assert.ok(session, `the claude leg started; stderr: ${stderr.slice(-800)}`)
    // the transcript is what normally says which model answered; this terminal
    // is a stub, so the record is given the two facts a real leg would have
    sessions.updateSession(session.session_id, { model: 'fable', agent_session_id: 'cs-e2e' })
    const out = execFileSync(process.execPath, [LEG, 'sessions', 'simulate-limit', session.session_id, '--message', "You've reached your Fable limit."], { env, encoding: 'utf8' })
    assert.match(out, /is at limit/)
    // the wall went on fable alone, and left the login open
    const u = usage.readUsage('claude', 'default')
    assert.ok(usage.wallActive(u.walls?.fable), 'the Fable wall is standing')
    assert.equal(u.limited_until, null, 'and the login itself is not walled')
    let launches = []
    const t1 = Date.now()
    while (Date.now() - t1 < 20000) {
      launches = readdirSync(records).filter((n) => n.startsWith('claude-')).sort()
      if (launches.length >= 2) break
      await sleep(150)
    }
    assert.equal(launches.length, 2, `the terminal started a second claude; ${stderr.slice(-800)}`)
    const second = JSON.parse(readFileSync(join(records, launches[1]), 'utf8'))
    const argv = second.argv.join(' ')
    assert.match(argv, /--resume cs-e2e --model opus/, `second launch argv was ${argv}`)
    assert.equal(second.argv.some((a) => /taking over an interactive coding session/.test(String(a))), false, 'the conversation was kept, so no bundle prompt')
    assert.equal(second.session, session.session_id, 'same terminal, same session record')
    const after = sessions.readSession(session.session_id)
    assert.equal(after.model, 'opus')
    assert.ok(sessions.readEvents(session.session_id).some((e) => /kept the conversation/.test(e.summary)))
  } finally {
    if (session && sessions.isActive(sessions.readSession(session.session_id))) sessions.requestControl(session.session_id, { end: true })
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
    clearUsage()
    prefs.writePreferences({ handoff_order: ORDER })
  }
  t.diagnostic(stderr.split('\n').filter((l) => l.includes('[leg]')).slice(-10).join('\n'))
})

test('End is unchanged by the picker and still needs no body', async () => {
  const repo = initRepo('picker-end-')
  sessions.createSession({ id: 's-pick-end', agent: 'claude', cwd: repo, repo, owner: 'wes', handoffOrder: ORDER, installed: INSTALLED })
  sessions.updateSession('s-pick-end', { status: 'running' })
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const r = await api(base, '/api/sessions/s-pick-end/end', { method: 'POST' })
    assert.equal(r.status, 200)
    assert.equal(r.json.requested, 'end')
    const f = join(sessions.sessionDir('s-pick-end'), 'control.json')
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).end, true)
  } finally {
    await server.stop()
  }
})
