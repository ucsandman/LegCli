#!/usr/bin/env node
// release-notes — the CHANGELOG.md section for one version, for the GitHub
// release CI creates right after it publishes that version to npm.
//
//   node scripts/release-notes.mjs 0.15.1           the section body (no heading)
//   node scripts/release-notes.mjs 0.15.1 --title   "Leg 0.15.1: <first sentence>"
//
// Exits 1 with a sentence when CHANGELOG.md has no `## <version> (` heading, so
// the publish gate refuses a version nobody wrote up.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function releaseSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`)
  const start = lines.findIndex((l) => heading.test(l))
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section; write the release up before publishing it`)
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  if (!body) throw new Error(`CHANGELOG.md's "## ${version}" section is empty`)
  return body
}

// "Leg <version>: <the section's first sentence, one line, no trailing stop>",
// capped so the release list stays readable. Older sections open with a
// bullet instead of a summary paragraph; the bullet's first sentence serves.
export function releaseTitle(changelog, version, { product = 'Leg', max = 100 } = {}) {
  const body = releaseSection(changelog, version)
  const paragraph = body.split(/\n\s*\n/)[0].replace(/^[-*]\s+/, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  const first = (paragraph.match(/^.*?[.!?](?=\s|$)/) ?? [paragraph])[0].replace(/[.!?:;,]$/, '')
  let title = `${product} ${version}: ${first}`
  if (title.length > max) title = title.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
  return title
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const version = args.find((a) => !a.startsWith('--'))
  if (!version) { console.error('usage: node scripts/release-notes.mjs <version> [--title]'); process.exit(2) }
  try {
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    process.stdout.write((args.includes('--title') ? releaseTitle(changelog, version) : releaseSection(changelog, version)) + '\n')
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
