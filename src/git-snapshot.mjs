#!/usr/bin/env node
// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
// git-snapshot — read-only git state snapshot. Prints ONE compact JSON object to stdout. Never mutates the repo.
// See PROTOCOL.md § Git workflow (coding tasks).
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

function die(code, msg) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      die(2, `bad argument pair near "${argv[i]}"`)
    }
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const repoArg = args['repo']
if (!repoArg) die(2, 'missing --repo <path>')
const repo = resolve(repoArg)
if (!existsSync(repo) || !statSync(repo).isDirectory()) {
  die(2, `not a directory: ${repo}`)
}

let maxFiles = 20
if (args['max-files'] !== undefined) {
  maxFiles = parseInt(args['max-files'], 10)
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    die(2, `invalid --max-files "${args['max-files']}"`)
  }
}

function git(gitArgs) {
  // MSYS_NO_PATHCONV: Git Bash would rewrite a leading-slash argument into a
  // Windows path (LESSONS 07-09); harmless elsewhere.
  return execFileSync('git', gitArgs, { cwd: repo, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

try {
  git(['rev-parse', '--is-inside-work-tree'])
} catch {
  die(2, `not a git repo: ${repo}`)
}

let branch
try {
  branch = git(['symbolic-ref', '--short', '-q', 'HEAD']).trim()
} catch {
  branch = 'DETACHED'
}

let head, head_subject
try {
  head = git(['rev-parse', '--short', 'HEAD']).trim()
  head_subject = git(['log', '-1', '--format=%s']).trim()
} catch {
  die(2, `repo has no commits: ${repo}`)
}

const statusLines = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
let staged = 0
let modified = 0
let untracked = 0
for (const line of statusLines) {
  if (line.startsWith('??')) {
    untracked++
    continue
  }
  if (line[0] !== ' ') staged++
  if (line[1] !== ' ') modified++
}
const dirty = {
  staged,
  modified,
  untracked,
  files: statusLines.slice(0, maxFiles),
  truncated: statusLines.length > maxFiles,
}

let submodules_dirty = []
try {
  const subLines = git(['submodule', 'status']).split(/\r?\n/).filter(Boolean)
  submodules_dirty = subLines
    .filter((l) => l[0] === '+' || l[0] === 'U')
    .map((l) => l.slice(1).trim().split(/\s+/)[1])
    .filter(Boolean)
} catch {
  submodules_dirty = []
}

let recommendation
if (dirty.staged === 0 && dirty.modified === 0 && dirty.untracked === 0) {
  recommendation = 'branch'
} else {
  recommendation = 'worktree'
}

const snapshot = {
  ts: new Date().toISOString(),
  repo,
  branch,
  head,
  head_subject,
  dirty,
  submodules_dirty,
  recommendation,
}

if (args['diff-since']) {
  const since = args['diff-since']
  let logLines
  let numstatLines
  try {
    logLines = git(['log', '--oneline', `${since}..HEAD`]).split(/\r?\n/).filter(Boolean)
    numstatLines = git(['diff', '--numstat', `${since}..HEAD`]).split(/\r?\n/).filter(Boolean)
  } catch (err) {
    die(2, `invalid --diff-since ref "${since}": ${err.message}`)
  }
  const commits = logLines.map((l) => {
    const sp = l.indexOf(' ')
    return sp === -1 ? { hash: l, subject: '' } : { hash: l.slice(0, sp), subject: l.slice(sp + 1) }
  })
  let insertions = 0
  let deletions = 0
  const files = []
  for (const line of numstatLines) {
    const [ins, del, path] = line.split('\t')
    if (ins !== '-') insertions += parseInt(ins, 10)
    if (del !== '-') deletions += parseInt(del, 10)
    files.push(path)
  }
  snapshot.diff = {
    since,
    commits,
    changed_files: numstatLines.length,
    insertions,
    deletions,
    files: files.slice(0, maxFiles),
    truncated: files.length > maxFiles,
  }
}

process.stdout.write(JSON.stringify(snapshot) + '\n')
