// mergequeue — the land station. One land at a time per repo root, FIFO: the
// queue key is the canonical root (two spellings of one path are one queue) and
// the turn itself is a file lock under BATON_HOME, so a `baton card run` CLI
// and the board server cannot land into one checkout at the same time.
// land(card, worktree):
//   1. root must be on <trunk> and clean, else bounce `dirty-trunk` (root untouched)
//   1b. commit whatever the agents left uncommitted in the worktree
//   2. rebase the card branch onto trunk in the worktree; abort + bounce `rebase-conflict` with the file list, or `rebase-failed` when git failed for another reason
//   3. run the test command (card.test_command → package.json test → pytest → none + land_warning); red → bounce `tests-red` with the tail
//   4. from the root: git merge --ff-only baton/<id>; trunk moved meanwhile → one retry, then bounce `trunk-moved`
//   5. success → { landed, sha, files, insertions, deletions, duration_ms }
// No force flags, no remote writes, no hard resets on the root, ever.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { branchName } from './worktree.mjs'
import { runCommandAsync } from './commands.mjs'
import { canonPath, withFileLock, writeJsonAtomic } from './fsx.mjs'
import { home } from './store.mjs'

const TEST_TIMEOUT_MS = Number((process.env.LEG_LAND_TEST_TIMEOUT_MS || process.env.BATON_LAND_TEST_TIMEOUT_MS) || 600000)
const queues = new Map() // canonical repo root → tail promise
// A turn covers the commit, the rebase and the repo's whole test run, so a
// claim is only stale once its holder died: the test budget plus the git work
// around it. The guard lock around the claim file protects two file writes and
// keeps a short staleness of its own.
const LOCK_STALE_MS = TEST_TIMEOUT_MS + 120000
const LOCK_GUARD_STALE_MS = 5000
const LOCK_POLL_MS = 250

function git(cwd, args, { ok = true } = {}) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`)
  return r
}

// A rebase/merge/cherry-pick the agent or a human left mid-flight. Landing must
// never commit that half-state and must never abort an operation it did not
// start (aborting a rebase throws away the uncommitted work sitting on it).
function operationInProgress(worktree) {
  for (const p of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const rel = git(worktree, ['rev-parse', '--git-path', p], { ok: false }).stdout.trim()
    if (rel && existsSync(resolve(worktree, rel))) return p
  }
  return null
}

export function trunkHead(repo) {
  return git(repo, ['rev-parse', 'HEAD']).stdout.trim()
}

export function rootState(repo, trunk) {
  const branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { ok: false }).stdout.trim() || 'DETACHED'
  const dirty = git(repo, ['status', '--porcelain']).stdout.split(/\r?\n/).filter(Boolean)
  return { branch, onTrunk: branch === trunk, dirty }
}

// Commit the agents' work so the branch can be rebased and merged. The commit
// skips git hooks (--no-verify): the repo's test command is Baton's gate, and
// interactive commit hooks (linters, wire-dark style checks) belong to humans
// typing commits. BATON_COMMIT_VERIFY=1 runs them anyway.
export function commitWorktree(worktree, message) {
  const dirty = git(worktree, ['status', '--porcelain']).stdout.split(/\r?\n/).filter(Boolean)
  if (!dirty.length) return { committed: false }
  git(worktree, ['add', '-A'])
  const verify = (process.env.LEG_COMMIT_VERIFY || process.env.BATON_COMMIT_VERIFY) === '1' ? [] : ['--no-verify']
  git(worktree, ['-c', 'user.email=baton@localhost', '-c', 'user.name=baton', 'commit', '-q', ...verify, '-m', message])
  return { committed: true, files: dirty.length }
}

export function resolveTestCommand(card, worktree) {
  if (card.test_command) return { command: card.test_command, source: 'card' }
  const pkg = join(worktree, 'package.json')
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, 'utf8'))
      if (p.scripts?.test) return { command: 'npm test', source: 'package.json' }
    } catch {}
  }
  if (existsSync(join(worktree, 'pyproject.toml'))) return { command: 'pytest', source: 'pyproject.toml' }
  return { command: null, source: 'none' }
}

function runTests(command, worktree) {
  return runCommandAsync(command, worktree, { timeoutMs: TEST_TIMEOUT_MS, tailLines: 40 })
}

function bounce(reason, detail, extra = {}) {
  return { landed: false, bounced: true, reason, detail, ...extra }
}

// A non-zero `git rebase` is a conflict only when git names unmerged files.
// Anything else (a hook that refuses, an upstream git cannot use) is a
// different failure, and the bounce reason is the next agent's brief: it must
// never read as a conflict in files git never mentioned.
function rebaseBounce(worktree, trunk, result, preSha, when) {
  const files = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { ok: false }).stdout.split(/\r?\n/).filter(Boolean)
  git(worktree, ['rebase', '--abort'], { ok: false })
  const detail = (result.stderr || result.stdout).trim().slice(0, 300)
  if (files.length) return bounce('rebase-conflict', `rebase onto ${trunk}${when} conflicted in: ${files.join(', ')}`, { files, pre_sha: preSha })
  return bounce('rebase-failed', `rebase onto ${trunk}${when} failed: ${detail || '(no git output)'}`, { files, pre_sha: preSha })
}

function claimFile(key) {
  const dir = join(home(), 'locks')
  mkdirSync(dir, { recursive: true })
  return join(dir, `land-${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`)
}

function claimHolder(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

// withFileLock guards the read-modify-write of the claim; the claim it leaves
// behind outlives that guard, which is what makes the turn last a whole land.
function takeTurn(file, token) {
  return withFileLock(`${file}.lock`, () => {
    const held = claimHolder(file)
    if (held && held.token !== token && Date.now() - held.ts < LOCK_STALE_MS) return false
    writeJsonAtomic(file, { token, pid: process.pid, ts: Date.now() })
    return true
  }, { staleMs: LOCK_GUARD_STALE_MS })
}

function dropTurn(file, token) {
  withFileLock(`${file}.lock`, () => {
    const held = claimHolder(file)
    if (!held || held.token === token) { try { unlinkSync(file) } catch {} }
  }, { staleMs: LOCK_GUARD_STALE_MS })
}

async function withRepoTurn(repo, fn) {
  const file = claimFile(canonPath(repo))
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  while (!takeTurn(file, token)) await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
  try { return await fn() } finally { dropTurn(file, token) }
}

async function landNow(card, worktree, { onWarning = () => {}, allowDirtyRoot = false } = {}) {
  const t0 = Date.now()
  const repo = card.repo
  const trunk = card.trunk || 'main'
  const branch = branchName(card.card_id)

  const checkedOut = git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { ok: false }).stdout.trim() || 'DETACHED'
  if (checkedOut !== branch) return bounce('worktree-branch', `worktree is on ${checkedOut}, not ${branch}; switch it back before landing`)

  const busy = operationInProgress(worktree)
  if (busy) return bounce('worktree-busy', `a ${busy.replace(/-/g, ' ')} is already in progress in ${worktree}; finish or abort it there before landing (Baton will not touch a rebase it did not start)`)

  const root = rootState(repo, trunk)
  if (!root.onTrunk) return bounce('dirty-trunk', `repo root is on ${root.branch}, not ${trunk}; check out ${trunk} and retry`)
  // allowDirtyRoot (a terminal's Land): the root is a live checkout, dirty by
  // nature; git's own fast-forward still refuses to overwrite a local change
  if (root.dirty.length && !allowDirtyRoot) return bounce('dirty-trunk', `repo root has ${root.dirty.length} uncommitted change(s): ${root.dirty.slice(0, 10).join(', ')}`)

  const committed = commitWorktree(worktree, `baton: ${card.title ?? card.card_id}`)
  const preSha = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
  const trunkBefore = trunkHead(repo)

  const rebase = git(worktree, ['rebase', trunk], { ok: false })
  if (rebase.status !== 0) return rebaseBounce(worktree, trunk, rebase, preSha, '')

  const tc = resolveTestCommand(card, worktree)
  let tests = null
  if (!tc.command) {
    onWarning(`no test command (card, package.json, pyproject.toml); landing untested`)
  } else {
    tests = await runTests(tc.command, worktree)
    if (!tests.green) {
      return bounce('tests-red', `${tests.command} exit ${tests.status}${tests.timedOut ? ' (timed out)' : ''}:\n${tests.tail}`, { test_tail: tests.tail, pre_sha: preSha })
    }
  }

  let merge = git(repo, ['merge', '--ff-only', branch], { ok: false })
  let retried = false
  if (merge.status !== 0 && trunkHead(repo) !== trunkBefore) {
    // trunk moved while we tested: rebase once more and retry the ff
    retried = true
    const again = git(worktree, ['rebase', trunk], { ok: false })
    if (again.status !== 0) return rebaseBounce(worktree, trunk, again, preSha, ` after ${trunk} moved`)
    if (tc.command) {
      tests = await runTests(tc.command, worktree)
      if (!tests.green) {
        return bounce('tests-red', `${tests.command} exit ${tests.status}${tests.timedOut ? ' (timed out)' : ''} after ${trunk} moved:\n${tests.tail}`, { test_tail: tests.tail, pre_sha: preSha })
      }
    }
    merge = git(repo, ['merge', '--ff-only', branch], { ok: false })
  }
  if (merge.status !== 0 && /would be overwritten by merge/.test(merge.stderr || merge.stdout)) {
    const files = (merge.stderr || merge.stdout).split(/\r?\n/).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim())
    return bounce('dirty-trunk', `the ${trunk} checkout has local changes this landing would overwrite: ${files.join(', ') || '(see git output)'}`, { files })
  }
  if (merge.status !== 0) {
    return bounce('trunk-moved', `fast-forward of ${trunk} failed${retried ? ' after one retry' : ''}: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`, { retried })
  }
  const sha = trunkHead(repo)
  const stat = git(repo, ['diff', '--shortstat', `${trunkBefore}..${sha}`], { ok: false }).stdout.trim()
  const files = git(repo, ['diff', '--name-only', `${trunkBefore}..${sha}`], { ok: false }).stdout.split(/\r?\n/).filter(Boolean)
  const m = /(\d+) insertion/.exec(stat)
  const d = /(\d+) deletion/.exec(stat)
  return {
    landed: true, sha, sha_before: trunkBefore, files, insertions: m ? Number(m[1]) : 0, deletions: d ? Number(d[1]) : 0,
    duration_ms: Date.now() - t0, retried, committed: committed.committed, tests: tests ? { command: tests.command, tail: tests.tail.split('\n').slice(-3).join(' | ') } : null,
    summary: `landed on ${trunk}: ${trunkBefore.slice(0, 7)} → ${sha.slice(0, 7)} (${files.length} file${files.length === 1 ? '' : 's'}, +${m ? m[1] : 0}/-${d ? d[1] : 0})${tests ? '' : ' [untested]'}`,
    body: JSON.stringify({ sha, files, insertions: m ? Number(m[1]) : 0, deletions: d ? Number(d[1]) : 0, duration_ms: Date.now() - t0, retried, tests: tests?.command ?? null }),
  }
}

// FIFO per repo root: the caller awaits its turn, here and in every other
// process landing into the same root.
export function land(card, worktree, opts) {
  const key = canonPath(card.repo)
  const prev = queues.get(key) ?? Promise.resolve()
  const mine = prev.catch(() => {}).then(() => withRepoTurn(card.repo, () => landNow(card, worktree, opts)))
  queues.set(key, mine)
  // the bookkeeping chain must never reject on its own: landNow's throw is the
  // caller's to handle (it returns `mine`), and an unhandled rejection here
  // would take the whole board server process down with it
  mine.catch(() => {}).finally(() => { if (queues.get(key) === mine) queues.delete(key) })
  return mine
}

export function isLanding(repo) { return queues.has(canonPath(repo)) }
