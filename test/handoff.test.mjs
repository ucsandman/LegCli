import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chbVersion, versionOk, buildNotes, writeHandoff, loadResume, resolveChb } from '../src/handoff.mjs'
import { initRepo, git } from './helpers.mjs'

const card = { card_id: 'card-20260910-1200-demo', task: 'Add a greeting function to lib.js and a test for it', repo: null }
const station = { name: 'build', kind: 'agent', chain: [{ adapter: 'fake-claude' }, { adapter: 'fake-codex' }] }
const run = { run: 1, adapter: 'fake-claude', outcome: 'limit', signal: 'claude-session-limit', reason: 'docs-only limit signal: claude-session-limit', exit_code: 1, diff: { changed: true, files: 2, head_at_start: 'abc1234', head: 'abc1234' } }

test('context-handoff-bundle resolves as an argv subprocess and is at least 0.4.0', () => {
  const r = resolveChb()
  assert.ok(r.bin)
  const v = chbVersion()
  assert.ok(v, 'version detected')
  assert.ok(versionOk(v), `version ${v} >= 0.4.0`)
  assert.equal(versionOk('0.3.9'), false)
  assert.equal(versionOk('1.0.0'), true)
})

test('notes carry the four Leg sections under the bundle\'s own headings', () => {
  const notes = buildNotes({ card, station, leg: 0, entry: station.chain[0], run, progress: 'created lib.js\nwrote greet()\n', lastMessage: 'I was about to add the test', changedFiles: ['lib.js', 'test/lib.test.js'], diffStat: ' 2 files changed, 12 insertions(+)' })
  for (const h of ['## Scope', '## Findings', '## Opportunities', '## Open questions', '## Evidence anchors']) assert.ok(notes.includes(h), h)
  for (const s of ['Task:', 'Done so far', 'Diff since leg start', 'Open findings']) assert.ok(notes.includes(s), s)
  assert.ok(notes.includes('claude-session-limit'))
  assert.ok(notes.includes('- lib.js'))
  assert.ok(notes.includes('I was about to add the test'))
  // secrets never reach a bundle
  const leaky = buildNotes({ card, station, leg: 0, run, progress: 'used api_key=sk-abcdefgh12345678 once\n' })
  assert.ok(!leaky.includes('sk-abcdefgh12345678'))
  assert.ok(leaky.includes('[REDACTED]'))
})

test('writeHandoff saves a repo-local bundle in the worktree, validates it, and load prints the task back', () => {
  const repo = initRepo('handoff-')
  const c = { ...card, repo }
  const wt = repo // a plain checkout stands in for the worktree here
  mkdirSync(join(wt, '.baton'), { recursive: true })
  writeFileSync(join(wt, '.baton', 'PROGRESS.md'), 'created lib.js\nwrote greet()\n')
  writeFileSync(join(wt, 'lib.js'), 'export const greet = (n) => `hi ${n}`\n')
  const h = writeHandoff({ card: c, station, leg: 0, entry: station.chain[0], run, worktree: wt, runDir: null, changedFiles: ['lib.js'], diffStat: '' })
  assert.match(h.bundle_id, /-leg-card-20260910-1200-demo-build-leg0$/)
  assert.ok(existsSync(h.path), 'bundle dir exists')
  for (const f of ['CONTEXT_HANDOFF.md', 'summary.json', 'entities.json', 'relations.json', 'evidence_index.json', 'open_questions.json', 'resume_prompt.txt', 'bundle_metadata.json']) {
    assert.ok(existsSync(join(h.path, f)), f)
  }
  assert.ok(existsSync(h.notes_path))
  assert.ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.context-handoffs/'))
  assert.equal(git(repo, ['status', '--porcelain']).includes('.context-handoffs'), false, 'bundle store is excluded from git')
  const resume = loadResume(wt)
  assert.ok(resume.includes('Add a greeting function'), 'load output contains the task')
  assert.ok(/Done so far|greet\(\)/.test(resume))
})
