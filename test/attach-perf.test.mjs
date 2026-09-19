// The three seams a measured pass at the idle terminal added (profile
// 2026-09-18): the `<agent> --version` probe remembered on disk, the bundle
// checkpoint taken off the poll tick one at a time, and control.json cleared
// under the same lock the board writes it with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo } from './helpers.mjs'

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'leg-attach-perf-'))

const sessions = await import('../src/sessions.mjs')
const { chb, chbAsync } = await import('../src/handoff.mjs')
const { saveSessionBundle, saveSessionBundleAsync } = await import('../src/bundle.mjs')
const { cachedVersionProbe, checkpointGate, installedAgents } = await import('../src/attach.mjs')

// ---- the installed probe cache ---------------------------------------------
// `<agent> --version` is a subprocess with an 8 s timeout budget, per agent, and
// installedAgents ran it on every single launch on a machine where the CLI is
// only on PATH. The cache is the only thing standing between a launch and four
// of those, so it is pinned: a hit inside the TTL must not probe, a different
// resolved bin must, and an expired entry must.
test('the installed probe is remembered for a day, keyed by the resolved bin, and re-asked when it expires', () => {
  const home = mkdtempSync(join(tmpdir(), 'leg-installed-'))
  const prev = process.env.LEG_HOME
  process.env.LEG_HOME = home
  try {
    const probed = []
    const probe = (target) => { probed.push(target); return true }
    const day = 24 * 60 * 60 * 1000
    const t0 = 1_700_000_000_000

    assert.equal(cachedVersionProbe('claude', 'claude', { probe, now: t0 }), true)
    assert.deepEqual(probed, ['claude'], 'the first launch has to ask')

    // second launch, same resolved bin, inside the TTL: no subprocess
    assert.equal(cachedVersionProbe('claude', 'claude', { probe, now: t0 + 60_000 }), true)
    assert.deepEqual(probed, ['claude'], 'a hit inside the TTL must not spawn anything')

    // the answer is on disk, in the shape the board and `leg up` can read
    const file = join(home, 'installed.json')
    assert.ok(existsSync(file), `installed.json in ${JSON.stringify(readdirSync(home))}`)
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(disk.claude, { installed: true, bin: 'claude', at: t0 })

    // a different resolved bin is a different question
    assert.equal(cachedVersionProbe('claude', 'claude-2.exe', { probe, now: t0 + 60_000 }), true)
    assert.deepEqual(probed, ['claude', 'claude-2.exe'], 'a changed bin path is a miss')

    // a day later the answer is stale: a CLI that was uninstalled must show up
    const gone = (target) => { probed.push(target); return false }
    assert.equal(cachedVersionProbe('claude', 'claude-2.exe', { probe: gone, now: t0 + 60_000 + day }), false)
    assert.deepEqual(probed, ['claude', 'claude-2.exe', 'claude-2.exe'], 'an expired entry is re-asked')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).claude.installed, false, 'and the new answer replaces the old one')

    // one agent's answer never overwrites another's
    assert.equal(cachedVersionProbe('codex', 'codex', { probe, now: t0 + 60_000 + day }), true)
    const both = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(both).sort(), ['claude', 'codex'])
  } finally {
    if (prev === undefined) delete process.env.LEG_HOME; else process.env.LEG_HOME = prev
  }
})

test('a *_BIN override is never cached: the suite points that at a stub and must get a live answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'leg-installed-bin-'))
  const stub = join(home, 'stub-claude.mjs')
  writeFileSync(stub, 'process.exit(0)\n')
  const prev = process.env.LEG_HOME
  const prevBin = process.env.LEG_CLAUDE_BIN
  process.env.LEG_HOME = home
  process.env.LEG_CLAUDE_BIN = stub
  try {
    const map = await installedAgents()
    assert.equal(map.claude, true, 'an override that exists on disk is installed')
    assert.ok(!existsSync(join(home, 'installed.json')), 'and nothing about it was written to the cache')
  } finally {
    if (prev === undefined) delete process.env.LEG_HOME; else process.env.LEG_HOME = prev
    if (prevBin === undefined) delete process.env.LEG_CLAUDE_BIN; else process.env.LEG_CLAUDE_BIN = prevBin
  }
})

// ---- the checkpoint gate ----------------------------------------------------
// The periodic bundle save shells out to the python CLI with a 120 s timeout.
// Synchronous, on the poll tick, that froze limit detection and every board
// control for the whole save; asynchronous, it can outlive its own interval, so
// only one may be in flight against a session's single bundle slug.
test('the checkpoint gate: one save in flight at a time, and idle() waits for it', async () => {
  const gate = checkpointGate()
  let release = null
  let runs = 0
  const slow = () => { runs += 1; return new Promise((r) => { release = r }) }

  assert.equal(gate(slow), true, 'the first checkpoint starts')
  await Promise.resolve()
  assert.equal(runs, 1)
  assert.equal(gate(slow), false, 'a second checkpoint while the first is saving is refused')
  assert.equal(runs, 1, 'and it never started the CLI')

  let idleDone = false
  const idle = gate.idle().then(() => { idleDone = true })
  await Promise.resolve()
  assert.equal(idleDone, false, 'idle() does not resolve while a save is running')
  release()
  await idle
  assert.equal(idleDone, true)

  assert.equal(gate(slow), true, 'once the save is done the next checkpoint runs')
  await Promise.resolve() // the gate calls run on a microtask, so release is the new one
  assert.equal(runs, 2)
  release()
  await gate.idle()

  // a checkpoint that throws still releases the gate: a chb that is not
  // installed must not stop every later checkpoint for the session's life
  assert.equal(gate(() => { throw new Error('chb missing') }), true)
  await gate.idle()
  assert.equal(gate(async () => {}), true, 'the gate is open again after a failure')
  await gate.idle()
})

// ---- the asynchronous save --------------------------------------------------
// chbAsync and saveSessionBundleAsync are what the checkpoint calls now, so the
// answer they give has to be the answer the synchronous pair gave: same status,
// same bundle shape, same session record, same throw.
test('chbAsync gives the same answer as chb, exit status included', async () => {
  const sync = chb(['--version'])
  const async_ = await chbAsync(['--version'])
  assert.equal(async_.status, sync.status)
  assert.equal(async_.stdout.trim(), sync.stdout.trim())
  // a CLI that ran and refused is a status, never a throw
  const refused = await chbAsync(['load', 'no-such-bundle-id-at-all'], { cwd: mkdtempSync(join(tmpdir(), 'leg-chb-'))  })
  assert.notEqual(refused.status, 0, 'a bundle that is not there is a non-zero exit')
  assert.equal(typeof refused.stdout, 'string')
  assert.equal(typeof refused.stderr, 'string')
})

test('saveSessionBundleAsync writes the same bundle the synchronous save does, and records the checkpoint', async () => {
  const repo = initRepo('leg-async-save-')
  const id = 's-asyncsave-claude'
  sessions.createSession({ id, agent: 'claude', cwd: repo, repo, branch: 'main' })
  sessions.updateSession(id, { task: 'prove the async save', turns: 2 })

  const session = sessions.readSession(id)
  const bundle = await saveSessionBundleAsync(session, { messages: [{ role: 'user', text: 'do the thing' }], why: 'checkpoint' })
  assert.ok(bundle.id, 'a bundle id came back')
  assert.ok(existsSync(bundle.path), `bundle dir ${bundle.path}`)
  assert.ok(existsSync(bundle.notes), 'the notes file is on disk')
  assert.equal(bundle.why, 'checkpoint')
  const after = sessions.readSession(id)
  assert.equal(after.bundle.id, bundle.id, 'the session record carries it')
  assert.equal(after.checkpoints.length, 1, 'and the checkpoint is counted')

  // the second save takes the --update path (the record now has a bundle id).
  // chb mints a fresh timestamped id per save under the one slug, so the slug is
  // what "one bundle per session" means here.
  const slug = `-leg-${id}`
  const again = await saveSessionBundleAsync(sessions.readSession(id), { messages: [], why: 'checkpoint' })
  assert.ok(again.id.endsWith(slug), `${again.id} under the session's slug`)
  assert.ok(existsSync(again.path))
  assert.equal(sessions.readSession(id).checkpoints.length, 2)

  // and the synchronous save agrees with it, slug and shape alike
  const sync = saveSessionBundle(sessions.readSession(id), { messages: [], why: 'handoff' })
  assert.ok(sync.id.endsWith(slug), `${sync.id} under the session's slug`)
  assert.ok(existsSync(sync.path))
  assert.equal(sync.why, 'handoff')
  assert.deepEqual(Object.keys(sync).sort(), Object.keys(again).sort(), 'the two saves return the same shape')
  assert.equal(sessions.readSession(id).checkpoints.length, 2, 'a hand-off save is not a checkpoint')
  sessions.updateSession(id, { status: 'ended' })
})

test('an async save whose bundle id has gone still saves: the notes are written before the CLI runs', async () => {
  const repo = initRepo('leg-async-save2-')
  const id = 's-asyncsave2-claude'
  sessions.createSession({ id, agent: 'claude', cwd: repo, repo, branch: 'main' })
  // a bundle id that was never saved: the --update call has to fail and the
  // plain save has to take over, exactly as the synchronous path does
  sessions.updateSession(id, { bundle: { id: 'gone-20260101-000000-leg-nope' }, turns: 1 })
  const bundle = await saveSessionBundleAsync(sessions.readSession(id), { messages: [], why: 'checkpoint' })
  assert.ok(bundle.id && bundle.id !== 'gone-20260101-000000-leg-nope')
  assert.ok(existsSync(bundle.path))
  assert.ok(readFileSync(bundle.notes, 'utf8').includes('## Scope'))
  sessions.updateSession(id, { status: 'ended' })
})

// ---- control.json under its own lock ---------------------------------------
test('clearControl removes the request under .control.lock and leaves no lock behind', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'leg-clearctl-'))
  const id = 's-clearctl-claude'
  sessions.createSession({ id, agent: 'claude', cwd, repo: cwd })
  const dir = sessions.sessionDir(id)

  sessions.requestControl(id, { handoff: true, by: 'wes' })
  assert.ok(existsSync(join(dir, 'control.json')), 'the board wrote a request')
  sessions.clearControl(id)
  assert.ok(!existsSync(join(dir, 'control.json')), 'and the terminal cleared it')
  assert.ok(!existsSync(join(dir, '.control.lock')), 'the lock is released, not left for the next writer to steal')

  // clearing nothing is not an error: every way out of the leg loop arrives here
  sessions.clearControl(id)
  assert.ok(!existsSync(join(dir, 'control.json')))
  sessions.updateSession(id, { status: 'ended' })
})

test('attach clears control.json through the lock, never with a bare rmSync', () => {
  const src = readFileSync(new URL('../src/attach.mjs', import.meta.url), 'utf8')
  // the board writes control.json under .control.lock (requestControl); a bare
  // unlink from this side could delete a request mid-write and lose it
  const bare = src.split('\n').filter((l) => /rmSync\(/.test(l) && /control\.json/.test(l))
  assert.deepEqual(bare, [], 'control.json is removed by sessions.clearControl')
  assert.match(src, /clearControl\(sid\)/)
})
