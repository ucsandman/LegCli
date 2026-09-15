#!/usr/bin/env node
// privacy-check — refuses any file in the tree that carries a string from the
// private source tooling this project was ported from. Runs in `npm test` and
// in the commit hook (`--staged`). Exit 1 on any hit.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Extend here (phase 12 may add patterns). Matching is case-insensitive.
// The first pattern skips the public GitHub handle "ucsandman" (NOTICE names
// it) but still catches the local user name and the e-mail local part.
export const PATTERNS = [
  ['sandm', /(?<!uc)sandm/i],
  ['1584804440', /1584804440/],
  ['clawd', /clawd/i],
]

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.supergoal', '.leg', '.leg-worktrees', '.baton', '.baton-worktrees', '.context-handoffs'])
// plain entries in .gitignore (no globs) are never shipped, so they are not scanned
let GITIGNORED = new Set()
try { GITIGNORED = new Set(readFileSync(resolve(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/\/$/, '')).filter((l) => l && !l.startsWith('#') && !/[*?[]/.test(l))) } catch {}
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|gz|tgz|mp4)$/i

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || GITIGNORED.has(name)) continue
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

const staged = process.argv.includes('--staged')
const files = staged ? stagedFiles() : walk(ROOT, [])
let hits = 0
for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const [label, re] of PATTERNS) {
      if (re.test(lines[i])) {
        hits += 1
        process.stdout.write(`${relative(ROOT, file)}:${i + 1}: ${label}\n`)
      }
    }
  }
}
process.stdout.write(`privacy-check: hits=${hits} files=${files.length}${staged ? ' (staged)' : ''}\n`)
process.exit(hits ? 1 : 0)
