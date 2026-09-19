// git — the one git seam the interactive terminal polls through. Every call is
// argv, never a shell, with MSYS_NO_PATHCONV=1 so Git Bash on Windows does not
// rewrite a `refs/…` or `a..b` argument into a path.
//
// `status()` answers in ONE process what four calls used to: `--porcelain=v2
// --branch` carries the HEAD oid, the branch, the upstream and the ahead/behind
// counts in its header lines, beside the same dirty list `--porcelain` gave.
// One idle `leg` terminal spawned 59.5 git processes a minute and blocked its
// own event loop 4.4–10.3 s/min for that (profile 2026-09-18, §3).
import { spawnSync } from 'node:child_process'

// A `git status` on a large tree is kilobytes, not megabytes; a repo that
// somehow produces more is a runaway, and a timeout is better than a terminal
// wedged on a hung git.
const MAX_BUFFER = 8 * 1024 * 1024
const TIMEOUT_MS = 20000

// The directories Leg itself writes into the work tree: a bundle, a session
// notes file or a local DashClaw state file is never "a file this session
// touched", and the card must not show one.
const TOOL_DIRS = /^(\.leg|\.baton|\.context-handoffs|\.dashclaw-local)\//

// `ok: true` answers '' instead of null when git refuses, for callers that read
// "no output" and "not a repo" the same way (src/bundle.mjs notes).
export function git(cwd, args, { ok = false } = {}) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) return ok ? '' : null
  // trimEnd only: a v1 porcelain line starts with a space (" M README.md")
  return r.stdout.trimEnd()
}

// git quotes a path with special characters (core.quotePath) and prints it
// wrapped in double quotes. The v1 parser stripped exactly the outer pair, so
// this does too: the two agree on what lands on the card.
const unquote = (p) => p.replace(/^"|"$/g, '')

// Field counts from git-status(1) "Porcelain Format Version 2", verified
// against git 2.52.0 on 2026-09-18:
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                    → 7 fields
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig> → 8 fields
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>          → 9 fields
//   ? <path> / ! <path>
// A path may contain spaces, so the tail is taken whole, never split.
const ORDINARY = /^1(?: \S+){7} (.*)$/
const RENAMED = /^2(?: \S+){8} (.*)$/
const UNMERGED = /^u(?: \S+){9} (.*)$/
const OTHER = /^[?!] (.*)$/

// → { head, branch, upstream, ahead, behind, dirty }
// `head` is null on a repo with no commits (`# branch.oid (initial)`), `branch`
// is 'HEAD' on a detached checkout — the word `rev-parse --abbrev-ref HEAD`
// used, so every caller written against that answer still reads the same thing.
// `ahead`/`behind` are null unless the checkout tracks an upstream that exists;
// git prints `# branch.ab` only then, and a count that could not be taken must
// never be printed as a zero (redesign A.4 row 8).
export function parseStatus(text) {
  let head = null
  let branch = null
  let upstream = null
  let ahead = null
  let behind = null
  const dirty = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    if (line.startsWith('# ')) {
      const sp = line.indexOf(' ', 2)
      const key = sp === -1 ? line.slice(2) : line.slice(2, sp)
      const value = sp === -1 ? '' : line.slice(sp + 1)
      if (key === 'branch.oid') head = value === '(initial)' ? null : value
      else if (key === 'branch.head') branch = value === '(detached)' ? 'HEAD' : value
      else if (key === 'branch.upstream') upstream = value || null
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10) }
      }
      continue
    }
    let path = null
    if (line.startsWith('1 ')) path = ORDINARY.exec(line)?.[1] ?? null
    // a rename carries both names, the new one first, separated by a TAB: the
    // new name is the file that is on disk now, and the one a human recognises
    else if (line.startsWith('2 ')) path = (RENAMED.exec(line)?.[1] ?? '').split('\t')[0] || null
    else if (line.startsWith('u ')) path = UNMERGED.exec(line)?.[1] ?? null
    else if (line.startsWith('? ') || line.startsWith('! ')) path = OTHER.exec(line)?.[1] ?? null
    if (!path) continue
    const file = unquote(path)
    if (file && !TOOL_DIRS.test(file)) dirty.push(file)
  }
  return { head, branch, upstream, ahead, behind, dirty }
}

// One process for the whole picture. null when git refuses (not a repository,
// or no git on this machine) — the caller's "is this a repo at all" gate.
export function status(cwd) {
  const out = git(cwd, ['status', '--porcelain=v2', '--branch'])
  return out === null ? null : parseStatus(out)
}
