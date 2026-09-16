#!/usr/bin/env node
// check-branding — refuses user-facing copy that still calls the product
// Baton, LegCLI, or "Leg CLI". Compatibility identifiers (BATON_*, .baton
// paths, legacy license prefixes) and historical changelog entries are
// allowed via the lists below. Runs in `npm test` and the commit hook
// (`--staged`). Exit 1 on any hit.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')

// Forbidden in product surfaces. Domain/package `legcli` is lowercase and
// is not matched. Add a file to ALLOW_FILES or a line pattern to ALLOW_LINE
// rather than deleting a pattern.
const PATTERNS = [
  ['Baton', /\bBaton\b/],
  ['LegCLI', /LegCLI/],
  ['LegCli', /LegCli/],
  ['Leg CLI', /Leg CLI/],
]

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.supergoal', 'fixtures', 'marketing',
  '.leg', '.leg-worktrees', '.baton', '.baton-worktrees', '.context-handoffs',
  '.playwright-cli', '.design',
])
let GITIGNORED = new Set()
try {
  GITIGNORED = new Set(readFileSync(resolve(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
    .map((l) => l.trim().replace(/\/$/, ''))
    .filter((l) => l && !l.startsWith('#') && !/[*?[]/.test(l)))
} catch {}
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|gz|tgz|mp4|mp3)$/i

// Whole files that may still name the old product: history, migration tests,
// this checker. Keep this list short.
const ALLOW_FILES = new Set([
  'CHANGELOG.md',
  'site/docs/changelog.html',
  'docs/DEVIATIONS.md',
  'test/resume.test.mjs',
  'scripts/check-branding.mjs',
].map((p) => p.replace(/\\/g, '/')))

// A line is allowed when it is only documenting a compatibility identifier,
// not presenting the old name as the product.
const ALLOW_LINE = [
  /\bBATON_[A-Z0-9_]+\b/,
  /\bBATON-/,
  /\.baton\b/,
  /events-baton/,
  /baton\.pid/,
  /baton_simulated/,
  /baton-lock/,
  /baton_(price|site|personal|team)/,
  /type['":\s]+baton/,
  /\bbaton\//,
  /CustomEvent\('baton:/,
  /addEventListener\('baton:/,
  /classList\.contains\('baton'\)/,
  /\blegacy\b/i,
  /\bLEGACY_/,
  /or a baton/,
  /older Baton/,
]

function posix(p) { return p.replace(/\\/g, '/') }

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || GITIGNORED.has(name) || name.includes('\uf03a')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (!BINARY_EXT.test(name) && full !== SELF) out.push(full)
  }
  return out
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd: ROOT, encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean).map((p) => join(ROOT, p))
    .filter((p) => p !== SELF)
    .filter((p) => { try { return statSync(p).isFile() && !BINARY_EXT.test(p) } catch { return false } })
}

function allowedFile(file) {
  return ALLOW_FILES.has(posix(relative(ROOT, file)))
}

function allowedLine(line) {
  return ALLOW_LINE.some((re) => re.test(line))
}

const staged = process.argv.includes('--staged')
const files = staged ? stagedFiles() : walk(ROOT, [])
let hits = 0
for (const file of files) {
  if (allowedFile(file)) continue
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (allowedLine(lines[i])) continue
    for (const [label, re] of PATTERNS) {
      if (re.test(lines[i])) {
        hits += 1
        process.stdout.write(`${posix(relative(ROOT, file))}:${i + 1}: ${label}\n`)
      }
    }
  }
}
process.stdout.write(`check-branding: hits=${hits} files=${files.length}${staged ? ' (staged)' : ''}\n`)
process.exit(hits ? 1 : 0)
