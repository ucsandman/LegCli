// The launcher: dry run spawns nothing; up → health → status → down; redaction
// of a child's output; no shell anywhere in src/ or bin/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, baton, batonFail, ROOT, BATON, sleep } from './helpers.mjs'

test('up --dry prints every would-be argv as JSON, creates no process and no pidfile', () => {
  const home = makeHome()
  const env = testEnv(home)
  const outText = baton(['up', '--dry', '--port', '4799'], env)
  assert.match(outText, /\[preflight\] node\s+ok/)
  assert.match(outText, /\[preflight\] (claude|codex|agy)\s+(ok|missing)/)
  assert.match(outText, /dry run: nothing spawned/)
  const m = /\[baton\] server: (\[.*?\]) env (\{.*?\})/.exec(outText)
  assert.ok(m, outText)
  const argv = JSON.parse(m[1])
  assert.equal(argv[0], process.execPath)
  assert.ok(argv[1].endsWith('server.mjs'))
  assert.deepEqual(JSON.parse(m[2]), { BATON_PORT: '4799', BATON_BIND: '127.0.0.1' })
  assert.match(outText, /sync:workboard: off/)
  assert.ok(!existsSync(join(home, 'baton.pid')))
})

function get(url) {
  return new Promise((resolvePromise, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c }); r.on('end', () => resolvePromise({ status: r.statusCode, text: d })) }).on('error', reject)
  })
}

test('up --no-open --port 0: health 200, status running, down closes the port and removes the pidfile', async (t) => {
  const home = makeHome()
  const env = testEnv(home, { BATON_HEALTH_TIMEOUT_MS: '30000' })
  const child = spawn(process.execPath, [BATON, 'up', '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let outText = ''
  child.stdout.on('data', (d) => { outText += d })
  child.stderr.on('data', (d) => { outText += d })
  const t0 = Date.now()
  while (!existsSync(join(home, 'baton.pid')) && Date.now() - t0 < 30000) await sleep(200)
  assert.ok(existsSync(join(home, 'baton.pid')), `pidfile within 30 s; output so far:\n${outText}`)
  const pf = JSON.parse(readFileSync(join(home, 'baton.pid'), 'utf8'))
  assert.equal(pf.pid, child.pid)
  assert.ok(pf.port > 0)
  assert.equal(pf.children.length, 1)
  const h = await get(`http://127.0.0.1:${pf.port}/api/health`)
  assert.equal(h.status, 200)
  while (!/\[baton\] ready http/.test(outText) && Date.now() - t0 < 30000) await sleep(100)
  t.diagnostic(outText.split('\n').slice(0, 20).join('\n'))
  assert.match(outText, /\[server\] \[board\] .* listening on http:\/\/127\.0\.0\.1:\d+/)
  assert.match(outText, new RegExp(`\\[baton\\] ready http://127\\.0\\.0\\.1:${pf.port}`))
  assert.ok(!/opened http/.test(outText), '--no-open skips the browser')

  const st = baton(['status'], env)
  assert.match(st, new RegExp(`\\[baton\\] running  pid ${pf.pid}  port ${pf.port}`))
  const dn = baton(['down'], env)
  assert.match(dn, /\[baton\] stopped \(pid/)
  await new Promise((r) => child.on('exit', r))
  assert.ok(!existsSync(join(home, 'baton.pid')))
  let closed = false
  try { await get(`http://127.0.0.1:${pf.port}/api/health`) } catch { closed = true }
  assert.equal(closed, true, 'port closed after down')
  const after = batonFail(['status'], env)
  assert.equal(after.status, 3)
  assert.match(after.stdout, /\[baton\] stopped/)
})

test('a child that prints a secret shows [REDACTED] on the launcher stdout; held env values never appear', async () => {
  const home = makeHome()
  const stub = join(home, 'stub-server.mjs')
  const fakeKey = ['sk', 'abcdefgh12345678'].join('-')
  const planted = ['planted', 'value', '9f8e7d6c', 'zz'].join('-')
  // A stand-in server: prints a fake key and the planted env value, then serves /api/health.
  writeFileSync(stub, `import http from 'node:http'
process.stdout.write('api_key=' + process.env.STUB_FAKE_KEY + ' leaked\\n')
process.stdout.write('token ' + process.env.OPENAI_API_KEY + '\\n')
const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, cards: 0 })) })
srv.listen(Number(process.env.BATON_PORT), '127.0.0.1', () => process.stdout.write('[board] x listening on http://127.0.0.1:' + srv.address().port + '\\n'))
`)
  const env = testEnv(home, { BATON_SERVER_SCRIPT: stub, STUB_FAKE_KEY: fakeKey, OPENAI_API_KEY: planted, BATON_HEALTH_TIMEOUT_MS: '20000' })
  const child = spawn(process.execPath, [BATON, 'up', '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let outText = ''
  child.stdout.on('data', (d) => { outText += d })
  child.stderr.on('data', (d) => { outText += d })
  const t0 = Date.now()
  while (!/\[baton\] ready http/.test(outText) && Date.now() - t0 < 20000) await sleep(100)
  child.kill()
  await new Promise((r) => child.on('exit', r))
  // the key=value pattern swallows the whole `api_key=<value>` token
  assert.match(outText, /\[server\] \[REDACTED\] leaked/)
  assert.match(outText, /\[server\] token \[REDACTED\]/)
  assert.ok(!outText.includes(fakeKey.slice(0, 8)), 'fake key must not appear')
  assert.ok(!outText.includes('planted'), 'held env value must not appear')
})

test('no shell in src/ or bin/: no shell: true, exec(, execSync(; every child is spawn/execFile with argv', () => {
  const files = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.mjs$/.test(n)) files.push(p) } }
  walk(join(ROOT, 'src')); walk(join(ROOT, 'bin'))
  const hits = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    if (/shell:\s*true/.test(src)) hits.push(`${f}: shell: true`)
    if (/(^|[^a-zA-Z_.])exec\(/.test(src)) hits.push(`${f}: exec(`)
    if (/(^|[^a-zA-Z_.])execSync\(/.test(src)) hits.push(`${f}: execSync(`)
  }
  assert.deepEqual(hits, [])
})
