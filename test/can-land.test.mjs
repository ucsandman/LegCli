import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git } from './helpers.mjs'
import { ensure } from '../src/worktree.mjs'

let HOME
let canLand
let acquireTargetLock
let releaseTargetLock
let createSession
let updateSession

beforeEach(async () => {
  HOME = makeHome()
  process.env.BATON_HOME = HOME
  process.env.LEG_HOME = HOME
  process.env.BATON_QUIET = '1'
  const landMod = await import(`../src/land.mjs?update=${Date.now()}-${Math.random()}`)
  const sessMod = await import(`../src/sessions.mjs?update=${Date.now()}-${Math.random()}`)
  canLand = landMod.canLand
  acquireTargetLock = landMod.acquireTargetLock
  releaseTargetLock = landMod.releaseTargetLock
  createSession = sessMod.createSession
  updateSession = sessMod.updateSession
})

test('Guard 1: zero commits ahead returns nothing_to_land', () => {
  const repo = initRepo('cl-guard1-')
  const wt = ensure(repo, 'wt-1', { trunk: 'main' })
  // wt is clean and has 0 commits ahead of main
  const res = canLand({
    repo,
    path: wt.path,
    branch: wt.branch,
    base: 'main',
  })
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'nothing_to_land')
  assert.ok(b, 'expected nothing_to_land blocker')
  assert.match(b.message, /Nothing to land/i)
})

test('Guard 2: dirty worktree returns working_tree_dirty with commit and stash fixes', () => {
  const repo = initRepo('cl-guard2-')
  const wt = ensure(repo, 'wt-2', { trunk: 'main' })
  writeFileSync(join(wt.path, 'uncommitted.txt'), 'hello\n')
  const res = canLand({
    repo,
    path: wt.path,
    branch: wt.branch,
    base: 'main',
  })
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'working_tree_dirty')
  assert.ok(b, 'expected working_tree_dirty blocker')
  assert.match(b.message, /Working tree dirty/i)
  const actions = (b.fixes || [b.fix]).map((f) => f.action)
  assert.ok(actions.includes('commit'), 'expected commit fix')
  assert.ok(actions.includes('stash'), 'expected stash fix')
})

test('Guard 3: worktree on target branch directly returns on_target_branch with commit_directly fix', () => {
  const repo = initRepo('cl-guard3-')
  const res = canLand({
    repo,
    path: repo,
    branch: 'main',
    base: 'main',
  })
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'on_target_branch')
  assert.ok(b, 'expected on_target_branch blocker')
  assert.match(b.message, /landing onto itself is meaningless/i)
  assert.equal(b.fix?.action, 'commit_directly')
})

test('Guard 4: session attached to worktree is running returns session_running', () => {
  const repo = initRepo('cl-guard4-')
  const wt = ensure(repo, 'wt-4', { trunk: 'main' })
  writeFileSync(join(wt.path, 'work.txt'), 'committed work\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'feat: work'])

  createSession({
    id: 's-test-running',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-test-running', { status: 'running' })

  const res = canLand('s-test-running')
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'session_running')
  assert.ok(b, 'expected session_running blocker')
  assert.match(b.message, /Session still running/i)
})

test('Guard 5: target branch is active/edited in another session returns target_branch_active', () => {
  const repo = initRepo('cl-guard5-')
  const wt = ensure(repo, 'wt-5', { trunk: 'main' })
  writeFileSync(join(wt.path, 'work.txt'), 'committed work\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'feat: work'])

  createSession({
    id: 's-landing',
    agent: 'claude',
    cwd: wt.path,
    repo,
    branch: wt.branch,
    worktree: { path: wt.path, branch: wt.branch, base: 'main' },
  })
  updateSession('s-landing', { status: 'waiting' })

  // Other session on main that is dirty/running
  createSession({
    id: 's-editing-main',
    agent: 'codex',
    cwd: repo,
    repo,
    branch: 'main',
  })
  updateSession('s-editing-main', { status: 'running', files_dirty: ['README.md'] })

  const res = canLand('s-landing')
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'target_branch_active')
  assert.ok(b, 'expected target_branch_active blocker')
  assert.match(b.message, /s-editing-main/i)
  assert.equal(b.fix?.action, 'queue_landing')
})

test('Guard 6: rebase dry-run conflict returns rebase_conflict with conflicted file list and rebase_now fix', () => {
  const repo = initRepo('cl-guard6-')
  writeFileSync(join(repo, 'shared.txt'), 'base line\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-m', 'add shared.txt'])

  const wt = ensure(repo, 'wt-6', { trunk: 'main' })
  writeFileSync(join(wt.path, 'shared.txt'), 'branch line\n')
  git(wt.path, ['add', 'shared.txt'])
  git(wt.path, ['commit', '-m', 'branch changes shared.txt'])

  // Now create conflicting commit on main
  writeFileSync(join(repo, 'shared.txt'), 'main line conflict\n')
  git(repo, ['add', 'shared.txt'])
  git(repo, ['commit', '-m', 'main changes shared.txt'])

  const res = canLand({
    repo,
    path: wt.path,
    branch: wt.branch,
    base: 'main',
  })
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'rebase_conflict')
  assert.ok(b, 'expected rebase_conflict blocker')
  assert.match(b.message, /shared\.txt/)
  assert.ok(b.files.includes('shared.txt'))
  assert.equal(b.fix?.action, 'rebase_now')
})

test('Guard 7: target branch locked returns target_locked naming holder', () => {
  const repo = initRepo('cl-guard7-')
  const wt = ensure(repo, 'wt-7', { trunk: 'main' })
  writeFileSync(join(wt.path, 'work.txt'), 'work\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'work'])

  const lock = acquireTargetLock(repo, 'main', 's-holder-99')
  try {
    const res = canLand({
      repo,
      path: wt.path,
      branch: wt.branch,
      base: 'main',
    })
    assert.equal(res.ok, false)
    const b = res.blockers.find((x) => x.code === 'target_locked')
    assert.ok(b, 'expected target_locked blocker')
    assert.match(b.message, /s-holder-99/)
  } finally {
    releaseTargetLock(repo, 'main', lock.token)
  }
})

test('Guard 8: test failure attached blocks landing with output', () => {
  const repo = initRepo('cl-guard8-')
  const wt = ensure(repo, 'wt-8', { trunk: 'main' })
  writeFileSync(join(wt.path, 'work.txt'), 'work\n')
  git(wt.path, ['add', '-A'])
  git(wt.path, ['commit', '-m', 'work'])

  const res = canLand({
    repo,
    path: wt.path,
    branch: wt.branch,
    base: 'main',
  }, {
    testResult: {
      green: false,
      command: 'npm test',
      status: 1,
      tail: 'FAIL test/something.test.js\nAssertionError: expected true but got false',
    },
  })
  assert.equal(res.ok, false)
  const b = res.blockers.find((x) => x.code === 'test_failure')
  assert.ok(b, 'expected test_failure blocker')
  assert.match(b.message, /Test command failed/i)
  assert.match(b.output, /AssertionError/i)
})
