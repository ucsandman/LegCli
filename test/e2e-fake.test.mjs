// The single-card limit handoff, end to end through the CLI: fake-claude hits
// a (recorded) usage limit, Baton writes a context-handoff-bundle, fake-codex
// resumes in the same worktree and finishes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, baton, batonFail, readCard, events, git } from './helpers.mjs'

// Phase 12 finding: a spawn error (missing CLI binary) wrote run.json with no
// outcome, so the orchestrator had nothing to transition on and the card sat
// in `running` forever. The supervisor now classifies it as launch_failed.
test('missing CLI at launch: card ends failed (launch_failed), error event names the spawn error, card run exits non-zero', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_CLAUDE_BIN: join(home, 'no-such-claude.exe') })
  const repo = initRepo('missingcli-')
  const id = baton(['card', 'add', '--repo', repo, '--task', 'never starts', '--chain', 'claude', '--slug', 'missing'], env).trim()
  const r = batonFail(['card', 'run', id], env)
  assert.notEqual(r.status, 0)
  const card = readCard(home, id)
  assert.equal(card.status, 'failed')
  assert.equal(card.failure, 'launch_failed')
  const err = events(home, id).find((e) => e.type === 'error')
  assert.match(err.summary, /agent spawn failed: spawn .*no-such-claude\.exe ENOENT/)
  const run = JSON.parse(readFileSync(join(home, 'cards', id, 'runs', '1', 'run.json'), 'utf8'))
  assert.equal(run.status, 'failed')
  assert.equal(run.outcome, 'launch_failed')
  assert.equal(run.handoff, true)
})

test('e2e: fake-claude limit → bundle → fake-codex completes, exact event sequence, under 60 s', (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('e2e-')
  const t0 = Date.now()
  const id = baton(['card', 'add', '--repo', repo, '--task', 'Create hello.txt containing hi', '--chain', 'fake-claude,fake-codex',
    '--fake-mode', 'fake-claude=limit,fake-codex=success', '--pipeline', 'build', '--leases', 'hello.txt'], env).trim()
  const out = baton(['card', 'run', id], env)
  const seconds = (Date.now() - t0) / 1000
  assert.ok(out.includes(`${id} done at build`), out)
  assert.ok(seconds < 60, `took ${seconds}s`)

  const card = readCard(home, id)
  assert.equal(card.status, 'done')
  assert.equal(card.leg, 0)
  assert.ok(card.worktree.endsWith(join('.baton-worktrees', id)))
  assert.ok(card.last_bundle, 'bundle id recorded on the card')

  const evs = events(home, id)
  const seq = evs.map((e) => e.type)
  t.diagnostic(`events: ${seq.join(' → ')} (${seconds.toFixed(1)}s)`)
  assert.deepEqual(seq, ['card_created', 'leg_started', 'limit_detected', 'handoff_written', 'leg_started', 'leg_exited', 'station_done', 'done'])
  // actors: the human created it; Baton did everything else; every event carries card_id/station/leg
  assert.deepEqual(evs[0].actor, { type: 'human', id: 'local' })
  for (const e of evs.slice(1)) assert.deepEqual(e.actor, { type: 'baton' })
  for (const e of evs) { assert.equal(e.card_id, id); assert.equal(typeof e.station, 'string'); assert.equal(typeof e.leg, 'number') }
  assert.equal(evs[1].leg, 0)
  assert.equal(evs[4].leg, 1)
  assert.match(evs[2].summary, /claude-session-limit/)
  assert.match(evs[3].summary, /next: fake-codex/)

  // the worktree holds the work, the DONE marker, the contract, and the bundle
  const wt = card.worktree
  assert.equal(readFileSync(join(wt, 'hello-fake.txt'), 'utf8').trim(), 'hi')
  assert.ok(existsSync(join(wt, '.baton', 'DONE')))
  assert.ok(existsSync(join(wt, '.baton', 'CONTRACT.md')))
  assert.ok(readFileSync(join(wt, '.baton', 'CONTRACT.md'), 'utf8').includes('Create hello.txt containing hi'))
  const bundles = readdirSync(join(wt, '.context-handoffs')).filter((d) => d.includes('baton-'))
  assert.equal(bundles.length, 1)
  assert.ok(existsSync(join(wt, '.context-handoffs', bundles[0], 'summary.json')))
  // leg 2's prompt started with the resume text
  const prompt = readFileSync(join(home, 'cards', id, 'prompt-build-leg1.txt'), 'utf8')
  assert.ok(prompt.includes('HANDOFF RESUME'))
  assert.ok(prompt.includes('Create hello.txt containing hi'))
  // two runs recorded with their outcomes
  const runs = [1, 2].map((n) => JSON.parse(readFileSync(join(home, 'cards', id, 'runs', String(n), 'run.json'), 'utf8')))
  assert.deepEqual(runs.map((r) => [r.adapter, r.outcome, r.signal]), [['fake-claude', 'limit', 'claude-session-limit'], ['fake-codex', 'completed', 'none']])
  // the main checkout is untouched
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '')
  assert.ok(git(repo, ['worktree', 'list']).includes(`baton/${id}`))
})
