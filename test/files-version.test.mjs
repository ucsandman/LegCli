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

// The landing page's JSON-LD tells search engines which version is current;
// it sat at 0.14.0 through three releases because nothing pinned it.
test(`site/index.html softwareVersion is package.json's ${version}`, () => {
  const html = readFileSync(join(root, 'site/index.html'), 'utf8')
  const m = html.match(/"softwareVersion":\s*"([^"]+)"/)
  assert.ok(m, 'site/index.html declares softwareVersion')
  assert.equal(m[1], version)
})

// A Personal key activates when RELEASE_DATE is on or before its
// updates_until, so a release that keeps an old date hands out releases the
// key did not cover. It sat at 2026-09-18 from 0.14.0 through 0.17.0.
test(`src/license.mjs RELEASE_DATE is the date CHANGELOG.md gives ${version}`, () => {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const heading = changelog.match(/^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)/m)
  assert.ok(heading, 'CHANGELOG.md opens with a "## <version> (<date>)" heading')
  assert.equal(heading[1], version, 'the newest CHANGELOG entry is the package.json version')
  const src = readFileSync(join(root, 'src/license.mjs'), 'utf8')
  const m = src.match(/export const RELEASE_DATE = '([^']+)'/)
  assert.ok(m, 'src/license.mjs declares RELEASE_DATE')
  assert.equal(m[1], heading[2])
})

test('the board says so when the process and the files disagree', () => {
  const src = readFileSync(join(root, 'src/board/board.js'), 'utf8')
  assert.match(src, /function versionSkew\(processVersion\)/)
  assert.match(src, /processVersion === FILES_VERSION\) return false/)
  assert.match(src, /Restart it to match: leg down && leg up/)
  const floor = readFileSync(join(root, 'src/board/floor.js'), 'utf8')
  assert.match(floor, /data\.version !== FILES_VERSION\) toast\(/)
})
