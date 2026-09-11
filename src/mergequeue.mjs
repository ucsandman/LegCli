// mergequeue — the land station. One land at a time per repo root, FIFO.
// land(card, worktree):
//   1. root must be on <trunk> and clean, else bounce `dirty-trunk` (root untouched)
//   1b. commit whatever the agents left uncommitted in the worktree
//   2. rebase the card branch onto trunk in the worktree; conflict → abort + bounce `rebase-conflict` with the file list
//   3. run the test command (card.test_command → package.json test → pytest → none + land_warning); red → bounce `tests-red` with the tail
//   4. from the root: git merge --ff-only baton/<id>; trunk moved meanwhile → one retry, then bounce `trunk-moved`
//   5. success → { landed, sha, files, insertions, deletions, duration_ms }
// No force flags, no remote writes, no hard resets on the root, ever.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchName } from './worktree.mjs'
import { runCommandAsync } from './commands.mjs'

const TEST_TIMEOUT_MS = Number(process.env.BATON_LAND_TEST_TIMEOUT_MS || 600000)
const queues = new Map() // repo → tail promise

function git(cwd, args, { ok = true } = {}) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`)
  return r
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
  const verify = process.env.BATON_COMMIT_VERIFY === '1' ? [] : ['--no-verify']
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

async function landNow(card, worktree, { onWarning = () => {}, allowDirtyRoot = false } = {}) {
  const t0 = Date.now()
  const repo = card.repo
  const trunk = card.trunk || 'main'
  const branch = branchName(card.card_id)

  const root = rootState(repo, trunk)
  if (!root.onTrunk) return bounce('dirty-trunk', `repo root is on ${root.branch}, not ${trunk}; check out ${trunk} and retry`)
  // allowDirtyRoot (a terminal's Land): the root is a live checkout, dirty by
  // nature; git's own fast-forward still refuses to overwrite a local change
  if (root.dirty.length && !allowDirtyRoot) return bounce('dirty-trunk', `repo root has ${root.dirty.length} uncommitted change(s): ${root.dirty.slice(0, 10).join(', ')}`)

  const committed = commitWorktree(worktree, `baton: ${card.title ?? card.card_id}`)
  const preSha = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
  const trunkBefore = trunkHead(repo)

  const rebase = git(worktree, ['rebase', trunk], { ok: false })
  if (rebase.status !== 0) {
    const files = git(worktree, ['diff', '--name-only', '--diff-filter=U'], { ok: false }).stdout.split(/\r?\n/).filter(Boolean)
    git(worktree, ['rebase', '--abort'], { ok: false })
    return bounce('rebase-conflict', `rebase onto ${trunk} conflicted in: ${files.join(', ') || '(unknown files)'}`, { files, pre_sha: preSha })
  }

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
    if (again.status === 0) merge = git(repo, ['merge', '--ff-only', branch], { ok: false })
    else git(worktree, ['rebase', '--abort'], { ok: false })
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

// FIFO per repo: the caller awaits its turn.
export function land(card, worktree, opts) {
  const key = card.repo
  const prev = queues.get(key) ?? Promise.resolve()
  const mine = prev.catch(() => {}).then(() => landNow(card, worktree, opts))
  queues.set(key, mine)
  mine.finally(() => { if (queues.get(key) === mine) queues.delete(key) })
  return mine
}

export function isLanding(repo) { return queues.has(repo) }
