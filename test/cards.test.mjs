// The headless CLI: card add validation and the read commands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHome, testEnv, initRepo, baton, batonFail, readCard } from './helpers.mjs'

test('card add refuses a forbidden mode, an unknown adapter, and a land station that is not last', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const bad = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'claude,codex', '--mode', 'claude=bypassPermissions'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /forbidden mode "bypassPermissions" for claude/)
  const yolo = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'agy', '--mode', 'agy=yolo'], env)
  assert.equal(yolo.status, 2)
  assert.match(yolo.stderr, /forbidden mode "yolo" for agy/)
  const unknown = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'grok'], env)
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown adapter "grok"/)
  const f = join(home, 'bad-pipeline.json')
  writeFileSync(f, JSON.stringify([{ name: 'land', kind: 'land' }, { name: 'build', kind: 'agent' }]))
  const land = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'fake', '--pipeline', f], env)
  assert.equal(land.status, 2)
  assert.match(land.stderr, /land station must be last/)
  assert.ok(!existsSync(join(home, 'cards')) || baton(['card', 'ls'], env).includes('(no cards)'))
})

test('card add writes the full card shape; ls/show/events read it back; rm removes card and worktree', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const id = baton(['card', 'add', '--repo', repo, '--task', 'Rename greet to hello', '--chain', 'fake-claude,fake-codex',
    '--pipeline', 'build-land', '--leases', 'src/**,docs/x.md', '--test-command', 'node --version', '--max-turns', 'fake-claude=2',
    '--mode', 'fake-codex=workspace-write', '--approve', 'fake-codex', '--land-mode', 'pr', '--title', 'Rename'], env).trim()
  assert.match(id, /^card-\d{8}-\d{4}-rename-greet-to-hello$/)
  const c = readCard(home, id)
  assert.equal(c.title, 'Rename')
  assert.deepEqual(c.leases, ['src/**', 'docs/x.md'])
  assert.equal(c.test_command, 'node --version')
  assert.equal(c.land_mode, 'pr')
  assert.equal(c.trunk, 'main')
  assert.equal(c.land_attempts, 0)
  assert.equal(c.status, 'backlog')
  assert.equal(c.station, '-')
  assert.deepEqual(c.actor, { type: 'human', id: 'local' })
  assert.deepEqual(c.pipeline.map((s) => s.name), ['build', 'test', 'land'])
  assert.deepEqual(c.pipeline[0].chain, [{ adapter: 'fake-claude', maxTurns: 2 }, { adapter: 'fake-codex', mode: 'workspace-write', approve: true }])
  assert.ok(baton(['card', 'ls'], env).includes(id))
  const show = baton(['card', 'show', id], env)
  assert.ok(show.includes('build(agent: fake-claude > fake-codex/workspace-write) → test(test) → land(land)'))
  assert.ok(show.includes('actions: kill, enqueue'), show)
  const shown = JSON.parse(baton(['card', 'show', id, '--json'], env))
  assert.equal(shown.card.card_id, id)
  assert.ok(baton(['card', 'events', id], env).includes('card_created'))
  const queued = baton(['card', 'queue', id], env)
  assert.ok(queued.includes('queued at build'))
  assert.equal(readCard(home, id).status, 'queued')
  assert.ok(baton(['card', 'rm', id], env).includes(`removed ${id}`))
  assert.ok(!existsSync(join(home, 'cards', id)))
})

test('card add --queue enqueues immediately; scheduler status reports not running', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const id = baton(['card', 'add', '--repo', repo, '--task', 'q', '--chain', 'fake', '--queue'], env).trim()
  assert.equal(readCard(home, id).status, 'queued')
  assert.ok(baton(['scheduler', 'status'], env).includes('not running'))
})

test('card add accepts a real scratch git repo', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const id = baton(['card', 'add', '--repo', repo, '--task', 'ok', '--chain', 'fake'], env).trim()
  assert.equal(readCard(home, id).status, 'backlog')
})

test('card add refuses a plain directory that is not a git repo', () => {
  const home = makeHome()
  const env = testEnv(home)
  const notAGitRepo = mkdtempSync(join(tmpdir(), 'baton-cards-'))
  const bad = batonFail(['card', 'add', '--repo', notAGitRepo, '--task', 't', '--chain', 'fake'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /repo is not a git repository:/)
})

test('card add refuses a file as --repo', () => {
  const home = makeHome()
  const env = testEnv(home)
  const dir = mkdtempSync(join(tmpdir(), 'baton-cards-'))
  const file = join(dir, 'not-a-dir.txt')
  writeFileSync(file, 'hi\n')
  const bad = batonFail(['card', 'add', '--repo', file, '--task', 't', '--chain', 'fake'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /repo is not a directory:/)
})

test('card add refuses a subdirectory of a git repo (root must be the repo itself)', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const sub = join(repo, 'sub')
  mkdirSync(sub)
  const bad = batonFail(['card', 'add', '--repo', sub, '--task', 't', '--chain', 'fake'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /repo is not the repository root: .*\(root is .*\)/)
})

test('card add refuses a repo path equal to BATON_HOME', () => {
  const repo = initRepo()
  const env = testEnv(repo)
  const bad = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'fake'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /repo cannot contain BATON_HOME/)
})

test('card add refuses a repo path that is a parent of BATON_HOME', () => {
  const repo = initRepo()
  const home = join(repo, 'nested', '.baton-home')
  const env = testEnv(home)
  const bad = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'fake'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /repo cannot contain BATON_HOME/)
})
