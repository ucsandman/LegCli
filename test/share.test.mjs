// `baton share`: per-human tokens, what a guest may see and do, and the
// security pass that goes with it (a token on every route including SSE, a
// lockout for guessing, a rate limit, and no terminal content for non-owners).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, sleep, testEnv, baton, batonFail } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '40'
process.env.BATON_RATE_MAX_FAILURES = '3'
const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { createSession, updateSession, takeControl, readRequests } = await import('../src/sessions.mjs')

const repo = initRepo('share-')
const TOKENS = { wes: share.newToken(), sam: share.newToken() }

function makeShare({ loopback_owner = true } = {}) {
  // built in memory and handed to the server: no file, no global state
  return {
    version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner,
    people: [['wes', 'owner'], ['sam', 'guest']].map(([name, role]) => ({ name, role, token_sha256: share.hashToken(TOKENS[name]), created_at: new Date().toISOString(), last_seen: null })),
  }
}

function request(base, path, { method = 'GET', token = null, header = true } = {}) {
  const url = new URL(base + path)
  if (token && !header) url.searchParams.set('token', token)
  return new Promise((resolvePromise, reject) => {
    const req = http.request(url, { method, headers: token && header ? { authorization: `Bearer ${token}` } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => { let json = null; try { json = JSON.parse(data) } catch {} resolvePromise({ status: r.statusCode, text: data, json, headers: r.headers }) })
    })
    req.on('error', reject)
    req.end()
  })
}

// one SSE frame, then hang up
function sse(base, token) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(`${base}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`, (r) => {
      if (r.statusCode !== 200) { r.resume(); req.destroy(); return resolvePromise({ status: r.statusCode, hello: null }) }
      let data = ''
      r.on('data', (c) => {
        data += c
        const end = data.indexOf('\n\n')
        if (end === -1) return
        const frame = data.slice(0, end)
        req.destroy()
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        resolvePromise({ status: 200, hello: JSON.parse(line.slice(6)) })
      })
    })
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err) })
  })
}

test('share units: names, tokens hashed not stored, identify, rotate, remove, whoami', () => {
  for (const ok of ['wes', 'sam-2', 'a_b']) assert.equal(share.validName(ok), true, ok)
  for (const bad of ['', '-x', 'a b', 'a'.repeat(33), 'sam!']) assert.equal(share.validName(bad), false, String(bad))
  const added = share.addPerson('wes', { role: 'owner', share: { ...share.OFF, people: [] } })
  assert.equal(added.person.token_sha256.length, 64)
  assert.equal(added.person.token_sha256.includes(added.token), false, 'the token itself is never stored')
  assert.equal(share.identify(added.share, added.token).name, 'wes')
  assert.equal(share.identify(added.share, 'not-the-token'), null)
  assert.equal(share.identify(added.share, ''), null)
  const rotated = share.rotate('wes', added.share)
  assert.notEqual(rotated.token, added.token)
  assert.equal(share.identify(rotated.share, added.token), null, 'the old link stopped working')
  assert.equal(share.identify(rotated.share, rotated.token).name, 'wes')
  assert.throws(() => share.addPerson('wes', { share: rotated.share }), /already on the board/)
  assert.throws(() => share.addPerson('bad name', { share: rotated.share }), /bad name/)
  share.removePerson('wes', rotated.share)
  assert.equal(share.identify(rotated.share, rotated.token), null)
  assert.equal(share.isOn({ on: true, people: [], bind: '1.2.3.4' }), false, 'nobody to let in is not on')
  assert.equal(share.isOn({ on: true, people: [{ name: 'x' }], bind: '1.2.3.4' }), true)
  process.env.BATON_PERSON = 'sam'
  assert.equal(share.whoami({ owner: 'wes' }), 'sam')
  delete process.env.BATON_PERSON
  assert.equal(share.whoami({ owner: 'wes' }), 'wes')
  assert.equal(share.whoami({ ...share.OFF }), 'local')
  assert.match(share.linkFor({ bind: '100.1.2.3', port: 4747 }, 'tok'), /^http:\/\/100\.1\.2\.3:4747\/\?token=tok$/)
})

// ---- a board with share on ----
let strict, strictBase, open, openBase
const OWNED = 's-share-wes'
const OTHER = 's-share-sam'

before(async () => {
  createSession({ id: OWNED, agent: 'claude', cwd: repo, repo, branch: 'main', runner_pid: process.pid, owner: 'wes' })
  updateSession(OWNED, { status: 'running', task: 'the owner private prompt', files_touched: ['secret-plan.md'] })
  createSession({ id: OTHER, agent: 'codex', cwd: repo, repo, branch: 'main', runner_pid: process.pid, owner: 'sam' })
  updateSession(OTHER, { status: 'running', task: "sam's own prompt" })
  strict = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: makeShare({ loopback_owner: false }) })
  strictBase = `http://127.0.0.1:${(await strict.start()).port}`
  open = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: makeShare() })
  openBase = `http://127.0.0.1:${(await open.start()).port}`
})
after(async () => { await strict.stop(); await open.stop() })

const ROUTES = [
  ['GET', '/api/health'], ['GET', '/api/sessions'], ['GET', `/api/sessions/${OWNED}`], ['GET', '/api/cards'], ['GET', '/api/floor'],
  ['GET', '/api/trunk'], ['GET', '/api/leases'], ['GET', '/api/presets'], ['GET', '/api/adapters'],
  ['POST', `/api/sessions/${OWNED}/handoff`], ['POST', `/api/sessions/${OWNED}/end`], ['POST', `/api/sessions/${OWNED}/land`],
  ['POST', `/api/sessions/${OWNED}/request-handoff`], ['DELETE', `/api/sessions/${OWNED}`], ['POST', '/api/cards'],
]

test('no token and a wrong token are refused on every route, SSE included', async () => {
  for (const [method, path] of ROUTES) {
    const none = await request(strictBase, path, { method })
    assert.equal(none.status, 401, `${method} ${path} without a token`)
    assert.match(none.json.error, /unauthorized/)
  }
  assert.equal((await sse(strictBase)).status, 401, 'SSE without a token')
  // a wrong token is refused too, and three of them lock this address out for a minute
  const wrong = await request(strictBase, '/api/sessions', { token: 'not-a-real-token' })
  assert.equal(wrong.status, 401)
  for (let i = 0; i < 4; i++) await request(strictBase, '/api/sessions', { token: `guess-${i}` })
  const locked = await request(strictBase, '/api/sessions', { token: TOKENS.wes })
  assert.equal(locked.status, 429, 'even the right token waits out the lockout')
  assert.ok(Number(locked.headers['retry-after']) >= 1)
})

test('the machine that runs the board is the owner on loopback; a guest needs their own link', async () => {
  const local = await request(openBase, '/api/sessions')
  assert.equal(local.status, 200)
  assert.equal(local.json.you.name, 'wes')
  assert.equal(local.json.share.on, true)
  const asGuest = await request(openBase, '/api/sessions', { token: TOKENS.sam })
  assert.equal(asGuest.json.you.name, 'sam')
  assert.equal(asGuest.json.you.role, 'guest')
})

test('a guest sees that a terminal exists and nothing it has said, read or written', async () => {
  const v = (await request(openBase, '/api/sessions', { token: TOKENS.sam })).json
  const theirs = v.sessions.find((s) => s.session_id === OWNED)
  assert.equal(theirs.hidden, true)
  assert.equal(theirs.owner, 'wes')
  assert.equal(theirs.task, null, 'no prompt')
  assert.equal(theirs.cwd, null, 'no path on this machine')
  assert.deepEqual(theirs.files, [], 'no file names')
  assert.equal(theirs.bundle, undefined, 'no bundle')
  assert.equal(theirs.transcript_path, undefined)
  assert.equal(theirs.argv, undefined)
  assert.equal(JSON.stringify(v).includes('secret-plan.md'), false, 'a file name never reaches a guest')
  assert.equal(JSON.stringify(v).includes('the owner private prompt'), false, 'a prompt never reaches a guest')
  assert.equal(JSON.stringify(v).includes(repo), false, 'the repo path never reaches a guest')
  // their own terminal is not redacted
  const own = v.sessions.find((s) => s.session_id === OTHER)
  assert.equal(own.hidden, undefined)
  assert.equal(own.task, "sam's own prompt")
  // and the trunk list keeps what landed without the path it landed in
  for (const t of v.trunk) assert.equal(t.repo, undefined)
})

test('a guest gets 403 on the owner-only routes and on another human terminal, and cannot control it', async () => {
  for (const path of ['/api/cards', '/api/floor', '/api/leases', '/api/presets', '/api/adapters']) {
    const r = await request(openBase, path, { token: TOKENS.sam })
    assert.equal(r.status, 403, path)
  }
  for (const [method, path] of [['GET', `/api/sessions/${OWNED}`], ['POST', `/api/sessions/${OWNED}/handoff`], ['POST', `/api/sessions/${OWNED}/end`], ['POST', `/api/sessions/${OWNED}/land`], ['DELETE', `/api/sessions/${OWNED}`]]) {
    const r = await request(openBase, path, { method, token: TOKENS.sam })
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.match(r.json.error, /read-only: this terminal belongs to wes/)
  }
  assert.equal(takeControl(OWNED), null, 'nothing was asked of the runner')
  // the guest's own terminal is still theirs to control
  assert.equal((await request(openBase, `/api/sessions/${OTHER}`, { token: TOKENS.sam })).status, 200)
})

test('request handoff: a guest asks, the owner approves, the runner is told who for', async () => {
  const asked = await request(openBase, `/api/sessions/${OWNED}/request-handoff`, { method: 'POST', token: TOKENS.sam })
  assert.equal(asked.status, 202)
  assert.deepEqual(readRequests(OWNED).map((r) => [r.by, r.state]), [['sam', 'pending']])
  // the owner sees the request on the card, the guest does not see the terminal at all
  const ownerView = (await request(openBase, '/api/sessions')).json.sessions.find((s) => s.session_id === OWNED)
  assert.deepEqual(ownerView.requests.map((r) => r.by), ['sam'])
  // a guest cannot approve their own request
  assert.equal((await request(openBase, `/api/sessions/${OWNED}/requests/sam/approve`, { method: 'POST', token: TOKENS.sam })).status, 403)
  assert.equal(takeControl(OWNED), null)
  const ok = await request(openBase, `/api/sessions/${OWNED}/requests/sam/approve`, { method: 'POST', token: TOKENS.wes })
  assert.equal(ok.status, 200)
  const ctl = takeControl(OWNED)
  assert.equal(ctl.handoff, true)
  assert.equal(ctl.by, 'wes for sam', 'the event trail says who it was for')
  assert.equal(readRequests(OWNED)[0].state, 'approved')
  const dismissed = await request(openBase, `/api/sessions/${OWNED}/requests/sam/dismiss`, { method: 'POST', token: TOKENS.wes })
  assert.equal(dismissed.status, 404, 'nothing pending any more')
})

test('SSE carries each human their own board: a guest gets redacted sessions and no cards', async () => {
  const guest = await sse(openBase, TOKENS.sam)
  assert.equal(guest.status, 200)
  assert.deepEqual(guest.hello.cards, [])
  const theirs = guest.hello.sessions.sessions.find((s) => s.session_id === OWNED)
  assert.equal(theirs.hidden, true)
  assert.equal(theirs.task, null)
  assert.equal(JSON.stringify(guest.hello).includes('the owner private prompt'), false)
  const owner = await sse(openBase, TOKENS.wes)
  assert.equal(owner.hello.sessions.sessions.find((s) => s.session_id === OWNED).task, 'the owner private prompt')
})

test('one client cannot flood the board: past the window it gets 429 and a Retry-After', async () => {
  let last = null
  for (let i = 0; i < 45; i++) {
    last = await request(openBase, '/api/health', { token: TOKENS.sam })
    if (last.status === 429) break
  }
  assert.equal(last.status, 429, 'the rate limit stopped the flood')
  assert.ok(Number(last.headers['retry-after']) >= 1)
  assert.match(last.json.error, /rate limit/)
  await sleep(10)
})

test('a guest only gets the health a guest needs: no home path, no tools, no cards', async () => {
  const h = (await request(openBase, '/api/health', { token: TOKENS.wes })).json
  assert.ok(h.home && h.tools, 'the owner still gets the full health')
  const strictShare = makeShare()
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: strictShare })
  const base = `http://127.0.0.1:${(await srv.start()).port}`
  try {
    const g = (await request(base, '/api/health', { token: TOKENS.sam })).json
    assert.equal(g.ok, true)
    assert.equal(g.you.name, 'sam')
    assert.equal(g.home, undefined)
    assert.equal(g.tools, undefined)
    assert.equal(g.bind, undefined)
    assert.equal(g.cards, undefined)
  } finally { await srv.stop() }
})

test('baton share: off by default, on writes share.json, a link is printed once and the token is never stored', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_PORT: '4999' })
  const readShareFile = () => JSON.parse(readFileSync(join(home, 'share.json'), 'utf8'))
  assert.match(baton(['share'], env), /share is off/)
  const on = baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4999', '--owner', 'wes'], env)
  assert.match(on, /share is on: the board is at http:\/\/127\.0\.0\.1:4999/)
  assert.match(on, /No TLS/)
  const link = /http:\/\/127\.0\.0\.1:4999\/\?token=([\w-]+)/.exec(on)
  assert.ok(link, on)
  const file = readShareFile()
  assert.equal(file.on, true)
  assert.equal(file.people[0].name, 'wes')
  assert.equal(file.people[0].role, 'owner')
  assert.equal(readFileSync(join(home, 'share.json'), 'utf8').includes(link[1]), false, 'the token itself is never written down')
  assert.equal(share.hashToken(link[1]), file.people[0].token_sha256)
  const added = baton(['share', 'add', 'sam'], env)
  assert.match(added, /sam is on the board \(guest\)/)
  assert.match(added, /read-only: no prompts, no file names, no logs, no bundles/)
  const samToken = /token=([\w-]+)/.exec(added)[1]
  const status = baton(['share'], env)
  assert.match(status, /share is on: http:\/\/127\.0\.0\.1:4999/)
  assert.match(status, /sam\s+guest/)
  assert.equal(status.includes(samToken), false, 'status never reprints a token')
  const rotated = baton(['share', 'rotate', 'sam'], env)
  const newToken = /token=([\w-]+)/.exec(rotated)[1]
  assert.notEqual(newToken, samToken)
  assert.equal(share.identify(readShareFile(), samToken), null, 'the old link stopped working')
  assert.equal(share.identify(readShareFile(), newToken).name, 'sam')
  assert.match(batonFail(['share', 'add', 'bad name'], env).stderr, /bad name/)
  assert.match(batonFail(['share', 'rotate', 'nobody'], env).stderr, /no one called/)
  baton(['share', 'rm', 'sam'], env)
  assert.equal(readShareFile().people.length, 1)
  baton(['share', 'off'], env)
  assert.equal(readShareFile().on, false)
  assert.match(baton(['share'], env), /share is off/)
})

test('a board that asks for a token is still a board: ensureBoard finds it instead of starting a second one', async () => {
  const { writeFileSync } = await import('node:fs')
  const { ensureBoard } = await import('../src/attach.mjs')
  const s = makeShare()
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: s })
  const { port } = await srv.start()
  writeFileSync(join(HOME, 'share.json'), JSON.stringify({ ...s, port }))
  try {
    const r = await ensureBoard({ open: false })
    assert.equal(r.started, false, 'the guarded board answered 401 and that counts as up')
    assert.equal(r.url, `http://127.0.0.1:${port}`)
  } finally { await srv.stop() }
})
