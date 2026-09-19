// The one-process git answer behind the terminal poll (src/git.mjs). The old
// poll spawned six git processes every six seconds; `status --porcelain=v2
// --branch` replaces four of them, so its parser is the thing that has to be
// right about every entry shape git can print.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo, git as gitIn } from './helpers.mjs'

const { parseStatus, status, git } = await import('../src/git.mjs')

test('the v2 parser: every entry shape, the quoted path, and the tool directories left out', () => {
  // captured from git 2.52.0 on 2026-09-18 (scratchpad probe): a modified file,
  // a rename with spaces in both names, untracked, an ignored entry, an
  // unmerged entry, a quoted non-ASCII path, and two Leg tool directories
  const text = [
    '# branch.oid 190b0c97d4b5a000ff0e30148ee653fa05f79eb9',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 822de96 822de96 README.md',
    '1 .M N... 100644 100644 100644 822de96 822de96 src/a file with spaces.mjs',
    '2 R. N... 100644 100644 100644 587be6b 587be6b R100 new name.txt\told name.txt',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt',
    '? untracked.txt',
    '? "weird \\303\\274nicode.txt"',
    '! ignored.txt',
    '? .dashclaw-local/',
    '? .leg/session-x.md',
    '? .baton/PROGRESS.md',
    '? .context-handoffs/abc/bundle.json',
  ].join('\n')
  const st = parseStatus(text)
  assert.equal(st.head, '190b0c97d4b5a000ff0e30148ee653fa05f79eb9')
  assert.equal(st.branch, 'main')
  assert.equal(st.upstream, null)
  assert.equal(st.ahead, null, 'no upstream means no count, never a zero')
  assert.equal(st.behind, null)
  assert.deepEqual(st.dirty, [
    'README.md',
    'src/a file with spaces.mjs',
    'new name.txt',
    'conflicted.txt',
    'untracked.txt',
    'weird \\303\\274nicode.txt',
    'ignored.txt',
  ])
})

test('the v2 parser: a detached HEAD says HEAD, an empty repo has no head, an upstream carries the counts', () => {
  assert.equal(parseStatus('# branch.oid 449cda6\n# branch.head (detached)').branch, 'HEAD')
  const initial = parseStatus('# branch.oid (initial)\n# branch.head main')
  assert.equal(initial.head, null)
  assert.equal(initial.branch, 'main')
  const tracked = parseStatus('# branch.oid 7075a57\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3')
  assert.equal(tracked.upstream, 'origin/main')
  assert.equal(tracked.ahead, 2)
  assert.equal(tracked.behind, 3)
  // upstream configured but the remote-tracking ref deleted: git prints the
  // upstream line and NO ab line, and `rev-parse @{upstream}` fails, so the
  // count is unknown rather than zero
  const gone = parseStatus('# branch.oid 7075a57\n# branch.head main\n# branch.upstream origin/main')
  assert.equal(gone.upstream, 'origin/main')
  assert.equal(gone.ahead, null)
  assert.equal(parseStatus('').dirty.length, 0)
})

test('status() against a real repository: modified, renamed and untracked, with the tool directory dropped', () => {
  const repo = initRepo('leg-gitstatus-')
  writeFileSync(join(repo, 'old name.txt'), 'x\n')
  gitIn(repo, ['add', 'old name.txt'])
  gitIn(repo, ['commit', '-q', '-m', 'second'])
  const head = gitIn(repo, ['rev-parse', 'HEAD']).trim()

  writeFileSync(join(repo, 'README.md'), '# toy\nchanged\n')
  renameSync(join(repo, 'old name.txt'), join(repo, 'new name.txt'))
  gitIn(repo, ['add', '-A', '--', 'old name.txt', 'new name.txt'])
  writeFileSync(join(repo, 'untracked.txt'), 'u\n')
  mkdirSync(join(repo, '.dashclaw-local'), { recursive: true })
  writeFileSync(join(repo, '.dashclaw-local', 'state.json'), '{}')

  const st = status(repo)
  assert.equal(st.head, head)
  assert.equal(st.branch, 'main')
  assert.equal(st.upstream, null)
  assert.ok(st.dirty.includes('README.md'), `README.md in ${JSON.stringify(st.dirty)}`)
  assert.ok(st.dirty.includes('new name.txt'), `the new name in ${JSON.stringify(st.dirty)}`)
  assert.ok(!st.dirty.some((f) => f.includes('old name.txt')), 'the name it had before is not a file on disk')
  assert.ok(st.dirty.includes('untracked.txt'))
  assert.ok(!st.dirty.some((f) => f.startsWith('.dashclaw-local')), 'tool directories stay off the card')

  // not a repository at all: the caller's own "is this a repo" gate
  assert.equal(status(mkdtempSync(join(tmpdir(), 'leg-norepo-'))), null)
  assert.equal(git(mkdtempSync(join(tmpdir(), 'leg-norepo-')), ['rev-parse', 'HEAD']), null)
  assert.equal(git(mkdtempSync(join(tmpdir(), 'leg-norepo-')), ['rev-parse', 'HEAD'], { ok: true }), '')
})
