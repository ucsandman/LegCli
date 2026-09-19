// The GitHub release CI creates after an npm publish takes its notes and title
// from CHANGELOG.md; a version with no section must refuse, not ship blank.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseSection, releaseTitle } from '../scripts/release-notes.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs')

const sample = `# Changelog

## 0.15.1 (2026-09-19)

Your own Claude Code status line comes back.

- **Your status line runs first.** Details here.

## 0.15.0 (2026-09-18)

A second login keeps the conversation.
`

test('releaseSection returns one version\'s body without its heading or the next section', () => {
  const body = releaseSection(sample, '0.15.1')
  assert.ok(body.startsWith('Your own Claude Code status line comes back.'))
  assert.ok(body.includes('Your status line runs first'))
  assert.ok(!body.includes('## 0.15.1'))
  assert.ok(!body.includes('A second login'))
  assert.equal(releaseSection(sample, '0.15.0'), 'A second login keeps the conversation.')
})

test('releaseTitle is "Leg <version>: <first paragraph>" with no trailing stop; 0.15.10 never matches 0.15.1', () => {
  assert.equal(releaseTitle(sample, '0.15.1'), 'Leg 0.15.1: Your own Claude Code status line comes back')
  assert.throws(() => releaseSection(sample.replace('0.15.1', '0.15.10'), '0.15.1'), /no "## 0.15.1" section/)
})

test('a version with no CHANGELOG section is refused, by the module and by the CLI (exit 1)', () => {
  assert.throws(() => releaseSection(sample, '9.9.9'), /no "## 9.9.9" section/)
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '9.9.9'], { stdio: 'pipe' }), (e) => e.status === 1 && /no "## 9.9.9" section/.test(String(e.stderr)))
})

test('the real CHANGELOG has a section for the version package.json is at, and the CLI prints it', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const body = execFileSync(process.execPath, [SCRIPT, version], { encoding: 'utf8' })
  assert.ok(body.trim().length > 20, `empty notes for ${version}`)
  const title = execFileSync(process.execPath, [SCRIPT, version, '--title'], { encoding: 'utf8' }).trim()
  assert.match(title, new RegExp(`^Leg ${version.replace(/\\./g, '\\\\.')}: .+`))
  assert.ok(title.length <= 100, title)
})
