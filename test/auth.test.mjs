// The auth seam: non-loopback binds need BATON_TOKEN; with a token every
// /api request needs the bearer header; loopback without a token is open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { makeHome, ROOT } from './helpers.mjs'
import { checkBind, BindRefused, tokenMatches, isLoopback, authorize } from '../src/auth.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const { createBoardServer } = await import('../src/server.mjs')

function get(url, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    http.get(url, { headers }, (r) => { let d = ''; r.on('data', (c) => { d += c }); r.on('end', () => resolvePromise({ status: r.statusCode, text: d, headers: r.headers })); r.resume() }).on('error', reject)
  })
}

test('isLoopback / tokenMatches / authorize units', () => {
  for (const b of ['127.0.0.1', '::1', 'localhost']) assert.equal(isLoopback(b), true, b)
  for (const b of ['0.0.0.0', '192.168.1.5', '', undefined]) assert.equal(isLoopback(b), false, String(b))
  assert.equal(tokenMatches('abc', 'abc'), true)
  assert.equal(tokenMatches('abc', 'abd'), false)
  assert.equal(tokenMatches('abc', 'ab'), false)
  assert.equal(tokenMatches('', ''), false)
  assert.deepEqual(authorize({ token: '', req: { headers: {} }, url: new URL('http://x/api/health') }), { ok: true, subject: 'local' })
  assert.equal(authorize({ token: 't', req: { headers: {} }, url: new URL('http://x/api/health') }).ok, false)
  assert.equal(authorize({ token: 't', req: { headers: { authorization: 'Bearer t' } }, url: new URL('http://x/api/health') }).ok, true)
  assert.equal(authorize({ token: 't', req: { headers: {} }, url: new URL('http://x/api/events?token=t') }).ok, true)
})

test('non-loopback bind without BATON_TOKEN refuses to start (module) and exits 3 (process) with the named error', () => {
  assert.throws(() => checkBind({ bind: '0.0.0.0', token: '' }), (e) => e instanceof BindRefused && /refusing to bind 0\.0\.0\.0 without BATON_TOKEN; see README "Network exposure"/.test(e.message))
  assert.throws(() => createBoardServer({ bind: '192.168.1.5', port: 0, token: '', scheduler: false }), BindRefused)
  assert.doesNotThrow(() => checkBind({ bind: '0.0.0.0', token: 'secret' }))
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'server.mjs')], { env: { ...process.env, BATON_BIND: '0.0.0.0', BATON_TOKEN: '', BATON_PORT: '0', BATON_NO_SCHEDULER: '1' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /refusing to bind 0\.0\.0\.0 without BATON_TOKEN/)
})

test('with a token: 401 without the header, 401 with a wrong token, 200 with the right one, SSE via ?token=', async () => {
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: 'hunter2-hunter2', scheduler: false })
  const { port } = await srv.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const none = await get(`${base}/api/health`)
    assert.equal(none.status, 401)
    assert.match(none.text, /unauthorized/)
    assert.equal((await get(`${base}/api/health`, { authorization: 'Bearer nope-nope-nope' })).status, 401)
    const ok = await get(`${base}/api/health`, { authorization: 'Bearer hunter2-hunter2' })
    assert.equal(ok.status, 200)
    // static pages stay reachable; only /api is gated
    assert.equal((await get(`${base}/`)).status, 200)
    const sse = await new Promise((resolvePromise, reject) => {
      const req = http.get(`${base}/api/events?token=hunter2-hunter2`, (r) => { resolvePromise({ status: r.statusCode, type: r.headers['content-type'] }); req.destroy() })
      req.on('error', reject)
    })
    assert.equal(sse.status, 200)
    assert.equal(sse.type, 'text/event-stream')
    assert.equal((await get(`${base}/api/events?token=wrong`)).status, 401)
  } finally {
    await srv.stop()
  }
})

test('loopback without a token is open', async () => {
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  try {
    assert.equal((await get(`http://127.0.0.1:${port}/api/health`)).status, 200)
  } finally {
    await srv.stop()
  }
})
