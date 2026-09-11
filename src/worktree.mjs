// worktree — one git worktree per card under <repo>/.baton-worktrees/<cardId>,
// on branch baton/<cardId>. Every git call runs with MSYS_NO_PATHCONV=1 (see
// git-snapshot.mjs) so Git Bash on Windows never rewrites an absolute path
// argument. Never pushes; never deletes outside <repo>/.baton-worktrees/.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { canonPath, realPath } from './fsx.mjs'

function git(cwd, argv) {
  return execFileSync('git', argv, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

// git reports long, real paths; callers may hand us short or symlinked ones
function samePath(a, b) {
  return canonPath(a) === canonPath(b)
}

function isUnder(child, parent) {
  const c = canonPath(child)
  const p = canonPath(parent)
  return c === p || c.startsWith(p + sep)
}

function isNestedWorktreePath(resolved) {
  const segments = resolved.split(sep)
  return segments.some((s) => process.platform === 'win32' ? s.toLowerCase() === '.baton-worktrees' : s === '.baton-worktrees')
}

export function worktreePath(repo, cardId) {
  // long real path: git reports worktrees that way, and the short 8.3 form a
  // caller may pass must never become the stored worktree path
  return join(realPath(repo), '.baton-worktrees', cardId)
}

export function branchName(cardId) {
  return `baton/${cardId}`
}

export function validateRepo(repo) {
  const resolved = realPath(repo)
  const batonHome = resolve(process.env.BATON_HOME || join(homedir(), '.baton'))
  if (samePath(resolved, batonHome)) {
    throw new Error(`refusing to use BATON_HOME as a repo: ${resolved}`)
  }
  if (isNestedWorktreePath(resolved)) {
    throw new Error('refusing a nested worktree path as a repo')
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`not a directory: ${resolved}`)
  }
  try {
    git(resolved, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`not a git repo: ${resolved}`)
  }
  try {
    git(resolved, ['rev-parse', 'HEAD'])
  } catch {
    throw new Error(`repo has no commits: ${resolved}`)
  }
  return resolved
}

function parseWorktreeList(output) {
  const entries = []
  let current = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: resolve(line.slice('worktree '.length)), head: null, branch: null }
      entries.push(current)
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

export function list(repo) {
  const resolved = resolve(repo)
  const out = git(resolved, ['worktree', 'list', '--porcelain'])
  return parseWorktreeList(out)
}

// Never committed by a landing: Baton's own directories, and the local state a
// DashClaw hook writes into every directory an agent runs in.
export function ensureExcludeEntries(repo) {
  const infoDir = join(repo, '.git', 'info')
  mkdirSync(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')
  const needed = ['.baton-worktrees/', '.baton/', '.context-handoffs/', '.dashclaw-local/']
  const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const lines = content.split(/\r?\n/)
  const missing = needed.filter((n) => !lines.includes(n))
  if (missing.length === 0) return
  const joiner = content.length && !content.endsWith('\n') ? '\n' : ''
  writeFileSync(excludePath, content + joiner + missing.join('\n') + '\n')
}

export function ensure(repo, cardId, { trunk = 'main' } = {}) {
  const resolvedRepo = validateRepo(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  const branch = branchName(cardId)

  const already = list(resolvedRepo).find((w) => samePath(w.path, wtPath))
  if (already) {
    ensureExcludeEntries(resolvedRepo)
    return { path: wtPath, branch, created: false }
  }

  let branchExists = true
  try {
    git(resolvedRepo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  } catch {
    branchExists = false
  }

  const result = { path: wtPath, branch, created: true }
  if (branchExists) {
    git(resolvedRepo, ['worktree', 'add', wtPath, branch])
  } else {
    let effectiveTrunk = trunk
    try {
      git(resolvedRepo, ['rev-parse', '--verify', '--quiet', trunk])
    } catch {
      effectiveTrunk = 'HEAD'
      result.trunk_fallback = true
    }
    git(resolvedRepo, ['worktree', 'add', '-b', branch, wtPath, effectiveTrunk])
  }

  ensureExcludeEntries(resolvedRepo)
  return result
}

export function remove(repo, cardId, { deleteBranch = false } = {}) {
  const resolvedRepo = resolve(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  const worktreesDir = join(resolvedRepo, '.baton-worktrees')
  if (!isUnder(wtPath, worktreesDir)) {
    throw new Error(`refusing to remove a path outside .baton-worktrees: ${wtPath}`)
  }

  const branch = branchName(cardId)
  const already = list(resolvedRepo).find((w) => samePath(w.path, wtPath))
  let removed = false
  if (already) {
    git(resolvedRepo, ['worktree', 'remove', '--force', wtPath])
    git(resolvedRepo, ['worktree', 'prune'])
    removed = true
  }

  let branchDeleted = false
  if (deleteBranch) {
    try {
      git(resolvedRepo, ['branch', '-D', branch])
      branchDeleted = true
    } catch {
      branchDeleted = false
    }
  }

  return { removed, branchDeleted }
}

export function isWorktreeOf(repo, cardId) {
  const resolvedRepo = resolve(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  return list(resolvedRepo).some((w) => samePath(w.path, wtPath))
}
