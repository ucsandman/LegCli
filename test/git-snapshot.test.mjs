// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'git-snapshot.mjs')

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })
}

function runFail(args) {
  try {
    run(args)
    return null
  } catch (err) {
    return { status: err.status, stderr: err.stderr.toString() }
  }
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'gitsnap-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'initial commit'])
  return repo
}

test('clean repo: recommendation "branch", correct head/branch fields', () => {
  const repo = initRepo()
  const out = JSON.parse(run(['--repo', repo]))
  assert.equal(out.recommendation, 'branch')
  assert.equal(out.dirty.staged, 0)
  assert.equal(out.dirty.modified, 0)
  assert.equal(out.dirty.untracked, 0)
  assert.equal(out.dirty.truncated, false)
  assert.equal(out.head_subject, 'initial commit')
  assert.match(out.head, /^[0-9a-f]{4,}$/)
  assert.match(out.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  const branchOut = git(repo, ['symbolic-ref', '--short', 'HEAD']).trim()
  assert.equal(out.branch, branchOut)
  assert.deepEqual(out.submodules_dirty, [])
})

test('dirty repo (one modified + one untracked): recommendation "worktree", exact counts and files', () => {
  const repo = initRepo()
  writeFileSync(join(repo, 'README.md'), 'hello world\n')
  writeFileSync(join(repo, 'new-file.txt'), 'new\n')
  const out = JSON.parse(run(['--repo', repo]))
  assert.equal(out.recommendation, 'worktree')
  assert.equal(out.dirty.staged, 0)
  assert.equal(out.dirty.modified, 1)
  assert.equal(out.dirty.untracked, 1)
  assert.equal(out.dirty.files.length, 2)
  assert.ok(out.dirty.files.some((f) => f.includes('README.md')))
  assert.ok(out.dirty.files.some((f) => f.includes('new-file.txt')))
})

test('--diff-since across 2 commits: commits length 2, changed_files/insertions counted', () => {
  const repo = initRepo()
  const before = git(repo, ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n')
  git(repo, ['add', 'a.txt'])
  git(repo, ['commit', '-q', '-m', 'add a.txt'])
  writeFileSync(join(repo, 'b.txt'), 'line1\n')
  git(repo, ['add', 'b.txt'])
  git(repo, ['commit', '-q', '-m', 'add b.txt'])
  const out = JSON.parse(run(['--repo', repo, '--diff-since', before]))
  assert.ok(out.diff)
  assert.equal(out.diff.since, before)
  assert.equal(out.diff.commits.length, 2)
  assert.equal(out.diff.changed_files, 2)
  assert.equal(out.diff.insertions, 3)
  assert.equal(out.diff.deletions, 0)
  assert.deepEqual(out.diff.commits.map((c) => c.subject).sort(), ['add a.txt', 'add b.txt'])
})

test('non-repo dir: exit 2, stderr mentions git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notgit-'))
  const fail = runFail(['--repo', dir])
  assert.equal(fail.status, 2)
  assert.match(fail.stderr, /git repo/)
})

test('max-files truncation: 25 untracked files caps at 20 with truncated=true', () => {
  const repo = initRepo()
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(repo, `untracked-${String(i).padStart(2, '0')}.txt`), 'x\n')
  }
  const out = JSON.parse(run(['--repo', repo]))
  assert.equal(out.dirty.untracked, 25)
  assert.equal(out.dirty.files.length, 20)
  assert.equal(out.dirty.truncated, true)
})
