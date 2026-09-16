// The land station through the orchestrator: a bounce writes a bundle whose
// Open findings carry the failure, and the bounced run's prompt includes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, git, baton, readCard, events, runCardOrExplain } from './helpers.mjs'

const PKG = JSON.stringify({ name: 'toy', type: 'module', scripts: { test: 'node --test' } })
const GREEN = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('base', () => { assert.equal(1, 1) })\n"

function toy() {
  const repo = initRepo('landst-')
  writeFileSync(join(repo, 'package.json'), PKG)
  mkdirSync(join(repo, 'test'))
  writeFileSync(join(repo, 'test', 'base.test.mjs'), GREEN)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'toy with tests'])
  return repo
}

// build → land with no test station in between, so the land station's own test
// run is what goes red (the build-land preset would catch it at its test station).
function buildLandPipeline(home) {
  const f = join(home, 'build-land-only.json')
  writeFileSync(f, JSON.stringify([{ name: 'build', kind: 'agent' }, { name: 'land', kind: 'land' }]))
  return f
}

test('build-land: a red test bounces the card to build with the failure in the bundle and in the next prompt, then it lands', (t) => {
  const home = makeHome()
  const env = testEnv(home)
  const repo = toy()
  const id = baton(['card', 'add', '--repo', repo, '--task', 'Add b.mjs', '--chain', 'fake', '--pipeline', buildLandPipeline(home),
    '--fake-mode', 'fake=break-test;fix-test', '--fake-target', 'fake=b.mjs', '--title', 'B'], env).trim()
  const out = runCardOrExplain(home, id, env)
  assert.match(out, /done at land/)
  const card = readCard(home, id)
  assert.equal(card.status, 'done')
  assert.equal(card.land_attempts, 1)
  const seq = events(home, id).map((e) => e.type)
  t.diagnostic(`events: ${seq.join(' → ')}`)
  assert.deepEqual(seq, ['card_created', 'leg_started', 'leg_exited', 'station_done', 'handoff_written', 'bounced', 'leg_started', 'leg_exited', 'station_done', 'landed', 'station_done', 'done'])
  const bounced = events(home, id).find((e) => e.type === 'bounced')
  assert.match(bounced.summary, /land bounced \(attempt 1\) → build/)
  assert.match(bounced.body, /tests-red/)
  // the bounce bundle's notes carry the failure under Open findings
  const wt = card.worktree
  const notesDir = existsSync(join(wt, '.leg')) ? join(wt, '.leg') : join(wt, '.baton')
  const notes = readdirSync(notesDir).filter((f) => f.startsWith('handoff-land'))
  assert.equal(notes.length, 1)
  const text = readFileSync(join(notesDir, notes[0]), 'utf8')
  assert.ok(text.includes('Open findings: land failure: tests-red'), text)
  assert.ok(text.includes('fail 1'), 'test tail present')
  // the second build run's prompt starts with the resume that names the failure
  const prompt = readFileSync(join(home, 'cards', id, 'prompt-build-leg0.txt'), 'utf8')
  assert.ok(prompt.includes('HANDOFF RESUME'))
  assert.ok(/tests-red/.test(prompt), 'prompt names the land failure')
  assert.ok(prompt.includes('Why this card came back'))
  // trunk has the landed commit and no broken test
  assert.match(git(repo, ['log', '--oneline', '-1']), /leg: B/)
  assert.ok(!existsSync(join(repo, 'test', 'broken.test.mjs')))
  assert.equal(readFileSync(join(repo, 'b.mjs'), 'utf8').trim(), 'hi')
  const landed = events(home, id).find((e) => e.type === 'landed')
  assert.match(landed.summary, /landed on main/)
  assert.ok(JSON.parse(landed.body).sha)
})

test('max land attempts → failed with the reason; pr land mode parks the card as waiting_human with the URL', (t) => {
  const home = makeHome()
  const repo = toy()
  // always-red: break-test on every attempt, max 2 attempts
  const env = testEnv(home, { BATON_MAX_LAND_ATTEMPTS: '2' })
  const id = baton(['card', 'add', '--repo', repo, '--task', 'Never green', '--chain', 'fake', '--pipeline', buildLandPipeline(home),
    '--fake-mode', 'fake=break-test', '--fake-target', 'fake=n.mjs', '--title', 'N'], env).trim()
  let status = 0
  try { baton(['card', 'run', id], env) } catch (err) { status = err.status }
  assert.equal(status, 1)
  const card = readCard(home, id)
  assert.equal(card.status, 'failed')
  assert.equal(card.land_attempts, 2)
  const seq = events(home, id).map((e) => e.type)
  t.diagnostic(`events: ${seq.join(' → ')}`)
  assert.equal(seq.filter((x) => x === 'bounced').length, 1)
  assert.equal(seq[seq.length - 1], 'failed')
  assert.match(events(home, id).at(-1).summary, /land failed after 2 attempt/)

  // pr mode through the gh stub
  const dir = join(home, 'stub')
  mkdirSync(dir)
  const stub = join(dir, 'gh-stub.mjs')
  writeFileSync(stub, "process.stdout.write('https://example.invalid/pull/7\\n')\n")
  const prEnv = testEnv(home, { BATON_GH_BIN: stub })
  const pr = baton(['card', 'add', '--repo', repo, '--task', 'Via PR', '--chain', 'fake', '--pipeline', 'build-land', '--land-mode', 'pr', '--fake-target', 'fake=p.mjs', '--title', 'P'], prEnv).trim()
  let prStatus = 0
  try { baton(['card', 'run', pr], prEnv) } catch (err) { prStatus = err.status }
  assert.equal(prStatus, 1, 'not done yet: a human merges the PR')
  const prCard = readCard(home, pr)
  assert.equal(prCard.status, 'waiting_human')
  assert.equal(prCard.station, 'land')
  assert.equal(prCard.pr_url, 'https://example.invalid/pull/7')
  assert.ok(events(home, pr).some((e) => e.type === 'approval_needed' && /pull request opened/.test(e.summary)))
  assert.doesNotMatch(git(repo, ['log', '--oneline', '-3']), /leg: P/, 'trunk untouched in pr mode')
  // approve → done
  baton(['card', 'approve', pr], prEnv)
  assert.equal(readCard(home, pr).status, 'done')
})
