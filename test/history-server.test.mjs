// The board's history routes: the owner reads the index, a page at a time
// and one conversation lazily; a guest on a shared board gets nothing from
// the group; an id is a lookup key and never a path.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { makeHome, initRepo } from './helpers.mjs'
import { allStores, id as uuid } from './history-fixture.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME
process.env.BATON_QUIET = '1'
// agy has no home variable: its store is found under the OS home, which this
// process points at a throwaway so the developer's own is never read
process.env.USERPROFILE = join(HOME, 'os-home')
process.env.HOME = join(HOME, 'os-home')
const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')

const repo = initRepo('hsrv-')
const KEY = ['sk', 'ant', 'api03', 'SERVERKEYAAAAAAAAAAAAAAAA'].join('-')
const CANARY = { title: 'CANARY-HISTORY-TITLE-1a2b', cwd: repo, reply: `CANARY-HISTORY-REPLY-3c4d and ${KEY}` }
const stores = allStores(join(HOME, 'stores'), {
  claude: [{ id: uuid(8001), title: CANARY.title, cwd: CANARY.cwd, reply: CANARY.reply, prompts: ['x'], updated: '2026-09-16T00:00:00.000Z' }, { id: uuid(8002), title: 'second', cwd: repo, updated: '2026-09-01T00:00:00.000Z' }],
  codex: [{ id: uuid(8003), title: 'codex on the board', cwd: repo }],
})
// the providers read their homes from the environment, as the real CLIs set them
process.env.CLAUDE_CONFIG_DIR = stores.homes.claude
process.env.CODEX_HOME = stores.homes.codex
process.env.GROK_HOME = stores.homes.grok
process.env.COPILOT_HOME = stores.homes.copilot

const TOKENS = { wes: share.newToken(), sam: share.newToken() }
const SHARE = { version: 1, on: true, bind: '100.64.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: true, people: [['wes', 'owner'], ['sam', 'guest']].map(([name, role]) => ({ name, role, token_sha256: share.hashToken(TOKENS[name]), created_at: new Date().toISOString(), last_seen: null })) }

let openSrv, sharedSrv, openBase, sharedBase
before(async () => {
  openSrv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  openBase = `http://127.0.0.1:${(await openSrv.start()).port}`
  sharedSrv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: SHARE })
  sharedBase = `http://127.0.0.1:${(await sharedSrv.start()).port}`
})
after(async () => { await openSrv.stop(); await sharedSrv.stop() })

function request(base, path, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    if (body) headers['content-type'] = 'application/json'
    const req = http.request(base + path, { method, headers }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => { let json = null; try { json = JSON.parse(data) } catch {} resolvePromise({ status: r.statusCode, text: data, json }) })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test('the owner lists a page, filters, and opens one conversation whose messages are redacted', async () => {
  const r = await request(openBase, '/api/history?limit=2')
  assert.equal(r.status, 200)
  assert.equal(r.json.total, 3)
  assert.equal(r.json.records.length, 2)
  assert.equal(r.json.records[0].title, CANARY.title, 'newest first')
  assert.ok(r.json.providers.some((p) => p.name === 'claude'))
  assert.equal((await request(openBase, '/api/history?provider=codex')).json.total, 1)
  assert.equal((await request(openBase, '/api/history?search=second')).json.total, 1)
  assert.equal((await request(openBase, `/api/history?repo=${encodeURIComponent(repo)}`)).json.total, 3)
  assert.equal((await request(openBase, '/api/history?provider=nope')).status, 400)
  assert.equal((await request(openBase, '/api/history?limit=1&offset=2')).json.records.length, 1)
  assert.equal((await request(openBase, '/api/history?limit=0')).json.limit, 1, 'the API never hands the whole index over in one page')
  assert.equal((await request(openBase, '/api/history?limit=9999')).json.limit, 200)
  const d = await request(openBase, `/api/history/${encodeURIComponent(`claude:${uuid(8001)}`)}?messages=4`)
  assert.equal(d.status, 200)
  assert.equal(d.json.title, CANARY.title)
  assert.equal(d.json.messages.length, 2)
  assert.ok(d.text.includes('CANARY-HISTORY-REPLY-3c4d'))
  assert.equal(d.text.includes(KEY), false, 'a key in a discovered transcript is redacted for the owner too')
  assert.equal(d.json.resume.supported, true)
  // a prefix works, an unknown id is 404, an ambiguous one is 400
  assert.equal((await request(openBase, '/api/history/00008003')).json.provider, 'codex')
  assert.equal((await request(openBase, '/api/history/claude:99999999')).status, 404)
  assert.equal((await request(openBase, '/api/history/0000800')).status, 400)
  assert.equal((await request(openBase, '/api/history/providers')).json.providers.length, 5)
  const rf = await request(openBase, '/api/history/refresh', { method: 'POST', body: {} })
  assert.equal(rf.status, 200)
  assert.equal(rf.json.stats.find((s) => s.provider === 'claude').records, 2)
  const w = await request(openBase, '/api/worktrees?dirty=0')
  assert.equal(w.status, 200)
  assert.equal(w.json.worktrees.find((x) => x.main).conversations.count, 3)
})

test('an id is never a path: traversal shapes get 400 or 404 and nothing from disk', async () => {
  for (const p of ['/api/history/..%2f..%2fshare.json', '/api/history/%2e%2e%2f%2e%2e%2fshare.json', '/api/history/C%3A%5CWindows%5Cwin.ini', '/api/history/..%5c..%5clicense.json']) {
    const r = await request(openBase, p)
    assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`)
    assert.equal(r.text.includes('token_sha256'), false)
    assert.equal(r.text.includes('[fonts]'), false)
  }
})

test('a guest on a shared board gets nothing from history or worktrees; the owner still does', async () => {
  for (const path of ['/api/history', `/api/history/${encodeURIComponent(`claude:${uuid(8001)}`)}`, '/api/history/providers', '/api/worktrees']) {
    const g = await request(sharedBase, path, { token: TOKENS.sam })
    assert.equal(g.status, 403, `${path} for a guest → ${g.status}`)
    for (const needle of [CANARY.title, 'CANARY-HISTORY-REPLY', HOME, repo]) assert.equal(g.text.toLowerCase().includes(String(needle).toLowerCase()), false, `${path} leaked ${needle} to a guest`)
    assert.equal(g.text.toLowerCase().includes(JSON.stringify(repo).slice(1, -1).toLowerCase()), false)
  }
  const g2 = await request(sharedBase, '/api/history/refresh', { method: 'POST', token: TOKENS.sam, body: {} })
  assert.equal(g2.status, 403)
  const o = await request(sharedBase, '/api/history?limit=1', { token: TOKENS.wes })
  assert.equal(o.status, 200)
  assert.equal(o.json.total, 3)
  const none = await request(sharedBase, '/api/history')
  assert.equal(none.status, 200, 'the loopback owner without a token is the owner')
})
