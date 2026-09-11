// land — the land station handler the orchestrator calls, and the Land button
// on a terminal card. `ff` mode runs the merge queue (src/mergequeue.mjs); `pr`
// mode opens a pull request through the gh stub (src/stations/pr.mjs) and
// parks the card for a human. A terminal session in its own worktree lands its
// branch (baton/<session-id>) through the same queue.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { land } from './mergequeue.mjs'
import { openPr } from './stations/pr.mjs'
import { cardDir, ledgerAppend } from './store.mjs'
import { remove as removeWorktree, ensureExcludeEntries } from './worktree.mjs'
import { appendEvent, writeLand, appendLanding } from './sessions.mjs'
import { scrub } from './redact.mjs'

export async function landCard(card, worktree) {
  const warn = (msg) => ledgerAppend(card.card_id, { type: 'land_warning', station: card.station, leg: 0, summary: msg })
  if (card.land_mode === 'pr') {
    const r = openPr({ card: { ...card, worktree }, runDir: join(cardDir(card.card_id), 'land') })
    if (!r.ok) return { landed: false, bounced: false, pr: false, reason: `pr mode: ${r.error}` }
    return { landed: false, pr: true, url: r.url, summary: `pull request opened: ${r.url ?? '(no url)'}`, argv: r.argv }
  }
  return land(card, worktree, { onWarning: warn })
}

// ---- terminals ----
const inFlight = new Set()
export function landingNow(id) { return inFlight.has(id) }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

// Why this session cannot land right now, or null.
export function landBlocker(s) {
  if (!s.worktree) return 'this terminal works in the checkout itself: there is no branch of its own to land'
  if (!s.worktree.base) return `${s.worktree.branch} was cut from a detached HEAD: there is no branch to land it onto`
  if (!existsSync(s.worktree.path)) return `the worktree ${s.worktree.path} is gone`
  if (inFlight.has(s.session_id)) return 'already landing'
  return null
}

// The Land button: commit what the agent left in the worktree, rebase the
// branch onto its base, run the tests, fast-forward the base (never a merge
// commit); a bounce carries the reason. land.json holds the card's state,
// landings.jsonl who landed what. Resolves with the queue's result.
export async function landSession(session, { by = 'local' } = {}) {
  const id = session.session_id
  const { path, branch, base } = session.worktree
  inFlight.add(id)
  writeLand(id, { state: 'landing', at: new Date().toISOString(), by, branch, base })
  appendEvent(id, { type: 'land_requested', by, summary: `land requested by ${by}: ${branch} onto ${base}` })
  let r
  try {
    await new Promise((res) => setImmediate(res)) // the caller answers the request first
    ensureExcludeEntries(session.repo) // the commit step adds everything else the agent left
    const task = String(session.task ?? 'terminal session').split('\n')[0].slice(0, 60)
    r = await land({ card_id: id, repo: session.repo, trunk: base, title: `${session.agent} ${id.split('-').pop()}: ${task}`, test_command: null }, path, {
      allowDirtyRoot: true,
      onWarning: (msg) => appendEvent(id, { type: 'land_warning', by, summary: msg }),
    })
  } catch (err) {
    r = { landed: false, bounced: true, reason: 'error', detail: String(err.message) }
  } finally {
    inFlight.delete(id)
  }
  const at = new Date().toISOString()
  if (r.landed && r.sha === r.sha_before) {
    writeLand(id, { state: 'noop', at, by, branch, base })
    appendEvent(id, { type: 'land_noop', by, summary: `nothing to land: ${branch} has no changes beyond ${base}` })
  } else if (r.landed) {
    const commits = git(session.repo, ['rev-list', '--reverse', `${r.sha_before}..${r.sha}`]).out.split('\n').filter(Boolean)
    const tested = Boolean(r.tests)
    appendLanding({ repo: session.repo, trunk: base, session_id: id, agent: session.agent, account: session.account, by, sha: r.sha, sha_before: r.sha_before, commits, files: r.files, insertions: r.insertions, deletions: r.deletions, tested })
    writeLand(id, { state: 'landed', at, by, branch, base, sha: r.sha, files: r.files, insertions: r.insertions, deletions: r.deletions, tested, summary: r.summary })
    appendEvent(id, { type: 'landed', by, summary: `${r.summary} · Land pressed by ${by}` })
  } else {
    const detail = scrub(String(r.detail ?? '')).slice(0, 4000)
    writeLand(id, { state: 'bounced', at, by, branch, base, reason: r.reason, detail, files: r.files ?? [] })
    appendEvent(id, { type: 'bounced', by, summary: `land bounced (${r.reason}): ${detail.split('\n')[0].slice(0, 200)}`, body: detail })
  }
  return r
}

// Removing a finished session takes its worktree and branch with it only when
// nothing is lost: a clean worktree whose branch is already in its base.
export function pruneSessionWorktree(s) {
  const wt = s.worktree
  if (!wt || !existsSync(wt.path)) return { removed: false, reason: 'no worktree on disk' }
  if (git(wt.path, ['status', '--porcelain']).out) return { removed: false, reason: `uncommitted changes in ${wt.path}` }
  if (!wt.base || !git(s.repo, ['merge-base', '--is-ancestor', wt.branch, wt.base]).ok) return { removed: false, reason: `${wt.branch} has commits that are not on ${wt.base ?? 'any branch'}` }
  removeWorktree(s.repo, s.session_id, { deleteBranch: true })
  return { removed: true }
}
