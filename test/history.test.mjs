// History discovery: the read-only index over every agent's own store.
// Every store here is synthetic (test/history-fixture.mjs); the developer's
// real ~/.claude, ~/.codex, ~/.grok, ~/.gemini and ~/.copilot are never read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git, testEnv, leg, legFail } from './helpers.mjs'
import { allStores, claudeStore, id as uuid } from './history-fixture.mjs'
// a Windows runner hands out a short 8.3 TEMP path while git reports the long
// one, so a repo or checkout path only matches after both are canonicalized
import { canonPath } from '../src/fsx.mjs'

const HOME = makeHome()
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
const H = await import('../src/history/index.mjs')
const { createSession, updateSession } = await import('../src/sessions.mjs')

const WIN = process.platform === 'win32'
const fresh = (name) => { const r = join(HOME, name); mkdirSync(r, { recursive: true }); return r }

// a snapshot of every file under a store, to prove discovery wrote nothing there
function snapshot(dir) {
  const out = []
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const st = statSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`) } } }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

test('discovers conversations across five providers, newest first, with ids of the form provider:native', () => {
  const root = fresh('five')
  const f = allStores(root, {
    claude: [{ title: 'Fix the drainer', cwd: 'C:\\Projects\\alpha', branch: 'feat/x', prompts: ['p1', 'p2', 'p3'], updated: '2026-09-15T10:00:00.000Z' }],
    codex: [{ title: 'Codex thread', prompts: ['a', 'b'], updated: '2026-09-15T11:00:00.000Z' }],
    grok: [{ title: 'Grok session', updated: '2026-09-15T12:00:00.000Z' }],
    agy: [{ title: 'Antigravity chat', started: '2026-09-15T13:00:00.000Z' }],
    copilot: [{ title: 'Copilot session', updated: '2026-09-15T14:00:00.000Z' }],
  })
  const before = Object.values(f.homes).flatMap(snapshot)
  const r = H.refreshIndex({ homes: f.homes })
  assert.deepEqual(r.stats.map((s) => [s.provider, s.records, s.error]), [['claude', 1, null], ['codex', 1, null], ['grok', 1, null], ['agy', 1, null], ['copilot', 1, null]])
  const { records, total } = H.listHistory({ homes: f.homes, refresh: false, sessions: [] })
  assert.equal(total, 5)
  assert.deepEqual(records.map((x) => x.provider), ['copilot', 'agy', 'grok', 'codex', 'claude'], 'newest first')
  const c = records.find((x) => x.provider === 'claude')
  assert.equal(c.id, `claude:${f.claude[0].id}`)
  assert.equal(c.title, 'Fix the drainer')
  assert.equal(c.cwd, 'C:\\Projects\\alpha')
  assert.equal(c.branch, 'feat/x')
  assert.equal(c.turns, 3, 'turns come from history.jsonl')
  assert.equal(c.managed, false)
  assert.equal(c.transcript_path, f.claude[0].file)
  const k = records.find((x) => x.provider === 'codex')
  assert.equal(k.title, 'Codex thread', 'session_index names the thread')
  assert.equal(k.turns, 2)
  assert.equal(k.branch, 'main', 'the git block')
  const g = records.find((x) => x.provider === 'grok')
  assert.equal(g.title, 'Grok session')
  assert.equal(g.turns, 1)
  const a = records.find((x) => x.provider === 'agy')
  assert.equal(a.title, 'Antigravity chat', 'annotations/<id>.pbtxt')
  assert.equal(a.turns, 2)
  assert.equal(a.transcript, 'unsupported')
  const p = records.find((x) => x.provider === 'copilot')
  assert.equal(p.title, 'Copilot session')
  assert.equal(p.resume.supported, false)
  // read only: not one byte changed in any store, and the index is under LEG_HOME
  assert.deepEqual(Object.values(f.homes).flatMap(snapshot), before, 'discovery wrote into a provider store')
  assert.ok(existsSync(join(HOME, 'history', 'index.json')))
})

test('empty stores list nothing and missing stores are said to be missing, without an error', () => {
  const root = fresh('empty')
  const homes = { claude: join(root, 'c'), codex: join(root, 'k'), grok: join(root, 'g'), agy: join(root, 'a'), copilot: join(root, 'p') }
  mkdirSync(join(homes.claude, 'projects'), { recursive: true })
  mkdirSync(join(homes.codex, 'sessions'), { recursive: true })
  const r = H.refreshIndex({ homes })
  assert.deepEqual(r.stats.map((s) => [s.provider, s.records, s.missing, s.error]), [['claude', 0, false, null], ['codex', 0, false, null], ['grok', 0, true, null], ['agy', 0, true, null], ['copilot', 0, true, null]])
  assert.equal(H.listHistory({ homes, refresh: false, sessions: [] }).total, 0)
})

test('a torn last line, a BOM, a corrupt line, an unknown line type and an unknown version all still yield the conversation', () => {
  const root = fresh('malformed')
  const f = allStores(root, {
    claude: [
      { title: 'torn', truncated: true },
      { title: 'bom', bom: true, version: '9.9.9-future' },
      { title: 'corrupt', malformedLine: '{"type":"user", this is not json' },
      { title: 'future', unknownType: true },
    ],
    codex: [{ title: 'codex bom', bom: true }, { title: 'codex corrupt', malformedLine: '{oops' }],
    grok: [{ title: 'ok' }, { corruptSummary: true }],
  })
  H.refreshIndex({ homes: f.homes })
  const { records } = H.listHistory({ homes: f.homes, refresh: false, sessions: [] })
  const titles = records.map((r) => r.title).sort()
  assert.deepEqual(titles, ['bom', 'codex bom', 'codex corrupt', 'corrupt', 'future', 'ok', 'torn'])
  assert.equal(records.find((r) => r.title === 'bom').native.version, '9.9.9-future')
  // a directory where a transcript is expected is skipped, not thrown on
  mkdirSync(join(f.homes.claude, 'projects', 'C--x', `${uuid(77)}.jsonl`), { recursive: true })
  const r2 = H.refreshIndex({ homes: f.homes })
  assert.equal(r2.stats[0].error, null)
})

test('subagent transcripts, sidechain lines and suppressed sessions never list as conversations', () => {
  const root = fresh('hidden')
  const f = allStores(root, {
    claude: [{ title: 'parent', withSubagentDir: true, sidechain: 'never a prompt' }, { title: 'vetoed', hidden: true }],
    codex: [{ title: 'root thread' }, { title: 'child', subagent: true }],
    grok: [{ title: 'human', kind: undefined }, { title: 'sub', kind: 'subagent' }, { title: 'headless', kind: 'headless' }],
  })
  H.refreshIndex({ homes: f.homes })
  const shown = H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records.map((r) => r.title).sort()
  assert.deepEqual(shown, ['headless', 'human', 'parent', 'root thread'])
  const all = H.listHistory({ homes: f.homes, refresh: false, sessions: [], includeHidden: true }).records.map((r) => r.title).sort()
  assert.deepEqual(all, ['child', 'headless', 'human', 'parent', 'root thread', 'sub', 'vetoed'])
  const child = all.length && H.listHistory({ homes: f.homes, refresh: false, sessions: [], includeHidden: true, provider: 'codex' }).records.find((r) => r.title === 'child')
  assert.equal(child.resume.supported, false)
  assert.equal(H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records.find((r) => r.title === 'parent').turns, null, 'no history.jsonl: the count is unknown, not zero')
})

test('a Leg session that started the agent is the same conversation: one record, marked managed', () => {
  const root = fresh('dedup')
  const f = allStores(root, { claude: [{ title: 'through leg' }, { title: 'on its own' }], codex: [{ title: 'codex via leg' }] })
  createSession({ id: 's-hist-claude', agent: 'claude', cwd: 'C:\\Projects\\toy', runner_pid: process.pid })
  updateSession('s-hist-claude', { status: 'ended', agent_session_id: f.claude[0].id, transcript_path: f.claude[0].file })
  // matched on the transcript path alone, in another case
  createSession({ id: 's-hist-codex', agent: 'codex', cwd: 'C:\\Projects\\toy', runner_pid: process.pid })
  updateSession('s-hist-codex', { status: 'running', transcript_path: WIN ? f.codex[0].file.toUpperCase() : f.codex[0].file })
  // a session whose agent id Leg never learned still lists, once, as Leg's
  createSession({ id: 's-hist-agy', agent: 'agy', cwd: 'C:\\Projects\\toy', runner_pid: process.pid })
  updateSession('s-hist-agy', { status: 'ended', task: 'an agy task' })
  const { records, total } = H.listHistory({ homes: f.homes, refresh: true })
  assert.equal(total, 4)
  const viaLeg = records.find((r) => r.title === 'through leg')
  assert.equal(viaLeg.managed, true)
  assert.equal(viaLeg.leg_session_id, 's-hist-claude')
  assert.equal(viaLeg.leg_status, 'ended')
  assert.equal(records.filter((r) => r.native_id === f.claude[0].id).length, 1, 'never once as Leg\'s and again as discovered')
  assert.equal(records.find((r) => r.title === 'on its own').managed, false)
  const codexViaLeg = records.find((r) => r.title === 'codex via leg')
  assert.equal(codexViaLeg.managed, true)
  assert.equal(codexViaLeg.live, true, 'a running Leg session is live')
  const agy = records.find((r) => r.id === 'leg:s-hist-agy')
  assert.ok(agy, 'a session with no native match lists under its Leg id')
  assert.equal(agy.managed, true)
  assert.equal(agy.title, 'an agy task')
  assert.equal(H.listHistory({ homes: f.homes, refresh: false, managed: true }).total, 3)
  assert.equal(H.listHistory({ homes: f.homes, refresh: false, managed: false }).total, 1)
  for (const s of ['s-hist-claude', 's-hist-codex', 's-hist-agy']) rmSync(join(HOME, 'sessions', s), { recursive: true, force: true })
})

test('a repo written in another case still groups and filters as the same repository on Windows; a POSIX path on Windows is kept, not resolved', () => {
  const root = fresh('paths')
  const repo = initRepo('hist-repo-')
  const other = WIN ? repo.toUpperCase() : repo
  const f = allStores(root, {
    claude: [{ title: 'same repo, other case', cwd: other, branch: 'main' }, { title: 'posix elsewhere', cwd: '/home/someone/proj', branch: 'dev' }],
    grok: [{ title: 'grok in repo', cwd: repo }],
  })
  H.refreshIndex({ homes: f.homes })
  const byRepo = H.listHistory({ homes: f.homes, refresh: false, sessions: [], repo }).records.map((r) => r.title).sort()
  assert.deepEqual(byRepo, ['grok in repo', 'same repo, other case'])
  const byName = H.listHistory({ homes: f.homes, refresh: false, sessions: [], repo: repo.split(/[\\/]/).pop() }).records.length
  assert.equal(byName, 2, 'a bare name matches repo_name')
  const posix = H.listHistory({ homes: f.homes, refresh: false, sessions: [], search: 'posix' }).records[0]
  assert.equal(posix.cwd, '/home/someone/proj')
  assert.equal(posix.repo_name, 'proj')
  if (WIN) { assert.equal(posix.cwd_exists, false); assert.equal(posix.repo, null) }
})

test('a 20 MB transcript is indexed from its head and tail only, quickly, and its messages come from the tail', (t) => {
  const root = fresh('big')
  const f = allStores(root, { claude: [{ title: 'big one', padTo: 20 * 1024 * 1024, extraMessages: [{ role: 'user', text: 'the very last prompt' }] }] })
  const t0 = Date.now()
  const r = H.refreshIndex({ homes: f.homes })
  const ms = Date.now() - t0
  t.diagnostic(`20 MB transcript indexed in ${ms} ms`)
  assert.ok(ms < 3000, `indexing took ${ms} ms`)
  assert.equal(r.stats[0].records, 1)
  const rec = H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records[0]
  assert.equal(rec.title, 'big one')
  assert.ok(rec.size_bytes > 20 * 1024 * 1024)
  const msgs = H.recordMessages(rec, 2, { homes: f.homes })
  assert.equal(msgs.length, 2)
  assert.ok(msgs.some((m) => m.text === 'the very last prompt'))
})

test('a key an agent printed never reaches the index or the messages', () => {
  const root = fresh('secrets')
  const key = ['sk', 'ant', 'api03', 'HISTORYKEYAAAAAAAAAAAAAA'].join('-')
  const f = allStores(root, {
    claude: [{ title: `set ${key} in the env`, prompt: `use ${key} please`, reply: `done with ${key}` }],
    codex: [{ prompt: `codex prompt ${key}`, reply: `codex reply ${key}` }],
    grok: [{ prompt: `grok prompt ${key}`, reply: `grok reply ${key}` }],
    copilot: [{ prompt: `copilot ${key}`, reply: `copilot reply ${key}` }],
  })
  H.refreshIndex({ homes: f.homes })
  const index = readFileSync(join(HOME, 'history', 'index.json'), 'utf8')
  assert.equal(index.includes(key), false, 'the index on disk carries the key')
  assert.ok(index.includes('[REDACTED]'))
  for (const rec of H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records) {
    assert.equal(JSON.stringify(rec).includes(key), false, `${rec.provider} record carries the key`)
    const msgs = H.recordMessages(rec, 8, { homes: f.homes })
    assert.equal(JSON.stringify(msgs).includes(key), false, `${rec.provider} messages carry the key`)
    assert.ok(msgs.length >= 2, `${rec.provider} messages read`)
  }
})

test('a refresh re-reads only what changed: a new conversation, a changed one, a deleted one', () => {
  const root = fresh('incremental')
  const f = allStores(root, { claude: [{ title: 'one' }, { title: 'two' }], codex: [{ title: 'k' }] })
  const r1 = H.refreshIndex({ homes: f.homes })
  assert.deepEqual(r1.stats.slice(0, 2).map((s) => s.parsed), [2, 1])
  const r2 = H.refreshIndex({ homes: f.homes })
  assert.deepEqual(r2.stats.slice(0, 2).map((s) => [s.scanned, s.parsed]), [[2, 0], [1, 0]], 'nothing changed: nothing read')
  claudeStore(f.homes.claude, [{ id: uuid(9), title: 'three', updated: '2026-09-16T00:00:00.000Z' }])
  const r3 = H.refreshIndex({ homes: f.homes })
  assert.deepEqual([r3.stats[0].scanned, r3.stats[0].parsed, r3.stats[0].records], [3, 1, 3])
  // the changed file is re-read; the title moves with it
  writeFileSync(f.claude[0].file, readFileSync(f.claude[0].file, 'utf8') + JSON.stringify({ type: 'custom-title', customTitle: 'renamed by hand', sessionId: f.claude[0].id }) + '\n')
  const r4 = H.refreshIndex({ homes: f.homes })
  assert.equal(r4.stats[0].parsed, 1)
  assert.equal(H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records.find((r) => r.native_id === f.claude[0].id).title, 'renamed by hand', 'a custom title beats the ai title')
  rmSync(f.claude[1].file)
  const r5 = H.refreshIndex({ homes: f.homes })
  assert.equal(r5.stats[0].records, 2)
  assert.equal(H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).total, 3)
  // and the listing refreshes on its own only when the index is stale
  const stale = H.listHistory({ homes: f.homes, sessions: [] })
  assert.equal(stale.stats, null, 'a fresh index is not re-scanned')
})

test('one provider failing loses only its own entries; the others still index and the failure is named', () => {
  const root = fresh('isolation')
  const f = allStores(root, { claude: [{ title: 'c' }], grok: [{ title: 'g' }], codex: [{ title: 'k' }] })
  H.refreshIndex({ homes: f.homes })
  const realScan = H.PROVIDERS.grok.scan
  H.PROVIDERS.grok.scan = () => { throw new Error('grok parser exploded on a new format') }
  try {
    const r = H.refreshIndex({ homes: f.homes })
    const grok = r.stats.find((s) => s.provider === 'grok')
    assert.match(grok.error, /exploded/)
    assert.equal(grok.records, 1, 'the last good pass is kept')
    assert.deepEqual(r.stats.filter((s) => s.provider !== 'grok').map((s) => s.error), [null, null, null, null])
    assert.equal(H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).total, 3)
  } finally { H.PROVIDERS.grok.scan = realScan }
})

test('resume: verified per provider, refused for a gone folder, a subagent, a live Leg session, or a folder inside LEG_HOME', () => {
  const root = fresh('resume')
  const live = initRepo('hist-live-')
  const f = allStores(root, {
    claude: [{ title: 'claude here', cwd: live }, { title: 'claude gone', cwd: join(root, 'nope') }, { title: 'in leg home', cwd: HOME }],
    codex: [{ title: 'codex here', cwd: live }],
    grok: [{ title: 'grok here', cwd: live }],
    agy: [{ title: 'agy here', cwd: live }],
    copilot: [{ title: 'copilot here', cwd: live }],
  })
  H.refreshIndex({ homes: f.homes })
  const recs = H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records
  const spec = (title) => H.resumeSpec(recs.find((r) => r.title === title))
  assert.deepEqual(spec('claude here'), { supported: true, agent: 'claude', args: ['--resume', f.claude[0].id], cwd: live })
  assert.deepEqual(spec('codex here').args, ['resume', f.codex[0].id])
  assert.deepEqual(spec('grok here').args, ['--resume', f.grok[0].id])
  assert.deepEqual(spec('agy here').args, ['--conversation', f.agy[0].id])
  assert.equal(spec('copilot here').supported, false)
  assert.match(spec('claude gone').reason, /folder is gone/)
  assert.match(spec('in leg home').reason, /Leg's own home/)
  const running = { ...recs.find((r) => r.title === 'claude here'), managed: true, live: true, leg_session_id: 's-x' }
  assert.match(H.resumeSpec(running).reason, /already running/)
  assert.deepEqual(H.providerSupport().map((p) => [p.name, p.transcript, p.resume]), [['claude', 'supported', 'supported'], ['codex', 'supported', 'supported'], ['grok', 'supported', 'supported'], ['agy', 'unsupported', 'supported'], ['copilot', 'supported', 'unsupported']])
})

test('findRecord takes a full id, a native id, a unique prefix, and refuses an ambiguous or too-short one', () => {
  const root = fresh('find')
  const f = allStores(root, { claude: [{ id: uuid(5001), title: 'a' }, { id: uuid(5002), title: 'b' }], codex: [{ id: uuid(5001), title: 'codex twin' }] })
  H.refreshIndex({ homes: f.homes })
  const o = { homes: f.homes, refresh: false, sessions: [] }
  assert.equal(H.findRecord(`claude:${uuid(5001)}`, o).title, 'a')
  assert.equal(H.findRecord(uuid(5002), o).title, 'b')
  assert.equal(H.findRecord('claude:00005002', o).title, 'b')
  assert.equal(H.findRecord('codex:00005001', o).title, 'codex twin')
  assert.throws(() => H.findRecord('00005001', o), /matches 2 conversations/)
  assert.throws(() => H.findRecord('000', o), /too short/)
  assert.throws(() => H.findRecord('', o), H.HistoryInputError)
  assert.equal(H.findRecord('claude:99999999', o), null)
})

test('messages: only what a human said and the agent answered, never injected context, reasoning or developer text; never from outside a known store', () => {
  const root = fresh('messages')
  const f = allStores(root, { codex: [{ prompt: 'ask codex', reply: 'codex says' }], grok: [{ prompt: 'ask grok', reply: 'grok says' }], claude: [{ prompt: 'ask claude', reply: 'claude says' }] })
  H.refreshIndex({ homes: f.homes })
  const recs = H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records
  for (const [prov, q, a] of [['codex', 'ask codex', 'codex says'], ['grok', 'ask grok', 'grok says'], ['claude', 'ask claude', 'claude says']]) {
    const msgs = H.recordMessages(recs.find((r) => r.provider === prov), 8, { homes: f.homes })
    assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', q], ['assistant', a]], prov)
  }
  assert.equal(H.recordMessages(recs.find((r) => r.provider === 'agy') ?? { provider: 'agy' }, 8, { homes: f.homes }), null)
  // a hand-edited index that points at a file outside every store reads nothing
  const outside = join(root, 'outside.jsonl')
  writeFileSync(outside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SHOULD NOT BE READ' }, sessionId: 'x' }) + '\n')
  const forged = { ...recs.find((r) => r.provider === 'claude'), transcript_path: outside }
  assert.deepEqual(H.recordMessages(forged, 8, { homes: f.homes }), [])
  assert.equal(H.insideKnownStore(join(HOME, 'sessions', 's-x', 'transcript.jsonl'), { homes: f.homes }), true, 'Leg\'s own session dir is a known store')
})

test('worktrees: a real linked worktree resolves to its repository; a recorded worktree survives the directory being gone', () => {
  const root = fresh('wt')
  const repo = initRepo('hist-wt-')
  const wt = join(repo, '.leg-worktrees', 's-wt-1')
  git(repo, ['worktree', 'add', '-q', '-b', 'leg/s-wt-1', wt, 'main'])
  const goneWt = join(repo, '.claude', 'worktrees', 'gone')
  const f = allStores(root, {
    claude: [{ title: 'in the worktree', cwd: wt, branch: 'leg/s-wt-1' }, { title: 'moved to a worktree since deleted', cwd: goneWt, worktree: { path: goneWt, branch: 'worktree-gone', originalCwd: repo } }],
    grok: [{ title: 'grok in the worktree', cwd: wt, gitRoot: wt }],
  })
  H.refreshIndex({ homes: f.homes })
  const recs = H.listHistory({ homes: f.homes, refresh: false, sessions: [] }).records
  const inWt = recs.find((r) => r.title === 'in the worktree')
  assert.equal(canonPath(inWt.repo), canonPath(repo))
  assert.equal(canonPath(inWt.worktree.path), canonPath(wt))
  assert.equal(canonPath(recs.find((r) => r.title === 'grok in the worktree').repo), canonPath(repo), 'git, not the provider, says which repo a worktree belongs to')
  const gone = recs.find((r) => r.title === 'moved to a worktree since deleted')
  assert.equal(gone.cwd_exists, false)
  assert.equal(gone.worktree.path, goneWt)
  assert.equal(gone.worktree.branch, 'worktree-gone')
  assert.equal(canonPath(gone.repo), canonPath(repo), 'the recorded original cwd names the repo')
})

test('leg history: ls, show, providers, refresh and worktrees through the CLI, JSON and text', () => {
  const home = makeHome()
  const root = join(home, 'stores')
  const repo = initRepo('hist-cli-')
  const f = allStores(root, {
    claude: [{ id: uuid(7001), title: 'cli claude', cwd: repo, prompts: ['one'] }],
    codex: [{ id: uuid(7002), title: 'cli codex', cwd: repo }],
    grok: [{ id: uuid(7003), title: 'cli grok', cwd: repo }],
    agy: [{ id: uuid(7004), title: 'cli agy', cwd: repo }],
    copilot: [{ id: uuid(7005), title: 'cli copilot', cwd: repo }],
  })
  // agy has no home variable: its store is found through the OS home
  const osHome = join(root, 'os-home')
  mkdirSync(join(osHome, '.gemini'), { recursive: true })
  renameSync(f.homes.agy, join(osHome, '.gemini', 'antigravity-cli'))
  const env = testEnv(home, { CLAUDE_CONFIG_DIR: f.homes.claude, CODEX_HOME: f.homes.codex, GROK_HOME: f.homes.grok, COPILOT_HOME: f.homes.copilot, USERPROFILE: osHome, HOME: osHome })
  const ls = JSON.parse(leg(['history', '--json'], env))
  assert.equal(ls.total, 5)
  assert.deepEqual(ls.records.map((r) => r.provider).sort(), ['agy', 'claude', 'codex', 'copilot', 'grok'])
  assert.ok(ls.providers.length === 5)
  const text = leg(['history'], env)
  assert.match(text, /claude:00007001\s+claude\s+external/)
  assert.match(text, /cli grok/)
  assert.equal(JSON.parse(leg(['history', 'ls', '--provider', 'grok,agy', '--json'], env)).total, 2)
  assert.equal(JSON.parse(leg(['history', '--search', 'copilot', '--json'], env)).total, 1)
  assert.equal(JSON.parse(leg(['history', '--repo', repo, '--json'], env)).total, 5)
  const show = JSON.parse(leg(['history', 'show', 'claude:00007001', '--json'], env))
  assert.equal(show.title, 'cli claude')
  assert.deepEqual(show.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(show.resume.supported, true)
  assert.match(leg(['history', 'show', '00007003'], env), /continue:\s+leg history continue grok:00007003/)
  assert.match(leg(['history', 'show', '00007005'], env), /not possible: copilot is not an agent Leg supervises/)
  assert.match(leg(['history', 'providers'], env), /agy\s+yes\s+unsupported\s+supported/)
  assert.match(leg(['history', 'refresh'], env), /claude\s+1 conversation \(1 scanned, 0 read\)/)
  assert.equal(legFail(['history', 'show', 'zzzz9999'], env).status, 3)
  assert.equal(legFail(['history', 'show', 'ab'], env).status, 2)
  assert.equal(legFail(['history', '--provider', 'nope'], env).status, 2)
  assert.equal(legFail(['history', 'continue', '00007005'], env).status, 3, 'copilot cannot be continued')
  assert.equal(legFail(['history', 'bogus'], env).status, 2)
  const wt = JSON.parse(leg(['worktrees', '--json', '--no-dirty'], env))
  assert.equal(wt.repos, 1)
  assert.equal(wt.worktrees[0].main, true)
  assert.equal(wt.worktrees[0].conversations.count, 5)
  assert.match(leg(['worktrees'], env), /checkout\s+5 conv/)
  assert.match(leg(['--help'], env), /history \[ls\]/)
})

test('leg history continue: a stub claude gets --resume <id> in the conversation\'s own folder, and the new session dedups against it at once', () => {
  const home = makeHome()
  const root = join(home, 'stores')
  const repo = initRepo('hist-cont-')
  const f = allStores(root, { claude: [{ id: uuid(7101), title: 'continue me', cwd: repo, reply: 'earlier answer' }], codex: [{ id: uuid(7102), title: 'codex too', cwd: repo }] })
  const stubs = join(home, 'stubs')
  mkdirSync(stubs, { recursive: true })
  // the stub records how it was started and exits at once: no board, no turn
  writeFileSync(join(stubs, 'agent.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.STUB_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), session: process.env.LEG_SESSION }))\n")
  const out = join(home, 'stub-out.json')
  const env = testEnv(home, { CLAUDE_CONFIG_DIR: f.homes.claude, CODEX_HOME: f.homes.codex, GROK_HOME: f.homes.grok, COPILOT_HOME: f.homes.copilot, USERPROFILE: join(root, 'os-home'), HOME: join(root, 'os-home'), LEG_CLAUDE_BIN: join(stubs, 'agent.mjs'), BATON_CLAUDE_BIN: join(stubs, 'agent.mjs'), LEG_CODEX_BIN: join(stubs, 'agent.mjs'), BATON_CODEX_BIN: join(stubs, 'agent.mjs'), BATON_NO_BOARD: '1', LEG_NO_BOARD: '1', BATON_NO_OPEN: '1', LEG_NO_OPEN: '1', STUB_OUT: out })
  const text = leg(['history', 'continue', 'claude:00007101', '--no-auto-approve'], env)
  assert.match(text, /continuing claude:00007101-0000-4000-8000-000000007101 with leg claude/)
  const stub = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(stub.argv.slice(0, 2), ['--resume', uuid(7101)])
  assert.ok(stub.argv.includes('--settings'), 'the claude tap is injected as for any session')
  assert.equal(stub.argv.includes('--dangerously-skip-permissions'), false)
  assert.equal(canonPath(stub.cwd), canonPath(repo), 'started in the conversation\'s own folder')
  const s = JSON.parse(readFileSync(join(home, 'sessions', stub.session, 'session.json'), 'utf8'))
  assert.equal(s.agent_session_id, uuid(7101))
  assert.equal(s.transcript_path, f.claude[0].file)
  assert.equal(s.task, 'continue me')
  assert.deepEqual(s.continued_from, { id: `claude:${uuid(7101)}`, provider: 'claude', native_id: uuid(7101) })
  assert.equal(s.worktree, null, 'a continued session shares its checkout')
  const events = readFileSync(join(home, 'sessions', stub.session, 'events.jsonl'), 'utf8')
  assert.match(events, /"type":"continued"/)
  // one row, marked Leg's, not a second one beside the discovered conversation
  const ls = JSON.parse(leg(['history', '--json', '--refresh'], env))
  const rows = ls.records.filter((r) => r.native_id === uuid(7101))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].managed, true)
  assert.equal(rows[0].leg_session_id, stub.session)
  // codex: the bare `resume <id>` argv, and the old rollout bound as the session's transcript
  const text2 = leg(['history', 'continue', 'codex:00007102', '--no-auto-approve'], env)
  assert.match(text2, /with leg codex/)
  const stub2 = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(stub2.argv.slice(0, 2), ['resume', uuid(7102)])
  const s2 = JSON.parse(readFileSync(join(home, 'sessions', stub2.session, 'session.json'), 'utf8'))
  assert.equal(s2.transcript_path, f.codex[0].file)
  assert.equal(s2.agent_session_id, uuid(7102))

  // unlicensed continue refuses with exit 4 without claiming it continued
  const unlicHome = makeHome()
  const unlicEnv = testEnv(unlicHome, { BATON_UNLICENSED: '1', CLAUDE_CONFIG_DIR: f.homes.claude, CODEX_HOME: f.homes.codex, USERPROFILE: join(root, 'os-home'), HOME: join(root, 'os-home') })
  try {
    leg(['history', 'continue', 'claude:00007101'], unlicEnv)
    assert.fail('should exit 4')
  } catch (err) {
    assert.equal(err.status, 4)
    assert.equal(err.stdout.includes('continuing'), false)
  }

  // help and argument validation
  assert.match(leg(['history', '--help'], env), /leg history: every coding-agent conversation/)
  assert.match(leg(['history', '-h'], env), /leg history: every coding-agent conversation/)
  assert.match(leg(['worktrees', '--help'], env), /leg worktrees/)
  assert.match(leg(['worktrees', '-h'], env), /leg worktrees/)
  try {
    leg(['history', 'ls', '--limit', 'foo'], env)
    assert.fail('should exit 2')
  } catch (err) {
    assert.equal(err.status, 2)
    assert.match(err.stderr, /--limit must be a non-negative integer/)
  }
})
