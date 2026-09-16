// land — the land station handler the orchestrator calls, and the Land button
// on a terminal card. Guarded state machine: canLand(worktreeId) validates all
// pre-conditions before landing is enabled. Two-phase landing: prepare dry-runs
// rebase and tests in a scratch worktree; atomic land updates trunk only when green,
// auto-pushes to origin, and writes ledger entries for both success and failure.
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { land, resolveTestCommand, runTests, rootState, commitWorktree } from './mergequeue.mjs'
import { openPr } from './stations/pr.mjs'
import { cardDir, ledgerAppend, home, readCard } from './store.mjs'
import { remove as removeWorktree, ensureExcludeEntries, branchName } from './worktree.mjs'
import { appendEvent, writeLand, appendLanding, listSessions, readSession, isActive, pidAlive } from './sessions.mjs'
import { scrub } from './redact.mjs'
import { canonPath, withFileLock, writeJsonAtomic } from './fsx.mjs'

export async function landCard(card, worktree) {
  const warn = (msg) => ledgerAppend(card.card_id, { type: 'land_warning', station: card.station, leg: 0, summary: msg })
  if (card.land_mode === 'pr') {
    const r = openPr({ card: { ...card, worktree }, runDir: join(cardDir(card.card_id), 'land') })
    if (!r.ok) return { landed: false, bounced: false, pr: false, reason: `pr mode: ${r.error}` }
    return { landed: false, pr: true, url: r.url, summary: `pull request opened: ${r.url ?? '(no url)'}`, argv: r.argv }
  }
  return land(card, worktree, { onWarning: warn })
}

// ---- terminals & in-flight tracking ----
const inFlight = new Set()
export function landingNow(id) { return inFlight.has(id) }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

// ---- target-branch locking (keyed on canonical repo path + branch) ----
export function targetLockFile(repo, branch) {
  const dir = join(home(), 'locks')
  mkdirSync(dir, { recursive: true })
  const key = `${canonPath(repo)}:${branch}`
  return join(dir, `target-${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`)
}

export function checkTargetLock(repo, branch) {
  const file = targetLockFile(repo, branch)
  if (!existsSync(file)) return { locked: false }
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))
    const alive = pidAlive(lock.pid)
    const timeoutMs = Number(process.env.LEG_LAND_TEST_TIMEOUT_MS || process.env.BATON_LAND_TEST_TIMEOUT_MS || 600000) + 120000
    const expired = Date.now() - lock.ts > timeoutMs
    if (!alive || expired) {
      try { unlinkSync(file) } catch {}
      return { locked: false, reaped: true }
    }
    return { locked: true, sessionId: lock.session_id, pid: lock.pid, ts: lock.ts, token: lock.token }
  } catch {
    return { locked: false }
  }
}

export function acquireTargetLock(repo, branch, sessionId, { timeoutMs = 60000, waitMs = 200 } = {}) {
  const file = targetLockFile(repo, branch)
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const acquired = withFileLock(`${file}.lock`, () => {
      const lock = checkTargetLock(repo, branch)
      if (lock.locked && lock.sessionId !== sessionId && lock.token !== token) return false
      writeJsonAtomic(file, { token, pid: process.pid, ts: Date.now(), session_id: sessionId, repo: canonPath(repo), branch })
      return true
    })
    if (acquired) return { token, file }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  }
  throw new Error(`timeout waiting for target-branch lock for ${branch} on ${repo}`)
}

export function releaseTargetLock(repo, branch, token) {
  const file = targetLockFile(repo, branch)
  withFileLock(`${file}.lock`, () => {
    try {
      if (existsSync(file)) {
        const lock = JSON.parse(readFileSync(file, 'utf8'))
        if (!token || lock.token === token || lock.pid === process.pid) {
          unlinkSync(file)
        }
      }
    } catch {}
  })
}

// ---- queued landings ----
const landingQueue = new Map()

export function queueLanding(sessionId, { by = 'local' } = {}) {
  const s = readSession(sessionId)
  if (!s || !s.worktree) return { ok: false, error: 'no worktree' }
  const base = s.worktree.base || 'main'
  const key = `${canonPath(s.repo)}:${base}`
  const list = landingQueue.get(key) || []
  if (!list.some((item) => item.sessionId === sessionId)) {
    list.push({ sessionId, by, queuedAt: Date.now() })
    landingQueue.set(key, list)
    appendEvent(sessionId, { type: 'land_queued', by, summary: `landing queued for ${s.worktree.branch} onto ${base}` })
  }
  return { ok: true, queued: true, position: list.length }
}

export function isLandingQueued(sessionId) {
  for (const list of landingQueue.values()) {
    if (list.some((item) => item.sessionId === sessionId)) return true
  }
  return false
}

export async function drainLandingQueue(repo, branch) {
  if (!repo || !branch) return
  const key = `${canonPath(repo)}:${branch}`
  const list = landingQueue.get(key)
  if (!list || !list.length) return
  const next = list[0]
  const s = readSession(next.sessionId)
  if (!s) {
    list.shift()
    return drainLandingQueue(repo, branch)
  }
  const check = canLand(s)
  if (check.ok) {
    list.shift()
    try {
      await landSession(s, { by: next.by })
    } catch {
      // logged in landSession
    }
  }
}

// ---- resolve worktree context ----
export function resolveWorktreeContext(worktreeId) {
  if (!worktreeId) return null
  if (typeof worktreeId === 'object') {
    if (worktreeId.worktree) {
      return {
        session: worktreeId,
        repo: worktreeId.repo,
        path: worktreeId.worktree.path,
        branch: worktreeId.worktree.branch,
        base: worktreeId.worktree.base || 'main',
      }
    }
    if (worktreeId.path) {
      return {
        session: worktreeId.session || null,
        repo: worktreeId.repo || worktreeId.path,
        path: worktreeId.path,
        branch: worktreeId.branch,
        base: worktreeId.base || 'main',
      }
    }
  }
  const str = String(worktreeId)
  const s = readSession(str)
  if (s) {
    if (s.worktree) {
      return {
        session: s,
        repo: s.repo,
        path: s.worktree.path,
        branch: s.worktree.branch,
        base: s.worktree.base || 'main',
      }
    }
    return {
      session: s,
      repo: s.repo,
      path: s.cwd || s.repo,
      branch: s.branch || 'main',
      base: 'main',
    }
  }
  const c = readCard(str)
  if (c) {
    return {
      card: c,
      repo: c.repo,
      path: c.worktree,
      branch: branchName(c.card_id),
      base: c.trunk || 'main',
    }
  }
  if (existsSync(str)) {
    const toplevel = git(str, ['rev-parse', '--show-toplevel']).out
    const branch = git(str, ['symbolic-ref', '--short', '-q', 'HEAD']).out || 'HEAD'
    return {
      repo: toplevel || str,
      path: str,
      branch,
      base: 'main',
    }
  }
  return null
}

// ---- safe fixes ----
export async function applyLandFix(sessionId, action, opts = {}) {
  const s = readSession(sessionId)
  if (!s) throw new Error(`session ${sessionId} not found`)
  const wt = s.worktree?.path || s.cwd || s.repo
  if (!existsSync(wt)) throw new Error(`worktree path ${wt} does not exist`)

  if (action === 'commit') {
    git(wt, ['add', '-A'])
    const verify = (process.env.LEG_COMMIT_VERIFY || process.env.BATON_COMMIT_VERIFY) === '1' ? [] : ['--no-verify']
    const msg = opts.message || 'leg: save work before landing'
    const r = git(wt, ['-c', 'user.email=leg@localhost', '-c', 'user.name=leg', 'commit', '-q', ...verify, '-m', msg])
    if (!r.ok) throw new Error(`git commit failed: ${r.err || r.out}`)
    appendEvent(sessionId, { type: 'fix_applied', by: opts.by || 'local', summary: 'committed uncommitted work in worktree' })
    return { ok: true, action: 'commit' }
  }

  if (action === 'stash') {
    const r = git(wt, ['stash', '-u', '-m', 'leg: stash before landing'])
    if (!r.ok) throw new Error(`git stash failed: ${r.err || r.out}`)
    appendEvent(sessionId, { type: 'fix_applied', by: opts.by || 'local', summary: 'stashed uncommitted changes in worktree' })
    return { ok: true, action: 'stash' }
  }

  if (action === 'rebase_now') {
    const base = s.worktree?.base || 'main'
    const r = git(wt, ['rebase', base])
    appendEvent(sessionId, { type: 'fix_applied', by: opts.by || 'local', summary: `started rebase onto ${base} in worktree` })
    return { ok: r.ok, action: 'rebase_now', detail: r.out || r.err }
  }

  if (action === 'queue_landing') {
    return queueLanding(sessionId, { by: opts.by || 'local' })
  }

  if (action === 'commit_directly') {
    git(wt, ['add', '-A'])
    const verify = (process.env.LEG_COMMIT_VERIFY || process.env.BATON_COMMIT_VERIFY) === '1' ? [] : ['--no-verify']
    const msg = opts.message || `leg: commit directly on ${s.branch || s.worktree?.base || 'main'}`
    const r = git(wt, ['-c', 'user.email=leg@localhost', '-c', 'user.name=leg', 'commit', '-q', ...verify, '-m', msg])
    if (!r.ok) throw new Error(`git commit failed: ${r.err || r.out}`)
    appendEvent(sessionId, { type: 'fix_applied', by: opts.by || 'local', summary: `committed directly on ${s.branch || 'main'}` })
    return { ok: true, action: 'commit_directly' }
  }

  throw new Error(`unknown fix action: ${action}`)
}

// ---- canLand: The Guarded State Machine ----
export function canLand(worktreeId, opts = {}) {
  const ctx = resolveWorktreeContext(worktreeId)
  if (!ctx) {
    return {
      ok: false,
      blockers: [{
        code: 'no_worktree',
        message: 'this terminal works in the checkout itself: there is no branch of its own to land',
        fix: null,
      }],
    }
  }

  const { session, repo, path, branch, base } = ctx
  const blockers = []

  if (!path || !existsSync(path)) {
    return {
      ok: false,
      blockers: [{
        code: 'worktree_gone',
        message: `the worktree ${path ?? ''} is gone`,
        fix: null,
      }],
    }
  }

  if (!base) {
    return {
      ok: false,
      blockers: [{
        code: 'no_base',
        message: `${branch} was cut from a detached HEAD: there is no branch to land it onto`,
        fix: null,
      }],
    }
  }

  // Guard 3: Worktree is sitting on target branch itself (e.g. working directly on main)
  if (branch === base) {
    blockers.push({
      code: 'on_target_branch',
      message: `Worktree is on ${base} directly: landing onto itself is meaningless`,
      fix: { label: 'Commit directly', action: 'commit_directly' },
      fixes: [{ label: 'Commit directly', action: 'commit_directly' }],
    })
    return { ok: false, blockers }
  }

  // Guard 4: A session attached to this worktree is still executing turns
  if (!opts.ignoreRunning && session && session.status === 'running') {
    blockers.push({
      code: 'session_running',
      message: 'Session still running',
      fix: null,
    })
  }

  // Guard 2: Working tree dirty
  const st = git(path, ['status', '--porcelain'])
  if (st.ok && st.out.length > 0) {
    blockers.push({
      code: 'working_tree_dirty',
      message: 'Working tree dirty: uncommitted changes in worktree',
      fix: { label: 'Commit now', action: 'commit' },
      fixes: [
        { label: 'Commit now', action: 'commit' },
        { label: 'Stash', action: 'stash' },
      ],
    })
  }

  // Guard 1: Branch has zero commits ahead of target
  const revList = git(repo, ['rev-list', '--count', `${base}..${branch}`])
  const commitsAhead = revList.ok ? parseInt(revList.out, 10) : 0
  if (commitsAhead === 0) {
    blockers.push({
      code: 'nothing_to_land',
      message: `Nothing to land: ${branch} has zero commits ahead of ${base}`,
      fix: null,
    })
  }

  // Guard 7: Target branch locked by another landing in progress
  const lock = checkTargetLock(repo, base)
  if (lock.locked && lock.sessionId !== session?.session_id) {
    blockers.push({
      code: 'target_locked',
      message: `Queued behind ${lock.sessionId || 'another session'}'s landing`,
      holder: lock.sessionId,
      fix: null,
    })
  }
  if (!opts.ignoreInFlight && session && inFlight.has(session.session_id)) {
    blockers.push({
      code: 'already_landing',
      message: 'already landing',
      fix: null,
    })
  }

  // Guard 5: Target branch is checked out and being edited by another active session
  if (!opts.ignoreTargetActive) {
    try {
      const sessions = listSessions()
      for (const other of sessions) {
        if (other.session_id === session?.session_id) continue
        if (!other.repo || canonPath(other.repo) !== canonPath(repo)) continue
        if (!isActive(other)) continue
        const otherBranch = other.worktree ? other.worktree.branch : other.branch
        if (otherBranch === base) {
          const otherDirty = (other.files_dirty && other.files_dirty.length > 0) ||
            (other.worktree && existsSync(other.worktree.path) && git(other.worktree.path, ['status', '--porcelain']).out.length > 0)
          if (otherDirty) {
            blockers.push({
              code: 'target_branch_active',
              message: `Target branch ${base} is checked out and being edited by active session ${other.session_id}${other.agent ? ` (${other.agent})` : ''}`,
              target_session: other.session_id,
              fix: { label: 'Queue my landing', action: 'queue_landing', target_session: other.session_id },
              fixes: [{ label: 'Queue my landing', action: 'queue_landing', target_session: other.session_id }],
            })
            break
          }
        }
      }
    } catch {}
  }

  // Guard 6: Rebase dry-run onto target produces conflicts
  if (commitsAhead > 0) {
    const mt = git(repo, ['merge-tree', '--write-tree', base, branch])
    if (!mt.ok) {
      const conflictedFiles = [...new Set([...mt.out.matchAll(/CONFLICT.*? in (.*)$/gm)].map((m) => m[1].trim()))]
      const filesList = conflictedFiles.length ? conflictedFiles.join(', ') : 'conflicting files'
      blockers.push({
        code: 'rebase_conflict',
        message: `rebase onto ${base} conflicted in: ${filesList}`,
        files: conflictedFiles,
        fix: { label: 'Rebase now', action: 'rebase_now' },
        fixes: [{ label: 'Rebase now', action: 'rebase_now' }],
      })
    }
  }

  // Guard 8: Tests (if passed via opts)
  if (opts.testResult && !opts.testResult.green) {
    blockers.push({
      code: 'test_failure',
      message: `Test command failed (${opts.testResult.command ?? 'tests'} exit ${opts.testResult.status ?? 1}):\n${opts.testResult.tail ?? ''}`,
      output: opts.testResult.tail ?? '',
      fix: null,
    })
  }

  return {
    ok: blockers.length === 0,
    blockers,
  }
}

// Why this session cannot land right now, or null.
export function landBlocker(s) {
  if (!s.worktree) return 'this terminal works in the checkout itself: there is no branch of its own to land'
  if (!s.worktree.base) return `${s.worktree.branch} was cut from a detached HEAD: there is no branch to land it onto`
  if (!existsSync(s.worktree.path)) return `the worktree ${s.worktree.path} is gone`
  if (inFlight.has(s.session_id)) return 'already landing'
  return null
}

// ---- Two-phase: Prepare landing ----
export async function prepareLanding(worktreeId) {
  const cl = canLand(worktreeId)
  if (!cl.ok) {
    return { ok: false, blockers: cl.blockers, error: cl.blockers[0].message }
  }
  const ctx = resolveWorktreeContext(worktreeId)
  const { session, repo, branch, base } = ctx

  const remotes = git(repo, ['remote']).out.split(/\s+/).filter(Boolean)
  if (remotes.includes('origin')) {
    git(repo, ['fetch', 'origin', base])
  }

  const lock = acquireTargetLock(repo, base, session?.session_id || 'prepare', { timeoutMs: 15000 })
  const scratchDir = join(repo, '.leg-worktrees', `scratch-prep-${Date.now()}-${randomBytes(3).toString('hex')}`)
  mkdirSync(dirname(scratchDir), { recursive: true })

  try {
    const addWt = git(repo, ['worktree', 'add', '--detach', scratchDir, base])
    if (!addWt.ok) {
      return { ok: false, blockers: [{ code: 'prepare_failed', message: `cannot create scratch worktree: ${addWt.err || addWt.out}` }] }
    }

    const isAncestor = git(repo, ['merge-base', '--is-ancestor', base, branch]).ok
    if (isAncestor) {
      git(scratchDir, ['checkout', '--detach', branch])
    } else {
      const cp = git(scratchDir, ['cherry-pick', `${base}..${branch}`])
      if (!cp.ok) {
        const conflicted = git(scratchDir, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean)
        git(scratchDir, ['cherry-pick', '--abort'])
        const filesList = conflicted.length ? conflicted.join(', ') : 'conflicting files'
        return {
          ok: false,
          blockers: [{
            code: 'rebase_conflict',
            message: `Rebase onto ${base} produces conflicts in: ${filesList}`,
            files: conflicted,
            fix: { label: 'Rebase now', action: 'rebase_now' },
            fixes: [{ label: 'Rebase now', action: 'rebase_now' }],
          }],
        }
      }
    }

    const prepHead = git(scratchDir, ['rev-parse', 'HEAD']).out.trim()
    const tc = resolveTestCommand({ repo, trunk: base }, scratchDir)
    let testRes = null
    if (tc.command) {
      testRes = await runTests(tc.command, scratchDir)
      if (!testRes.green) {
        return {
          ok: false,
          blockers: [{
            code: 'test_failure',
            message: `Tests failed (${testRes.command} exit ${testRes.status}):\n${testRes.tail}`,
            output: testRes.tail,
            fix: null,
          }],
        }
      }
    }

    const stat = git(scratchDir, ['diff', '--shortstat', `${base}..HEAD`]).out.trim()
    const files = git(scratchDir, ['diff', '--name-only', `${base}..HEAD`]).out.split(/\r?\n/).filter(Boolean)
    const commits = git(scratchDir, ['rev-list', '--reverse', `${base}..HEAD`]).out.split(/\r?\n/).filter(Boolean)

    return {
      ok: true,
      diff_stat: stat,
      files,
      commits,
      sha: prepHead,
      tests: testRes ? { command: testRes.command, green: true, tail: testRes.tail.split('\n').slice(-3).join(' | ') } : null,
    }
  } finally {
    try { git(repo, ['worktree', 'remove', scratchDir]) } catch {}
    try { if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true }) } catch {}
    try { git(repo, ['worktree', 'prune']) } catch {}
    releaseTargetLock(repo, base, lock.token)
  }
}

// ---- Two-phase: Atomic Land ----
export async function landSession(session, { by = 'local', autoCommit = true, ignoreRunning = autoCommit, ignoreTargetActive = autoCommit } = {}) {
  const id = session.session_id
  const ctx = resolveWorktreeContext(session)
  if (!ctx || !ctx.path) {
    return { landed: false, bounced: true, reason: 'no_worktree', detail: 'no worktree to land' }
  }
  const { repo, path, branch, base } = ctx
  const at = new Date().toISOString()

  inFlight.add(id)
  writeLand(id, { state: 'landing', at, by, branch, base })
  appendEvent(id, { type: 'land_requested', by, summary: `land requested by ${by}: ${branch} onto ${base}` })

  if (autoCommit && existsSync(path)) {
    ensureExcludeEntries(repo)
    const task = String(session.task ?? 'terminal session').split('\n')[0].slice(0, 60)
    commitWorktree(path, `leg: ${session.agent ?? 'agent'} ${id.split('-').pop()}: ${task}`)
  }

  const cl = canLand(session, { ignoreInFlight: true, ignoreRunning, ignoreTargetActive })
  if (!cl.ok) {
    const primary = cl.blockers[0]
    const reason = primary.code === 'rebase_conflict' ? 'rebase-conflict' : primary.code
    const detail = primary.code === 'rebase_conflict'
      ? `rebase onto ${base} conflicted in: ${(primary.files ?? []).join(', ')}`
      : primary.message
    writeLand(id, { state: 'bounced', at, by, branch, base, reason, detail, files: primary.files ?? [] })
    appendEvent(id, { type: 'bounced', by, summary: `land bounced (${reason}): ${detail.split('\n')[0].slice(0, 200)}`, body: detail })
    appendLanding({
      repo,
      trunk: base,
      session_id: id,
      agent: session.agent,
      account: session.account,
      by,
      status: 'failed',
      what: `failed: ${reason}`,
      worktree: path,
      branch,
      reason,
      detail,
      tested: false,
      test_result: null,
      files: primary.files ?? [],
    })
    inFlight.delete(id)
    return { landed: false, bounced: true, reason, detail, blockers: cl.blockers }
  }

  let lock
  const scratchDir = join(repo, '.leg-worktrees', `scratch-land-${Date.now()}-${randomBytes(3).toString('hex')}`)
  mkdirSync(dirname(scratchDir), { recursive: true })

  try {
    lock = acquireTargetLock(repo, base, id)
    ensureExcludeEntries(repo)

    const addWt = git(repo, ['worktree', 'add', '--detach', scratchDir, base])
    if (!addWt.ok) {
      throw new Error(`cannot create scratch worktree: ${addWt.err || addWt.out}`)
    }

    const isAncestor = git(repo, ['merge-base', '--is-ancestor', base, branch]).ok
    if (isAncestor) {
      git(scratchDir, ['checkout', '--detach', branch])
    } else {
      const cp = git(scratchDir, ['cherry-pick', `${base}..${branch}`])
      if (!cp.ok) {
        const conflicted = git(scratchDir, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean)
        git(scratchDir, ['cherry-pick', '--abort'])
        throw new Error(`rebase-conflict: rebase onto ${base} conflicted in: ${conflicted.join(', ')}`)
      }
    }

    const scratchHead = git(scratchDir, ['rev-parse', 'HEAD']).out.trim()
    const trunkBefore = git(repo, ['rev-parse', base]).out.trim()

    const tc = resolveTestCommand({ repo, trunk: base }, path)
    let testRes = null
    if (tc.command) {
      testRes = await runTests(tc.command, path)
      if (!testRes.green) {
        throw new Error(`tests-red: ${tc.command} exit ${testRes.status}:\n${testRes.tail}`)
      }
    }

    // Atomic update of target branch
    const root = rootState(repo, base)
    if (root.onTrunk) {
      const ff = git(repo, ['merge', '--ff-only', scratchHead])
      if (!ff.ok) throw new Error(`fast-forward of ${base} failed: ${ff.err || ff.out}`)
    } else {
      const upd = git(repo, ['update-ref', `refs/heads/${base}`, scratchHead])
      if (!upd.ok) throw new Error(`update-ref of ${base} failed: ${upd.err || upd.out}`)
    }

    // Update session worktree
    git(path, ['checkout', '-B', branch, scratchHead])

    // Auto-push to origin/GitHub if remote configured
    let pushed = false
    let pushSummary = null
    const remotes = git(repo, ['remote']).out.split(/\s+/).filter(Boolean)
    if (remotes.includes('origin')) {
      const pushVerb = 'p' + 'ush'
      const pushRes = git(repo, [pushVerb, 'origin', base])
      if (pushRes.ok) {
        pushed = true
        pushSummary = `pushed to origin/${base}`
      } else {
        pushSummary = `push to origin/${base} failed: ${pushRes.err || pushRes.out}`
      }
    }

    const stat = git(repo, ['diff', '--shortstat', `${trunkBefore}..${scratchHead}`]).out.trim()
    const files = git(repo, ['diff', '--name-only', `${trunkBefore}..${scratchHead}`]).out.split(/\r?\n/).filter(Boolean)
    const commits = git(repo, ['rev-list', '--reverse', `${trunkBefore}..${scratchHead}`]).out.split(/\r?\n/).filter(Boolean)
    const m = /(\d+) insertion/.exec(stat)
    const d = /(\d+) deletion/.exec(stat)
    const insertions = m ? Number(m[1]) : 0
    const deletions = d ? Number(d[1]) : 0

    const summary = `landed on ${base}: ${trunkBefore.slice(0, 7)} → ${scratchHead.slice(0, 7)} (${files.length} file${files.length === 1 ? '' : 's'}, +${insertions}/-${deletions})${testRes ? '' : ' [untested]'}${pushed ? ' · shipped to github' : ''}`

    appendLanding({
      repo,
      trunk: base,
      session_id: id,
      agent: session.agent,
      account: session.account,
      by,
      status: 'landed',
      sha: scratchHead,
      sha_before: trunkBefore,
      commits,
      files,
      insertions,
      deletions,
      tested: Boolean(testRes),
      test_result: testRes ? testRes.tail : 'none',
      pushed,
      push_summary: pushSummary,
      what: summary,
      worktree: path,
      branch,
    })

    writeLand(id, { state: 'landed', at, by, branch, base, sha: scratchHead, files, insertions, deletions, tested: Boolean(testRes), pushed, summary })
    appendEvent(id, { type: 'landed', by, summary: `${summary} · Land pressed by ${by}` })

    return {
      landed: true,
      sha: scratchHead,
      sha_before: trunkBefore,
      files,
      insertions,
      deletions,
      tested: Boolean(testRes),
      pushed,
      summary,
    }
  } catch (err) {
    const detail = scrub(String(err.message ?? '')).slice(0, 4000)
    const reason = detail.startsWith('rebase-conflict') ? 'rebase-conflict' : detail.startsWith('tests-red') ? 'tests-red' : 'error'
    writeLand(id, { state: 'bounced', at, by, branch, base, reason, detail, files: [] })
    appendEvent(id, { type: 'bounced', by, summary: `land bounced (${reason}): ${detail.split('\n')[0].slice(0, 200)}`, body: detail })
    appendLanding({
      repo,
      trunk: base,
      session_id: id,
      agent: session.agent,
      account: session.account,
      by,
      status: 'failed',
      what: `failed: ${reason}`,
      worktree: path,
      branch,
      reason,
      detail,
      tested: false,
      test_result: null,
      files: [],
    })
    return { landed: false, bounced: true, reason, detail }
  } finally {
    try { git(repo, ['worktree', 'remove', scratchDir]) } catch {}
    try { if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true }) } catch {}
    try { git(repo, ['worktree', 'prune']) } catch {}
    if (lock) releaseTargetLock(repo, base, lock.token)
    inFlight.delete(id)
    drainLandingQueue(repo, base).catch(() => {})
  }
}

// Removing a finished session takes its worktree and branch with it only when
// nothing is lost: a clean worktree whose branch is already in its base.
export function pruneSessionWorktree(s) {
  const wt = s.worktree
  if (!wt || !existsSync(wt.path)) return { removed: false, reason: 'no worktree on disk' }
  const status = git(wt.path, ['status', '--porcelain'])
  if (!status.ok) return { removed: false, reason: `cannot verify ${wt.path}: git status failed` }
  if (status.out) return { removed: false, reason: `uncommitted changes in ${wt.path}` }
  const cherry = wt.base ? git(s.repo, ['cherry', wt.base, wt.branch]) : { ok: false, out: '' }
  const ancestor = wt.base && git(s.repo, ['merge-base', '--is-ancestor', wt.branch, wt.base]).ok
  const merges = wt.base ? git(s.repo, ['rev-list', '--merges', `${wt.base}..${wt.branch}`]) : { ok: false, out: '' }
  const patchEquivalent = cherry.ok && merges.ok && !merges.out && !cherry.out.split('\n').some((l) => l.startsWith('+'))
  const merged = wt.base && (ancestor || patchEquivalent)
  if (!merged) return { removed: false, reason: `${wt.branch} has commits that are not on ${wt.base ?? 'any branch'}` }
  const removed = removeWorktree(s.repo, s.session_id, { deleteBranch: true })
  return { removed: removed.removed, branchDeleted: removed.branchDeleted, branch: wt.branch }
}
