// worktree — one git worktree per card under <repo>/.leg-worktrees/<cardId>,
// on branch leg/<cardId> (legacy .baton-worktrees/ and baton/<id> still
// resolved). Every git call runs with MSYS_NO_PATHCONV=1 (see
// git-snapshot.mjs) so Git Bash on Windows never rewrites an absolute path
// argument. Never pushes; never deletes outside those worktree dirs.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, sep, isAbsolute } from 'node:path'
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
  return segments.some((s) => { const l = process.platform === 'win32' ? s.toLowerCase() : s; return l === '.leg-worktrees' || l === '.baton-worktrees'; })
}

export function worktreePath(repo, cardId) {
  // long real path: git reports worktrees that way, and the short 8.3 form a
  // caller may pass must never become the stored worktree path
  const root = realPath(repo); const oldPath = join(root, '.baton-worktrees', cardId); if (existsSync(oldPath)) return oldPath; return join(root, '.leg-worktrees', cardId);
}

export function branchName(cardId) {
  return `leg/${cardId}`
}

export function validateRepo(repo) {
  const resolved = realPath(repo)
  const legHome = resolve(process.env.LEG_HOME || process.env.BATON_HOME || (existsSync(join(homedir(), '.leg')) ? join(homedir(), '.leg') : existsSync(join(homedir(), '.baton')) ? join(homedir(), '.baton') : join(homedir(), '.leg')))
  if (samePath(resolved, legHome)) {
    throw new Error(`refusing to use LEG_HOME as a repo: ${resolved}`)
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

// Never committed by a landing: Leg's own directories, and the local state a
// DashClaw hook writes into every directory an agent runs in.
export function ensureExcludeEntries(repo) {
  // a linked worktree or submodule has `.git` as a FILE, so the shared info dir
  // must come from git, not from assuming <repo>/.git is a directory
  let gitDir
  try { gitDir = git(repo, ['rev-parse', '--git-common-dir']).trim() } catch { gitDir = join(repo, '.git') }
  const infoDir = isAbsolute(gitDir) ? join(gitDir, 'info') : join(repo, gitDir, 'info')
  mkdirSync(infoDir, { recursive: true })
  const excludePath = join(infoDir, 'exclude')
  // .env / .env.* so a Land never commits a secret the agent left in the
  // worktree; the placeholder files are re-included, since `.env.*` otherwise
  // swallows the .env.example an agent was asked to update (an exclude entry
  // has no effect on a file the repo already tracks)
  const needed = ['.leg-worktrees/', '.leg/', '.baton-worktrees/', '.baton/', '.context-handoffs/', '.dashclaw-local/', '.env', '.env.*', '!.env.example', '!.env.sample']
  const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const lines = content.split(/\r?\n/)
  const missing = needed.filter((n) => !lines.includes(n))
  if (missing.length === 0) return
  const joiner = content.length && !content.endsWith('\n') ? '\n' : ''
  writeFileSync(excludePath, content + joiner + missing.join('\n') + '\n')
}

// The branch this repo actually calls its trunk: origin's default if there is
// one, else whatever the root checkout is on.
function defaultBranch(repo) {
  for (const argv of [['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], ['symbolic-ref', '--short', 'HEAD']]) {
    try { return git(repo, argv).trim().replace(/^origin\//, '') } catch {}
  }
  return null
}

export function ensure(repo, cardId, { trunk = 'main' } = {}) {
  const resolvedRepo = validateRepo(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  const branch = branchName(cardId)

  const already = list(resolvedRepo).find((w) => samePath(w.path, wtPath))
  if (already && existsSync(wtPath)) {
    ensureExcludeEntries(resolvedRepo)
    return { path: wtPath, branch, created: false }
  }
  // git still lists a worktree whose directory was deleted by hand; prune the
  // stale admin entry so `worktree add` below does not refuse the path
  if (already) git(resolvedRepo, ['worktree', 'prune'])

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
    // A card cut from HEAD because its trunk does not exist runs its whole
    // agent chain and then bounces every land attempt until it fails: refuse
    // here, while it has cost nothing, and name the branch this repo uses.
    try {
      git(resolvedRepo, ['rev-parse', '--verify', '--quiet', trunk])
    } catch {
      const actual = defaultBranch(resolvedRepo)
      throw new Error(`trunk ${trunk} does not exist in ${resolvedRepo}${actual ? `; this repo's default branch is ${actual} (add the card with --trunk ${actual})` : ''}`)
    }
    git(resolvedRepo, ['worktree', 'add', '-b', branch, wtPath, trunk])
  }

  ensureExcludeEntries(resolvedRepo)
  return result
}

export function remove(repo, cardId, { deleteBranch = false, force = false } = {}) {
  const resolvedRepo = resolve(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  const legWt = join(resolvedRepo, '.leg-worktrees'); const batonWt = join(resolvedRepo, '.baton-worktrees'); if (!isUnder(wtPath, legWt) && !isUnder(wtPath, batonWt)) { throw new Error(`refusing to remove a path outside .leg-worktrees: ${wtPath}`); }

  const branch = branchName(cardId)
  const already = list(resolvedRepo).find((w) => samePath(w.path, wtPath))
  let removed = false
  if (already) {
    git(resolvedRepo, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath])
    git(resolvedRepo, ['worktree', 'prune'])
    removed = true
  }

  // `git branch -d` refuses an unmerged branch; only escalate to `-D` (which
  // discards commits) when the caller explicitly forces it. branchUnmerged
  // tells the caller work would be lost.
  let branchDeleted = false
  let branchUnmerged = false
  if (deleteBranch) {
    try {
      git(resolvedRepo, ['branch', '-d', branch])
      branchDeleted = true
    } catch {
      branchUnmerged = true
      if (force) { try { git(resolvedRepo, ['branch', '-D', branch]); branchDeleted = true } catch { branchDeleted = false } }
    }
  }

  return { removed, branchDeleted, branchUnmerged }
}

// Uncommitted files in a card's worktree (empty when the worktree is clean or
// absent). Used by the board's Remove to refuse discarding agent work silently.
// A git that cannot answer throws: "status failed" must never reach that guard
// as "clean", which is the reading that force-deletes the directory.
export function worktreeDirty(repo, cardId) {
  const wtPath = worktreePath(realPath(repo), cardId)
  if (!existsSync(wtPath)) return []
  return git(wtPath, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
}

export function isWorktreeOf(repo, cardId) {
  const resolvedRepo = resolve(repo)
  const wtPath = worktreePath(resolvedRepo, cardId)
  return list(resolvedRepo).some((w) => samePath(w.path, wtPath))
}
