import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  worktreePath, branchName, validateRepo, ensure, remove, list, isWorktreeOf, worktreeDirty,
} from '../src/worktree.mjs'

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'baton-wt-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'initial commit'])
  return resolve(repo)
}

test('ensure creates the worktree on branch baton/<id> and updates .git/info/exclude', () => {
  const repo = initRepo()
  const result = ensure(repo, 'card-1')
  assert.equal(result.created, true)
  assert.equal(result.branch, branchName('card-1'))
  assert.equal(result.path, worktreePath(repo, 'card-1'))
  assert.ok(existsSync(result.path))
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.match(exclude, /^\.baton-worktrees\/$/m)
  assert.match(exclude, /^\.baton\/$/m)
  assert.match(exclude, /^\.context-handoffs\/$/m, 'bundles never ride along in a landing')
  assert.match(exclude, /^\.dashclaw-local\/$/m, 'hook state never rides along in a landing')
})

test('ensure is idempotent (second call reuses, created false)', () => {
  const repo = initRepo()
  const first = ensure(repo, 'card-2')
  assert.equal(first.created, true)
  const second = ensure(repo, 'card-2')
  assert.equal(second.created, false)
  assert.equal(second.path, first.path)
  assert.equal(second.branch, first.branch)
})

test('ensure reuses an existing branch after remove without deleteBranch', () => {
  const repo = initRepo()
  ensure(repo, 'card-3')
  remove(repo, 'card-3')
  assert.equal(isWorktreeOf(repo, 'card-3'), false)
  const again = ensure(repo, 'card-3')
  assert.equal(again.created, true)
  assert.equal(again.branch, branchName('card-3'))
  assert.ok(existsSync(again.path))
})

test('list shows the worktree with its branch', () => {
  const repo = initRepo()
  ensure(repo, 'card-4')
  const entries = list(repo)
  const wt = entries.find((e) => e.path === worktreePath(repo, 'card-4'))
  assert.ok(wt, 'worktree entry present in list()')
  assert.equal(wt.branch, 'baton/card-4')
  assert.match(wt.head, /^[0-9a-f]{7,}$/)
})

test('remove deletes the worktree; deleteBranch also drops the branch', () => {
  const repo = initRepo()
  const created = ensure(repo, 'card-5')
  const result = remove(repo, 'card-5', { deleteBranch: true })
  assert.equal(result.removed, true)
  assert.equal(result.branchDeleted, true)
  assert.equal(existsSync(created.path), false)
  const branches = git(repo, ['branch', '--list', 'baton/card-5']).trim()
  assert.equal(branches, '')
})

test('remove refuses a path outside .baton-worktrees', () => {
  const repo = initRepo()
  assert.throws(() => remove(repo, '../../escape'), /refusing to remove a path outside \.baton-worktrees/)
})

test('validateRepo refuses a non-directory, a non-repo dir, an empty repo, and BATON_HOME', () => {
  const notADir = join(mkdtempSync(join(tmpdir(), 'baton-wt-')), 'does-not-exist')
  assert.throws(() => validateRepo(notADir), (err) => /^not a directory:/.test(err.message))

  const notAGitRepo = mkdtempSync(join(tmpdir(), 'baton-wt-'))
  assert.throws(() => validateRepo(notAGitRepo), (err) => /^not a git repo:/.test(err.message))

  const emptyRepo = mkdtempSync(join(tmpdir(), 'baton-wt-'))
  git(emptyRepo, ['init', '-q', '-b', 'main'])
  git(emptyRepo, ['config', 'user.email', 'test@example.com'])
  git(emptyRepo, ['config', 'user.name', 'Test User'])
  assert.throws(() => validateRepo(emptyRepo), (err) => /^repo has no commits:/.test(err.message))

  const savedBatonHome = process.env.BATON_HOME
  const fakeHome = mkdtempSync(join(tmpdir(), 'baton-home-'))
  process.env.BATON_HOME = fakeHome
  try {
    assert.throws(() => validateRepo(fakeHome), (err) => /^refusing to use BATON_HOME as a repo:/.test(err.message))
  } finally {
    if (savedBatonHome === undefined) delete process.env.BATON_HOME
    else process.env.BATON_HOME = savedBatonHome
  }
})

test('ensure refuses a trunk that does not exist and names the repo\'s own default branch', () => {
  const repo = mkdtempSync(join(tmpdir(), 'baton-wt-'))
  git(repo, ['init', '-q', '-b', 'master'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'initial commit'])
  assert.throws(() => ensure(repo, 'card-6', { trunk: 'main' }), (err) => /trunk main does not exist/.test(err.message) && /master/.test(err.message))
  assert.equal(existsSync(worktreePath(repo, 'card-6')), false, 'no branch cut from HEAD behind the card\'s back')
})

test('the exclude list hides .env but keeps .env.example visible to a landing', () => {
  const repo = initRepo()
  const result = ensure(repo, 'card-8')
  writeFileSync(join(result.path, '.env'), 'SECRET=1\n')
  writeFileSync(join(result.path, '.env.example'), 'SECRET=\n')
  const status = git(result.path, ['status', '--porcelain'])
  assert.match(status, /^\?\? \.env\.example$/m)
  assert.doesNotMatch(status, /^\?\? \.env$/m)
})

test('worktreeDirty throws when git cannot report status: a failed check must not read as clean', () => {
  const repo = initRepo()
  const result = ensure(repo, 'card-9')
  assert.deepEqual(worktreeDirty(repo, 'card-9'), [])
  // what a half-killed agent leaves behind: the worktree is there, git cannot read it
  rmSync(join(repo, '.git', 'worktrees', 'card-9'), { recursive: true, force: true })
  assert.ok(existsSync(result.path), 'the worktree is still on disk with the agent\'s work in it')
  assert.throws(() => worktreeDirty(repo, 'card-9'), /status/i)
})

test('a file written inside the worktree does not appear in the main checkout\'s git status', () => {
  const repo = initRepo()
  const result = ensure(repo, 'card-7')
  writeFileSync(join(result.path, 'scratch.txt'), 'scratch\n')
  const status = git(repo, ['status', '--porcelain']).trim()
  assert.equal(status, '')
})
