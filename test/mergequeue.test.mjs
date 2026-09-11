import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, initRepo, git } from './helpers.mjs'
import { ensure } from '../src/worktree.mjs'
import { land, rootState, resolveTestCommand, commitWorktree, trunkHead } from '../src/mergequeue.mjs'

process.env.BATON_HOME = makeHome()

const PKG = JSON.stringify({ name: 'toy', type: 'module', scripts: { test: 'node --test' } })
const GREEN = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('base', () => { assert.equal(1, 1) })\n"

function toy() {
  const repo = initRepo('land-')
  writeFileSync(join(repo, 'package.json'), PKG)
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'test', 'base.test.mjs'), GREEN)
  writeFileSync(join(repo, 'shared.txt'), 'line one\nline two\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'toy with tests'])
  return repo
}

const card = (repo, id, over = {}) => ({ card_id: id, title: `card ${id}`, repo, trunk: 'main', test_command: null, land_attempts: 0, ...over })

test('dirty-trunk: root not on trunk or not clean → bounce without touching it', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-dirty').path
  writeFileSync(join(repo, 'scratch.txt'), 'x')
  const r1 = await land(card(repo, 'c-dirty'), wt)
  assert.equal(r1.bounced, true)
  assert.equal(r1.reason, 'dirty-trunk')
  assert.match(r1.detail, /uncommitted change/)
  git(repo, ['checkout', '-q', '-b', 'elsewhere'])
  const r2 = await land(card(repo, 'c-dirty'), wt)
  assert.equal(r2.reason, 'dirty-trunk')
  assert.match(r2.detail, /on elsewhere, not main/)
  assert.deepEqual(rootState(repo, 'main'), { branch: 'elsewhere', onTrunk: false, dirty: ['?? scratch.txt'] })
})

test('clean path: worktree changes are committed, rebased, tested, fast-forwarded; landed carries sha/files/counts', async () => {
  const repo = toy()
  const before = trunkHead(repo)
  const wt = ensure(repo, 'c-ok').path
  writeFileSync(join(wt, 'a.mjs'), 'export const a = 1\n')
  const r = await land(card(repo, 'c-ok'), wt)
  assert.equal(r.landed, true, JSON.stringify(r))
  assert.notEqual(r.sha, before)
  assert.equal(r.sha, trunkHead(repo))
  assert.deepEqual(r.files, ['a.mjs'])
  assert.equal(r.insertions, 1)
  assert.equal(r.committed, true)
  assert.equal(r.tests.command.includes('npm-cli.js'), true, 'npm test ran through node, not a shell')
  assert.match(r.summary, /landed on main: [0-9a-f]{7} → [0-9a-f]{7} \(1 file, \+1\/-0\)/)
  assert.match(git(repo, ['log', '--oneline', '-1']), /baton: card c-ok/)
  assert.equal(readFileSync(join(repo, 'a.mjs'), 'utf8').trim(), 'export const a = 1')
})

test('rebase-conflict: abort, list the files, root untouched', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-conf').path
  // trunk moves on shared.txt after the worktree branched
  writeFileSync(join(repo, 'shared.txt'), 'line one (trunk)\nline two\n')
  git(repo, ['commit', '-q', '-am', 'trunk edit'])
  const trunkSha = trunkHead(repo)
  writeFileSync(join(wt, 'shared.txt'), 'line one (card)\nline two\n')
  const r = await land(card(repo, 'c-conf'), wt)
  assert.equal(r.bounced, true)
  assert.equal(r.reason, 'rebase-conflict')
  assert.deepEqual(r.files, ['shared.txt'])
  assert.match(r.detail, /conflicted in: shared.txt/)
  assert.equal(trunkHead(repo), trunkSha, 'trunk untouched')
  assert.equal(git(wt, ['status', '--porcelain']).trim(), '', 'worktree left clean after abort')
  assert.doesNotMatch(git(wt, ['status']), /rebase in progress/)
})

test('tests-red: the tail travels with the bounce; trunk untouched', async () => {
  const repo = toy()
  const trunkSha = trunkHead(repo)
  const wt = ensure(repo, 'c-red').path
  writeFileSync(join(wt, 'test', 'broken.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('broken', () => { assert.equal(1, 2) })\n")
  const r = await land(card(repo, 'c-red'), wt)
  assert.equal(r.reason, 'tests-red')
  assert.match(r.detail, /exit 1/)
  assert.match(r.test_tail, /fail 1/)
  assert.equal(trunkHead(repo), trunkSha)
})

test('no test command → land_warning callback, landed untested', async () => {
  const repo = initRepo('land-notest-')
  const wt = ensure(repo, 'c-nt').path
  writeFileSync(join(wt, 'x.txt'), 'x\n')
  const warnings = []
  const r = await land(card(repo, 'c-nt'), wt, { onWarning: (m) => warnings.push(m) })
  assert.equal(r.landed, true)
  assert.equal(r.tests, null)
  assert.match(r.summary, /\[untested\]/)
  assert.match(warnings[0], /no test command/)
  assert.deepEqual(resolveTestCommand({ test_command: null }, wt), { command: null, source: 'none' })
  assert.deepEqual(resolveTestCommand({ test_command: 'make check' }, wt), { command: 'make check', source: 'card' })
})

test('trunk-moved: trunk advances between the test and the ff → one retry lands it', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-move').path
  writeFileSync(join(wt, 'b.mjs'), 'export const b = 2\n')
  // Simulate the race: another landing commits to trunk while our tests run, by
  // landing a second worktree's change first through the same queue.
  const wt2 = ensure(repo, 'c-other').path
  writeFileSync(join(wt2, 'c.mjs'), 'export const c = 3\n')
  const [a, b] = await Promise.all([land(card(repo, 'c-other'), wt2), land(card(repo, 'c-move'), wt)])
  assert.equal(a.landed, true)
  assert.equal(b.landed, true)
  const log = git(repo, ['log', '--oneline', '-3'])
  assert.match(log, /baton: card c-move/)
  assert.match(log, /baton: card c-other/)
})

test('commitWorktree is a no-op on a clean tree and never touches the root', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-clean').path
  assert.deepEqual(commitWorktree(wt, 'noop'), { committed: false })
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '')
})

test('source hygiene: no --force, push, or reset --hard in the merge queue; every git spawn sets MSYS_NO_PATHCONV', () => {
  for (const f of ['src/mergequeue.mjs', 'src/land.mjs', 'src/stations/land.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /--force|'push'|reset --hard|'reset', '--hard'/, f)
  }
  const mq = readFileSync(new URL('../src/mergequeue.mjs', import.meta.url), 'utf8')
  assert.ok(mq.includes("MSYS_NO_PATHCONV: '1'"))
  assert.equal((mq.match(/spawnSync\('git'/g) || []).length, 1, 'one git helper')
})

test('an agent-created .env.example lands; a real .env never leaves the worktree', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-env').path
  writeFileSync(join(wt, '.env.example'), 'DATABASE_URL=\n')
  writeFileSync(join(wt, '.env'), 'DATABASE_URL=postgres://user:pw@host/db\n')
  const r = await land(card(repo, 'c-env'), wt)
  assert.equal(r.landed, true, JSON.stringify(r))
  assert.deepEqual(r.files, ['.env.example'])
  assert.equal(readFileSync(join(repo, '.env.example'), 'utf8').trim(), 'DATABASE_URL=')
  assert.equal(existsSync(join(repo, '.env')), false, 'the secret file stays excluded')
})

test('a rebase that fails without a conflict bounces rebase-failed carrying git\'s reason', async () => {
  const repo = toy()
  const hooks = mkdtempSync(join(tmpdir(), 'land-hooks-'))
  // mode matters on Linux: git skips a hook that is not executable
  writeFileSync(join(hooks, 'pre-rebase'), '#!/bin/sh\necho "refused by policy" >&2\nexit 1\n', { mode: 0o755 })
  git(repo, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')])
  const wt = ensure(repo, 'c-hook').path
  // trunk moves so the rebase is a real one for the hook to refuse
  writeFileSync(join(repo, 'trunk.txt'), 'moved\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '--no-verify', '-m', 'trunk edit'])
  const trunkSha = trunkHead(repo)
  writeFileSync(join(wt, 'h.mjs'), 'export const h = 1\n')
  const r = await land(card(repo, 'c-hook'), wt)
  assert.equal(r.bounced, true)
  assert.equal(r.reason, 'rebase-failed', JSON.stringify(r))
  assert.match(r.detail, /refused by policy|pre-rebase hook/)
  assert.doesNotMatch(r.detail, /conflicted in/)
  assert.equal(trunkHead(repo), trunkSha, 'trunk untouched')
})

test('the retry rebase after trunk moved reports its own conflict, not a fast-forward race', async () => {
  const repo = toy()
  const wt = ensure(repo, 'c-retry').path
  const mover = join(mkdtempSync(join(tmpdir(), 'land-move-')), 'move-trunk.mjs')
  writeFileSync(mover, [
    "import { execFileSync } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const repo = process.argv[2]',
    "writeFileSync(join(repo, 'shared.txt'), 'line one (trunk)\\nline two\\n')",
    "execFileSync('git', ['commit', '-q', '--no-verify', '-am', 'trunk moved during tests'], { cwd: repo, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })",
    '',
  ].join('\n'))
  writeFileSync(join(wt, 'shared.txt'), 'line one (card)\nline two\n')
  const r = await land(card(repo, 'c-retry', { test_command: `node ${mover} ${repo}` }), wt)
  assert.equal(r.bounced, true)
  assert.equal(r.reason, 'rebase-conflict', JSON.stringify(r))
  assert.deepEqual(r.files, ['shared.txt'])
  assert.match(r.detail, /after main moved/)
  assert.equal(git(wt, ['status', '--porcelain']).trim(), '', 'worktree left clean after abort')
})

test('allowDirtyRoot (a terminal\'s Land): an unrelated root change does not stop the landing; a root change the landing would overwrite bounces dirty-trunk naming the file', async () => {
  const repo = toy()
  writeFileSync(join(repo, 'notes.txt'), 'scratch\n')
  const wt = ensure(repo, 'c-dirty-ok').path
  writeFileSync(join(wt, 'b.mjs'), 'export const b = 1\n')
  const ok = await land(card(repo, 'c-dirty-ok', { test_command: 'node -e 0' }), wt, { allowDirtyRoot: true })
  assert.equal(ok.landed, true, JSON.stringify(ok))
  assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'scratch\n', 'the root change is still there')
  writeFileSync(join(repo, 'shared.txt'), 'root edit\n')
  const wt2 = ensure(repo, 'c-dirty-clash').path
  writeFileSync(join(wt2, 'shared.txt'), 'worktree edit\n')
  const clash = await land(card(repo, 'c-dirty-clash', { test_command: 'node -e 0' }), wt2, { allowDirtyRoot: true })
  assert.equal(clash.reason, 'dirty-trunk', JSON.stringify(clash))
  assert.match(clash.detail, /local changes this landing would overwrite: shared\.txt/)
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'root edit\n', 'the root edit survives')
})
