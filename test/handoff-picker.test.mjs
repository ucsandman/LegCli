// Hand off now TO a destination you name, rather than to whatever is next in
// the order. The risk this file covers is a pick that is silently ignored: a
// picked account can wall between the click and the hand-off, and the terminal
// must say where it went and why, never just go somewhere else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeHome, initRepo, licenseHome, testEnv, LEG } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

const usage = await import('../src/usage.mjs')
const sessions = await import('../src/sessions.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { claimHandoffChoice } = await import('../src/attach.mjs')

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
