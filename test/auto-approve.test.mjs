import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { makeHome } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME
for (const prefix of ['LEG', 'BATON']) {
  delete process.env[`${prefix}_AUTO_APPROVE`]
  delete process.env[`${prefix}_NO_AUTO_APPROVE`]
  for (const agent of ['CLAUDE', 'CODEX', 'AGY', 'GROK']) delete process.env[`${prefix}_${agent}_ARGS`]
}

const { resolveAutoApprove, readPreferences, writePreferences, preferencesFile } = await import('../src/preferences.mjs')
const { spawnSpec } = await import('../src/attach.mjs')
const { sessionDir } = await import('../src/sessions.mjs')

function ensureSession(id) {
  mkdirSync(sessionDir(id), { recursive: true })
}

test('resolveAutoApprove: default is false when unconfigured, without creating preferences', () => {
  assert.equal(resolveAutoApprove({ env: {}, preferences: {} }), false)
  assert.equal(resolveAutoApprove({ env: {}, preferences: null }), false)
  assert.equal(existsSync(preferencesFile()), false)
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

test('environment opt-in is explicit, normalized, and fails closed', () => {
  for (const key of ['LEG_AUTO_APPROVE', 'BATON_AUTO_APPROVE']) {
    for (const value of ['1', 'true', 'on', ' TRUE ', 'On']) {
      assert.equal(resolveAutoApprove({ env: { [key]: value }, preferences: { auto_approve: false } }), true, `${key}=${value}`)
    }
    for (const value of ['', '0', 'false', 'off', 'FALSE', ' OFF ', 'yes', 'tru', '2']) {
      assert.equal(resolveAutoApprove({ env: { [key]: value }, preferences: { auto_approve: true } }), false, `${key}=${value}`)
    }
  }
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '0', BATON_AUTO_APPROVE: '1' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '', BATON_AUTO_APPROVE: '1' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '1', BATON_AUTO_APPROVE: '0' } }), true)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '1', LEG_NO_AUTO_APPROVE: '1' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '1', BATON_NO_AUTO_APPROVE: ' TRUE ' } }), false)
  assert.equal(resolveAutoApprove({ env: { LEG_AUTO_APPROVE: '1', LEG_NO_AUTO_APPROVE: '0', BATON_NO_AUTO_APPROVE: '1' } }), true)
  assert.equal(resolveAutoApprove({ cliFlag: true, env: { LEG_NO_AUTO_APPROVE: '1' } }), true)
  assert.equal(resolveAutoApprove({ cliFlag: 'false', env: { LEG_AUTO_APPROVE: '1' } }), false)
})

test('missing, corrupt and non-boolean saved values stay off without writes', () => {
  for (const text of ['{', 'null', '[]', '{}', ...['true', 'false', 1, 0, null, [], {}].map((auto_approve) => JSON.stringify({ auto_approve }))]) {
    writeFileSync(preferencesFile(), text)
    assert.equal(readPreferences().auto_approve, false, text)
    assert.equal(resolveAutoApprove({ env: {} }), false, text)
    assert.equal(readFileSync(preferencesFile(), 'utf8'), text)
  }
  unlinkSync(preferencesFile())
})

test('unrelated saves preserve explicit booleans and never enable a missing setting', () => {
  for (const value of [undefined, false, true]) {
    writeFileSync(preferencesFile(), JSON.stringify({ auto_approve: value }))
    assert.equal(writePreferences({ notify_board: true }).auto_approve, value === true)
    assert.equal(readPreferences().auto_approve, value === true)
  }
  const before = readFileSync(preferencesFile(), 'utf8')
  for (const value of ['false', 'true', 1, null, {}]) assert.throws(() => writePreferences({ auto_approve: value }), /must be a boolean/)
  assert.equal(readFileSync(preferencesFile(), 'utf8'), before)
  unlinkSync(preferencesFile())
})

test('readPreferences and writePreferences: auto_approve persistence', () => {
  const initial = readPreferences()
  assert.equal(initial.auto_approve, false)

  const updated = writePreferences({ auto_approve: false })
  assert.equal(updated.auto_approve, false)
  assert.equal(readPreferences().auto_approve, false)

  const restored = writePreferences({ auto_approve: true })
  assert.equal(restored.auto_approve, true)
  assert.equal(readPreferences().auto_approve, true)
  unlinkSync(preferencesFile())
})

test('spawnSpec claude: explicit auto-approve, disabled, and deduplication', async () => {
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

test('spawnSpec codex: explicit auto-approve, disabled, and deduplication', async () => {
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

test('spawnSpec agy: explicit auto-approve, disabled, and deduplication', async () => {
  ensureSession('s-agy-test')
  const sDefault = await spawnSpec('agy', { account: 'default', args: ['--model', 'gemini-2.5-pro'], sessionId: 's-agy-test', autoApprove: true })
  assert.ok(sDefault.args.includes('--dangerously-skip-permissions'))
  assert.deepEqual(sDefault.args.slice(0, 2), ['--model', 'gemini-2.5-pro'])

  const sDisabled = await spawnSpec('agy', { account: 'default', args: ['--model', 'gemini-2.5-pro'], sessionId: 's-agy-test', autoApprove: false })
  assert.ok(!sDisabled.args.includes('--dangerously-skip-permissions'))

  const sDedup = await spawnSpec('agy', { account: 'default', args: ['--dangerously-skip-permissions'], sessionId: 's-agy-test', autoApprove: true })
  assert.equal(sDedup.args.filter((a) => a === '--dangerously-skip-permissions').length, 1)
})

test('spawnSpec grok: explicit auto-approve, disabled, and deduplication', async () => {
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

for (const agent of ['claude', 'codex', 'agy', 'grok']) {
  test(`${agent}: default direct, resume, and handoff specs add no approval override`, async () => {
    const sessionId = `s-safe-${agent}`
    ensureSession(sessionId)
    for (const extra of [{}, { resume: 'native-session' }, { prompt: 'Continue this task', model: 'model' }]) {
      const spec = await spawnSpec(agent, { account: 'default', args: [], sessionId, ...extra })
      for (const flag of ['--dangerously-skip-permissions', '--ask-for-approval', '--always-approve']) assert.ok(!spec.args.includes(flag), `${agent}: ${flag}`)
    }
  })
}

test('explicit native permission modes win over an auto-approve preference', async () => {
  for (const [agent, args, forbidden] of [
    ['claude', ['--permission-mode', 'default'], '--dangerously-skip-permissions'],
    ['claude', ['--permission-mode=plan'], '--dangerously-skip-permissions'],
    ['claude', ['--permission-prompts', 'stdio'], '--dangerously-skip-permissions'],
    ['codex', ['--ask-for-approval=on-request'], '--ask-for-approval'],
    ['codex', ['-a=on-request'], '--ask-for-approval'],
    ['codex', ['-aon-request'], '--ask-for-approval'],
    ['codex', ['--approve-for-me'], '--ask-for-approval'],
    ['codex', ['--full-auto'], '--ask-for-approval'],
    ['codex', ['-c', 'approval_policy="on-request"'], '--ask-for-approval'],
    ['codex', ['--config=approval_policy="on-request"'], '--ask-for-approval'],
    ['codex', ['-capproval_policy="on-request"'], '--ask-for-approval'],
    ['grok', ['--permission-mode', 'default'], '--always-approve'],
    ['grok', ['--permission-mode=plan'], '--always-approve'],
    ['grok', ['--approval-mode', 'default'], '--always-approve'],
  ]) {
    const sessionId = `s-native-${agent}`
    ensureSession(sessionId)
    const spec = await spawnSpec(agent, { account: 'default', args, sessionId, autoApprove: true })
    assert.deepEqual(spec.args.slice(0, args.length), args)
    assert.ok(!spec.args.includes(forbidden))
  }
})

test('disabling injection preserves explicit native bypass arguments', async () => {
  for (const [agent, args] of [
    ['claude', ['--dangerously-skip-permissions']],
    ['codex', ['--ask-for-approval', 'never']],
    ['agy', ['--dangerously-skip-permissions']],
    ['grok', ['--always-approve']],
  ]) {
    const sessionId = `s-explicit-${agent}`
    ensureSession(sessionId)
    const spec = await spawnSpec(agent, { account: 'default', args, sessionId, autoApprove: false })
    assert.deepEqual(spec.args.slice(0, args.length), args)
  }
})
