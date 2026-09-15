// claude tap — how `baton claude` sees inside a normal interactive Claude Code.
// Nothing in ~/.claude is edited: the session gets one extra settings file via
// `--settings` (hooks merge with the user's; statusLine is the only key that
// replaces, so Baton's status line runs the user's own command first).
// Sources: code.claude.com/docs/en/hooks (StopFailure `error: rate_limit`),
// docs/en/statusline (rate_limits.five_hour/seven_day used_percentage,
// resets_at), docs/en/settings (`--settings` sits above user settings).
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionDir, updateSession, appendEvent, readSession, workRoot } from '../sessions.mjs'
import { recordUsage, markLimited, WARN_PCT } from '../usage.mjs'
import { writeJsonAtomic } from '../fsx.mjs'
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

export function settingsFor(sessionId, { statusLine = null } = {}) {
  const cmd = (kind) => ({ type: 'command', command: `node ${q(HOOK)} ${kind} --session ${sessionId}`, timeout: 20 })
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [cmd('claude-hook')] }],
      UserPromptSubmit: [{ hooks: [cmd('claude-hook')] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [cmd('claude-hook')] }],
      Stop: [{ hooks: [cmd('claude-hook')] }],
      StopFailure: [{ hooks: [cmd('claude-hook')] }],
      SessionEnd: [{ hooks: [cmd('claude-hook')] }],
    },
    statusLine: { type: 'command', command: `node ${q(HOOK)} claude-statusline --session ${sessionId}`, padding: statusLine?.padding ?? 0 },
    // Baton owns the limit: it hands the work to the next option instead of
    // waiting in the session for the reset.
    autoContinueAtUsageLimit: false,
  }
  return settings
}

export function writeSettings(sessionId, opts) {
  const file = join(sessionDir(sessionId), 'claude-settings.json')
  writeJsonAtomic(file, settingsFor(sessionId, opts))
  return file
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n')
  return ''
}

// Last human/assistant messages from a Claude Code transcript (jsonl).
export function transcriptTail(path, limit = 8) {
  if (!path || !existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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

export function firstPrompt(path) {
  const t = transcriptTail(path, 1000).find((m) => m.role === 'user')
  return t ? t.text.slice(0, 500) : null
}

function limitsFrom(rl) {
  if (!rl) return null
  const w = (x) => (x && Number.isFinite(x.used_percentage) ? { pct: x.used_percentage, resets_at: x.resets_at ?? null } : null)
  return { five_hour: w(rl.five_hour), seven_day: w(rl.seven_day) }
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
      updateSession(sessionId, (cur) => ({ ...base, task: cur.task ?? (p.prompt ? String(p.prompt).slice(0, 500) : null), turns: (cur.turns ?? 0) + 1 }), { event: { type: 'turn', summary: `prompt: ${String(p.prompt ?? '').slice(0, 120)}` } })
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
    case 'Stop':
      // reducer: never turn a 'limit'/'handing_off' back to 'running' by racing
      updateSession(sessionId, (cur) => ({ ...base, status: cur.status === 'starting' ? 'running' : cur.status }), { event: { type: 'turn_done', summary: String(p.last_assistant_message ?? '').slice(0, 160) || 'turn done' } })
      return 'stop'
    case 'StopFailure': {
      if (p.error === 'rate_limit') {
        // a simulated wall (baton sessions simulate-limit) clears after two minutes so a test never walls the real login for hours
        const simulated = Boolean(p.leg_simulated || p.baton_simulated)
        const u = markLimited('claude', s.account, { reason: 'rate_limit', source: simulated ? 'leg simulate-limit' : 'claude StopFailure', resets_at: simulated ? Math.floor(Date.now() / 1000) + 120 : null })
        updateSession(sessionId, { ...base, status: 'limit', limit: { reason: 'rate_limit', detail: String(p.last_assistant_message ?? p.error_details ?? '').slice(0, 300), resets_at: u.limited_until, at: new Date().toISOString(), simulated } }, { event: { type: 'limit', summary: `claude usage limit${simulated ? ' (simulated)' : ''}: ${String(p.last_assistant_message ?? p.error_details ?? '').slice(0, 160)}` } })
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

// Status line: record the limits and print. Returns the text to print.
export function handleStatusline(sessionId, p) {
  const s = readSession(sessionId)
  if (!s) return { text: '', limits: null }
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
  return { text, limits, warn }
}
