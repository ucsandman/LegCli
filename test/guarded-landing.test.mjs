import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git } from './helpers.mjs'
import { ensure } from '../src/worktree.mjs'

let HOME
let canLand
let landSession
let applyLandFix
let drainLandingQueue
let isLandingQueued
let createSession
let updateSession
let readLandings

beforeEach(async () => {
  HOME = makeHome()
  process.env.BATON_HOME = HOME
  process.env.LEG_HOME = HOME
  process.env.BATON_QUIET = '1'
  const landMod = await import(`../src/land.mjs?update=${Date.now()}-${Math.random()}`)
  const sessMod = await import(`../src/sessions.mjs?update=${Date.now()}-${Math.random()}`)
  canLand = landMod.canLand
  landSession = landMod.landSession
  applyLandFix = landMod.applyLandFix
  drainLandingQueue = landMod.drainLandingQueue
  isLandingQueued = landMod.isLandingQueued
  createSession = sessMod.createSession
  updateSession = sessMod.updateSession
  readLandings = sessMod.readLandings
})

test('Incident 1: Land on a 0-commit worktree is refused and logged as failed', async () => {
  const repo = initRepo('inc-0commit-')
  const wt = ensure(repo, 'inc-wt-1', { trunk: 'main' })
  const sess = createSession({
    id: 's-0commit',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-0commit', { status: 'waiting' })

  const res = await landSession(sess)
  assert.equal(res.landed, false)
  assert.equal(res.bounced, true)
  assert.equal(res.reason, 'nothing_to_land')

  const landings = readLandings()
  const last = landings.find((l) => l.session_id === 's-0commit')
  assert.ok(last, 'expected ledger entry')
  assert.equal(last.status, 'failed')
  assert.equal(last.reason, 'nothing_to_land')
})

test('Incident 2: Land with uncommitted work refused; fix via commit unblocks and lands', async () => {
  const repo = initRepo('inc-dirty-')
  const wt = ensure(repo, 'inc-wt-2', { trunk: 'main' })
  writeFileSync(join(wt.path, 'f.txt'), 'dirty content\n')
  const sess = createSession({
    id: 's-dirty',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-dirty', { status: 'waiting' })

  const res = await landSession(sess, { autoCommit: false })
  assert.equal(res.landed, false)
  assert.equal(res.reason, 'working_tree_dirty')

  // Apply safe fix: commit
  const fixRes = await applyLandFix('s-dirty', 'commit')
  assert.equal(fixRes.ok, true)

  const check = canLand('s-dirty')
  assert.equal(check.ok, true)

  const landRes = await landSession(sess)
  assert.equal(landRes.landed, true)
  assert.match(git(repo, ['log', '-1', '--oneline']), /leg: save work before landing/)
})

test('Incident 3: Two worktrees landing onto main at once serialize with no interleaving', async () => {
  const repo = initRepo('inc-concurrent-')
  const wtA = ensure(repo, 'wt-a', { trunk: 'main' })
  const wtB = ensure(repo, 'wt-b', { trunk: 'main' })

  writeFileSync(join(wtA.path, 'a.txt'), 'from A\n')
  git(wtA.path, ['add', '-A'])
  git(wtA.path, ['commit', '-m', 'commit A'])

  writeFileSync(join(wtB.path, 'b.txt'), 'from B\n')
  git(wtB.path, ['add', '-A'])
  git(wtB.path, ['commit', '-m', 'commit B'])

  const sessA = createSession({
    id: 's-concurrent-a',
    agent: 'claude',
    cwd: wtA.path,
    repo,
    branch: wtA.branch,
    worktree: { path: wtA.path, branch: wtA.branch, base: 'main' },
  })
  const sessB = createSession({
    id: 's-concurrent-b',
    agent: 'codex',
    cwd: wtB.path,
    repo,
    branch: wtB.branch,
    worktree: { path: wtB.path, branch: wtB.branch, base: 'main' },
  })
  updateSession('s-concurrent-a', { status: 'waiting' })
  updateSession('s-concurrent-b', { status: 'waiting' })

  const [resA, resB] = await Promise.all([
    landSession(sessA),
    landSession(sessB),
  ])

  assert.equal(resA.landed, true)
  assert.equal(resB.landed, true)

  const log = git(repo, ['log', '--oneline', '-2'])
  assert.match(log, /commit A/)
  assert.match(log, /commit B/)
})

test('Incident 4: Landing onto main while another session edits main is queued and auto-lands when idle', async () => {
  const repo = initRepo('inc-active-target-')
  const wtA = ensure(repo, 'wt-target-a', { trunk: 'main' })
  writeFileSync(join(wtA.path, 'feature.txt'), 'feature content\n')
  git(wtA.path, ['add', '-A'])
  git(wtA.path, ['commit', '-m', 'feat: add feature'])

  createSession({
    id: 's-queue-a',
    agent: 'claude',
    cwd: wtA.path,
    repo,
    branch: wtA.branch,
    worktree: { path: wtA.path, branch: wtA.branch, base: 'main' },
  })
  updateSession('s-queue-a', { status: 'waiting' })

  // Active session on main
  createSession({
    id: 's-busy-main',
    agent: 'codex',
    cwd: repo,
    repo,
    branch: 'main',
  })
  updateSession('s-busy-main', { status: 'running', files_dirty: ['README.md'] })

  // Check canLand for A is blocked
  const check = canLand('s-queue-a')
  assert.equal(check.ok, false)
  assert.equal(check.blockers[0].code, 'target_branch_active')

  // Queue landing
  const queueRes = await applyLandFix('s-queue-a', 'queue_landing')
  assert.equal(queueRes.ok, true)
  assert.equal(isLandingQueued('s-queue-a'), true)

  // Now session B becomes idle
  updateSession('s-busy-main', { status: 'waiting', files_dirty: [] })

  // Drain landing queue
  await drainLandingQueue(repo, 'main')
  assert.equal(isLandingQueued('s-queue-a'), false)

  // Verify feature landed on main
  const log = git(repo, ['log', '-1', '--oneline'])
  assert.match(log, /feat: add feature/)
})

test('Failure-injection test: failed landing leaves NO half-finished rebase or merge in repo', async () => {
  const repo = initRepo('inc-fail-injection-')
  const pkg = JSON.stringify({ name: 'toy', type: 'module', scripts: { test: 'node --test' } })
  writeFileSync(join(repo, 'package.json'), pkg)
  git(repo, ['add', 'package.json'])
  git(repo, ['commit', '-m', 'add package.json'])

  const wt = ensure(repo, 'wt-failing', { trunk: 'main' })
  // Add a broken test
  mkdirSync(join(wt.path, 'test'), { recursive: true })
  writeFileSync(join(wt.path, 'test', 'fail.test.mjs'), 'import { test } from "node:test"\nimport assert from "node:assert"\ntest("fails", () => { assert.equal(1, 2) })\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'add broken test'])

  const sess = createSession({
    id: 's-failing-tests',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-failing-tests', { status: 'waiting' })

  const res = await landSession(sess)
  assert.equal(res.landed, false)
  assert.equal(res.bounced, true)

  // Verify working tree and main repo have no half-finished rebase or merge
  const wtStatus = git(wt.path, ['status', '--porcelain']).trim()
  assert.equal(wtStatus, '', 'worktree status must be clean')
  const repoStatus = git(repo, ['status', '--porcelain']).trim()
  assert.equal(repoStatus, '', 'repo status must be clean')

  for (const dir of [wt.path, repo]) {
    assert.equal(existsSync(join(dir, '.git', 'rebase-merge')), false, 'no rebase-merge')
    assert.equal(existsSync(join(dir, '.git', 'rebase-apply')), false, 'no rebase-apply')
    assert.equal(existsSync(join(dir, '.git', 'MERGE_HEAD')), false, 'no MERGE_HEAD')
  }
})

test('Auto-push: successful landing pushes to origin if remote exists', async () => {
  const bareDir = makeHome()
  const bareRepo = join(bareDir, 'remote.git')
  git(bareDir, ['init', '--bare', '-b', 'main', bareRepo])

  const repo = initRepo('inc-autopush-')
  git(repo, ['remote', 'add', 'origin', bareRepo])
  git(repo, ['push', '-u', 'origin', 'main'])

  const wt = ensure(repo, 'wt-autopush', { trunk: 'main' })
  writeFileSync(join(wt.path, 'shipped.txt'), 'shipped to github\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'feat: ship to github'])

  const sess = createSession({
    id: 's-autopush',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-autopush', { status: 'waiting' })

  const res = await landSession(sess)
  assert.equal(res.landed, true)
  assert.equal(res.pushed, true)

  // Verify bare repo has the commit on main
  const bareLog = git(bareRepo, ['log', '-1', '--oneline', 'main'])
  assert.match(bareLog, /feat: ship to github/)
})
