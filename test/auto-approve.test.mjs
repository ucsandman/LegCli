import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { makeHome } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME

const { resolveAutoApprove, readPreferences, writePreferences } = await import('../src/preferences.mjs')
const { spawnSpec } = await import('../src/attach.mjs')
const { sessionDir } = await import('../src/sessions.mjs')

function ensureSession(id) {
  mkdirSync(sessionDir(id), { recursive: true })
}

test('resolveAutoApprove: default is true when unconfigured', () => {
  assert.equal(resolveAutoApprove({ env: {}, preferences: {} }), true)
  assert.equal(resolveAutoApprove({ env: {}, preferences: null }), true)
})

test('resolveAutoApprove: cliFlag has highest precedence', () => {
  assert.equal(resolveAutoApprove({ cliFlag: false, env: { LEG_AUTO_APPROVE: '1' }, preferences: { auto_approve: true } }), false)
  assert.equal(resolveAutoApprove({ cliFlag: true, env: { LEG_AUTO_APPROVE: '0' }, preferences: { auto_approve: false } }), true)
})

test('resolveAutoApprove: env vars LEG_AUTO_APPROVE and BATON_AUTO_APPROVE', () => {
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '0' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: 'false' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: 'off' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '1' } }), true)

  assert.equal(resolveAutoApprove({ env: { BATON_AUTO_APPROVE: '0' } }), false)
  assert.equal(resolveAutoApprove({ env: { BATON_AUTO_APPROVE: 'false' } }), false)
  assert.equal(resolveAutoApprove({ env: { BATON_AUTO_APPROVE: 'off' } }), false)
  assert.equal(resolveAutoApprove({ env: { BATON_AUTO_APPROVE: '1' } }), true)
})

test('resolveAutoApprove: env vars LEG_NO_AUTO_APPROVE and BATON_NO_AUTO_APPROVE', () => {
  assert.equal(resolveAutoApprove({ env: { LEG_NO_AUTO_APPROVE: '1' } }), false)
  assert.equal(resolveAutoApprove({ env: { BATON_NO_AUTO_APPROVE: '1' } }), false)
})

test('resolveAutoApprove: preferences.auto_approve', () => {
  assert.equal(resolveAutoApprove({ env: {}, preferences: { auto_approve: false } }), false)
  assert.equal(resolveAutoApprove({ env: {}, preferences: { auto_approve: true } }), true)
})

test('readPreferences and writePreferences: auto_approve persistence', () => {
  const initial = readPreferences()
  assert.equal(initial.auto_approve, true)

  const updated = writePreferences({ auto_approve: false })
  assert.equal(updated.auto_approve, false)
  assert.equal(readPreferences().auto_approve, false)

  const restored = writePreferences({ auto_approve: true })
  assert.equal(restored.auto_approve, true)
  assert.equal(readPreferences().auto_approve, true)
})

test('spawnSpec claude: auto-approve default, disabled, and deduplication', async () => {
  ensureSession('s-claude-test')
  const sDefault = await spawnSpec('claude', { account: 'default', args: ['--model', 'haiku'], sessionId: 's-claude-test', autoApprove: true })
  assert.ok(sDefault.args.includes('--dangerously-skip-permissions'))
  assert.deepEqual(sDefault.args.slice(0, 2), ['--model', 'haiku'])

  const sDisabled = await spawnSpec('claude', { account: 'default', args: ['--model', 'haiku'], sessionId: 's-claude-test', autoApprove: false })
  assert.ok(!sDisabled.args.includes('--dangerously-skip-permissions'))

  const sDedup = await spawnSpec('claude', { account: 'default', args: ['--dangerously-skip-permissions', '--model', 'haiku'], sessionId: 's-claude-test', autoApprove: true })
  const count = sDedup.args.filter((a) => a === '--dangerously-skip-permissions').length
  assert.equal(count, 1)
})

test('spawnSpec codex: auto-approve default, disabled, and deduplication', async () => {
  ensureSession('s-codex-test')
  const sDefault = await spawnSpec('codex', { account: 'default', args: ['-m', 'o3'], sessionId: 's-codex-test', autoApprove: true })
  assert.ok(sDefault.args.includes('--ask-for-approval'))
  assert.equal(sDefault.args[sDefault.args.indexOf('--ask-for-approval') + 1], 'never')
  assert.deepEqual(sDefault.args.slice(0, 2), ['-m', 'o3'])

  const sDisabled = await spawnSpec('codex', { account: 'default', args: ['-m', 'o3'], sessionId: 's-codex-test', autoApprove: false })
  assert.ok(!sDisabled.args.includes('--ask-for-approval'))

  const sDedupFlag = await spawnSpec('codex', { account: 'default', args: ['--ask-for-approval', 'prompt', '-m', 'o3'], sessionId: 's-codex-test', autoApprove: true })
  assert.equal(sDedupFlag.args.filter((a) => a === '--ask-for-approval').length, 1)
  assert.equal(sDedupFlag.args[sDedupFlag.args.indexOf('--ask-for-approval') + 1], 'prompt')

  const sDedupShort = await spawnSpec('codex', { account: 'default', args: ['-a', 'prompt', '-m', 'o3'], sessionId: 's-codex-test', autoApprove: true })
  assert.ok(!sDedupShort.args.includes('--ask-for-approval'))
  assert.ok(sDedupShort.args.includes('-a'))
})

test('spawnSpec agy: auto-approve default, disabled, and deduplication', async () => {
  ensureSession('s-agy-test')
  const sDefault = await spawnSpec('agy', { account: 'default', args: ['--model', 'gemini-2.5-pro'], sessionId: 's-agy-test', autoApprove: true })
  assert.ok(sDefault.args.includes('--dangerously-skip-permissions'))
  assert.deepEqual(sDefault.args.slice(0, 2), ['--model', 'gemini-2.5-pro'])

  const sDisabled = await spawnSpec('agy', { account: 'default', args: ['--model', 'gemini-2.5-pro'], sessionId: 's-agy-test', autoApprove: false })
  assert.ok(!sDisabled.args.includes('--dangerously-skip-permissions'))

  const sDedup = await spawnSpec('agy', { account: 'default', args: ['--dangerously-skip-permissions'], sessionId: 's-agy-test', autoApprove: true })
  assert.equal(sDedup.args.filter((a) => a === '--dangerously-skip-permissions').length, 1)
})

test('spawnSpec grok: auto-approve default, disabled, and deduplication', async () => {
  ensureSession('s-grok-test')
  const sDefault = await spawnSpec('grok', { account: 'default', args: ['--model', 'grok-beta'], sessionId: 's-grok-test', autoApprove: true })
  assert.ok(sDefault.args.includes('--always-approve'))
  assert.deepEqual(sDefault.args.slice(0, 2), ['--model', 'grok-beta'])

  const sDisabled = await spawnSpec('grok', { account: 'default', args: ['--model', 'grok-beta'], sessionId: 's-grok-test', autoApprove: false })
  assert.ok(!sDisabled.args.includes('--always-approve'))

  const sDedupApprove = await spawnSpec('grok', { account: 'default', args: ['--always-approve'], sessionId: 's-grok-test', autoApprove: true })
  assert.equal(sDedupApprove.args.filter((a) => a === '--always-approve').length, 1)

  const sDedupYolo = await spawnSpec('grok', { account: 'default', args: ['--yolo'], sessionId: 's-grok-test', autoApprove: true })
  assert.ok(!sDedupYolo.args.includes('--always-approve'))
})
