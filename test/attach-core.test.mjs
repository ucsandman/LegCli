// Pure pieces behind `leg claude|codex|agy`: session store + overlap, usage
// state + the handoff chooser, the three taps, and the claude hook handler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo, git as gitIn } from './helpers.mjs'

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-attach-'))

const sessions = await import('../src/sessions.mjs')
const usage = await import('../src/usage.mjs')
const claudeTap = await import('../src/taps/claude.mjs')
const codexTap = await import('../src/taps/codex.mjs')
const agyTap = await import('../src/taps/agy.mjs')
const accounts = await import('../src/accounts.mjs')
const { isCurrentLeg, TERMINAL_RESET, spawnSpec, modelFromArgs, terminalTitle, osc2, aheadCount, takeFlagValue, resolveCardId } = await import('../src/attach.mjs')

const cwd = mkdtempSync(join(tmpdir(), 'baton-cwd-'))
// codex names its day directory from local time, so the fixtures do too
const dayParts = (d) => [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')]

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
  assert.deepEqual(usage.candidates({ agent: 'codex', account: 'default', accounts: acc }).map((c) => `${c.agent}/${c.account}`), ['claude/default', 'claude/work', 'agy/default'])
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

test('codex quota: window duration identifies weekly-only primary data', () => {
  const r = codexTap.parseLines([JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-09-14T18:00:00.000Z',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 25, window_minutes: 10080, resets_at: 2_000_000_000 }, secondary: null } },
  })])
  assert.equal(r.limits.five_hour, null)
  assert.equal(r.limits.seven_day.pct, 25)
  assert.equal(r.limits_at, '2026-09-14T18:00:00.000Z')
})

test('codex quota: only explicit current availability clears a wall and stale limit replay is rejected', () => {
  const nowS = Math.floor(Date.now() / 1000)
  const oldAt = new Date(Date.now() - 60000).toISOString()
  const currentAt = new Date().toISOString()
  usage.markLimited('codex', 'quota-current', { resets_at: nowS + 172800, reason: 'usage_limit_exceeded', observed_at: oldAt })
  const unknown = usage.recordUsage('codex', 'quota-current', { five_hour: null, seven_day: { pct: 25, resets_at: nowS + 172800, window_minutes: 10080 } }, 'rollout', { observed_at: currentAt })
  assert.ok(unknown.limited_until > nowS)
  const current = usage.recordUsage('codex', 'quota-current', { five_hour: null, seven_day: { pct: 25, resets_at: nowS + 172800, window_minutes: 10080 } }, 'app-server', { observed_at: currentAt, available: true })
  assert.equal(current.limited_until, null)
  const replay = usage.markLimited('codex', 'quota-current', { resets_at: nowS + 172800, reason: 'usage_limit_exceeded', observed_at: oldAt })
  assert.equal(replay.wall_applied, false)
  assert.equal(replay.limited_until, null)
  const blocked = usage.recordUsage('codex', 'quota-blocked', { five_hour: null, seven_day: null }, 'app-server', { observed_at: currentAt, available: false })
  assert.ok(blocked.limited_until > nowS)
})

test('codex quota: a completed leg rejects a delayed probe result for its replacement', () => {
  assert.equal(isCurrentLeg({ pid: 11, agent: 'codex', account: 'default' }, { pid: 11, agent: 'codex', account: 'default' }), true)
  assert.equal(isCurrentLeg({ pid: 12, agent: 'claude', account: 'default' }, { pid: 11, agent: 'codex', account: 'default' }), false)
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
  // ts carries each turn's own time for the card drawer; these fixture lines have none
  assert.deepEqual(claudeTap.transcriptTail(t), [{ role: 'user', text: 'real prompt', ts: null }, { role: 'assistant', text: 'answer', ts: null }])
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
  const now = new Date()
  const day = join(codexHome, 'sessions', ...dayParts(now))
  mkdirSync(day, { recursive: true })
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

test('codex tap: a session started in the local evening is found, though codex names the day directory in local time and stamps the rollout in UTC', () => {
  // observed live 2026-09-10: sessions/2026/09/10/rollout-2026-09-10T20-33-44-…
  // carries session_meta timestamp 2026-09-11T00:33:44.035Z. Pinned to a zone
  // behind UTC in a child process, so the check does not depend on this
  // machine's own clock offset.
  const zone = 'America/New_York'
  const stamp = '2026-09-11T00:33:44.035Z'
  const sinceMs = Date.parse(stamp)
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-evening-'))
  const day = join(codexHome, 'sessions', ...new Date(sinceMs).toLocaleDateString('en-CA', { timeZone: zone }).split('-'))
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-evening.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'evening', cwd, timestamp: stamp } }) + '\n')
  const probe = join(codexHome, 'probe.mjs')
  writeFileSync(probe, `const { findRollout } = await import(${JSON.stringify(new URL('../src/taps/codex.mjs', import.meta.url).href)})\n`
    + 'const r = findRollout({ codexHome: process.env.PROBE_HOME, cwd: process.env.PROBE_CWD, sinceMs: Number(process.env.PROBE_SINCE) })\n'
    + "process.stdout.write(r ? r.meta.id : 'null')\n")
  const out = execFileSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, TZ: zone, PROBE_HOME: codexHome, PROBE_CWD: cwd, PROBE_SINCE: String(sinceMs) } })
  assert.equal(out, 'evening', `the rollout under ${day.split(/[\\/]/).slice(-3).join('/')} is found in ${zone}`)
})

test('bundle: the resume prompt names the absolute RESUME file, not a path relative to a cwd the next agent may not share', async () => {
  const { resumePrompt } = await import('../src/bundle.mjs')
  // started in a subdirectory (`cd repo/src && baton claude`): the bundle and
  // the notes go to the repo root, the next agent is spawned in the subdirectory
  const repo = mkdtempSync(join(tmpdir(), 'leg-resume-'))
  mkdirSync(join(repo, '.leg'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  const notes = join(repo, '.leg', 'session-s-resume.md')
  writeFileSync(notes, '## Scope\n\nTask: keep going\n')
  const session = { session_id: 's-resume', agent: 'claude', account: 'default', cwd: join(repo, 'src'), repo, task: 'keep going' }
  const prompt = resumePrompt(session, { id: 'b-1', path: join(repo, '.context-handoffs', 'b-1'), notes }, { agent: 'codex', account: 'default' })
  const perSession = join(repo, '.leg', 'RESUME-s-resume.md')
  assert.equal(existsSync(perSession), true, 'the per-session resume file is written at the work root')
  assert.ok(prompt.includes(perSession), `the prompt points at ${perSession}; got: ${prompt.slice(0, 220)}`)
})

test('bundle: resumePrompt and sessionNotes alert next agent when commits were made and working tree is clean', async () => {
  const { resumePrompt, sessionNotes, sessionCommitDelta } = await import('../src/bundle.mjs')
  const repo = mkdtempSync(join(tmpdir(), 'leg-clean-commits-'))
  const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@example.com']); g(['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'README.md'), '# test\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'init'])
  const headAtStart = g(['rev-parse', 'HEAD']).trim()

  // No commits yet, clean tree:
  const session = { session_id: 's-clean-1', agent: 'agy', account: 'default', cwd: repo, repo, head_at_start: headAtStart, task: 'fix trust' }
  let delta = sessionCommitDelta(repo, session)
  assert.equal(delta.isClean, true)
  assert.equal(delta.newCommits.length, 0)

  // Agent makes a commit and leaves tree clean:
  writeFileSync(join(repo, 'feature.txt'), 'hello feature\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'add feature x'])
  delta = sessionCommitDelta(repo, session)
  assert.equal(delta.isClean, true)
  assert.equal(delta.newCommits.length, 1)
  assert.match(delta.newCommits[0], /add feature x/)

  mkdirSync(join(repo, '.leg'), { recursive: true })
  const notesFile = join(repo, '.leg', 'session-s-clean-1.md')
  writeFileSync(notesFile, '## Scope\n\nTask: fix trust\n')
  const notes = sessionNotes(session)
  assert.match(notes, /The previous agent committed changes \(1 commit\(s\)/)
  assert.match(notes, /verify whether the task is already satisfied before doing redundant work/)

  const prompt = resumePrompt(session, { id: 'b-clean', path: join(repo, '.context-handoffs', 'b-clean'), notes: notesFile }, { agent: 'claude', account: 'default' })
  assert.match(prompt, /The previous agent committed changes \(1 commit\(s\)/)
  assert.match(prompt, /verify whether the task is already complete before doing redundant work/)

  // If working tree is dirty, it falls back to normal check git status / git diff:
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted')
  const dirtyPrompt = resumePrompt(session, { id: 'b-clean', path: join(repo, '.context-handoffs', 'b-clean'), notes: notesFile }, { agent: 'claude', account: 'default' })
  assert.match(dirtyPrompt, /check git status and git diff, then continue the work from where it stopped/)
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
  assert.deepEqual(accounts.readAccounts(), { claude: ['default'], codex: ['default'], agy: ['default'], grok: ['default'] })
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
    assert.deepEqual(accounts.readAccounts().grok, ['default'])
    assert.equal(readFileSync(join(fakeHome, 'hooks', 'h.cjs'), 'utf8'), '1', 'real home untouched by removal')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev
  }
})

test('accounts: grok stays a default login when accounts.json never mentions it', () => {
  const file = accounts.accountsFile()
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null
  writeFileSync(file, JSON.stringify({ claude: ['work'] }))
  try {
    assert.deepEqual(accounts.readAccounts(), {
      claude: ['default', 'work'],
      codex: ['default'],
      agy: ['default'],
      grok: ['default'],
    })
  } finally {
    if (prev === null) { try { unlinkSync(file) } catch {} }
    else writeFileSync(file, prev)
  }
})

test('sessions: a session in its own worktree keeps paths relative to that worktree, and overlaps say separate', () => {
  const wt = join(cwd, '.baton-worktrees', 's-w-claude')
  mkdirSync(wt, { recursive: true })
  sessions.createSession({ id: 's-w-claude', agent: 'claude', cwd: wt, repo: cwd, branch: 'baton/s-w-claude', worktree: { path: wt, branch: 'baton/s-w-claude', base: 'main' } })
  sessions.updateSession('s-w-claude', { status: 'running' })
  assert.equal(sessions.workRoot(sessions.readSession('s-w-claude')), wt)
  claudeTap.handleHook('s-w-claude', { hook_event_name: 'PostToolUse', tool_input: { file_path: join(wt, 'README.md') } })
  assert.deepEqual(sessions.readSession('s-w-claude').files_touched, ['README.md'])
  sessions.createSession({ id: 's-w-codex', agent: 'codex', cwd, repo: cwd, branch: 'main' })
  sessions.updateSession('s-w-codex', { status: 'running', files_dirty: ['README.md'] })
  const ov = sessions.overlaps(sessions.listSessions())
  assert.equal(ov.get('s-w-claude').find((o) => o.session_id === 's-w-codex').separate, true)
  assert.equal(sessions.workRoot(sessions.readSession('s-w-codex')), cwd)
  for (const id of ['s-w-claude', 's-w-codex']) sessions.updateSession(id, { status: 'ended' })
})

test('git dirty list: a porcelain line that starts with a space keeps its first letter, and tool directories are left out (attach gitInfo, bundle notes)', async () => {
  const { gitInfo } = await import('../src/attach.mjs')
  const { sessionNotes } = await import('../src/bundle.mjs')
  const repo = mkdtempSync(join(tmpdir(), 'baton-porcelain-'))
  const g = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@example.com']); g(['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'README.md'), '# x\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'README.md'), '# x\nchanged\n')
  mkdirSync(join(repo, '.dashclaw-local')); writeFileSync(join(repo, '.dashclaw-local', 'state.json'), '{}')
  // observed live 2026-09-11: " M README.md" trimmed to "M README.md" showed as EADME.md on the card
  assert.deepEqual(gitInfo(repo).dirty, ['README.md'])
  const notes = sessionNotes({ session_id: 's-porcelain', agent: 'claude', cwd: repo, repo, task: 't' })
  assert.match(notes, /Dirty file: README\.md/)
  assert.doesNotMatch(notes, /Dirty file: EADME/)
})

test('claude usage endpoint: 404, a body that is not JSON, and a shape with no window all read as usage unknown; the wall still comes from the hook', async () => {
  const { fetchClaudeUsage } = await import('../src/taps/claude-usage.mjs')
  const http = await import('node:http')
  const configDir = mkdtempSync(join(tmpdir(), 'claude-cfg-'))
  const routes = {
    '/404': [404, 'nope'],
    '/garbage': [200, '<html>not json</html>'],
    '/changed': [200, JSON.stringify({ windows: { five_hour: { pct: 10 } } })],
    '/good': [200, JSON.stringify({ five_hour: { utilization: 12.5, resets_at: '2026-09-11T12:00:00Z' }, seven_day: { utilization: 40 } })],
  }
  const server = http.createServer((req, res) => { const [code, body] = routes[req.url] ?? [200, '{}']; res.writeHead(code); res.end(body) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    // no login at all
    const noLogin = await fetchClaudeUsage({ configDir, url: `${base}/good` })
    assert.equal(noLogin.ok, false)
    assert.match(noLogin.error, /no claude\.ai login found/)
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 600000 } }))
    const notFound = await fetchClaudeUsage({ configDir, url: `${base}/404` })
    assert.equal(notFound.ok, false)
    assert.equal(notFound.status, 404)
    assert.match(notFound.error, /usage endpoint 404/)
    const garbage = await fetchClaudeUsage({ configDir, url: `${base}/garbage` })
    assert.equal(garbage.ok, false)
    assert.match(garbage.error, /no JSON/)
    const changed = await fetchClaudeUsage({ configDir, url: `${base}/changed` })
    assert.equal(changed.ok, true, 'the endpoint answered')
    assert.equal(changed.limits.five_hour, null, 'but nothing in it is a window Leg knows')
    assert.equal(changed.limits.seven_day, null)
    const good = await fetchClaudeUsage({ configDir, url: `${base}/good` })
    assert.equal(good.limits.five_hour.pct, 12.5)
    assert.equal(typeof good.limits.five_hour.resets_at, 'number')
  } finally { server.close() }
  // with no usage numbers at all, the hook still walls the account and the session
  const s = sessions.createSession({ id: 's-nousage-claude', agent: 'claude', cwd, repo: cwd })
  claudeTap.handleHook(s.session_id, { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' })
  const after = sessions.readSession(s.session_id)
  assert.equal(after.status, 'limit')
  assert.equal(after.limits, null, 'no percentages were ever recorded')
  assert.equal(after.limit.reason, 'rate_limit')
  sessions.updateSession(s.session_id, { status: 'ended' })
})

// Which terminal is this, and where is it working: `-n` for claude (the flag is
// in fixtures/help/claude.txt line 132, general Options, and two of its three
// surfaces are interactive-only), OSC 2 for the three CLIs with no title flag.
test('the claude argv carries -n leg#<id> <repo>/<branch>, and a name the human passed is kept', async () => {
  const s = sessions.createSession({ id: 's-title-claude', agent: 'claude', cwd, repo: join(cwd, 'leg'), branch: 'main' })
  assert.equal(terminalTitle(s), 'leg#claude leg/main')
  const spec = await spawnSpec('claude', { account: 'default', args: [], sessionId: 's-title-claude', autoApprove: false })
  const at = spec.args.indexOf('-n')
  assert.ok(at !== -1, `the claude argv carries -n: ${spec.args.join(' ')}`)
  assert.equal(spec.args[at + 1], 'leg#claude leg/main')

  const mine = await spawnSpec('claude', { account: 'default', args: ['--name', 'my own window'], sessionId: 's-title-claude', autoApprove: false })
  assert.equal(mine.args.filter((a) => a === '-n' || a === '--name').length, 1, 'a name the human passed is never doubled')
  assert.equal(mine.args.includes('leg#claude leg/main'), false)

  // the other three have no such flag, so Leg writes the title itself
  assert.equal(osc2('leg#7f3a leg/main'), '\x1b]2;leg#7f3a leg/main\x07')
  assert.equal(osc2('a\x1b]0;evil\x07b'), '\x1b]2;a ]0;evil b\x07', 'nothing in the title can open a second sequence')
  const codex = await spawnSpec('codex', { account: 'default', args: [], sessionId: 's-title-claude', autoApprove: false })
  assert.equal(codex.args.includes('-n'), false, 'codex has no name flag and must not be handed one')
  sessions.updateSession('s-title-claude', { status: 'ended' })
})

test('session.model is the model the human asked for, or null; the transcript corrects it', () => {
  assert.equal(modelFromArgs('claude', ['--model', 'opus']), 'opus')
  assert.equal(modelFromArgs('claude', ['--model=claude-fable-5-1']), 'fable', 'a full id is said as its alias')
  assert.equal(modelFromArgs('codex', ['-m', 'gpt-5.6-sol']), 'gpt-5.6-sol', 'codex has no alias list, so the id is kept raw')
  assert.equal(modelFromArgs('claude', []), null, 'no flag means no model, never a guessed default')
  assert.equal(modelFromArgs('claude', ['--model']), null, 'a dangling flag is not a model')
  assert.equal(modelFromArgs('claude', ['--model', '--resume']), null)

  const s = sessions.createSession({ id: 's-model-claude', agent: 'claude', cwd, repo: cwd, model: modelFromArgs('claude', ['--model', 'fable']) })
  assert.equal(s.model, 'fable')
  assert.equal(sessions.createSession({ id: 's-model-bare', agent: 'codex', cwd, repo: cwd }).model, null, 'old records and bare launches carry null')
  // the silent fallback: argv said fable, the transcript says haiku
  const jsonl = join(cwd, 'model-refresh.jsonl')
  writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5' } }) + '\n')
  assert.equal(claudeTap.modelFromTranscript(jsonl), 'haiku', 'the newest assistant line wins')
  for (const id of ['s-model-claude', 's-model-bare']) sessions.updateSession(id, { status: 'ended' })
})

test('the terminal reset undoes what a killed agent left behind: mouse reporting, paste, keys, margins', () => {
  // the wheel printed `[<65;40;24M` into the shell after End because the agent
  // was killed with mouse tracking on: every mode it can set has to go off
  for (const mode of [1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004]) {
    assert.ok(TERMINAL_RESET.includes(`\x1b[?${mode}l`), `mode ${mode} is turned off`)
  }
  assert.ok(TERMINAL_RESET.startsWith('\x1b[?1049l'), 'the alternate screen is left first')
  // a leftover scrolling region made the next leg overwrite the lines on screen;
  // DECSTBM homes the cursor, so the reset sits between DECSC and DECRC
  assert.ok(TERMINAL_RESET.includes('\x1b7\x1b[r\x1b8'), 'margins are reset without moving the cursor')
  assert.ok(TERMINAL_RESET.includes('\x1b[?1l\x1b>'), 'cursor keys and keypad are back to normal')
  assert.ok(TERMINAL_RESET.includes('\x1b[?7h'), 'autowrap is back on')
  assert.ok(TERMINAL_RESET.endsWith('\x1b[?25h\x1b[0m\r\x1b[J\n'), 'ends visible, unstyled, on a clean line')
})

// ---- the register's commit count (redesign A.4 row 8) ----------------------
test('ahead counts commits past the recorded start, and says nothing rather than zero when it cannot', () => {
  const repo = initRepo('leg-ahead-')
  const startedAt = gitIn(repo, ['rev-parse', 'HEAD']).trim()

  // nothing since the session began
  assert.equal(aheadCount(repo, startedAt), 0)
  writeFileSync(join(repo, 'b.txt'), 'two\n')
  gitIn(repo, ['add', 'b.txt'])
  gitIn(repo, ['commit', '-q', '-m', 'second'])
  writeFileSync(join(repo, 'c.txt'), 'three\n')
  gitIn(repo, ['add', 'c.txt'])
  gitIn(repo, ['commit', '-q', '-m', 'third'])
  assert.equal(aheadCount(repo, startedAt), 2)

  // no upstream and no recorded start: there is no base to count from, so the
  // answer is "unknown", never a zero standing in for it
  assert.equal(aheadCount(repo, null), null)
  // not a repository at all
  assert.equal(aheadCount(mkdtempSync(join(tmpdir(), 'leg-norepo-')), startedAt), null)
  // a base that is not a commit: git refuses, and so does this
  assert.equal(aheadCount(repo, 'no-such-ref'), null)
  // the session record starts with no count rather than a zero
  assert.equal(sessions.createSession({ id: 's-ahead-new', agent: 'claude', cwd: repo, repo }).ahead, null)
})

// ---- taking over a card (redesign C.4) -------------------------------------
test('--resume-card is lifted out of the argv before the agent ever sees it, in both spellings', () => {
  assert.deepEqual(takeFlagValue(['--resume-card', 'card-1', '--model', 'opus'], '--resume-card'), { args: ['--model', 'opus'], value: 'card-1' })
  assert.deepEqual(takeFlagValue(['--resume-card=card-2'], '--resume-card'), { args: [], value: 'card-2' })
  assert.deepEqual(takeFlagValue(['--model', 'opus'], '--resume-card'), { args: ['--model', 'opus'], value: null })
  // a flag with nothing after it keeps the next flag: it is not swallowed
  assert.deepEqual(takeFlagValue(['--resume-card', '--model'], '--resume-card'), { args: ['--model'], value: null })
})

test('a card id resolves in full or by its tail, and an ambiguous one is an error rather than a pick', () => {
  const cards = [{ card_id: 'card-20260917-1100-add-the-export' }, { card_id: 'card-20260917-1200-add-the-import' }]
  assert.equal(resolveCardId('card-20260917-1100-add-the-export', cards).id, 'card-20260917-1100-add-the-export')
  assert.equal(resolveCardId('add-the-export', cards).id, 'card-20260917-1100-add-the-export')
  const both = resolveCardId('add-the', cards)
  assert.equal(both.id, null)
  assert.equal(both.matches.length, 2)
  assert.deepEqual(resolveCardId('nothing-like-this', cards), { id: null, matches: [] })
  assert.deepEqual(resolveCardId('', cards), { id: null, matches: [] })
})
