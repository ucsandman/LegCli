// The unified worktree view: git's list per known repository, Leg's own
// worktrees (sessions and cards), the ones discovered conversations worked
// in, and the read-only verdicts on each (exists, dirty, owner, stale, orphaned).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, git } from './helpers.mjs'

const HOME = makeHome()
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
const { listWorktrees } = await import('../src/history/worktrees.mjs')
const { canonPath } = await import('../src/fsx.mjs')

const same = (a, b) => canonPath(a) === canonPath(b)

test('every checkout has a repo, an owner, its conversations and a verdict; nothing is removed', () => {
  const repo = initRepo('uwt-')
  const sessWt = join(repo, '.leg-worktrees', 's-uwt-live')
  git(repo, ['worktree', 'add', '-q', '-b', 'leg/s-uwt-live', sessWt, 'main'])
  const orphanWt = join(repo, '.leg-worktrees', 's-uwt-orphan')
  git(repo, ['worktree', 'add', '-q', '-b', 'leg/s-uwt-orphan', orphanWt, 'main'])
  const cardWt = join(repo, '.leg-worktrees', 'card-uwt-1')
  git(repo, ['worktree', 'add', '-q', '-b', 'leg/card-uwt-1', cardWt, 'main'])
  const externalWt = repo + '-external'
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/external', externalWt, 'main'])
  const goneWt = join(repo, '.leg-worktrees', 's-uwt-gone')
  git(repo, ['worktree', 'add', '-q', '-b', 'leg/s-uwt-gone', goneWt, 'main'])
  rmSync(goneWt, { recursive: true, force: true }) // deleted by hand: git still lists it
  writeFileSync(join(orphanWt, 'dirty.txt'), 'uncommitted\n')

  const sessions = [
    { session_id: 's-uwt-live', agent: 'claude', status: 'running', repo, cwd: sessWt, worktree: { path: sessWt, branch: 'leg/s-uwt-live', base: 'main' }, updated_at: new Date().toISOString() },
    { session_id: 's-uwt-gone', agent: 'codex', status: 'ended', repo, cwd: goneWt, worktree: { path: goneWt, branch: 'leg/s-uwt-gone', base: 'main' }, updated_at: '2026-01-01T00:00:00.000Z' },
  ]
  const cards = [{ card_id: 'card-uwt-1', repo, worktree: cardWt, status: 'done', updated_at: '2026-09-01T00:00:00.000Z' }]
  const records = [
    { id: 'claude:1', provider: 'claude', managed: true, live: true, title: 'in the live worktree', repo, cwd: sessWt, worktree: { path: sessWt, branch: 'leg/s-uwt-live' }, updated_at: new Date().toISOString() },
    { id: 'grok:2', provider: 'grok', managed: false, live: false, title: 'in the external worktree', repo, cwd: externalWt, worktree: { path: externalWt, branch: 'feat/external' }, updated_at: '2026-09-10T00:00:00.000Z' },
    { id: 'codex:3', provider: 'codex', managed: false, live: false, title: 'in the checkout', repo, cwd: repo, worktree: null, updated_at: '2026-09-11T00:00:00.000Z' },
    { id: 'agy:4', provider: 'agy', managed: false, live: false, title: 'somewhere else', repo: null, cwd: 'C:\\nowhere', worktree: null, updated_at: '2026-09-11T00:00:00.000Z' },
  ]
  const before = git(repo, ['worktree', 'list', '--porcelain'])
  const r = listWorktrees({ sessions, cards, records })
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']), before, 'the view removed or pruned a worktree')
  assert.equal(r.repos, 1)
  const rows = r.worktrees
  const row = (p) => rows.find((w) => same(w.path, p))
  assert.equal(rows.length, 6)
  const main = row(repo)
  assert.equal(main.main, true)
  assert.equal(main.owner.kind, 'checkout')
  assert.equal(main.conversations.count, 1)
  assert.equal(main.conversations.latest[0].id, 'codex:3')
  assert.equal(main.stale, false, 'the main checkout is never stale')
  const live = row(sessWt)
  assert.deepEqual([live.owner.kind, live.owner.id, live.owner.live], ['session', 's-uwt-live', true])
  assert.equal(live.branch, 'leg/s-uwt-live')
  assert.equal(live.conversations.count, 1)
  assert.equal(live.dirty, 0)
  assert.equal(live.stale, false)
  const orphan = row(orphanWt)
  assert.equal(orphan.owner.kind, 'external')
  assert.equal(orphan.orphaned, true, 'a .leg-worktrees dir no session or card records')
  assert.equal(orphan.dirty, 1)
  assert.equal(orphan.stale, false, 'its files were just written')
  const card = row(cardWt)
  assert.deepEqual([card.owner.kind, card.owner.id], ['card', 'card-uwt-1'])
  assert.equal(card.orphaned, false)
  const ext = row(externalWt)
  assert.equal(ext.owner.kind, 'external')
  assert.equal(ext.orphaned, false, 'not Leg\'s naming: external, not orphaned')
  assert.equal(ext.conversations.count, 1)
  assert.equal(ext.listed_by_git, true)
  const gone = row(goneWt)
  assert.equal(gone.exists, false)
  assert.deepEqual([gone.owner.kind, gone.owner.id], ['session', 's-uwt-gone'])
  assert.equal(gone.dirty, null, 'no git status on a directory that is not there')
  assert.equal(gone.stale, false, 'missing is its own verdict')
  // stale: exists, no live owner, nothing touched it for a long time
  const far = listWorktrees({ sessions, cards, records, now: Date.now() + 400 * 86400000 })
  assert.equal(far.worktrees.find((w) => same(w.path, externalWt)).stale, true)
  assert.equal(far.worktrees.find((w) => same(w.path, sessWt)).stale, false, 'a live session keeps its worktree fresh')
  // dirty is capped, and off on request
  assert.equal(listWorktrees({ sessions, cards, records, dirty: false }).dirty_checked, 0)
  assert.equal(listWorktrees({ sessions, cards, records, dirtyLimit: 1 }).dirty_checked, 1)
  // the repo filter
  assert.equal(listWorktrees({ sessions, cards, records, repo: 'C:\\not-a-repo', dirty: false }).worktrees.length, 0)
})

test('a repository that is gone or is not a repository any more lists nothing and prints nothing', () => {
  const dir = join(HOME, 'plain-dir')
  mkdirSync(dir, { recursive: true })
  const r = listWorktrees({ sessions: [{ session_id: 's-x', agent: 'claude', status: 'ended', repo: dir, cwd: dir, worktree: null }], cards: [], records: [{ id: 'claude:x', provider: 'claude', repo: join(HOME, 'never-existed'), cwd: join(HOME, 'never-existed'), worktree: null }] })
  assert.equal(r.worktrees.length, 0)
})
