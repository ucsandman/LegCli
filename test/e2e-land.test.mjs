// Three cards land in sequence on one toy repo: A lands clean, B is bounced
// by a red test and lands after the fix, C is bounced by a rebase conflict
// with A's change and lands after resolving.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, git, baton, readCard, events, runCardOrExplain } from './helpers.mjs'
import { ensure } from '../src/worktree.mjs'

const PKG = JSON.stringify({ name: 'toy', type: 'module', scripts: { test: 'node --test' } })
const GREEN = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('base', () => { assert.equal(1, 1) })\n"

test('e2e-land: A lands, B bounced by tests-red then lands, C bounced by rebase-conflict then lands; trunk shows A, B, C', (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = initRepo('e2eland-')
  writeFileSync(join(repo, 'package.json'), PKG)
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'test', 'base.test.mjs'), GREEN)
  writeFileSync(join(repo, 'shared.txt'), 'line one\nline two\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'toy with tests'])
  const base = git(repo, ['rev-parse', 'HEAD']).trim()

  const add = (title, task, fakeMode, target, content, extra = []) => baton(['card', 'add', '--repo', repo, '--task', task, '--chain', 'fake',
    '--pipeline', 'build-land', '--fake-mode', `fake=${fakeMode}`, '--fake-target', `fake=${target}`, '--fake-content', `fake=${content}`, '--title', title, '--slug', title.toLowerCase(), ...extra], env).trim()
  // All three branch from the same trunk before anything lands.
  const A = add('A', 'Add a.mjs and touch shared.txt', 'success', 'shared.txt', 'line one (A)')
  const B = add('B', 'Add b.mjs with a test', 'break-test;fix-test', 'b.mjs', 'export const b = 2')
  const C = add('C', 'Edit shared.txt line one', 'success;resolve-rebase', 'shared.txt', 'line one (C)')
  // Create all three worktrees now so every card branches from the same base
  // commit (the orchestrator reuses an existing worktree); that is what makes
  // C conflict with A's landed change later.
  for (const id of [A, B, C]) { ensure(repo, id, { trunk: 'main' }); baton(['card', 'queue', id], env) }
  const t0 = Date.now()
  const outA = runCardOrExplain(home, A, env)
  assert.match(outA, /done at land/)
  const outB = runCardOrExplain(home, B, env)
  assert.match(outB, /done at land/)
  const outC = runCardOrExplain(home, C, env)
  assert.match(outC, /done at land/)
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)

  for (const [id, name] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    const seq = events(home, id).map((e) => e.type)
    t.diagnostic(`${name}: ${seq.join(' → ')}`)
  }
  const seqA = events(home, A).map((e) => e.type)
  // build → test (status: test green) → land
  assert.deepEqual(seqA, ['card_created', 'leg_started', 'leg_exited', 'station_done', 'status', 'station_done', 'landed', 'station_done', 'done'])
  // B goes red at the test station (before land) and comes back green after the bounce
  const bB = events(home, B).find((e) => e.type === 'bounced')
  assert.match(bB.summary, /test red \(attempt 1\) → build/)
  assert.match(bB.body, /test red/)
  assert.ok(events(home, B).filter((e) => e.type === 'leg_started').length === 2)
  const bC = events(home, C).find((e) => e.type === 'bounced')
  assert.match(bC.body, /rebase-conflict/)
  assert.match(bC.body, /shared\.txt/)
  assert.equal(readCard(home, C).land_attempts, 1)

  const log = git(repo, ['log', '--oneline', `${base}..HEAD`]).trim().split('\n')
  t.diagnostic(`trunk: ${log.join(' | ')} (${seconds}s)`)
  assert.deepEqual(log.map((l) => l.replace(/^[0-9a-f]+ /, '')), ['baton: C', 'baton: B', 'baton: A'])
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8').trim(), 'line one (C)', 'C resolved on top of A (the fake rewrites the whole file)')
  assert.equal(readFileSync(join(repo, 'b.mjs'), 'utf8').trim(), 'export const b = 2')
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '')
  // three landed events across the cards (what /api/trunk lists)
  const landed = [A, B, C].flatMap((id) => events(home, id).filter((e) => e.type === 'landed'))
  assert.equal(landed.length, 3)
  for (const e of landed) assert.deepEqual(e.actor, { type: 'baton' })
})
