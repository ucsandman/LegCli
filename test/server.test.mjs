// The board server: ledger-backed routes, SSE, static files, floor/trunk shapes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { makeHome, initRepo, ROOT, git, sleep } from './helpers.mjs'
import { canonPath } from '../src/fsx.mjs'

// BATON_HOME must be set before the ledger module is imported (it reads it once).
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const { createBoardServer, columnsFor, columnOf } = await import('../src/server.mjs')
const usage = await import('../src/usage.mjs')

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
  for (const t of ['claude', 'codex', 'agy', 'grok', 'chb', 'git']) assert.equal(typeof r.json.tools[t], 'boolean', t)
  assert.deepEqual(r.json.columns, ['backlog', 'queued', 'done', 'failed'])
  assert.equal(srv.server.address().address, '127.0.0.1')
})

test('idle Codex quota polling is opt-in, injected, and single-flight at startup', async () => {
  let reads = 0
  const polling = createBoardServer({
    bind: '127.0.0.1',
    port: 0,
    token: '',
    scheduler: false,
    usagePolling: true,
    usageReader: async () => {
      reads += 1
      return { ok: true, available: true, observed_at: new Date().toISOString(), limits: { five_hour: null, seven_day: { pct: 25, resets_at: 2_000_000_000, window_minutes: 10080 } } }
    },
  })
  try {
    await polling.start()
    await sleep(50)
    assert.equal(reads, 1)
    assert.equal(usage.readUsage('codex', 'default').seven_day.pct, 25)
  } finally {
    await polling.stop()
  }
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

test('sessions API: view, handoff/end control, delete, lost reaper', async () => {
  const { createSession, updateSession, takeControl, readSession } = await import('../src/sessions.mjs')
  createSession({ id: 's-t-claude', agent: 'claude', cwd: repo, repo, branch: 'main', runner_pid: process.pid })
  updateSession('s-t-claude', { status: 'running', files_touched: ['a.txt'] })
  createSession({ id: 's-t-codex', agent: 'codex', cwd: repo, repo, branch: 'main', runner_pid: process.pid })
  updateSession('s-t-codex', { status: 'running', files_dirty: ['a.txt'] })
  createSession({ id: 's-t-dead', agent: 'agy', cwd: repo, repo, branch: 'main', runner_pid: 999999999 })
  updateSession('s-t-dead', { status: 'running' })
  let r = await api('/api/sessions')
  assert.equal(r.status, 200)
  const byId = Object.fromEntries(r.json.sessions.map((s) => [s.session_id, s]))
  assert.deepEqual(byId['s-t-claude'].overlap.map((o) => o.files), [['a.txt']], 'overlap flagged both ways')
  assert.equal(byId['s-t-codex'].overlap[0].session_id, 's-t-claude')
  assert.equal(byId['s-t-dead'].status, 'lost', 'dead runner pid is reaped')
  assert.ok(r.json.accounts.some((a) => a.agent === 'claude' && a.account === 'default'))
  assert.equal(r.json.trunk[0].branch, 'main')
  assert.ok(r.json.trunk[0].commits.length >= 1)
  r = await api('/api/sessions/s-t-claude/handoff', { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(takeControl('s-t-claude').handoff, true)
  r = await api('/api/sessions/s-t-dead/handoff', { method: 'POST' })
  assert.equal(r.status, 409, 'not active')
  r = await api('/api/sessions/s-t-claude', { method: 'DELETE' })
  assert.equal(r.status, 409, 'active sessions cannot be removed')
  r = await api('/api/sessions/s-t-dead', { method: 'DELETE' })
  assert.equal(r.status, 200)
  assert.equal(readSession('s-t-dead'), null)
  r = await api('/api/sessions/s-t-claude')
  assert.equal(r.json.events[0].type, 'started')
})

test('session record-only removal preserves unmerged and dirty work', async () => {
  const { createSession, updateSession, readSession } = await import('../src/sessions.mjs')
  const { ensure } = await import('../src/worktree.mjs')
  const lrepo = initRepo('srv-remove-record-')
  const id = 's-remove-record-claude'
  const wt = ensure(lrepo, id, { trunk: 'main' })
  writeFileSync(join(wt.path, 'committed.txt'), 'keep this commit\n')
  git(wt.path, ['add', 'committed.txt'])
  git(wt.path, ['commit', '-q', '-m', 'unlanded terminal work'])
  writeFileSync(join(wt.path, 'dirty.txt'), 'keep this dirty file\n')
  createSession({ id, agent: 'claude', cwd: wt.path, repo: lrepo, branch: wt.branch, runner_pid: process.pid, worktree: { path: wt.path, branch: wt.branch, base: 'main' } })
  updateSession(id, { status: 'ended' })

  let r = await api(`/api/sessions/${id}`, { method: 'DELETE' })
  assert.equal(r.status, 409, 'unforced remove must not orphan unmerged or dirty work')
  assert.ok(readSession(id), 'the guarded request keeps the Baton record')
  assert.match(r.json.error, /uncommitted changes/)

  r = await api(`/api/sessions/${id}?keep_worktree=1`, { method: 'DELETE' })
  assert.equal(r.status, 400, 'record-only removal requires explicit force')
  assert.ok(readSession(id), 'missing force keeps the Baton record')

  r = await api(`/api/sessions/${id}?force=1&keep_worktree=1`, { method: 'DELETE' })
  assert.equal(r.status, 200)
  assert.equal(r.json.worktree.preserved, true)
  assert.equal(readSession(id), null, 'only the Baton record is removed')
  assert.equal(existsSync(wt.path), true, 'worktree remains')
  assert.equal(existsSync(join(wt.path, 'committed.txt')), true, 'committed file remains')
  assert.equal(existsSync(join(wt.path, 'dirty.txt')), true, 'dirty file remains')
  assert.match(git(wt.path, ['status', '--porcelain']), /dirty\.txt/)
  assert.match(git(wt.path, ['log', '--oneline', '-1']), /unlanded terminal work/)
  assert.match(git(lrepo, ['branch', '--list', wt.branch]), new RegExp(wt.branch.replace('/', '\\/')), 'branch remains')
})

test('session record-only removal rejects active and landing sessions', async () => {
  const { createSession, updateSession, readSession, readLand } = await import('../src/sessions.mjs')
  const { ensure } = await import('../src/worktree.mjs')
  const lrepo = initRepo('srv-remove-guard-')
  const activeId = 's-remove-record-active'
  createSession({ id: activeId, agent: 'claude', cwd: lrepo, repo: lrepo, branch: 'main', runner_pid: process.pid })
  updateSession(activeId, { status: 'running' })
  let r = await api(`/api/sessions/${activeId}?force=1&keep_worktree=1`, { method: 'DELETE' })
  assert.equal(r.status, 409, 'active sessions cannot be removed even with explicit preservation')
  assert.ok(readSession(activeId))

  const id = 's-remove-record-landing'
  const wt = ensure(lrepo, id, { trunk: 'main' })
  writeFileSync(join(wt.path, 'package.json'), JSON.stringify({ scripts: { test: 'node slow-test.mjs' } }))
  writeFileSync(join(wt.path, 'slow-test.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('test-started', 'yes')\nsetTimeout(() => process.exit(0), 1000)\n")
  createSession({ id, agent: 'claude', cwd: wt.path, repo: lrepo, branch: wt.branch, runner_pid: process.pid, worktree: { path: wt.path, branch: wt.branch, base: 'main' } })
  updateSession(id, { status: 'ended', task: 'exercise asynchronous landing test' })
  r = await api(`/api/sessions/${id}/land`, { method: 'POST' })
  assert.equal(r.status, 202)
  const deadline = Date.now() + 5000
  while (!existsSync(join(wt.path, 'test-started')) && Date.now() < deadline) await sleep(25)
  assert.equal(existsSync(join(wt.path, 'test-started')), true, 'the asynchronous package test started')
  assert.equal(readLand(id)?.state, 'landing')
  r = await api(`/api/sessions/${id}?force=1&keep_worktree=1`, { method: 'DELETE' })
  assert.equal(r.status, 409, 'a record being written by Land cannot be removed')
  assert.ok(readSession(id), 'the landing record remains while tests run')
})

test('Land: a worktree session lands through the merge queue, a clashing one bounces naming the file, the checkout session has no branch, trunk says who landed', async () => {
  const { createSession, updateSession, readLandings } = await import('../src/sessions.mjs')
  const { ensure } = await import('../src/worktree.mjs')
  const lrepo = initRepo('srv-land-')
  for (const [id, agent] of [['s-land-claude', 'claude'], ['s-land-codex', 'codex']]) {
    const wt = ensure(lrepo, id, { trunk: 'main' })
    createSession({ id, agent, cwd: wt.path, repo: lrepo, branch: wt.branch, runner_pid: process.pid, worktree: { path: wt.path, branch: wt.branch, base: 'main' } })
    updateSession(id, { status: 'running', task: `edit the README as ${agent}` })
    writeFileSync(join(wt.path, 'README.md'), `# toy\n${agent} was here\n`) // left uncommitted, the way agents leave work
  }
  createSession({ id: 's-land-root', agent: 'agy', cwd: lrepo, repo: lrepo, branch: 'main', runner_pid: process.pid })
  updateSession('s-land-root', { status: 'running' })
  const landState = async (id, want) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      const v = (await api('/api/sessions')).json
      const s = v.sessions.find((x) => x.session_id === id)
      if (s.land?.state === want) return { s, v }
      await sleep(100)
    }
    assert.fail(`${id} never reached ${want}`)
  }

  let r = await api('/api/sessions/s-land-root/land', { method: 'POST' })
  assert.equal(r.status, 409)
  assert.match(r.json.error, /no branch of its own/)

  r = await api('/api/sessions/s-land-claude/land', { method: 'POST' })
  assert.equal(r.status, 202)
  const { s: landed, v } = await landState('s-land-claude', 'landed')
  assert.deepEqual(landed.land.files, ['README.md'])
  assert.equal(landed.land.tested, false, 'no test command in the toy repo')
  assert.match(git(lrepo, ['show', 'main:README.md']), /claude was here/)
  const t = v.trunk.find((x) => canonPath(x.repo) === canonPath(lrepo))
  assert.equal(t.commits[0].landed_by.session_id, 's-land-claude', 'the trunk list says who landed it')
  assert.equal(t.commits[0].landed_by.agent, 'claude')
  assert.equal(t.commits[1].landed_by, undefined, 'the init commit was not a Land')
  const entry = readLandings().filter((l) => l.session_id === 's-land-claude')
  assert.equal(entry.length, 1)
  assert.equal(entry[0].commits.length, 1)
  assert.equal(entry[0].by, 'local')

  r = await api('/api/sessions/s-land-codex/land', { method: 'POST' })
  assert.equal(r.status, 202)
  const { s: bounced } = await landState('s-land-codex', 'bounced')
  assert.equal(bounced.land.reason, 'rebase-conflict')
  assert.match(bounced.land.detail, /conflicted in: README\.md/)
  assert.doesNotMatch(git(lrepo, ['show', 'main:README.md']), /codex was here/)
  const types = (await api('/api/sessions/s-land-codex')).json.events.map((e) => e.type)
  assert.ok(types.includes('land_requested') && types.includes('bounced'), types.join(','))

  // Remove takes a landed, clean worktree with the session; a bounced branch is kept
  updateSession('s-land-claude', { status: 'ended' })
  updateSession('s-land-codex', { status: 'ended' })
  r = await api('/api/sessions/s-land-claude', { method: 'DELETE' })
  assert.equal(r.json.worktree.removed, true)
  assert.equal(existsSync(join(lrepo, '.leg-worktrees', 's-land-claude')) || existsSync(join(lrepo, '.baton-worktrees', 's-land-claude')), false)
  r = await api('/api/sessions/s-land-codex', { method: 'DELETE' })
  assert.equal(r.json.worktree.removed, false)
  assert.match(r.json.worktree.reason, /commits that are not on main/)
  assert.equal(existsSync(join(lrepo, '.leg-worktrees', 's-land-codex')) || existsSync(join(lrepo, '.baton-worktrees', 's-land-codex')), true)
})

test('/api/health asks each adapter where its binary is, so a CLI the runner can start is never reported missing', async () => {
  const { detectTools } = await import('../src/server.mjs')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'baton-bins-'))
  const fake = join(dir, 'codex.mjs')
  writeFileSync(fake, '')
  process.env.BATON_CODEX_BIN = fake
  // observed live: probing the bare name said codex:false while the adapter
  // resolves an exe the runner starts fine
  assert.equal((await detectTools({ refresh: true })).codex, true)
  process.env.BATON_CODEX_BIN = join(dir, 'not-here.mjs')
  assert.equal((await detectTools({ refresh: true })).codex, false)
  delete process.env.BATON_CODEX_BIN
  const tools = (await api('/api/health')).json.tools
  for (const k of ['claude', 'codex', 'agy', 'git', 'chb']) assert.equal(typeof tools[k], 'boolean', k)
})

// A handoff card finished on its SECOND agent, but card.leg is reset when the
// station ends, so summarize() read chain[0] and reported the agent that
// started the work as the one that did it. On a product whose whole claim is
// "the next one keeps your place", the finished row named the wrong next one.
test('a card that finished after a handoff names the agent that finished it', async () => {
  const { ledgerAppend, ledgerUpdate } = await import('../src/store.mjs')
  const r = await api('/api/cards', { method: 'POST', body: { repo, task: 'Handed off then done', chain: 'fake-claude,fake-codex', title: 'H1', queue: true } })
  assert.equal(r.status, 201)
  const id = r.json.card.card_id
  assert.equal(r.json.card.active_adapter, 'fake-claude', 'before anything runs the first agent is the active one')

  // both legs ran at the build station, then the station ended and leg reset
  ledgerAppend(id, { type: 'leg_started', summary: 'leg started: adapter=fake-claude', station: 'build', leg: 0 })
  ledgerAppend(id, { type: 'leg_started', summary: 'leg started: adapter=fake-codex', station: 'build', leg: 1 })
  ledgerUpdate(id, { status: 'done', station: 'build', leg: 0 })

  const list = await api('/api/cards')
  const card = list.json.cards.find((c) => c.card_id === id)
  assert.equal(card.status, 'done')
  assert.equal(card.active_adapter, 'fake-codex', 'the finished card names the agent that finished it, not chain[0]')
  assert.deepEqual(card.chain_view.map((x) => x.state), ['handed', 'done'])
})
