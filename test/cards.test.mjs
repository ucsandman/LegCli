// The headless CLI: card add validation and the read commands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, baton, batonFail, readCard } from './helpers.mjs'

test('card add refuses a forbidden mode, an unknown adapter, and a land station that is not last', () => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo()
  const bad = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'claude,codex', '--mode', 'claude=bypassPermissions'], env)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /forbidden mode "bypassPermissions" for claude/)
  const yolo = batonFail(['card', 'add', '--repo', repo, '--task', 't', '--chain', 'gemini', '--mode', 'gemini=yolo'], env)
  assert.equal(yolo.status, 2)
  assert.match(yolo.stderr, /forbidden mode "yolo" for gemini/)
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
