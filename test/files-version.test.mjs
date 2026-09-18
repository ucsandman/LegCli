// The board pages carry the version they shipped with, so a page served from
// disk by a process started before a release can say so (board.js
// `versionSkew`). A release bump that forgets either constant would make every
// board print the skew note against itself, so the two are pinned here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

for (const file of ['src/board/board.js', 'src/board/floor.js']) {
  test(`${file} FILES_VERSION is package.json's ${version}`, () => {
    const src = readFileSync(join(root, file), 'utf8')
    const m = src.match(/const FILES_VERSION = '([^']+)'/)
    assert.ok(m, `${file} declares FILES_VERSION`)
    assert.equal(m[1], version)
  })
}

test('the board says so when the process and the files disagree', () => {
  const src = readFileSync(join(root, 'src/board/board.js'), 'utf8')
  assert.match(src, /function versionSkew\(processVersion\)/)
  assert.match(src, /processVersion === FILES_VERSION\) return false/)
  assert.match(src, /Restart it to match: leg down && leg up/)
  const floor = readFileSync(join(root, 'src/board/floor.js'), 'utf8')
  assert.match(floor, /data\.version !== FILES_VERSION\) toast\(/)
})
