import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeHome } from './helpers.mjs'

process.env.BATON_HOME = makeHome()
process.env.BATON_QUIET = '1'

const { createBoardServer } = await import('../src/server.mjs')

let server
let port

before(async () => {
  server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  port = (await server.start()).port
})

after(async () => { await server.stop() })

function request(path, { method = 'GET', host = `127.0.0.1:${port}`, origin, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: host,
        ...(origin && { Origin: origin }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test('tokenless loopback owner rejects a DNS-rebound Host on reads and writes', async () => {
  const host = `attacker.example:${port}`
  const read = await request('/api/health', { host })
  assert.equal(read.status, 401)

  const write = await request('/api/cards', {
    method: 'POST',
    host,
    origin: `http://${host}`,
    body: { repo: process.cwd(), task: 'must not be created' },
  })
  assert.equal(write.status, 401)

  const local = await request('/api/health')
  assert.equal(local.status, 200)
})
