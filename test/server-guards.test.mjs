// The board's guards: turning share off revokes a guest's stream instead of
// promoting it, the machine's own page cannot lock itself out with one stale
// token, a bucket per address when nobody is named, a guest's topbar carries no
// scheduler, a redacted terminal still says which branch it lands, and Remove
// never discards commits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git, testEnv, baton, batonFail, sleep } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
delete process.env.BATON_TOKEN
delete process.env.BATON_BIND
delete process.env.BATON_PERSON
// node runs these tests concurrently: the two rate-limit tests set their own
// numbers in the one synchronous step that builds their own server
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'
const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { createSession, updateSession, sessionDir } = await import('../src/sessions.mjs')
const { createCard } = await import('../src/cards.mjs')
const { worktreePath, branchName } = await import('../src/worktree.mjs')

const repo = initRepo('guards-')
const TOKENS = { wes: share.newToken(), sam: share.newToken() }
const CANARY = 'CANARY-GUARD-TASK-4e1d the owner private prompt'
const OWNED = 's-guard-wes'

function roster(on = true) {
  return {
    version: 1, on, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: true,
    people: [['wes', 'owner'], ['sam', 'guest']].map(([name, role]) => ({ name, role, token_sha256: share.hashToken(TOKENS[name]), created_at: new Date().toISOString(), last_seen: null })),
  }
}

function request(base, path, { method = 'GET', token = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(new URL(base + path), { method, headers: token ? { authorization: `Bearer ${token}` } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { /* not json */ } resolvePromise({ status: r.statusCode, text: data, json, headers: r.headers }) })
    })
    req.on('error', reject)
    req.end()
  })
}

// Open an SSE stream, do something while it is open, keep every frame.
function sseCollect(base, token, { ms = 1500, whileOpen = async () => {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(`${base}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`, (r) => {
      if (r.statusCode !== 200) { r.resume(); req.destroy(); return resolvePromise({ status: r.statusCode, frames: [] }) }
      let buf = ''
      const frames = []
      let ended = false
      r.on('end', () => { ended = true })
      r.on('data', (c) => {
        buf += c
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const lines = chunk.split('\n')
          const event = (lines.find((l) => l.startsWith('event: ')) ?? 'event: message').slice(7)
          const dataLine = lines.find((l) => l.startsWith('data: '))
          frames.push({ event, text: dataLine ? dataLine.slice(6) : '' })
        }
      })
      Promise.resolve()
        .then(whileOpen)
        .then(() => sleep(ms))
        .then(() => { req.destroy(); resolvePromise({ status: 200, frames, ended }) })
        .catch((err) => { req.destroy(); reject(err) })
    })
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(new Error(`sse: ${err.code ?? err.message}`)) })
  })
}

// wes's terminal, with a bounced landing: the guest sees that it exists
createSession({ id: OWNED, agent: 'claude', cwd: repo, repo, branch: 'main', owner: 'wes' })
updateSession(OWNED, { status: 'running', task: CANARY, worktree: { path: join(repo, '.baton-worktrees', OWNED), branch: `baton/${OWNED}`, base: 'main' } })
writeFileSync(join(sessionDir(OWNED), 'land.json'), JSON.stringify({
  state: 'bounced', at: new Date().toISOString(), by: 'wes', branch: `baton/${OWNED}`, base: 'main', reason: 'tests-red',
}))

test('share off revokes a guest\'s live stream instead of promoting it to owner', async () => {
  writeFileSync(join(HOME, 'share.json'), JSON.stringify(roster(true)))
  // no explicit share: this board re-reads share.json per push, as the real one does
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  try {
    const guest = await sseCollect(`http://127.0.0.1:${port}`, TOKENS.sam, {
      ms: 1800,
      whileOpen: async () => {
        await sleep(300)
        writeFileSync(join(HOME, 'share.json'), JSON.stringify(roster(false)))
        await sleep(300)
        updateSession(OWNED, { turns: 4 })
        await sleep(400)
        updateSession(OWNED, { turns: 5 })
      },
    })
    assert.equal(guest.status, 200)
    assert.ok(guest.frames.length >= 1, 'the guest got their hello frame')
    const leaked = guest.frames.filter((f) => f.text.includes(CANARY))
    assert.deepEqual(leaked.map((f) => f.event), [], `share off handed the guest ${leaked.length} unredacted frame(s) of someone else's terminal`)
  } finally {
    await srv.stop()
    writeFileSync(join(HOME, 'share.json'), JSON.stringify(roster(true)))
  }
})

test('one stale token repeated from this machine is not a guessing attack', async () => {
  process.env.BATON_RATE_MAX_FAILURES = '3'
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster(true) })
  process.env.BATON_RATE_MAX_FAILURES = '5000'
  const { port } = await srv.start()
  const base = `http://127.0.0.1:${port}`
  try {
    // a /floor tab whose token was rotated: the same dead token, 60 times a minute
    const stale = share.newToken()
    for (let i = 0; i < 10; i++) assert.equal((await request(base, '/api/sessions', { token: stale })).status, 401, `poll ${i}`)
    const mine = await request(base, '/api/sessions')
    assert.equal(mine.status, 200, 'the machine\'s own tokenless browser is locked out of its own board')
    assert.equal(mine.json.you.name, 'wes')
    // and a real guess, four different tokens, still locks the address out
    for (let i = 0; i < 4; i++) await request(base, '/api/sessions', { token: `${share.newToken()}-${i}` })
    const locked = await request(base, '/api/sessions')
    assert.equal(locked.status, 429, 'four distinct bad tokens still lock the address out')
    assert.match(locked.json.error, /too many bad tokens/)
  } finally { await srv.stop() }
})

test('with share off and BATON_TOKEN set, the rate limit is per address, not one bucket for everyone', async () => {
  // dual stack: 127.0.0.1 and ::1 are two clients holding the same token
  process.env.BATON_RATE_MAX = '5'
  const srv = createBoardServer({ bind: '::', port: 0, token: 'guards-token-guards', scheduler: false, share: { ...share.OFF } })
  process.env.BATON_RATE_MAX = '5000'
  const { port } = await srv.start()
  try {
    let first429 = -1
    for (let i = 0; i < 6; i++) {
      const r = await request(`http://127.0.0.1:${port}`, '/api/health', { token: 'guards-token-guards' })
      if (r.status === 429) { first429 = i; break }
    }
    assert.equal(first429, 5, 'the sixth request from one address is the first 429')
    const other = await request(`http://[::1]:${port}`, '/api/health', { token: 'guards-token-guards' })
    assert.equal(other.status, 200, 'the second client shared the first one\'s bucket')
  } finally { await srv.stop() }
})

test('a redacted terminal still names the branch it is landing', async () => {
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster(true) })
  const { port } = await srv.start()
  try {
    const seen = await request(`http://127.0.0.1:${port}`, '/api/sessions', { token: TOKENS.sam })
    assert.equal(seen.status, 200)
    const wes = seen.json.sessions.find((s) => s.session_id === OWNED)
    assert.equal(wes.hidden, true, 'the guest sees a redacted terminal')
    assert.equal(wes.land.branch, `baton/${OWNED}`, 'a redacted landing says which branch it is landing')
    assert.equal(wes.land.base, 'main')
    assert.equal(wes.task, null)
  } finally { await srv.stop() }
})

test('a guest\'s stream carries no scheduler state', async () => {
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster(true) })
  const { port } = await srv.start()
  try {
    // the health tick is the one push that was not a function of the viewer
    const guest = await sseCollect(`http://127.0.0.1:${port}`, TOKENS.sam, { ms: 11500 })
    const health = guest.frames.filter((f) => f.event === 'health')
    assert.ok(health.length >= 1, `no health frame arrived in 11.5 s (frames: ${guest.frames.map((f) => f.event).join(',')})`)
    for (const f of health) assert.equal(JSON.parse(f.text).scheduler, undefined, `a guest's topbar was handed the scheduler state: ${f.text}`)
  } finally { await srv.stop() }
})

test('removing a card with ?branch=delete never discards commits the branch alone carries', async () => {
  const card = await createCard({ repo, task: 'guards: unlanded work', title: 'guards branch', chain: 'claude' }, { type: 'human', id: 'wes' })
  const id = card.card_id
  const branch = branchName(id)
  const wt = worktreePath(repo, id)
  git(repo, ['worktree', 'add', '-b', branch, wt, 'main'])
  writeFileSync(join(wt, 'work.md'), '# the agent committed this and never landed it\n')
  git(wt, ['add', 'work.md'])
  git(wt, ['commit', '-q', '-m', 'work the card never landed'])
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: { ...share.OFF } })
  const { port } = await srv.start()
  try {
    const r = await request(`http://127.0.0.1:${port}`, `/api/cards/${id}?branch=delete`, { method: 'DELETE' })
    assert.equal(r.status, 409, `unlanded commits must not be deleted without ?force=1 (got ${r.status}: ${r.text.slice(0, 200)})`)
    assert.match(git(repo, ['branch', '--list', branch]), new RegExp(branch.replace('/', '\\/')), 'the branch with the only copy of the work is gone')
    const forced = await request(`http://127.0.0.1:${port}`, `/api/cards/${id}?branch=delete&force=1`, { method: 'DELETE' })
    assert.equal(forced.status, 200, 'an explicit force still removes the card and its branch')
    assert.equal(git(repo, ['branch', '--list', branch]).trim(), '', 'force deletes the branch')
  } finally { await srv.stop() }
})

test('`leg sessions rm` refuses while land.json says the session is landing', () => {
  const id = 's-guard-landing'
  const env = testEnv(HOME)
  createSession({ id, agent: 'claude', cwd: repo, repo, branch: 'main', owner: 'wes' })
  updateSession(id, { status: 'ended' })
  writeFileSync(join(sessionDir(id), 'land.json'), JSON.stringify({ state: 'landing', at: new Date().toISOString(), by: 'wes', branch: `baton/${id}`, base: 'main' }))
  const r = batonFail(['sessions', 'rm', id], env)
  assert.equal(r.status, 3, `a land is in flight; stdout: ${r.stdout} stderr: ${r.stderr}`)
  assert.match(r.stderr, /land/)
  assert.ok(existsSync(sessionDir(id)), 'the record the landing is about to write to is still there')
  writeFileSync(join(sessionDir(id), 'land.json'), JSON.stringify({ state: 'landed', at: new Date().toISOString(), by: 'wes', branch: `baton/${id}`, base: 'main' }))
  assert.match(baton(['sessions', 'rm', id], env), /removed/, 'a finished landing does not block the removal')
})
