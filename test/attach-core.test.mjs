// Pure pieces behind `baton claude|codex|agy`: session store + overlap, usage
// state + the handoff chooser, the three taps, and the claude hook handler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-attach-'))

const sessions = await import('../src/sessions.mjs')
const usage = await import('../src/usage.mjs')
const claudeTap = await import('../src/taps/claude.mjs')
const codexTap = await import('../src/taps/codex.mjs')
const agyTap = await import('../src/taps/agy.mjs')
const accounts = await import('../src/accounts.mjs')

const cwd = mkdtempSync(join(tmpdir(), 'baton-cwd-'))

test('sessions: create, update, events, control, overlap', () => {
  const a = sessions.createSession({ id: 's-a-claude', agent: 'claude', cwd, repo: cwd, branch: 'main', chain: [{ agent: 'codex', account: 'default' }] })
  assert.equal(a.status, 'starting')
  sessions.updateSession('s-a-claude', { status: 'running', files_touched: ['src/x.mjs', 'README.md'] }, { event: { type: 'turn', summary: 'hi' } })
  const b = sessions.createSession({ id: 's-b-codex', agent: 'codex', cwd, repo: cwd.toUpperCase(), branch: 'main' })
  sessions.updateSession('s-b-codex', { status: 'running', files_dirty: ['README.md'] })
  const ov = sessions.overlaps(sessions.listSessions())
  assert.deepEqual(ov.get('s-a-claude')[0].files, ['README.md'])
  assert.equal(ov.get('s-b-codex')[0].session_id, 's-a-claude')
  assert.equal(sessions.readEvents('s-a-claude').map((e) => e.type).join(','), 'started,turn')
  sessions.requestControl('s-a-claude', { handoff: true })
  assert.equal(sessions.takeControl('s-a-claude').handoff, true)
  assert.equal(sessions.takeControl('s-a-claude'), null)
  sessions.updateSession('s-b-codex', { status: 'ended' })
  assert.equal(sessions.overlaps(sessions.listSessions()).size, 0)
  assert.equal(b.agent, 'codex')
})

test('usage: record, warn pressure, limit wall, chooser order and all-out', () => {
  const acc = { claude: ['default', 'work'], codex: ['default'], agy: ['default'] }
  usage.recordUsage('claude', 'default', { five_hour: { pct: 91, resets_at: 1_900_000_000 }, seven_day: { pct: 40, resets_at: 1_900_500_000 } }, 'test')
  assert.equal(usage.hottest(usage.readUsage('claude', 'default')).window, '5h')
  assert.deepEqual(usage.candidates({ agent: 'claude', account: 'default', accounts: acc }).map((c) => `${c.agent}/${c.account}`), ['claude/work', 'codex/default', 'agy/default'])
  assert.deepEqual(usage.candidates({ agent: 'codex', account: 'default', accounts: acc }).map((c) => `${c.agent}/${c.account}`), ['agy/default', 'claude/default', 'claude/work'])
  const nowS = 1_800_000_000
  const u = usage.markLimited('claude', 'default', { reason: 'rate_limit' })
  assert.equal(u.limited_until, 1_900_000_000, 'wall = soonest known window reset')
  let c = usage.chooseNext({ agent: 'claude', account: 'default', accounts: acc, nowS })
  assert.deepEqual(c.next, { agent: 'claude', account: 'work' })
  usage.markLimited('claude', 'work', { resets_at: nowS + 600 })
  usage.markLimited('codex', 'default', { resets_at: nowS + 7200 })
  usage.markLimited('agy', 'default', { resets_at: nowS + 60 })
  c = usage.chooseNext({ agent: 'claude', account: 'default', accounts: acc, nowS })
  assert.equal(c.next, null)
  assert.deepEqual(c.out.map((o) => `${o.agent}/${o.account}`), ['agy/default', 'claude/work', 'codex/default'], 'sorted by soonest reset')
  // a reset in the past is available again
  c = usage.chooseNext({ agent: 'claude', account: 'default', accounts: acc, nowS: nowS + 100 })
  assert.deepEqual(c.next, { agent: 'agy', account: 'default' })
  // installed=false skips an agent
  c = usage.chooseNext({ agent: 'claude', account: 'default', accounts: acc, nowS: nowS + 100, installed: { agy: false } })
  assert.equal(c.next, null, 'agy skipped, the others still walled')
  assert.equal(c.out.length, 2)
})

test('claude tap: settings shape, hook handling, statusline limits', () => {
  const s = sessions.createSession({ id: 's-c-claude', agent: 'claude', cwd, repo: cwd, chain: [{ agent: 'codex', account: 'default' }] })
  const settings = claudeTap.settingsFor(s.session_id)
  assert.equal(settings.autoContinueAtUsageLimit, false)
  assert.ok(settings.hooks.StopFailure[0].hooks[0].command.includes('claude-hook --session s-c-claude'))
  assert.ok(settings.statusLine.command.includes('claude-statusline'))
  claudeTap.handleHook('s-c-claude', { hook_event_name: 'SessionStart', session_id: 'cs1', transcript_path: 'C:/t.jsonl', source: 'startup' })
  claudeTap.handleHook('s-c-claude', { hook_event_name: 'UserPromptSubmit', session_id: 'cs1', prompt: 'build the thing' })
  claudeTap.handleHook('s-c-claude', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwd, 'src', 'a.mjs') } })
  let r = sessions.readSession('s-c-claude')
  assert.equal(r.status, 'running'); assert.equal(r.task, 'build the thing'); assert.deepEqual(r.files_touched, ['src/a.mjs']); assert.equal(r.agent_session_id, 'cs1')
  const sl = claudeTap.handleStatusline('s-c-claude', { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 }, seven_day: { used_percentage: 88.4, resets_at: 2 } } })
  assert.equal(sl.warn, true)
  assert.match(sl.text, /7d at 88%/)
  r = sessions.readSession('s-c-claude')
  assert.equal(r.status, 'warning'); assert.equal(r.warning.window, '7d')
  claudeTap.handleHook('s-c-claude', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' })
  r = sessions.readSession('s-c-claude')
  assert.equal(r.status, 'limit'); assert.equal(r.limit.reason, 'rate_limit')
  assert.equal(usage.readUsage('claude', 'default').limited_reason, 'rate_limit')
  claudeTap.handleHook('s-c-claude', { hook_event_name: 'StopFailure', error: 'server_error' })
  assert.equal(sessions.readEvents('s-c-claude').filter((e) => e.type === 'error').length, 1)
})

test('claude tap: transcript tail skips sidechains and tag-only messages', () => {
  const t = join(cwd, 'transcript.jsonl')
  writeFileSync(t, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'real prompt' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'side' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] } }),
  ].join('\n'))
  assert.deepEqual(claudeTap.transcriptTail(t), [{ role: 'user', text: 'real prompt' }, { role: 'assistant', text: 'answer' }])
  assert.equal(claudeTap.firstPrompt(t), 'real prompt')
})

test('codex tap: rollout parsing (observed-live shapes) and discovery by cwd', () => {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd, timestamp: '2026-09-11T02:33:26.241Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a calc module' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 22, window_minutes: 300, resets_at: 1789097419 }, secondary: { used_percent: 58, window_minutes: 10080, resets_at: 1789582802 } } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', input: '*** Begin Patch\n*** Add File: src/calc.mjs\n+x\n*** End Patch' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done', error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 14th, 2026 9:35 PM.", codex_error_info: 'usage_limit_exceeded' } } }),
  ]
  const r = codexTap.parseLines(lines)
  assert.equal(r.threadId, 'thread-1')
  assert.equal(r.limits.five_hour.pct, 22); assert.equal(r.limits.seven_day.window_minutes, 10080)
  assert.equal(r.messages[0].text, 'add a calc module')
  assert.deepEqual(r.files, ['src/calc.mjs'])
  assert.equal(r.limit.reason, 'usage_limit_exceeded')
  assert.equal(new Date(r.limit.resets_at * 1000).getUTCFullYear(), 2026)
  // discovery: newest rollout since spawn whose meta.cwd matches
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const day = join(codexHome, 'sessions', '2026', '09', '11')
  mkdirSync(day, { recursive: true })
  const now = new Date()
  writeFileSync(join(day, 'rollout-a.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: 'C:/elsewhere', timestamp: now.toISOString() } }) + '\n')
  writeFileSync(join(day, 'rollout-b.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'mine', cwd: cwd.toUpperCase(), timestamp: now.toISOString(), git: { pad: 'x'.repeat(20000) } } }) + '\n') // a real session_meta line runs past 15 KB
  const found = codexTap.findRollout({ codexHome, cwd, sinceMs: now.getTime() - 1000 })
  assert.equal(found.meta.id, 'mine')
  const tail = codexTap.createTail(found.path)
  assert.equal(tail.read().length, 1)
  assert.equal(tail.read().length, 0)
  writeFileSync(found.path, lines.find((l) => l.includes('task_started')) + '\n', { flag: 'a' })
  assert.equal(codexTap.parseLines(tail.read()).taskStarted, 1)
})

test('agy tap: log signals and history prompts', () => {
  assert.equal(agyTap.scanLog('I0910 ok\nrpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED quota\n').signal, 'agy-resource-exhausted')
  const r = agyTap.scanLog('quota is out, it resets in 2h for this model')
  assert.equal(r.signal, 'agy-resets-in'); assert.ok(r.resets_at > Date.now() / 1000 + 7000)
  assert.equal(agyTap.scanLog('doRefreshQuota: starting reload'), null)
  const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
  writeFileSync(join(home, 'history.jsonl'), [
    JSON.stringify({ display: 'old', timestamp: 1, workspace: cwd, conversationId: 'c0' }),
    JSON.stringify({ display: 'fix the bug', timestamp: Date.now(), workspace: cwd.replace(/\\/g, '/'), conversationId: 'c1' }),
  ].join('\n'))
  const p = agyTap.promptsSince({ agyHome: home, cwd, sinceMs: Date.now() - 5000 })
  assert.equal(p.length, 1); assert.equal(p[0].conversationId, 'c1')
})

test('accounts: default only, extra account dir with junctions and login line', () => {
  assert.deepEqual(accounts.readAccounts(), { claude: ['default'], codex: ['default'], agy: ['default'] })
  assert.deepEqual(accounts.envFor('claude', 'default'), {})
  const fakeHome = mkdtempSync(join(tmpdir(), 'claude-home-'))
  mkdirSync(join(fakeHome, 'hooks')); writeFileSync(join(fakeHome, 'hooks', 'h.cjs'), '1'); writeFileSync(join(fakeHome, 'settings.json'), '{"a":1}')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = fakeHome
  try {
    const r = accounts.addAccount('claude', 'work')
    assert.deepEqual(r.shared, ['hooks'])
    assert.equal(readFileSync(join(r.dir, 'hooks', 'h.cjs'), 'utf8'), '1', 'junction resolves')
    assert.equal(readFileSync(join(r.dir, 'settings.json'), 'utf8'), '{"a":1}')
    assert.match(r.login, /CLAUDE_CONFIG_DIR/)
    assert.deepEqual(accounts.readAccounts().claude, ['default', 'work'])
    assert.equal(accounts.envFor('claude', 'work').CLAUDE_CONFIG_DIR, r.dir)
    assert.throws(() => accounts.addAccount('agy', 'two'), /no config-dir override/)
    assert.throws(() => accounts.addAccount('claude', 'default'), /invalid account name/)
    accounts.removeAccount('claude', 'work')
    assert.deepEqual(accounts.readAccounts().claude, ['default'])
    assert.equal(readFileSync(join(fakeHome, 'hooks', 'h.cjs'), 'utf8'), '1', 'real home untouched by removal')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev
  }
})
