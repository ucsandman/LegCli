// The board server: ledger-backed routes, SSE, static files, floor/trunk shapes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { makeHome, initRepo, ROOT } from './helpers.mjs'

// BATON_HOME must be set before the ledger module is imported (it reads it once).
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const { createBoardServer, columnsFor, columnOf } = await import('../src/server.mjs')

let srv
let base
const repo = initRepo('srv-')

before(async () => {
  srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  base = `http://127.0.0.1:${port}`
})
after(async () => { await srv.stop() })

async function api(path, { method = 'GET', body } = {}) {
  const res = await new Promise((resolvePromise, reject) => {
    const req = http.request(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => resolvePromise({ status: r.statusCode, headers: r.headers, text: data }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
  let json = null
  try { json = JSON.parse(res.text) } catch {}
  return { ...res, json }
}

test('health reports version, bind, port, home, scheduler, tools, columns', async () => {
  const r = await api('/api/health')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.bind, '127.0.0.1')
  assert.equal(r.json.home, HOME)
  assert.ok(Number.isInteger(r.json.port))
  assert.ok('max_concurrent' in r.json.scheduler)
  for (const t of ['claude', 'codex', 'gemini', 'agy', 'grok', 'chb', 'git']) assert.equal(typeof r.json.tools[t], 'boolean', t)
  assert.deepEqual(r.json.columns, ['backlog', 'queued', 'done', 'failed'])
  assert.equal(srv.server.address().address, '127.0.0.1')
})

test('POST /api/cards 201 with the summarized card; 400 on a forbidden mode; list shows it', async () => {
  const bad = await api('/api/cards', { method: 'POST', body: { repo, task: 't', chain: 'claude', mode: 'claude=bypassPermissions' } })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /forbidden mode "bypassPermissions" for claude/)
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Server-made card', chain: 'fake-claude,fake-codex', leases: 'src/**', title: 'S1', queue: true } })
  assert.equal(r.status, 201)
  const c = r.json.card
  assert.match(c.card_id, /^card-/)
  assert.equal(c.status, 'queued')
  assert.equal(c.column, 'queued')
  assert.equal(c.station, 'build')
  assert.deepEqual(c.actions, ['kill', 'reassign'])
  assert.deepEqual(c.chain_view.map((x) => x.state), ['pending', 'pending'])
  assert.equal(c.active_adapter, 'fake-claude')
  assert.equal(c.last_event.type, 'card_created')
  const list = await api('/api/cards')
  assert.ok(list.json.cards.some((x) => x.card_id === c.card_id))
  assert.deepEqual(list.json.columns, ['backlog', 'queued', 'build', 'done', 'failed'])
})

test('GET /api/cards/:id returns card, runs, events, bundle; 404 unknown; 409 illegal action; log endpoint', async () => {
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Detail card', chain: 'fake' } })
  const id = r.json.card.card_id
  const d = await api(`/api/cards/${id}`)
  assert.equal(d.status, 200)
  assert.equal(d.json.card.card_id, id)
  assert.deepEqual(d.json.runs, [])
  assert.equal(d.json.events[0].type, 'card_created')
  assert.equal(d.json.bundle, null)
  assert.equal((await api('/api/cards/card-nope')).status, 404)
  const ill = await api(`/api/cards/${id}/approve`, { method: 'POST' })
  assert.equal(ill.status, 409)
  assert.match(ill.json.error, /illegal transition backlog --approve-->/)
  const run = await api(`/api/cards/${id}/run`, { method: 'POST' })
  assert.equal(run.status, 200)
  assert.equal(run.json.card.status, 'queued')
  const kill = await api(`/api/cards/${id}/kill`, { method: 'POST' })
  assert.equal(kill.json.card.status, 'killed')
  assert.equal(kill.json.card.column, 'failed')
  const ev = await api(`/api/cards/${id}/events`)
  assert.deepEqual(ev.json.events.map((e) => e.type), ['card_created', 'killed'])
  assert.deepEqual(ev.json.events[1].actor, { type: 'human', id: 'local' })
  const lg = await api(`/api/cards/${id}/log?tail=50`)
  assert.equal(lg.status, 200)
  assert.deepEqual(lg.json.lines, [])
  const bad = await api(`/api/cards/${id}/frobnicate`, { method: 'POST' })
  assert.equal(bad.status, 404)
})

test('columns derive from the pipeline: a custom station name adds a column', async () => {
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Custom station', chain: 'fake', pipeline: JSON.stringify([{ name: 'build', kind: 'agent' }, { name: 'polish', kind: 'agent' }]) } })
  assert.equal(r.status, 201, r.text)
  const list = await api('/api/cards')
  assert.deepEqual(list.json.columns, ['backlog', 'queued', 'build', 'polish', 'done', 'failed'])
  assert.deepEqual(columnsFor([{ pipeline: [{ name: 'zz' }, { name: 'plan' }] }]), ['backlog', 'queued', 'plan', 'zz', 'done', 'failed'])
  assert.equal(columnOf({ status: 'running', station: 'polish' }), 'polish')
  assert.equal(columnOf({ status: 'killed', station: 'polish' }), 'failed')
})

test('restart persistence: a second server process over the same home lists the same cards', async () => {
  const before = (await api('/api/cards')).json.cards.map((c) => c.card_id)
  assert.ok(before.length >= 2)
  const other = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await other.start()
  const res = await new Promise((resolvePromise, reject) => http.get(`http://127.0.0.1:${port}/api/cards`, (r) => { let d = ''; r.on('data', (c) => { d += c }); r.on('end', () => resolvePromise(JSON.parse(d))) }).on('error', reject))
  await other.stop()
  assert.deepEqual(res.cards.map((c) => c.card_id).sort(), before.sort())
})

test('SSE: hello frame, then a card frame within 2 s of creating a card', async () => {
  const frames = []
  const req = http.get(base + '/api/events', (res) => {
    assert.equal(res.headers['content-type'], 'text/event-stream')
    let buf = ''
    res.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(raw)?.[1]
        const data = /^data: (.*)$/m.exec(raw)?.[1]
        frames.push({ event: ev, data: data ? JSON.parse(data) : null })
      }
    })
  })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(frames[0]?.event, 'hello')
  assert.ok(Array.isArray(frames[0].data.columns))
  const t0 = Date.now()
  const created = await api('/api/cards', { method: 'POST', body: { repo, task: 'SSE card', chain: 'fake' } })
  const id = created.json.card.card_id
  while (Date.now() - t0 < 2000 && !frames.some((f) => f.event === 'card' && f.data.card_id === id)) await new Promise((r) => setTimeout(r, 50))
  const hit = frames.find((f) => f.event === 'card' && f.data.card_id === id)
  assert.ok(hit, `card frame within 2 s; got ${frames.map((f) => f.event).join(',')}`)
  assert.equal(hit.data.column, 'backlog')
  req.destroy()
})

test('floor and trunk shapes from a seeded ledger', async () => {
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Landed one', chain: 'fake', title: 'L1' } })
  const id = r.json.card.card_id
  execFileSync(process.execPath, [join(ROOT, 'src', 'ledger.mjs'), 'append', '--card', id, '--actor', '{"type":"baton"}', '--type', 'landed', '--summary', 'landed on main: abc1234 (2 files)', '--station', 'land'], { env: process.env, encoding: 'utf8' })
  const t = await api('/api/trunk?since=1h')
  assert.equal(t.json.landed.length, 1)
  assert.equal(t.json.landed[0].card_id, id)
  assert.equal(t.json.landed[0].title, 'L1')
  assert.equal((await api('/api/trunk?since=1m')).json.landed.length, 1)
  const f = await api('/api/floor')
  for (const k of ['running', 'waiting', 'queued', 'leases', 'scheduler', 'repos', 'counts']) assert.ok(k in f.json, k)
  assert.equal(f.json.counts.queued, 1)
  assert.ok(f.json.repos.includes(repo))
  const l = await api('/api/leases')
  assert.deepEqual(l.json.leases, [])
  const a = await api('/api/adapters')
  assert.ok(a.json.adapters.some((x) => x.name === 'claude' && x.modes.default === 'acceptEdits'))
  const p = await api('/api/presets')
  assert.deepEqual(Object.keys(p.json.presets), ['factory', 'build', 'build-land'])
})

test('static: board pages and assets with correct content types; traversal and unknown api are 404', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/floor', 'text/html'], ['/board.css', 'text/css'], ['/board.js', 'text/javascript'], ['/floor.js', 'text/javascript']]) {
    const r = await api(path)
    assert.equal(r.status, 200, path)
    assert.ok(r.headers['content-type'].startsWith(type), `${path} ${r.headers['content-type']}`)
  }
  assert.match((await api('/board.css')).text, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
  assert.equal((await api('/../package.json')).status, 404)
  assert.equal((await api('/%2e%2e/package.json')).status, 404)
  assert.equal((await api('/nope.html')).status, 404)
  assert.equal((await api('/api/nope')).status, 404)
})

test('DELETE removes a non-running card', async () => {
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Remove me', chain: 'fake' } })
  const id = r.json.card.card_id
  const del = await api(`/api/cards/${id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal((await api(`/api/cards/${id}`)).status, 404)
})
