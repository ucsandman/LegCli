// The shared board grows three things: TLS, a role between owner and guest,
// and one list of who did what.
//
// The risk each covers: a board told to use TLS that quietly serves plaintext;
// a new role that widens access to the machine instead of only the pipeline;
// an audit that returns an empty list from a board that read nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, initRepo } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

const share = await import('../src/share.mjs')
const sessions = await import('../src/sessions.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { auditTrail } = await import('../src/audit.mjs')

function roster(people) {
  return { version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: false, people }
}

async function api(base, path, { method = 'GET', token, agent } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const mod = base.startsWith('https:') ? https : http
    const req = mod.request(base + path, { method, headers, agent }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolvePromise({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ---- roles ----

test('the roles and what each may reach are declared in one place', () => {
  assert.deepEqual(share.ROLES, ['owner', 'operator', 'guest'])
  assert.equal(share.mayUseCards('owner'), true)
  assert.equal(share.mayUseCards('operator'), true)
  assert.equal(share.mayUseCards('guest'), false)
  assert.equal(share.mayUseMachine('owner'), true)
  assert.equal(share.mayUseMachine('operator'), false, 'an operator runs the work, not the machine')
  assert.equal(share.mayUseMachine('guest'), false)
})

test('an operator gets the pipeline board and nothing that describes this machine', async () => {
  const ownerToken = share.newToken()
  const opToken = share.newToken()
  const guestToken = share.newToken()
  const people = [
    { name: 'wes', role: 'owner', token_sha256: share.hashToken(ownerToken) },
    { name: 'dana', role: 'operator', token_sha256: share.hashToken(opToken) },
    { name: 'sam', role: 'guest', token_sha256: share.hashToken(guestToken) },
  ]
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster(people) })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    // the pipeline: the operator is in
    for (const p of ['/api/cards', '/api/floor', '/api/presets', '/api/adapters', '/api/leases']) {
      assert.equal((await api(base, p, { token: opToken })).status, 200, `an operator may read ${p}`)
      assert.equal((await api(base, p, { token: guestToken })).status, 403, `a guest may not read ${p}`)
      assert.equal((await api(base, p, { token: ownerToken })).status, 200, `the owner may read ${p}`)
    }
    // the machine itself: the operator is out
    for (const p of ['/api/settings', '/api/history', '/api/worktrees', '/api/trunk', '/api/audit']) {
      assert.equal((await api(base, p, { token: opToken })).status, 403, `an operator may not read ${p}`)
      assert.equal((await api(base, p, { token: guestToken })).status, 403, `a guest may not read ${p}`)
      assert.equal((await api(base, p, { token: ownerToken })).status, 200, `the owner may read ${p}`)
    }
    // health tells an operator about the cards but never where this machine keeps them
    const opHealth = await api(base, '/api/health', { token: opToken })
    assert.equal(opHealth.status, 200)
    assert.ok(opHealth.json.columns, 'an operator sees the card columns')
    assert.equal(opHealth.json.home, null, 'and never this machine’s home path')
    assert.equal((await api(base, '/api/health', { token: ownerToken })).json.home, HOME)
    const guestHealth = await api(base, '/api/health', { token: guestToken })
    assert.equal(guestHealth.json.columns, undefined, 'a guest gets no card board at all')
  } finally { await server.stop() }
})

test('leg share add refuses a role that is not one of the three', () => {
  assert.throws(() => share.addPerson('nope', { role: 'admin', share: { ...share.OFF, people: [] } }), /bad role "admin" \(owner\|operator\|guest\)/)
})

// ---- TLS ----

test('a TLS pair that cannot be used stops the board instead of serving plaintext', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leg-tls-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  const off = { ...share.OFF }

  assert.equal(share.readTls(off, {}), null, 'no pair configured is not an error')
  assert.equal(share.tlsConfigured(off, {}), false)
  assert.equal(share.scheme(off, {}), 'http')

  // half a pair
  assert.throws(() => share.readTls({ ...off, tls: { cert, key: null } }, {}), /both a certificate and a key/)
  // a pair that is not there
  assert.throws(() => share.readTls({ ...off, tls: { cert, key } }, {}), /certificate not found/)
  writeFileSync(cert, 'x')
  assert.throws(() => share.readTls({ ...off, tls: { cert, key } }, {}), /key not found/)
  // an empty pair
  writeFileSync(key, '')
  assert.throws(() => share.readTls({ ...off, tls: { cert, key } }, {}), /empty/)

  writeFileSync(key, 'y')
  const ok = share.readTls({ ...off, tls: { cert, key } }, {})
  assert.equal(ok.cert_path, cert)
  assert.equal(ok.key_path, key)
  assert.equal(share.tlsConfigured({ ...off, tls: { cert, key } }, {}), true)
  assert.equal(share.scheme({ ...off, tls: { cert, key } }, {}), 'https')
  // the environment wins over the file, so a board can be given a pair without a rewrite
  assert.equal(share.readTls(off, { LEG_TLS_CERT: cert, LEG_TLS_KEY: key }).cert_path, cert)
})

test('a shared link carries the scheme the board actually serves', () => {
  const s = { ...share.OFF, on: true, bind: '100.64.0.1', port: 4747, people: [{ name: 'wes', role: 'owner' }] }
  assert.match(share.linkFor({ ...s, tls: null }, 'tok'), /^http:\/\/100\.64\.0\.1:4747/)
  assert.match(share.linkFor({ ...s, tls: { cert: 'c', key: 'k' } }, 'tok'), /^https:\/\/100\.64\.0\.1:4747/)
})

test('the board serves real HTTPS from a real certificate pair', async (t) => {
  let openssl = true
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { openssl = false }
  if (!openssl) return t.skip('openssl is not on this machine; the wiring is covered by the test below')

  const dir = mkdtempSync(join(tmpdir(), 'leg-tls-real-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  assert.ok(existsSync(cert) && existsSync(key))

  const token = share.newToken()
  const people = [{ name: 'wes', role: 'owner', token_sha256: share.hashToken(token) }]
  const server = createBoardServer({
    bind: '127.0.0.1', port: 0, token: '', scheduler: false,
    share: { ...roster(people), tls: { cert, key } },
  })
  assert.ok(server.server instanceof https.Server, 'a configured pair makes an https listener, not an http one')
  assert.equal(server.tls.cert_path, cert)
  const { port } = await server.start()
  try {
    // rejectUnauthorized: the pair is self-signed for this test only; what is
    // being proved is that the bytes on the wire are TLS, not that a browser
    // would trust them (the shipped guidance is `tailscale cert`, which is).
    const agent = new https.Agent({ rejectUnauthorized: false })
    const r = await api(`https://127.0.0.1:${port}`, '/api/health', { token, agent })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    // and plain http against the TLS port is not answered as if it were fine
    await assert.rejects(api(`http://127.0.0.1:${port}`, '/api/health', { token }), /.*/)
  } finally { await server.stop() }
})

test('with no pair configured the board is a plain http listener', async () => {
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: { ...share.OFF } })
  assert.ok(server.server instanceof http.Server)
  assert.ok(!(server.server instanceof https.Server))
  assert.equal(server.tls, null)
})

// ---- audit ----

test('the audit names who did what, and says how much it read', () => {
  const repo = initRepo('audit-')
  sessions.createSession({ id: 's-audit-1', agent: 'claude', cwd: repo, repo, owner: 'wes' })
  sessions.appendEvent('s-audit-1', { type: 'handoff_requested', by: 'dana', summary: 'hand off requested from the board by dana' })
  sessions.appendEvent('s-audit-1', { type: 'handoff', summary: 'claude → codex (bundle b1)' })
  sessions.appendEvent('s-audit-1', { type: 'status', by: 'dana', summary: 'commentary that is not an action' })

  const all = auditTrail({})
  const mine = all.entries.filter((e) => e.id === 's-audit-1')
  assert.equal(mine.length, 2, 'two actions; the status line is commentary, not an audited action')
  assert.deepEqual(mine.map((e) => e.what).sort(), ['handoff', 'handoff_requested'])
  const req = mine.find((e) => e.what === 'handoff_requested')
  assert.equal(req.who, 'dana')
  assert.equal(req.kind, 'human')
  assert.equal(req.where, 'terminal')
  assert.equal(req.repo, repo)
  // L2: the count of what was read travels with the answer
  assert.ok(all.scanned.sessions >= 1)
  assert.ok(all.scanned.events >= 3)
  assert.ok(all.people.includes('dana'))

  // filters
  assert.equal(auditTrail({ who: 'dana' }).entries.every((e) => e.who === 'dana'), true)
  assert.equal(auditTrail({ who: 'nobody-here' }).entries.length, 0)
  assert.equal(auditTrail({ kind: 'human' }).entries.every((e) => e.kind === 'human'), true)
  // newest first
  const ts = all.entries.map((e) => Date.parse(e.at))
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a))
  // a limit is a cap, and says so
  const one = auditTrail({ limit: 1 })
  assert.equal(one.entries.length, 1)
  assert.equal(one.truncated, true)
})

test('an empty audit still reports the volume it processed', () => {
  const r = auditTrail({ who: 'someone-who-never-touched-this-board' })
  assert.equal(r.entries.length, 0)
  assert.equal(r.matched, 0)
  assert.ok(r.scanned.events > 0, 'an empty answer from a board that read nothing must not look like a quiet week')
})

test('/api/audit rejects a bad kind and answers the owner', async () => {
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const bad = await api(base, '/api/audit?kind=wizard')
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /kind is one of/)
    const ok = await api(base, '/api/audit?limit=5')
    assert.equal(ok.status, 200)
    assert.ok(Array.isArray(ok.json.entries))
    assert.ok(ok.json.scanned)
  } finally { await server.stop() }
})
