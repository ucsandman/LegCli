// Editable interactive-terminal order: persisted defaults, server guards, and
// one real attach handoff through synthetic CLIs only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, batonSpawn, sleep } from './helpers.mjs'
// a Windows runner hands out a short 8.3 TEMP path while git reports the long
// one, so the session's repo only matches after both are canonicalized
import { canonPath } from '../src/fsx.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

const preferences = await import('../src/preferences.mjs')
const usage = await import('../src/usage.mjs')
const sessions = await import('../src/sessions.mjs')
const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { claimHandoffChoice } = await import('../src/attach.mjs')

async function startServer(options = {}) {
  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, ...options })
  const { port } = await server.start()
  return { server, base: `http://127.0.0.1:${port}` }
}

async function api(base, path, { method = 'GET', body, token } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(base + path, { method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
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

test('persisted order is validated and preserves same-agent account fallback before the chosen agent priority', () => {
  assert.deepEqual(preferences.readPreferences().handoff_order, ['claude', 'codex', 'agy'])
  preferences.writePreferences({ handoff_order: ['codex', 'claude', 'agy'] })
  assert.deepEqual(preferences.readPreferences().handoff_order, ['codex', 'claude', 'agy'])
  assert.throws(() => preferences.writePreferences({ handoff_order: ['codex', 'claude', 'claude'] }), /exactly once/)

  const accounts = { claude: ['default'], codex: ['default', 'work'], agy: ['default'] }
  assert.deepEqual(usage.candidates({ agent: 'codex', account: 'default', accounts, order: ['codex', 'claude', 'agy'] }), [
    { agent: 'codex', account: 'work' },
    { agent: 'claude', account: 'default' },
    { agent: 'agy', account: 'default' },
  ])
  assert.deepEqual(usage.candidates({ agent: 'claude', account: 'default', accounts, order: ['codex', 'claude', 'agy'] }).map((c) => `${c.agent}/${c.account}`), ['codex/default', 'codex/work', 'agy/default'],
    'the saved order is absolute priority: agy placed last stays last even when the terminal starts on an agent above it')
  assert.deepEqual(usage.candidates({ agent: 'agy', account: 'default', accounts, order: ['codex', 'claude', 'agy'] }).map((c) => `${c.agent}/${c.account}`), ['codex/default', 'codex/work', 'claude/default'])

  const nowS = Math.floor(Date.now() / 1000)
  usage.markLimited('codex', 'work', { resets_at: nowS + 600, reason: 'test' })
  const choice = usage.chooseNext({ agent: 'codex', account: 'default', accounts, order: ['codex', 'claude', 'agy'], installed: { claude: true, codex: true, agy: false }, nowS })
  assert.deepEqual(choice.next, { agent: 'claude', account: 'default' })
  assert.deepEqual(choice.out.map((x) => `${x.agent}/${x.account}`), ['codex/work'])
})

// Step 4 of docs/redesign-2026-09-17.md turns the order of agents into a
// ladder of rungs. The one thing that may not change on the way: a machine
// that already has an order must walk it exactly as it did, and every older
// reader of preferences.json must still find a valid `handoff_order`.
test('a bare handoff_order migrates to a ladder that walks it identically, and the order round-trips', () => {
  const accounts = { claude: ['default', 'work'], codex: ['default'], agy: ['default'], grok: ['default'] }
  for (const order of [['codex', 'claude', 'agy'], ['grok', 'claude', 'codex', 'agy']]) {
    const saved = preferences.writePreferences({ handoff_order: order })
    assert.deepEqual(saved.handoff_order, order)
    assert.deepEqual(saved.handoff_ladder.map((r) => r.agent), order, 'one rung per agent, in the order that was saved')
    assert.deepEqual(saved.handoff_ladder.map((r) => r.model), order.map(() => null), 'a migrated rung names no model')
    assert.deepEqual(preferences.orderFromLadder(saved.handoff_ladder), order, 'and the order derives back out of it')
    assert.deepEqual(preferences.readPreferences().handoff_order, order, 'which is what an older reader finds on disk')
    assert.equal(preferences.validHandoffOrder(preferences.readPreferences().handoff_order), true)
    for (const from of order) {
      const bare = usage.candidates({ agent: from, account: 'default', accounts, order })
      const rungs = usage.candidates({ agent: from, account: 'default', accounts, order, ladder: saved.handoff_ladder })
      assert.deepEqual(rungs.map((r) => `${r.agent}/${r.account}`), bare.map((c) => `${c.agent}/${c.account}`), `${from} on ${order.join(',')} walks the same list`)
      assert.equal(rungs.every((r) => r.model === undefined), true, 'and no rung invents a model')
    }
  }
  // a ladder with model rungs still leaves a valid order behind it
  const ladder = preferences.writePreferences({
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable' },
      { agent: 'claude', account: 'default', model: 'opus' },
      { agent: 'codex', account: 'default', model: null },
      { agent: 'agy', account: 'default', model: null },
    ],
  })
  assert.deepEqual(ladder.handoff_order, ['claude', 'codex', 'agy'])
  assert.equal(preferences.validHandoffOrder(ladder.handoff_order), true)
  assert.equal(preferences.readPreferences().handoff_ladder.length, 4)
  assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'claude', model: 'fable' }, { agent: 'claude', model: 'fable' }] }), /twice/)
  // A rung's model is validated by SHAPE for every agent and by MEMBERSHIP for
  // claude alone. claude's four words are a closed set of aliases Claude Code
  // resolves itself, so a fifth is a typo and saying so is help. codex, agy and
  // grok take service-side ids from catalogs that move between Leg releases
  // (src/models.mjs reads each CLI's own), and a list frozen in this repo would
  // refuse next month's model while the CLI beside it ran it. This assertion
  // used to read `{agent: 'codex', model: 'gpt-9'}` -> /no model/, which is the
  // contract that changed when the board gained a model picker.
  assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'claude', model: 'gpt-9' }] }), /no model/)
  // what survives for every agent: a model that is a flag, or that is not one
  // token, never reaches an argv
  assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'codex', model: '--model' }] }), /must be a model id/)
  assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'codex', model: 'gpt 5' }] }), /must be a model id/)
  // and a real codex id round-trips through the file
  preferences.writePreferences({ handoff_ladder: [{ agent: 'codex', account: 'default', model: 'gpt-5.6-luna' }] })
  assert.deepEqual(preferences.readPreferences().handoff_ladder.map((r) => `${r.agent}/${r.model}`), ['codex/gpt-5.6-luna'])
  assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'claude', model: 'opus', when: 'soon' }] }), /always, below:N or walled-only/)
  assert.throws(() => preferences.writePreferences({ climb_back: 'when-quiet' }), /climb_back must be/)
  assert.throws(() => preferences.writePreferences({ reserve: { claude: 140 } }), /between 1 and 100/)
  // and the machine goes back to what the rest of this file expects
  preferences.writePreferences({ handoff_order: ['claude', 'codex', 'agy'] })
})

// Finding 2: docs/configuration.md shows preferences.json as a hand-editable
// block. One mistyped claude alias used to throw the whole ladder away without
// a word, and the next unrelated board save wrote the substitute over the file.
test('one bad rung is dropped and the good ones are kept; an unrelated save never rewrites the ladder', () => {
  const file = preferences.preferencesFile()
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null
  const handEdited = {
    handoff_order: ['claude', 'codex', 'agy'],
    handoff_ladder: [
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'opus-4', when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'sonnet', when: 'always', cost: 'plan' },
      { agent: 'codex', account: 'default', model: 'gpt-5.6-luna', when: 'always', cost: 'plan' },
    ],
    climb_back: 'next-handoff',
    may_spend: false,
  }
  try {
    writeFileSync(file, JSON.stringify(handEdited, null, 2))
    const read = preferences.readPreferences()
    assert.deepEqual(read.handoff_ladder.map((r) => `${r.agent}/${r.model ?? ''}`), ['claude/fable', 'claude/sonnet', 'codex/gpt-5.6-luna'],
      'a typo in one rung took the whole ladder with it')
    assert.deepEqual(read.handoff_order, ['claude', 'codex', 'agy'])
    // the rung that was refused says why, for anything that wants to show it
    const { dropped } = preferences.salvageHandoffLadder(handEdited.handoff_ladder)
    assert.equal(dropped.length, 1)
    assert.match(dropped[0].why, /claude has no model "opus-4"/)

    // a save about something else leaves the human's file exactly as it was
    preferences.writePreferences({ may_spend: true })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.may_spend, true, 'the save did not happen')
    assert.deepEqual(after.handoff_ladder, handEdited.handoff_ladder, 'toggling may_spend rewrote the ladder on disk')

    // a ladder the board really sends is still validated as a whole, and a
    // save that IS about the ladder replaces what is there
    assert.throws(() => preferences.writePreferences({ handoff_ladder: [{ agent: 'claude', model: 'opus-4' }] }), /no model/)
    preferences.writePreferences({ handoff_ladder: [{ agent: 'claude', account: 'default', model: 'opus' }] })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).handoff_ladder.map((r) => r.model), ['opus'])

    // and a ladder with nothing readable left in it still falls back to the order
    writeFileSync(file, JSON.stringify({ handoff_order: ['codex', 'claude', 'agy'], handoff_ladder: [{ agent: 'nope' }] }, null, 2))
    assert.deepEqual(preferences.readPreferences().handoff_ladder.map((r) => r.agent), ['codex', 'claude', 'agy'])
  } finally {
    // the rest of this file expects the machine's own default order
    if (before === null) rmSync(file, { force: true }); else writeFileSync(file, before)
    preferences.writePreferences({ handoff_order: ['claude', 'codex', 'agy'] })
  }
})

test('server validates order, enforces ownership and lifecycle, and rejects legacy wrappers', async () => {
  const ownerToken = share.newToken()
  const guestToken = share.newToken()
  const roster = {
    version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: true,
    people: [
      { name: 'wes', role: 'owner', token_sha256: share.hashToken(ownerToken) },
      { name: 'sam', role: 'guest', token_sha256: share.hashToken(guestToken) },
    ],
  }
  const repo = initRepo('handoff-order-api-')
  sessions.createSession({ id: 's-order-capable', agent: 'codex', cwd: repo, repo, owner: 'wes', handoffOrder: ['claude', 'codex', 'agy'], runtimeCapabilities: [sessions.HANDOFF_ORDER_CAPABILITY] })
  sessions.updateSession('s-order-capable', { status: 'running' })
  sessions.createSession({ id: 's-order-legacy', agent: 'codex', cwd: repo, repo, owner: 'wes' })
  sessions.updateSession('s-order-legacy', { status: 'running', runtime_capabilities: [] })
  const { server, base } = await startServer({ share: roster })
  try {
    const guest = await api(base, '/api/sessions/s-order-capable/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'claude', 'agy'] }, token: guestToken })
    assert.equal(guest.status, 403)
    assert.equal((await api(base, '/api/settings', { method: 'PATCH', body: { handoff_order: ['codex', 'claude', 'agy'] }, token: guestToken })).status, 403)

    const malformed = await api(base, '/api/sessions/s-order-capable/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'claude', 'claude'] }, token: ownerToken })
    assert.equal(malformed.status, 400)
    assert.deepEqual(sessions.readSession('s-order-capable').handoff_order, ['claude', 'codex', 'agy'])

    const saved = await api(base, '/api/sessions/s-order-capable/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'claude', 'agy'] }, token: ownerToken })
    assert.equal(saved.status, 200)
    assert.deepEqual(sessions.readSession('s-order-capable').handoff_order, ['codex', 'claude', 'agy'])
    assert.deepEqual(sessions.readSession('s-order-capable').chain.map((x) => x.agent), ['claude', 'agy'])

    sessions.updateSession('s-order-capable', { files_touched: ['src/good.mjs', '*** Begin Patch\\n*** Update File: src/bad.mjs'], files_dirty: ['C:\\new\\legit.mjs'] })
    const ownerView = await api(base, '/api/sessions', { token: ownerToken })
    const visible = ownerView.json.sessions.find((item) => item.session_id === 's-order-capable').files
    assert.deepEqual(visible.sort(), ['C:\\new\\legit.mjs', 'src/good.mjs'], 'patch envelopes are hidden without treating Windows backslash-n as an escape')

    sessions.createSession({ id: 's-order-save-first', agent: 'codex', cwd: repo, repo, owner: 'wes', runtimeCapabilities: [sessions.HANDOFF_ORDER_CAPABILITY] })
    sessions.updateSession('s-order-save-first', { status: 'limit' })
    const saveFirst = await api(base, '/api/sessions/s-order-save-first/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'claude', 'agy'] }, token: ownerToken })
    assert.equal(saveFirst.status, 200)
    const afterSave = claimHandoffChoice({ sid: 's-order-save-first', agent: 'codex', account: 'default', installed: { claude: true, codex: true, agy: true }, reason: 'limit' })
    assert.deepEqual(afterSave.choice.next, { agent: 'claude', account: 'default' }, 'a save that wins the lock controls the imminent choice')
    assert.equal(afterSave.session.status, 'handing_off')

    sessions.createSession({ id: 's-order-claim-first', agent: 'codex', cwd: repo, repo, owner: 'wes', handoffOrder: ['codex', 'claude', 'agy'], runtimeCapabilities: [sessions.HANDOFF_ORDER_CAPABILITY] })
    sessions.updateSession('s-order-claim-first', { status: 'limit' })
    const claimFirst = claimHandoffChoice({ sid: 's-order-claim-first', agent: 'codex', account: 'default', installed: { claude: true, codex: true, agy: true }, reason: 'limit' })
    assert.deepEqual(claimFirst.choice.next, { agent: 'claude', account: 'default' })
    const tooLate = await api(base, '/api/sessions/s-order-claim-first/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'agy', 'claude'] }, token: ownerToken })
    assert.equal(tooLate.status, 409, 'an order edit that loses the lock cannot claim it changed the committed handoff')
    assert.deepEqual(sessions.readSession('s-order-claim-first').handoff.to, { agent: 'claude', account: 'default' })

    const legacy = await api(base, '/api/sessions/s-order-legacy/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'claude', 'agy'] }, token: ownerToken })
    assert.equal(legacy.status, 409)
    assert.match(legacy.json.error, /restart the terminal/)

    sessions.updateSession('s-order-capable', { status: 'handing_off' })
    const committed = await api(base, '/api/sessions/s-order-capable/handoff-order', { method: 'POST', body: { handoff_order: ['codex', 'agy', 'claude'] }, token: ownerToken })
    assert.equal(committed.status, 409)
    assert.deepEqual(sessions.readSession('s-order-capable').handoff_order, ['codex', 'claude', 'agy'])
  } finally {
    await server.stop()
  }
})

test('an order saved after the codex leg starts is consumed by the next real attach choice', async (t) => {
  const stubs = mkdtempSync(join(tmpdir(), 'handoff-order-stubs-'))
  const records = mkdtempSync(join(tmpdir(), 'handoff-order-records-'))
  mkdirSync(join(records, 'live'))
  writeFileSync(join(stubs, 'codex.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/codex-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), session: process.env.BATON_SESSION }))
setTimeout(() => {}, 120000)
`)
  writeFileSync(join(stubs, 'claude.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/claude-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), session: process.env.BATON_SESSION }))
`)
  writeFileSync(join(stubs, 'agy.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.STUB_DIR + '/agy-' + Date.now() + '.json', JSON.stringify({ argv: process.argv.slice(2), session: process.env.BATON_SESSION }))
`)
  for (const agent of ['claude', 'codex', 'agy']) usage.clearLimited(agent, 'default')
  preferences.writePreferences({ handoff_order: ['agy', 'claude', 'codex'] })
  const repo = initRepo('handoff-order-attach-')
  const env = testEnv(HOME, {
    BATON_CODEX_BIN: join(stubs, 'codex.mjs'), BATON_CLAUDE_BIN: join(stubs, 'claude.mjs'), BATON_AGY_BIN: join(stubs, 'agy.mjs'),
    BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_ATTACH_POLL_MS: '200', BATON_LIVE_DIR: join(records, 'live'), STUB_DIR: records,
  })
  const child = batonSpawn(['codex', '--no-worktree'], env, { cwd: repo })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.resume()
  const exited = new Promise((resolvePromise) => child.on('exit', resolvePromise))
  let session = null
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    session = sessions.listSessions().find((item) => item.repo && canonPath(item.repo) === canonPath(repo) && item.pid)
    if (session) break
    await sleep(100)
  }
  try {
    assert.ok(session, `codex leg started; stderr: ${stderr.slice(-800)}`)
    assert.ok(session.runtime_capabilities.includes(sessions.HANDOFF_ORDER_CAPABILITY))
    assert.deepEqual(session.chain.map((x) => x.agent), ['agy', 'claude'], 'the starting order would hand codex to agy')
    sessions.updateSession(session.session_id, (current) => ({
      handoff_order: ['codex', 'claude', 'agy'],
      chain: usage.candidates({ agent: current.agent, account: current.account, accounts: { claude: ['default'], codex: ['default'], agy: ['default'] }, order: ['codex', 'claude', 'agy'] }),
    }))
    sessions.requestControl(session.session_id, { handoff: true, by: 'test' })
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')])
    assert.equal(code, 0, stderr)
    const launches = readdirSync(records)
    assert.equal(launches.filter((name) => name.startsWith('claude-')).length, 1, `Claude launched: ${launches.join(', ')}`)
    assert.equal(launches.filter((name) => name.startsWith('agy-')).length, 0, `agy was skipped: ${launches.join(', ')}`)
    const claude = JSON.parse(readFileSync(join(records, launches.find((name) => name.startsWith('claude-'))), 'utf8'))
    assert.match(claude.argv[claude.argv.length - 1], /taking over an interactive coding session from codex/)
    const final = sessions.readSession(session.session_id)
    assert.deepEqual(final.handoff_order, ['codex', 'claude', 'agy'])
    assert.equal(final.lineage.to, 'claude')
  } finally {
    if (session && sessions.isActive(sessions.readSession(session.session_id))) sessions.requestControl(session.session_id, { end: true })
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
  }
  t.diagnostic(stderr.split('\n').filter((line) => line.includes('[leg]')).slice(-8).join('\n'))
})

// ---- the cost word and the account name (adversarial review, 2026-09-17) ----

test('a ladder migrated from an order costs what the agent costs, and the spending gate fires on it', () => {
  const migrated = preferences.ladderFromOrder(['claude', 'codex', 'agy', 'grok'])
  assert.deepEqual(migrated.map((r) => `${r.agent}:${r.cost}`), ['claude:plan', 'codex:plan', 'agy:free', 'grok:metered'], 'the migration reads the cost off the agent, never a hard-coded word')
  // a persisted word may never make a rung look CHEAPER than the agent is: that
  // is the whole cost gate bypassed on an upgrading machine
  assert.equal(preferences.rungCost({ agent: 'grok', account: 'default', model: null, cost: 'plan' }), 'metered')
  assert.equal(preferences.rungCost({ agent: 'agy', account: 'default', model: null, cost: 'plan' }), 'free')
  assert.equal(preferences.rungCost({ agent: 'claude', account: 'default', model: 'opus', cost: 'credits' }), 'plan', 'a word persisted on the rung is a label, never the gate\'s input')
  assert.equal(preferences.rungCost({ agent: 'claude', account: 'default', model: 'fable' }, { extra_usage: { enabled: true } }), 'credits', 'and the live part still decides fable')

  const rows = usage.evaluateLadder({ from: { agent: 'claude', account: 'default' }, list: migrated, ladder: migrated, maySpend: false })
  const grok = rows.find((r) => r.agent === 'grok')
  assert.equal(grok.cost, 'metered')
  assert.equal(grok.ok, false)
  assert.equal(grok.reason, 'it spends metered credits and you have not allowed that', 'the ledger line the gate exists for reaches an upgrading machine too')
  // the same word on the extra-account rungs candidates() synthesises
  const accounts = { claude: ['default'], codex: ['default'], agy: ['default'], grok: ['default', 'second'] }
  const list = usage.candidates({ agent: 'claude', account: 'default', accounts, order: ['claude', 'codex', 'agy', 'grok'], ladder: migrated })
  assert.equal(list.find((r) => r.agent === 'grok' && r.account === 'second').cost, 'metered')
  assert.equal(list.find((r) => r.agent === 'agy').cost, 'free')
})

test('a rung account is a name this machine has, never a path', () => {
  // the config dir the CLI is pointed at and the file the usage record is
  // written to are both built from this string (src/accounts.mjs, usage.mjs)
  assert.throws(() => preferences.requireHandoffLadder([{ agent: 'claude', account: '../../../../pwned', model: 'opus' }]), /account/)
  assert.throws(() => preferences.requireHandoffLadder([{ agent: 'claude', account: 'C:\\Windows', model: 'opus' }]), /account/)
  assert.throws(() => preferences.requireHandoffLadder([{ agent: 'claude', account: 'work', model: 'opus' }]), /no account "work"/)
  assert.equal(preferences.requireHandoffLadder([{ agent: 'claude', account: 'default', model: 'opus' }])[0].account, 'default')
  // belt and braces: the usage writer refuses a name that could leave its directory
  assert.throws(() => usage.usageFile('claude', '../../../../pwned'), /account/)
  assert.equal(usage.usageFile('claude', 'default').endsWith('claude--default.json'), true)
})
