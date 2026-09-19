// worktrees — every checkout Leg can see, in one list: what git lists for each
// repository it knows about, what its own sessions and cards cut, and what
// the discovered conversations were working in. Read only: nothing here
// prunes, removes or touches a worktree; src/worktree.mjs keeps that job, for
// Leg's own worktrees only, unchanged.
//
// Two entry points over one body of logic. `listWorktrees` is synchronous and
// is what the CLI (`leg worktrees`) uses: a command that has nothing else to do
// while git answers. `listWorktreesAsync` runs the same git calls through
// execFile, at most GIT_CONCURRENCY at a time, and is what the board uses: a
// cold list is twenty `git status` calls at about half a second each, and run
// synchronously that is ten to twenty-five seconds in which the board's single
// event loop serves no stylesheet, no click and no SSE frame.
import { existsSync, statSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { listSessions, isActive } from '../sessions.mjs'
import { listCards } from '../store.mjs'
import { parseWorktreeList } from '../worktree.mjs'
import { listHistory } from './index.mjs'
import { repoNameOf, canonOrNull } from './common.mjs'

export const STALE_DAYS = 14
export const DIRTY_LIMIT = 40
export const REPO_LIMIT = 40
// how many git processes the async path keeps in flight at once
export const GIT_CONCURRENCY = 4

const LEG_DIR_RE = /[\\/]\.(?:leg|baton)-worktrees[\\/]([^\\/]+)$/i

const gitOpts = (timeoutMs) => ({ windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
const statusArgs = (path) => ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=', '-C', path, 'status', '--porcelain']
const listArgs = (repo) => ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=', '-C', repo, 'worktree', 'list', '--porcelain']

// MSYS_NO_PATHCONV is spelled out at each spawn site: test/lessons.test.mjs
// checks every git spawn line in src/ for it
function gitSync(args, timeoutMs) {
  try { return execFileSync('git', args, { ...gitOpts(timeoutMs), env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}
// stderr is captured and dropped rather than inherited, the same as the sync
// path: a repo that is not one any more must not print on the operator's terminal
function gitAsync(args, timeoutMs) {
  return new Promise((resolve) => {
    try { execFile('git', args, { ...gitOpts(timeoutMs), env: { ...process.env, MSYS_NO_PATHCONV: '1' } }, (err, stdout) => resolve(err ? null : stdout)) } catch { resolve(null) }
  })
}

// at most `limit` promises in flight, answers keyed by the item that asked
async function pooled(items, limit, fn) {
  const out = new Map()
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      out.set(item, await fn(item))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

const countDirty = (out) => (out === null ? null : out.split(/\r?\n/).filter(Boolean).length)

function dirtyOf(path, timeoutMs = 5000) { return countDirty(gitSync(statusArgs(path), timeoutMs)) }

// git's own list for one repository, stderr dropped: a repo that is not one
// any more ("fatal: not a git repository") is an empty list, not a line on the
// operator's terminal.
function gitWorktrees(repo, timeoutMs = 5000) { return parseWorktreeList(gitSync(listArgs(repo), timeoutMs) ?? '') }

const mtimeOf = (p) => { try { return statSync(p).mtimeMs } catch { return null } }
const at = (iso) => (iso ? Date.parse(iso) || 0 : 0)

// ---- the three phases, with the git calls between them ---------------------
// Everything the view is built from except git: the records, the repositories
// they name, and which one repository was asked for.
function gather({ repo = null, sessions = null, cards = null, records = null, homes = null } = {}) {
  const sess = sessions ?? listSessions()
  const crd = cards ?? listCards()
  const recs = records ?? listHistory({ limit: 0, homes, includeSubagents: true }).records
  const repos = new Map()
  const addRepo = (p) => { const c = canonOrNull(p); if (c && !repos.has(c) && existsSync(p)) repos.set(c, p) }
  for (const s of sess) addRepo(s.repo)
  for (const c of crd) addRepo(c.repo)
  for (const r of recs) addRepo(r.repo)
  const only = repo ? canonOrNull(repo) : null
  if (only) for (const k of [...repos.keys()]) if (k !== only) repos.delete(k)
  return { sess, crd, recs, repos, only }
}

// The repositories git is asked about: the first `repoLimit` of them, in the
// order they were discovered, so a home with two hundred never forks two hundred.
const askedRepos = (ctx, repoLimit) => [...ctx.repos.values()].slice(0, repoLimit)

// Every row, with each checkout's owner and conversations resolved. `lists` is
// what git said about each asked repository.
function buildRows(ctx, lists) {
  const { sess, crd, recs, only } = ctx
  const rows = new Map() // canon path → row
  const row = (path, repoPath, extra = {}) => {
    const key = canonOrNull(path)
    if (!key) return null
    if (only && canonOrNull(repoPath) !== only) return null
    if (!rows.has(key)) rows.set(key, { path, repo: repoPath, repo_name: repoNameOf(repoPath), branch: null, head: null, exists: existsSync(path), main: false, listed_by_git: false, owner: { kind: 'external' }, conversations: { count: 0, latest: [], last_at: null }, dirty: null, stale: false, orphaned: false })
    return Object.assign(rows.get(key), extra)
  }
  for (const [repoPath, listed] of lists) {
    listed.forEach((w, i) => row(w.path, repoPath, { branch: w.branch, head: w.head, listed_by_git: true, main: i === 0 && canonOrNull(w.path) === canonOrNull(repoPath) }))
  }
  // checkouts git no longer lists (deleted by hand, pruned) but a record still names
  for (const s of sess) if (s.worktree?.path && s.repo) row(s.worktree.path, s.repo, { branch: rows.get(canonOrNull(s.worktree.path))?.branch ?? s.worktree.branch ?? null })
  for (const c of crd) if (c.worktree && c.repo) row(c.worktree, c.repo)
  for (const r of recs) if (r.worktree?.path && r.repo) row(r.worktree.path, r.repo, { branch: rows.get(canonOrNull(r.worktree.path))?.branch ?? r.worktree.branch ?? null })

  // owners: a session's own worktree, a card's, or the main checkout
  const byCard = new Map(crd.map((c) => [c.card_id, c]))
  for (const s of sess) {
    if (!s.worktree?.path) continue
    const r = rows.get(canonOrNull(s.worktree.path))
    if (!r) continue
    const prior = r.owner.kind === 'session' ? sess.find((x) => x.session_id === r.owner.id) : null
    // a live session outranks a finished one on the same path
    if (!prior || (!isActive(prior) && isActive(s))) r.owner = { kind: 'session', id: s.session_id, agent: s.agent, status: s.status, live: isActive(s), updated_at: s.updated_at ?? null }
  }
  for (const r of rows.values()) {
    if (r.owner.kind !== 'external') continue
    const m = LEG_DIR_RE.exec(r.path)
    if (m && byCard.has(m[1])) { const c = byCard.get(m[1]); r.owner = { kind: 'card', id: c.card_id, status: c.status, live: ['running', 'handing_off'].includes(c.status), updated_at: c.updated_at ?? null }; continue }
    if (r.main) r.owner = { kind: 'checkout' }
    else if (m) r.orphaned = true
  }
  // which conversations point here
  const convs = new Map()
  for (const rec of recs) {
    const key = canonOrNull(rec.worktree?.path) ?? (rec.repo && !rec.worktree ? canonOrNull(rec.repo) : null)
    if (!key || !rows.has(key)) continue
    if (!convs.has(key)) convs.set(key, [])
    convs.get(key).push(rec)
  }
  for (const [key, list] of convs) {
    list.sort((a, b) => at(b.updated_at) - at(a.updated_at))
    rows.get(key).conversations = { count: list.length, last_at: list[0]?.updated_at ?? null, latest: list.slice(0, 3).map((r) => ({ id: r.id, provider: r.provider, managed: r.managed, live: r.live, title: r.title, updated_at: r.updated_at })) }
  }
  return rows
}

// The checkouts `git status` is run on: the first `dirtyLimit` that exist, in
// row order, so the board never waits on two hundred of them.
function dirtyTargets(rows, { dirty, dirtyLimit }) {
  if (!dirty) return []
  const out = []
  for (const r of rows.values()) {
    if (out.length >= dirtyLimit) break
    if (r.exists) out.push(r)
  }
  return out
}

function finish(ctx, rows, dirtyBy, { now, checked }) {
  for (const r of rows.values()) {
    if (dirtyBy.has(r.path)) r.dirty = dirtyBy.get(r.path)
    const liveOwner = Boolean(r.owner.live)
    const last = Math.max(at(r.conversations.last_at), at(r.owner.updated_at), r.exists ? (mtimeOf(r.path) ?? 0) : 0)
    r.last_activity_at = last ? new Date(last).toISOString() : null
    r.stale = r.exists && !r.main && !liveOwner && (!last || now - last > STALE_DAYS * 86400000)
  }
  const out = [...rows.values()].sort((a, b) => String(a.repo).localeCompare(String(b.repo)) || (a.main ? -1 : b.main ? 1 : 0) || a.path.localeCompare(b.path))
  return { worktrees: out, repos: ctx.repos.size, dirty_checked: checked, ts: new Date(now).toISOString() }
}

// { worktrees: [...], repos, ts }. `dirty` runs git status on up to
// `dirtyLimit` existing checkouts (null past the cap, so the board never waits
// on two hundred of them). `records`/`sessions`/`cards` are for tests.
export function listWorktrees({ dirty = true, dirtyLimit = DIRTY_LIMIT, repoLimit = REPO_LIMIT, repo = null, sessions = null, cards = null, records = null, homes = null, now = Date.now(), timeoutMs = 5000 } = {}) {
  const ctx = gather({ repo, sessions, cards, records, homes })
  const lists = new Map(askedRepos(ctx, repoLimit).map((p) => [p, gitWorktrees(p, timeoutMs)]))
  const rows = buildRows(ctx, lists)
  const targets = dirtyTargets(rows, { dirty, dirtyLimit })
  const dirtyBy = new Map(targets.map((r) => [r.path, dirtyOf(r.path, timeoutMs)]))
  return finish(ctx, rows, dirtyBy, { now, checked: targets.length })
}

// The same list, with git off the caller's stack: identical payload, up to
// GIT_CONCURRENCY processes at a time, each with its own timeout.
export async function listWorktreesAsync({ dirty = true, dirtyLimit = DIRTY_LIMIT, repoLimit = REPO_LIMIT, repo = null, sessions = null, cards = null, records = null, homes = null, now = Date.now(), timeoutMs = 5000, concurrency = GIT_CONCURRENCY } = {}) {
  const ctx = gather({ repo, sessions, cards, records, homes })
  const listed = await pooled(askedRepos(ctx, repoLimit), concurrency, (p) => gitAsync(listArgs(p), timeoutMs))
  const lists = new Map([...listed].map(([p, out]) => [p, parseWorktreeList(out ?? '')]))
  const rows = buildRows(ctx, lists)
  const targets = dirtyTargets(rows, { dirty, dirtyLimit })
  const dirtyOut = await pooled(targets.map((r) => r.path), concurrency, (p) => gitAsync(statusArgs(p), timeoutMs))
  const dirtyBy = new Map([...dirtyOut].map(([p, out]) => [p, countDirty(out)]))
  // `now` defaults at call time, not at resolution time, the same as the sync path
  return finish(ctx, rows, dirtyBy, { now, checked: targets.length })
}

export function underLegWorktrees(path) { return LEG_DIR_RE.test(String(path ?? '')) }
