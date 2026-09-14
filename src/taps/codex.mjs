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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT } from '../accounts.mjs'
import { sanitizeEnv } from '../env.mjs'
import codexAdapter from '../adapters/codex.mjs'

const BATON_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version } catch { return 'unknown' } })()

export function sessionsRootFor(codexHome = LAYOUT.codex.home()) { return join(codexHome, 'sessions') }

function sameDir(a, b) {
  const n = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Newest rollout created at or after `sinceMs` whose session_meta cwd is `cwd`.
export function findRollout({ codexHome, cwd, sinceMs, allowOlderMs = 5000 }) {
  const root = sessionsRootFor(codexHome)
  if (!existsSync(root)) return null
  // codex names the day directory from LOCAL time while the rollout's own
  // session_meta timestamp is UTC (observed live: a 20:33 EDT rollout under
  // sessions/2026/09/10 stamped 2026-09-11T00:33:44Z). Compare local days, and
  // keep the one before as slack around midnight.
  const from = localDay(new Date(sinceMs - allowOlderMs - 86400000))
  const days = []
  for (const y of readdirSync(root)) for (const m of safeList(join(root, y))) for (const day of safeList(join(root, y, m))) {
    if (`${y}-${m}-${day}` >= from) days.push(join(root, y, m, day))
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

// Incremental reader: keeps a byte offset and a partial line. `from` skips
// what is already in the file (agy's log is per session, not per leg).
export function createTail(path, { from = 0 } = {}) {
  let offset = from
  let rest = ''
  return {
    path,
    read() {
      let st
      try { st = statSync(path) } catch { return [] }
      // truncated or replaced under us: read it again rather than go blind
      if (st.size < offset) { offset = 0; rest = '' }
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
const PATCH_BLOCK_RE = /\*\*\* Begin Patch\n([\s\S]*?)\n\*\*\* End Patch/g
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)$/gm

function applyPatchArgument(args) {
  const text = String(args ?? '')
  if (text.startsWith('*** Begin Patch')) return text
  const start = /tools\.apply_patch\(\s*(['"])/.exec(text)
  if (!start) return text
  const quote = start[1]
  let value = ''
  for (let i = start.index + start[0].length; i < text.length; i += 1) {
    const char = text[i]
    if (char === quote) return value
    if (char !== '\\' || i + 1 === text.length) { value += char; continue }
    const escaped = text[++i]
    if (escaped === 'n') value += '\n'
    else if (escaped === 'r') value += '\r'
    else if (escaped === '\\' || escaped === quote) value += escaped
    else value += `\\${escaped}`
  }
  return text
}

function patchFiles(args) {
  // A functions.exec payload can contain an apply_patch JavaScript string,
  // where patch line breaks are serialized as literal "\\n". Decode only
  // that string argument so direct patches retain literal Windows backslashes.
  const patch = applyPatchArgument(args).replace(/\r\n/g, '\n')
  const files = []
  for (const block of patch.matchAll(PATCH_BLOCK_RE)) {
    let match
    while ((match = PATCH_FILE_RE.exec(block[1]))) files.push(match[1].trim())
  }
  return files
}

// Codex can expose either window as primary. The duration is the identity:
// current Pro Lite rollouts expose only primary=10080 (the weekly window).
export function normalizeRateLimits(rateLimits) {
  const out = { five_hour: null, seven_day: null }
  const entries = [rateLimits?.primary, rateLimits?.secondary]
  for (const raw of entries) {
    if (!raw) continue
    const pct = Number(raw.used_percent ?? raw.usedPercent)
    if (!Number.isFinite(pct)) continue
    const minutes = Number(raw.window_minutes ?? raw.windowDurationMins)
    const window = { pct, resets_at: raw.resets_at ?? raw.resetsAt ?? null, window_minutes: Number.isFinite(minutes) ? minutes : null }
    if (minutes === 300) out.five_hour = window
    else if (minutes === 10080) out.seven_day = window
    // An absent or unfamiliar duration stays unknown. Primary is a transport
    // position, not a promise that this is the 5-hour bucket.
  }
  return out
}

function parseRetryAt(msg) {
  const m = RETRY_AT_RE.exec(msg ?? '')
  if (!m) return null
  // "Sep 14th, 2026 9:35 PM" → strip the ordinal suffix
  const t = Date.parse(m[1].replace(/(\d+)(st|nd|rd|th)/, '$1'))
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

// lines → { limits, limit, messages, turnsDone, taskStarted, threadId }
export function parseLines(lines) {
  const out = { limits: null, limits_at: null, limit: null, messages: [], turnsDone: 0, taskStarted: 0, threadId: null, files: [] }
  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const p = j.payload ?? {}
    if (j.type === 'session_meta') { out.threadId = p.id ?? null; continue }
    if (j.type === 'event_msg') {
      if (p.type === 'token_count' && p.rate_limits) {
        out.limits = normalizeRateLimits(p.rate_limits)
        out.limits_at = j.timestamp ?? null
      } else if (p.type === 'task_started') out.taskStarted += 1
      else if (p.type === 'task_complete') {
        out.turnsDone += 1
        if (p.last_agent_message) out.messages.push({ role: 'assistant', text: String(p.last_agent_message).slice(0, 1500), ts: j.timestamp ?? null })
        const err = p.error
        if (err && (err.codex_error_info === 'usage_limit_exceeded' || USAGE_LIMIT_RE.test(err.message ?? ''))) {
          out.limit = { reason: 'usage_limit_exceeded', detail: String(err.message ?? '').slice(0, 300), resets_at: parseRetryAt(err.message), observed_at: j.timestamp ?? null, raw: j }
        }
      } else if (p.type === 'error' && USAGE_LIMIT_RE.test(p.message ?? '')) {
        out.limit = { reason: 'usage_limit_exceeded', detail: String(p.message).slice(0, 300), resets_at: parseRetryAt(p.message), observed_at: j.timestamp ?? null, raw: j }
      }
      continue
    }
    if (j.type === 'response_item') {
      if (p.type === 'message' && Array.isArray(p.content)) {
        const text = p.content.filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text).map((c) => c.text).join('\n').trim()
        // skip the injected context (<environment_context>, and the "# AGENTS.md instructions" block codex
        // prepends to a thread: observed live 2026-09-11 as the first user message of every rollout)
        if (text && !/^<[a-z_-]+>/i.test(text) && !/^# AGENTS\.md instructions/i.test(text)) out.messages.push({ role: p.role === 'user' ? 'user' : 'assistant', text: text.slice(0, 1500), ts: j.timestamp ?? null })
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const args = String(p.arguments ?? p.input ?? '')
        out.files.push(...patchFiles(args))
      }
    }
  }
  return out
}

// Read the account quota without starting a model turn. This protocol and the
// `ordinaryUsageAllowed` tri-state come from `codex app-server
// generate-json-schema --experimental`; null means unavailable and must not be
// inferred from percentages.
export function readCodexUsage({ codexHome = LAYOUT.codex.home(), timeoutMs = 8000, signal = null } = {}) {
  return new Promise((resolvePromise) => {
    let child
    let settled = false
    let stdout = ''
    const killProbe = () => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill() } catch {} } }
    }
    const finish = (result, { kill = false } = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (kill) killProbe()
      else {
        try { child?.stdin.end() } catch {}
        const cleanup = setTimeout(killProbe, 1000)
        cleanup.unref?.()
        child?.once('exit', () => clearTimeout(cleanup))
      }
      resolvePromise(result)
    }
    const stop = (error) => {
      finish({ ok: false, limits: null, available: null, observed_at: null, error }, { kill: true })
    }
    const onAbort = () => stop('codex usage read cancelled')
    const timer = setTimeout(() => stop('codex usage read timed out'), timeoutMs)
    timer.unref?.()
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const { bin, viaNode, entry } = codexAdapter.resolve()
      const args = [...(viaNode ? [entry ?? bin] : []), 'app-server', '--listen', 'stdio://']
      const env = { ...sanitizeEnv(process.env, { interactive: true }), CODEX_HOME: codexHome }
      child = spawn(viaNode ? process.execPath : bin, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      child.stderr.resume()
    } catch { return stop('codex app-server failed to start') }
    child.on('error', () => stop('codex app-server failed to start'))
    child.stdin.on('error', () => stop('codex app-server input closed'))
    child.on('exit', (code) => { if (!settled) finish({ ok: false, limits: null, available: null, observed_at: null, error: `codex app-server exited (${code ?? 'unknown'})` }) })
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result) {
          try {
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
            child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })}\n`)
          } catch { return stop('codex app-server input closed') }
        } else if (message.id === 2) {
          if (message.error || !message.result) return stop('codex rate-limit read failed')
          const snapshot = message.result.rateLimitsByLimitId?.codex ?? message.result.rateLimits
          const limits = normalizeRateLimits(snapshot)
          const available = typeof message.result.ordinaryUsageAllowed === 'boolean' ? message.result.ordinaryUsageAllowed : null
          return finish({ ok: available !== null || Boolean(limits.five_hour || limits.seven_day), limits, available, observed_at: new Date().toISOString(), error: null })
        }
      }
    })
    try { child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'baton', version: BATON_VERSION }, capabilities: { experimentalApi: true } } })}\n`) } catch { stop('codex app-server input closed') }
  })
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
