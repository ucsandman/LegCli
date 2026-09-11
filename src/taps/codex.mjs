// codex tap — an interactive `codex` writes its whole thread to a rollout
// file, flushed per event (observed live 2026-09-11: file mtime == last line
// timestamp). Baton tails that file; no hook is injected, so codex never shows
// its "review new hooks" prompt for a Baton session.
// Shapes (observed live, codex-cli 0.153.4, originator codex-tui):
//   session_meta.payload  {id, cwd, originator, cli_version, source}
//   event_msg.token_count.rate_limits {primary:{used_percent,window_minutes,resets_at}, secondary:{…}}
//     primary = 300 min (5h), secondary = 10080 min (7d)
//   event_msg.task_complete.error {message:"You've hit your usage limit…", codex_error_info:"usage_limit_exceeded"}
//   response_item.message {role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}]}
// Source of the error text: codex-rs/protocol/src/error.rs (UsageLimitReachedError).
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT } from '../accounts.mjs'

export function sessionsRootFor(codexHome = LAYOUT.codex.home()) { return join(codexHome, 'sessions') }

function sameDir(a, b) {
  const n = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}

// Newest rollout created at or after `sinceMs` whose session_meta cwd is `cwd`.
export function findRollout({ codexHome, cwd, sinceMs, allowOlderMs = 5000 }) {
  const root = sessionsRootFor(codexHome)
  if (!existsSync(root)) return null
  const d = new Date(sinceMs - allowOlderMs)
  const days = []
  for (const y of readdirSync(root)) for (const m of safeList(join(root, y))) for (const day of safeList(join(root, y, m))) {
    if (`${y}-${m}-${day}` >= d.toISOString().slice(0, 10)) days.push(join(root, y, m, day))
  }
  const cands = []
  for (const dir of days) for (const f of safeList(dir)) {
    if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
    const p = join(dir, f)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.birthtimeMs && st.birthtimeMs < sinceMs - allowOlderMs && st.mtimeMs < sinceMs - allowOlderMs) continue
    cands.push({ p, mtime: st.mtimeMs })
  }
  cands.sort((a, b) => b.mtime - a.mtime)
  for (const c of cands) {
    const meta = readMeta(c.p)
    if (meta && sameDir(meta.cwd, cwd) && Date.parse(meta.timestamp ?? 0) >= sinceMs - allowOlderMs) return { path: c.p, meta }
  }
  return null
}

function safeList(dir) { try { return readdirSync(dir) } catch { return [] } }

export function readMeta(path) {
  try {
    const fd = openSync(path, 'r')
    // session_meta carries the git snapshot and can run past 15 KB (seen live)
    const buf = Buffer.alloc(Math.min(1048576, fstatSync(fd).size))
    readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const first = buf.toString('utf8').split('\n')[0]
    const j = JSON.parse(first)
    return j.type === 'session_meta' ? j.payload : null
  } catch { return null }
}

// Incremental reader: keeps a byte offset and a partial line.
export function createTail(path) {
  let offset = 0
  let rest = ''
  return {
    path,
    read() {
      let st
      try { st = statSync(path) } catch { return [] }
      if (st.size <= offset) return []
      const fd = openSync(path, 'r')
      const buf = Buffer.alloc(st.size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      offset = st.size
      const text = rest + buf.toString('utf8')
      const lines = text.split('\n')
      rest = lines.pop() ?? ''
      return lines.filter(Boolean)
    },
  }
}

const USAGE_LIMIT_RE = /hit your usage limit/i
const RETRY_AT_RE = /try again at ([^.]+?)(?:\.|$)/i

function parseRetryAt(msg) {
  const m = RETRY_AT_RE.exec(msg ?? '')
  if (!m) return null
  // "Sep 14th, 2026 9:35 PM" → strip the ordinal suffix
  const t = Date.parse(m[1].replace(/(\d+)(st|nd|rd|th)/, '$1'))
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

// lines → { limits, limit, messages, turnsDone, taskStarted, threadId }
export function parseLines(lines) {
  const out = { limits: null, limit: null, messages: [], turnsDone: 0, taskStarted: 0, threadId: null, files: [] }
  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const p = j.payload ?? {}
    if (j.type === 'session_meta') { out.threadId = p.id ?? null; continue }
    if (j.type === 'event_msg') {
      if (p.type === 'token_count' && p.rate_limits) {
        const w = (x) => (x && Number.isFinite(x.used_percent) ? { pct: x.used_percent, resets_at: x.resets_at ?? null, window_minutes: x.window_minutes ?? null } : null)
        out.limits = { five_hour: w(p.rate_limits.primary), seven_day: w(p.rate_limits.secondary) }
      } else if (p.type === 'task_started') out.taskStarted += 1
      else if (p.type === 'task_complete') {
        out.turnsDone += 1
        if (p.last_agent_message) out.messages.push({ role: 'assistant', text: String(p.last_agent_message).slice(0, 1500) })
        const err = p.error
        if (err && (err.codex_error_info === 'usage_limit_exceeded' || USAGE_LIMIT_RE.test(err.message ?? ''))) {
          out.limit = { reason: 'usage_limit_exceeded', detail: String(err.message ?? '').slice(0, 300), resets_at: parseRetryAt(err.message), raw: j }
        }
      } else if (p.type === 'error' && USAGE_LIMIT_RE.test(p.message ?? '')) {
        out.limit = { reason: 'usage_limit_exceeded', detail: String(p.message).slice(0, 300), resets_at: parseRetryAt(p.message), raw: j }
      }
      continue
    }
    if (j.type === 'response_item') {
      if (p.type === 'message' && Array.isArray(p.content)) {
        const text = p.content.filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text).map((c) => c.text).join('\n').trim()
        // skip the injected context (<environment_context>, and the "# AGENTS.md instructions" block codex
        // prepends to a thread: observed live 2026-09-11 as the first user message of every rollout)
        if (text && !/^<[a-z_-]+>/i.test(text) && !/^# AGENTS\.md instructions/i.test(text)) out.messages.push({ role: p.role === 'user' ? 'user' : 'assistant', text: text.slice(0, 1500) })
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const args = String(p.arguments ?? p.input ?? '')
        const m = /\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/g
        let x
        while ((x = m.exec(args))) out.files.push(x[1].trim())
      }
    }
  }
  return out
}

export function firstPrompt(path) {
  if (!path || !existsSync(path)) return null
  const r = parseLines(readFileSync(path, 'utf8').split('\n').filter(Boolean))
  return r.messages.find((m) => m.role === 'user')?.text.slice(0, 500) ?? null
}

export function transcriptTail(path, limit = 8) {
  if (!path || !existsSync(path)) return []
  return parseLines(readFileSync(path, 'utf8').split('\n').filter(Boolean)).messages.slice(-limit)
}
