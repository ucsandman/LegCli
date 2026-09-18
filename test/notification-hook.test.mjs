// The Notification hook: a terminal parked at a permission prompt is waiting on
// a human, and the board could not see that before. Covers the four types Leg
// acts on, the two events that clear the wait, the reducer hazard the status
// line handler documents (a Notification write must never erase a limit a
// concurrent StopFailure set), the OSC 9 toast, and the hand-off stand-down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'leg-notify-'))
process.env.BATON_HOME = HOME
process.env.LEG_HOME = HOME

const sessions = await import('../src/sessions.mjs')
const claudeTap = await import('../src/taps/claude.mjs')
const { handoffStoodDown } = await import('../src/attach.mjs')
const { writePreferences, readPreferences } = await import('../src/preferences.mjs')
const HOOK = resolve('src', 'hook.mjs')

const cwd = mkdtempSync(join(tmpdir(), 'leg-notify-cwd-'))
const mk = (id) => sessions.createSession({ id, agent: 'claude', cwd, repo: cwd, branch: 'main' })
const notify = (id, notification_type, message) => claudeTap.handleHook(id, { hook_event_name: 'Notification', notification_type, message, session_id: 'cs-notify' })

test('settingsFor writes a Notification hook for the four types Leg acts on', () => {
  const s = claudeTap.settingsFor('s-n-settings')
  const entry = s.hooks.Notification[0]
  assert.equal(entry.matcher, 'permission_prompt|idle_prompt|agent_needs_input|quota_auto_resume_fired')
  assert.ok(entry.hooks[0].command.includes('claude-hook --session s-n-settings'))
})

test('a permission_prompt payload sets waiting; Stop and UserPromptSubmit clear it', () => {
  const id = 's-n-permission'
  mk(id)
  assert.equal(sessions.readSession(id).waiting, null, 'a new session waits on nobody')
  assert.equal(notify(id, 'permission_prompt', 'Claude needs your permission to use Bash(git push origin HEAD)'), 'notify permission_prompt')
  const w = sessions.readSession(id).waiting
  assert.equal(w.type, 'permission_prompt')
  assert.equal(w.message, 'Claude needs your permission to use Bash(git push origin HEAD)', 'the question verbatim')
  assert.ok(Date.parse(w.since) > 0, 'since is a timestamp')
  assert.ok(sessions.readEvents(id).some((e) => e.type === 'waiting'), 'the wait is on the timeline')

  claudeTap.handleHook(id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
  assert.equal(sessions.readSession(id).waiting, null, 'Stop clears the wait')

  notify(id, 'idle_prompt', 'Claude is waiting for your input')
  assert.equal(sessions.readSession(id).waiting.type, 'idle_prompt')
  claudeTap.handleHook(id, { hook_event_name: 'UserPromptSubmit', prompt: 'carry on' })
  assert.equal(sessions.readSession(id).waiting, null, 'the human typed, so nothing is being waited on')
})

test('a long question is cut at 160 characters, and agent_needs_input counts as a wait', () => {
  const id = 's-n-long'
  mk(id)
  notify(id, 'agent_needs_input', 'x'.repeat(400))
  const w = sessions.readSession(id).waiting
  assert.equal(w.type, 'agent_needs_input')
  assert.equal(w.message.length, 160)
})

test('a type Leg does not act on never writes a wait', () => {
  const id = 's-n-other'
  mk(id)
  assert.equal(notify(id, 'auth_success', 'signed in'), 'notify auth_success')
  assert.equal(sessions.readSession(id).waiting, null)
})

// The hazard: both hooks are their own process and both write session.json.
// The Notification handler reads `cur` inside the same cross-process lock the
// StopFailure handler uses and touches only `waiting`, so the wall survives.
test('a Notification racing a StopFailure rate_limit leaves the limit intact', () => {
  const id = 's-n-race'
  mk(id)
  claudeTap.handleHook(id, { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've reached your Fable limit." })
  const walled = sessions.readSession(id)
  assert.equal(walled.status, 'limit')
  assert.equal(walled.limit.model, 'fable')
  const limitedUntil = walled.limit.resets_at

  notify(id, 'permission_prompt', 'Claude needs your permission to use Bash(ls)')
  const after = sessions.readSession(id)
  assert.equal(after.status, 'limit', 'the Notification did not put the terminal back to running')
  assert.equal(after.limit.reason, 'rate_limit', 'the limit object survived')
  assert.equal(after.limit.model, 'fable')
  assert.equal(after.limit.resets_at, limitedUntil, 'the reset time survived')
  assert.equal(after.waiting.type, 'permission_prompt', 'and the wait was still recorded')
})

test('quota_auto_resume_fired stands the hand-off down for that terminal', () => {
  const id = 's-n-quota'
  mk(id)
  assert.equal(handoffStoodDown(sessions.readSession(id)), null, 'nothing to stand down for')
  assert.equal(handoffStoodDown({ waiting: { type: 'permission_prompt', message: 'hi' } }), null, 'an ordinary wait is not a stand-down')
  assert.equal(handoffStoodDown({ waiting: { type: 'reset', agent: 'codex', resets_at: 1 } }), null, 'the all-out countdown is not a stand-down')

  notify(id, 'quota_auto_resume_fired', 'Claude Code will resume when the limit resets')
  const w = sessions.readSession(id).waiting
  assert.equal(w.type, 'quota_auto_resume')
  assert.equal(w.message, claudeTap.QUOTA_STAND_DOWN)
  assert.equal(handoffStoodDown(sessions.readSession(id)), claudeTap.QUOTA_STAND_DOWN)
})

test('the all-out countdown on `waiting` is never overwritten by a Notification', () => {
  const id = 's-n-reset'
  mk(id)
  sessions.updateSession(id, { status: 'waiting', waiting: { type: 'reset', agent: 'codex', account: 'default', resets_at: 1_900_000_000, since: new Date().toISOString() } })
  notify(id, 'permission_prompt', 'Claude needs your permission to use Bash(ls)')
  const w = sessions.readSession(id).waiting
  assert.equal(w.type, 'reset', 'the countdown the runner owns is still there')
  assert.equal(w.resets_at, 1_900_000_000)
})

test('terminalSequenceFor: OSC 9 for the three waiting types, gated on notify_terminal', () => {
  const prefs = readPreferences()
  assert.equal(prefs.notify_terminal, true, 'the terminal toast is on by default')
  assert.equal(prefs.notify_board, false, 'the board toast is off by default')

  const seq = claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'permission to run Bash(git push)' }, { preferences: prefs })
  assert.equal(seq, '\x1b]9;permission to run Bash(git push)\x07')
  for (const t of ['idle_prompt', 'agent_needs_input']) {
    assert.ok(claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: t, message: 'hi' }, { preferences: prefs }).startsWith('\x1b]9;'))
  }
  assert.equal(claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'quota_auto_resume_fired', message: 'hi' }, { preferences: prefs }), null, 'nobody is being waited on')
  assert.equal(claudeTap.terminalSequenceFor({ hook_event_name: 'Stop' }, { preferences: prefs }), null)
  assert.equal(claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'hi' }, { preferences: { notify_terminal: false } }), null, 'the toggle is off')
  // the field is ignored wholesale if anything outside the OSC allowlist rides
  // in it (hooks doc 608), so control bytes in the message are dropped
  const dirty = claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'a\x07b\x1b]0;evil\x07' }, { preferences: prefs })
  assert.equal(dirty.slice(4, -1).includes('\x1b'), false)
  assert.equal(dirty.slice(4, -1).includes('\x07'), false)
  // the C1 controls do the same job as ESC and BEL on a terminal that decodes
  // them from UTF-8: U+009C (ST) closes the sequence Leg is building and U+009D
  // (OSC) opens whatever follows it
  const c1 = claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'hiP;e;s;whoami tail' }, { preferences: prefs })
  const payload = c1.slice(4, -1)
  for (const cp of [...payload].map((c) => c.codePointAt(0))) {
    assert.equal(cp >= 0x80 && cp <= 0x9f, false, `a C1 control (U+${cp.toString(16)}) rode into the OSC 9 payload`)
    assert.equal(cp < 0x20 || cp === 0x7f, false, 'a C0 control rode into the OSC 9 payload')
  }
  assert.equal(payload, 'hi  P;e;s;whoami  tail'.trim(), 'each control byte becomes a space, so the text is still readable')
  // and the payload is capped, whatever the agent quoted into the message
  const long = claudeTap.terminalSequenceFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x'.repeat(4000) }, { preferences: prefs })
  assert.equal(long.slice(4, -1).length, 160, 'the OSC 9 payload is capped at 160 characters')
})

test('preferences: notify_terminal and notify_board persist', () => {
  assert.equal(writePreferences({ notify_terminal: false, notify_board: true }).notify_terminal, false)
  const back = readPreferences()
  assert.equal(back.notify_terminal, false)
  assert.equal(back.notify_board, true)
  writePreferences({ notify_terminal: true, notify_board: false })
})

test('hook.mjs end to end: the Notification payload writes the wait and prints the toast', () => {
  const id = 's-n-e2e'
  mk(id)
  const payload = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash(rm -rf build)', session_id: 'cs-e2e', transcript_path: join(cwd, 't.jsonl') }
  const out = execFileSync(process.execPath, [HOOK, 'claude-hook', '--session', id], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, BATON_HOME: HOME, LEG_HOME: HOME } })
  assert.deepEqual(JSON.parse(out.trim()), { terminalSequence: '\x1b]9;Claude needs your permission to use Bash(rm -rf build)\x07' })
  assert.equal(sessions.readSession(id).waiting.type, 'permission_prompt')
  assert.ok(readFileSync(join(sessions.sessionDir(id), 'hook.log'), 'utf8').includes('Notification notify permission_prompt'))
})

test('modelFromTranscript maps a transcript model id to its alias', () => {
  const f = join(cwd, 'transcript.jsonl')
  writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'ok' }] } }),
    '',
  ].join('\n'))
  assert.equal(claudeTap.modelFromTranscript(f), 'fable')
  writeFileSync(f, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5' } }) + '\n{"type":"assistant","message":{"mod')
  assert.equal(claudeTap.modelFromTranscript(f), 'haiku', 'a torn last line is dropped, not fatal')
  assert.equal(claudeTap.modelFromTranscript(join(cwd, 'nope.jsonl')), null)
  assert.equal(claudeTap.modelAlias('claude', 'some-private-preview-9'), 'some-private-preview-9', 'an id with no alias is kept raw')
  assert.equal(claudeTap.modelAlias('claude', ''), null)
})
