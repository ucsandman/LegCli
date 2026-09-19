// claude tap — how `leg claude` sees inside a normal interactive Claude Code.
// Nothing in ~/.claude is edited: the session gets one extra settings file via
// `--settings` (hooks merge with the user's; statusLine is the only key that
// replaces, so Leg's status-line hook runs the user's own command with the
// same stdin and prints its rows above Leg's one line).
// Sources: code.claude.com/docs/en/hooks (StopFailure `error: rate_limit`),
// docs/en/statusline (rate_limits.five_hour/seven_day used_percentage,
// resets_at), docs/en/settings (`--settings` sits above user settings).
import { existsSync, readFileSync, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionDir, updateSession, appendEvent, readSession, workRoot } from '../sessions.mjs'
import { recordUsage, markLimited, WARN_PCT } from '../usage.mjs'
import { bucketFromWall, MODEL_ALIASES } from '../buckets.mjs'
import { writeJsonAtomic } from '../fsx.mjs'
import { readPreferences } from '../preferences.mjs'
import { LAYOUT } from '../accounts.mjs'

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs')
const q = (p) => `"${String(p).replace(/\\/g, '\\\\')}"`

// The user's own statusLine command, if any, so it keeps running.
export function userStatusLine(configDir = LAYOUT.claude.home()) {
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = join(configDir, f)
    if (!existsSync(p)) continue
    try {
      const s = JSON.parse(readFileSync(p, 'utf8'))
      if (s.statusLine?.type === 'command' && s.statusLine.command) return s.statusLine
    } catch {}
  }
  return null
}

// The four Notification types Leg acts on, as one matcher. Notification
// "matches on notification type" and, not being FileChanged or StopFailure,
// takes `|` as the alternation separator (hooks doc lines 173, 165, 1424).
// The other eight types (auth_success, the elicitation family, agent_completed,
// quota_auto_resume_stale, quota_auto_resume_disabled) say nothing about a
// human being waited on, so they never start a hook process.
export const WAITING_TYPES = ['permission_prompt', 'idle_prompt', 'agent_needs_input']
export const NOTIFY_MATCHER = [...WAITING_TYPES, 'quota_auto_resume_fired'].join('|')
// Claude Code waiting at the limit by itself. Leg sets autoContinueAtUsageLimit
// false, but the human's own settings can re-enable it; two waiters on one
// terminal is the failure to avoid, so Leg stands down and the row says so.
export const QUOTA_STAND_DOWN = 'Claude Code is waiting at the limit itself; Leg is not handing this one off.'

export function settingsFor(sessionId, { statusLine = null } = {}) {
  const cmd = (kind) => ({ type: 'command', command: `node ${q(HOOK)} ${kind} --session ${sessionId}`, timeout: 20 })
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [cmd('claude-hook')] }],
      UserPromptSubmit: [{ hooks: [cmd('claude-hook')] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [cmd('claude-hook')] }],
      Notification: [{ matcher: NOTIFY_MATCHER, hooks: [cmd('claude-hook')] }],
      Stop: [{ hooks: [cmd('claude-hook')] }],
      StopFailure: [{ hooks: [cmd('claude-hook')] }],
      SessionEnd: [{ hooks: [cmd('claude-hook')] }],
    },
    statusLine: { type: 'command', command: `node ${q(HOOK)} claude-statusline --session ${sessionId}`, padding: statusLine?.padding ?? 0 },
    // Leg owns the limit: it hands the work to the next option instead of
    // waiting in the session for the reset.
    autoContinueAtUsageLimit: false,
  }
  return settings
}

export function writeSettings(sessionId, opts = {}) {
  const file = join(sessionDir(sessionId), 'claude-settings.json')
  writeJsonAtomic(file, settingsFor(sessionId, opts))
  // the hook process reads this back to run the user's command (see userStatusLineText)
  if (opts.statusLine?.command) updateSession(sessionId, { user_statusline: { command: opts.statusLine.command } })
  return file
}

// The shell Claude Code itself uses for a status-line command: /bin/sh, or on
// Windows Git Bash when installed, else PowerShell (docs/en/statusline,
// "Windows configuration").
function statusLineShell(command) {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] }
  const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (existsSync(bash)) return { file: bash, args: ['-c', command] }
  return { file: 'powershell', args: ['-NoProfile', '-Command', command] }
}

// The user's own status line, rendered: their command gets the same JSON on
// stdin Claude Code handed Leg, and whatever it prints goes above Leg's row.
// Never throws; an absent, slow (3 s) or broken command yields ''.
export function userStatusLineText(session, raw) {
  const command = session?.user_statusline?.command
  if (!command) return ''
  try {
    const { file, args } = statusLineShell(command)
    const r = spawnSync(file, args, { input: raw ?? '', encoding: 'utf8', timeout: 3000, windowsHide: true })
    return String(r.stdout ?? '').replace(/\s+$/, '')
  } catch { return '' }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n')
  return ''
}

// Human/assistant messages from Claude Code transcript lines (jsonl). Shared
// with history discovery, which hands in the tail of a file it never reads whole.
export function messagesFromLines(lines, limit = 8) {
  if (!(limit > 0)) return []
  const out = []
  for (const line of lines) {
    if (!line) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.type !== 'user' && j.type !== 'assistant') continue
    if (j.isSidechain) continue
    const text = textOf(j.message?.content).trim()
    if (!text || /^<[a-z-]+>/.test(text)) continue
    out.push({ role: j.type, text: text.slice(0, 1500), ts: j.timestamp ?? null })
  }
  return out.slice(-limit)
}

// Last human/assistant messages from a Claude Code transcript (jsonl).
export function transcriptTail(path, limit = 8) {
  if (!path || !existsSync(path)) return []
  return messagesFromLines(readFileSync(path, 'utf8').split('\n'), limit)
}

// A model id from a CLI (`claude-fable-5-1`) said as the name the ladder, the
// picker and the row use (`fable`). An id that matches no alias is kept raw:
// printing a model Leg does not recognise is honest, inventing one is not.
export function modelAlias(agent, id) {
  const raw = String(id ?? '').trim()
  if (!raw) return null
  for (const alias of MODEL_ALIASES[agent] ?? []) {
    // whitespace is a separator too: a display name reads "Claude Opus 5" where
    // a CLI id reads "claude-opus-5", and both name the same rung
    if (new RegExp(`(?:^|[-_\\s])${alias}(?:$|[-_.\\s])`, 'i').test(raw)) return alias
  }
  return raw
}

// The model that actually answered, from the transcript's per-assistant-line
// `message.model` (VERIFIED: 29 assistant lines of the newest jsonl for this
// repo carry "claude-fable-5-1"). This is how a silent fallback off Fable
// becomes visible, so it reads the file itself rather than trusting the argv.
//
// Two Windows facts shape the read. The file is appended to while Claude Code
// runs, so a read can land mid-write: it is retried, and a torn last line is
// dropped by the per-line JSON.parse rather than failing the whole read. And
// mtime is not a content clock here, so nothing is skipped on a timestamp — the
// tail is read every time and the answer is whatever the bytes say.
export function modelFromTranscript(path, { agent = 'claude', tailBytes = 262144, attempts = 3 } = {}) {
  if (!path || !existsSync(path)) return null
  for (let i = 0; i < attempts; i++) {
    let fd = null
    try {
      fd = openSync(path, 'r')
      const size = fstatSync(fd).size
      const want = Math.min(size, tailBytes)
      const buf = Buffer.alloc(want)
      readSync(fd, buf, 0, want, size - want)
      const lines = buf.toString('utf8').split('\n')
      // a partial first line when the tail starts mid-file, a partial last line
      // when the writer is mid-append: both are dropped by the parse below
      for (let k = lines.length - 1; k >= 0; k--) {
        let j
        try { j = JSON.parse(lines[k]) } catch { continue }
        if (j?.type !== 'assistant') continue
        const id = j.message?.model
        if (id) return modelAlias(agent, id)
      }
      return null
    } catch {
      // EBUSY / EPERM / a share violation while Claude Code writes: try again
    } finally { if (fd !== null) try { closeSync(fd) } catch {} }
  }
  return null
}

export function firstPrompt(path) {
  const t = transcriptTail(path, 1000).find((m) => m.role === 'user')
  return t ? t.text.slice(0, 500) : null
}

function limitsFrom(rl) {
  if (!rl) return null
  const w = (x) => (x && Number.isFinite(x.used_percentage) ? { pct: x.used_percentage, resets_at: x.resets_at ?? null } : null)
  return { five_hour: w(rl.five_hour), seven_day: w(rl.seven_day) }
}

// The all-out countdown the runner owns (src/attach.mjs) also lives on
// `waiting`. A Notification never overwrites it: while that is set the child is
// already dead and nobody is being waited on in the terminal.
const humanWait = (w) => Boolean(w) && w.type !== 'reset'
const clearHumanWait = (cur) => (humanWait(cur.waiting) ? { waiting: null } : {})

// What the hook prints back to Claude Code. `terminalSequence` is emitted by
// Claude Code itself on events that discard systemMessage and continue, which
// Notification is (hooks doc lines 608, 622, 1490); OSC 9 is the desktop
// notification Windows Terminal renders (line 617). Restricted to the OSC
// 0/1/2/9/99/777 allowlist, so anything in the message that could close or open
// a sequence is dropped rather than risking the whole field being ignored (608).
// Every control byte out, ESC and BEL included: one of them inside the message
// would close the sequence Leg is building and open whatever followed it.
// Written as a scan rather than a regex because a control-character class is
// exactly what the linter stops, and for good reason.
// The C1 range (U+0080 to U+009F) goes out with C0 and DEL: on a terminal that
// decodes C1 from UTF-8, U+009C is ST and closes the sequence Leg is building,
// and U+009D is OSC and opens whatever follows it. That is the same hazard as a
// raw ESC or BEL, in two bytes instead of one.
export const printable = (s) => [...String(s ?? '')].map((c) => {
  const cp = c.codePointAt(0)
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? ' ' : c
}).join('')

export function terminalSequenceFor(p, { preferences = null } = {}) {
  if (p?.hook_event_name !== 'Notification') return null
  if (!WAITING_TYPES.includes(String(p.notification_type ?? ''))) return null
  const prefs = preferences ?? readPreferences()
  if (!prefs.notify_terminal) return null
  const text = printable(p.message).trim().slice(0, 160)
  return `\x1b]9;${text || 'leg: this terminal is waiting on you'}\x07`
}

// Hook payload → session record. Returns a short line for the hook log.
export function handleHook(sessionId, p) {
  const s = readSession(sessionId)
  if (!s) return 'no session'
  const base = { agent_session_id: p.session_id ?? s.agent_session_id, transcript_path: p.transcript_path ?? s.transcript_path, last_activity: new Date().toISOString() }
  switch (p.hook_event_name) {
    case 'SessionStart':
      // reducer: one hook process per tool call, so read `cur` inside the lock
      updateSession(sessionId, (cur) => ({ ...base, status: cur.status === 'starting' ? 'running' : cur.status }), { event: { type: 'agent_ready', summary: `claude session ${p.session_id ?? '?'} (${p.source ?? 'startup'})` } })
      return 'session start'
    case 'UserPromptSubmit': {
      // the human typed, so whatever was being waited on has been answered
      updateSession(sessionId, (cur) => ({ ...base, ...clearHumanWait(cur), task: cur.task ?? (p.prompt ? String(p.prompt).slice(0, 500) : null), turns: (cur.turns ?? 0) + 1 }), { event: { type: 'turn', summary: `prompt: ${String(p.prompt ?? '').slice(0, 120)}` } })
      return 'prompt'
    }
    case 'PostToolUse': {
      const file = p.tool_input?.file_path ?? p.tool_input?.notebook_path ?? null
      if (!file) return 'tool (no file)'
      const rel = relTo(workRoot(s), file)
      // reducer: concurrent Edit/Write hooks each add their own file without
      // the last writer overwriting the others' additions
      updateSession(sessionId, (cur) => ({ ...base, files_touched: cur.files_touched.includes(rel) ? cur.files_touched : [...cur.files_touched, rel].slice(-200) }))
      return `touched ${rel}`
    }
    case 'Notification': {
      const type = String(p.notification_type ?? '')
      const since = new Date().toISOString()
      // reducer, and the hazard the status-line handler documents: this hook is
      // its own process and a StopFailure can be writing `status: 'limit'` in
      // the same moment. Only `waiting` is touched from `cur` inside the lock —
      // never status, never limit — so a Notification can never erase a wall.
      if (type === 'quota_auto_resume_fired') {
        updateSession(sessionId, (cur) => ({ ...base, waiting: cur.waiting?.type === 'reset' ? cur.waiting : { type: 'quota_auto_resume', message: QUOTA_STAND_DOWN, since } }),
          { event: { type: 'status', summary: QUOTA_STAND_DOWN } })
        return 'notify quota_auto_resume'
      }
      if (!WAITING_TYPES.includes(type)) { updateSession(sessionId, base); return `notify ${type || 'unknown'}` }
      // the question verbatim: a paraphrase of what an agent is asking for is
      // the one thing a human cannot check against the terminal in front of them
      const message = String(p.message ?? '').slice(0, 160)
      updateSession(sessionId, (cur) => ({ ...base, waiting: cur.waiting?.type === 'reset' ? cur.waiting : { type, message, since } }),
        { event: { type: 'waiting', summary: `waiting on you (${type}): ${message}` } })
      return `notify ${type}`
    }
    case 'Stop':
      // reducer: never turn a 'limit'/'handing_off' back to 'running' by racing
      updateSession(sessionId, (cur) => ({ ...base, ...clearHumanWait(cur), status: cur.status === 'starting' ? 'running' : cur.status }), { event: { type: 'turn_done', summary: String(p.last_assistant_message ?? '').slice(0, 160) || 'turn done' } })
      return 'stop'
    case 'StopFailure': {
      if (p.error === 'rate_limit') {
        // a simulated wall (baton sessions simulate-limit) clears after two minutes so a test never walls the real login for hours
        const simulated = Boolean(p.leg_simulated || p.baton_simulated)
        const detail = String(p.last_assistant_message ?? p.error_details ?? '').slice(0, 300)
        // which bucket the wording walled: one model family, or the whole
        // login. Unrecognised wording walls the login (src/buckets.mjs rule 5).
        const hit = bucketFromWall('claude', p.last_assistant_message)
        // markLimited takes the same cross-process lock recordUsage does, so a
        // percentage arriving from the poller in this same moment cannot erase
        // the wall this hook is writing (that race handed the baton straight
        // back to a walled login).
        const u = markLimited('claude', s.account, {
          reason: hit.scope === 'model' ? 'model_limit' : 'rate_limit',
          source: simulated ? 'leg simulate-limit' : 'claude StopFailure',
          resets_at: simulated ? Math.floor(Date.now() / 1000) + 120 : null,
          scope: hit.scope,
          model: hit.model ?? null,
          evidence: detail,
        })
        const resets = hit.scope === 'model' ? (u.walls?.[hit.model]?.limited_until ?? null) : u.limited_until
        updateSession(sessionId, { ...base, status: 'limit', limit: { reason: 'rate_limit', detail, resets_at: resets, at: new Date().toISOString(), simulated, scope: hit.scope, model: hit.model ?? null } }, { event: { type: 'limit', summary: `claude usage limit${simulated ? ' (simulated)' : ''}${hit.scope === 'model' ? ` (${hit.model})` : ''}: ${detail.slice(0, 160)}` } })
        return 'LIMIT'
      }
      appendEvent(sessionId, { type: 'error', summary: `claude ${p.error}: ${String(p.last_assistant_message ?? p.error_details ?? '').slice(0, 160)}` })
      updateSession(sessionId, base)
      return `error ${p.error}`
    }
    case 'SessionEnd':
      updateSession(sessionId, { ...base, agent_exit_reason: p.reason ?? null }, { event: { type: 'agent_exit', summary: `claude session ended (${p.reason ?? 'unknown'})` } })
      return 'session end'
    default:
      updateSession(sessionId, base)
      return p.hook_event_name ?? 'unknown'
  }
}

export function relTo(root, file) {
  const a = String(file).replace(/\\/g, '/')
  const r = String(root ?? '').replace(/\\/g, '/').replace(/\/$/, '')
  return r && a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : a
}

// Status line: record the limits and print. Returns Leg's row as `text` and
// the user's own status line (from `raw`, the stdin JSON) as `user`.
export function handleStatusline(sessionId, p, raw = '') {
  const s = readSession(sessionId)
  if (!s) return { text: '', user: '', limits: null }
  const limits = limitsFrom(p.rate_limits)
  if (limits) recordUsage('claude', s.account, limits, 'claude statusline')
  const hot = limits ? [['5h', limits.five_hour], ['7d', limits.seven_day]].filter(([, w]) => w).sort((a, b) => b[1].pct - a[1].pct)[0] : null
  const warn = hot && hot[1].pct >= WARN_PCT
  // reducer: the status-line hook is its own process; only nudge running↔warning
  // from `cur`, so it never overwrites a 'limit' a StopFailure set at the same time
  updateSession(sessionId, (cur) => {
    const patch = { last_activity: new Date().toISOString() }
    if (limits) patch.limits = limits
    if (p.session_id && !cur.agent_session_id) patch.agent_session_id = p.session_id
    if (p.transcript_path && !cur.transcript_path) patch.transcript_path = p.transcript_path
    if (warn && !cur.warning) patch.warning = { window: hot[0], pct: hot[1].pct, resets_at: hot[1].resets_at, at: new Date().toISOString() }
    if (!warn && cur.warning) patch.warning = null
    if (warn && cur.status === 'running') patch.status = 'warning'
    if (!warn && cur.status === 'warning') patch.status = 'running'
    return patch
  }, warn && !s.warning ? { event: { type: 'warning', summary: `claude ${hot[0]} window at ${Math.round(hot[1].pct)}%` } } : {})
  const next = s.chain?.[0] ? `${s.chain[0].agent}${s.chain[0].account !== 'default' ? '/' + s.chain[0].account : ''}` : 'nothing'
  const pct = limits ? ` 5h ${limits.five_hour ? Math.round(limits.five_hour.pct) + '%' : '-'} · 7d ${limits.seven_day ? Math.round(limits.seven_day.pct) + '%' : '-'}` : ''
  const text = warn ? `⚠ leg: ${hot[0]} at ${Math.round(hot[1].pct)}% → next ${next}${pct}` : `leg ·${pct || ' limits pending'} · next ${next} · board ${s.board_url ?? ''}`
  return { text, user: userStatusLineText(s, raw), limits, warn }
}
