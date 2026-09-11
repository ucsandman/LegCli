// canonPath: the comparison form used for repo, worktree and BATON_HOME paths.
// On GitHub's Windows runner the temp dir is an 8.3 short path (RUNNER~1)
// while git reports the long one; both must compare equal, including for
// paths that do not exist yet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { canonPath } from '../src/fsx.mjs'

const dir = mkdtempSync(join(tmpdir(), 'canon-'))

test('an existing path equals its realpath form; case is folded on Windows', () => {
  const real = realpathSync.native(dir)
  assert.equal(canonPath(dir), canonPath(real))
  if (process.platform === 'win32') assert.equal(canonPath(dir.toUpperCase()), canonPath(dir))
})

test('a path that does not exist yet is canonicalised through its existing ancestor', () => {
  const missing = join(dir, 'not', 'yet')
  assert.equal(canonPath(missing), canonPath(dir) + sep + 'not' + sep + 'yet')
  mkdirSync(join(dir, 'not'))
  assert.equal(canonPath(missing), canonPath(dir) + sep + 'not' + sep + 'yet')
})

test('Windows: the 8.3 short form of an existing directory equals the long form', { skip: process.platform !== 'win32' }, () => {
  const short = execFileSync('powershell', ['-NoProfile', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir}').ShortPath`], { encoding: 'utf8', windowsHide: true }).trim()
  // machines with 8.3 names disabled return the long path; the assertion still holds
  assert.equal(canonPath(short), canonPath(dir))
  assert.equal(canonPath(join(short, 'child-to-be')), canonPath(join(dir, 'child-to-be')))
})
