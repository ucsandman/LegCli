// Grok discovery — what `~/.grok` (GROK_HOME) keeps, read only.
// Observed live, grok 4.6 build CLI (2026-09-16):
//   sessions/<url-encoded cwd>/<session-id>/summary.json   {info:{id,cwd},
//     created_at, updated_at, last_active_at, generated_title, session_summary,
//     git_root_dir, head_branch, head_commit, num_chat_messages, current_model_id}
//   sessions/<url-encoded cwd>/<session-id>/chat_history.jsonl   lines
//     {type:'user', content:[{type:'text',text}]} and {type:'assistant',
//     content:'…'} (plus system and reasoning lines, skipped)
//   sessions/<url-encoded cwd>/prompt_history.jsonl   {timestamp, session_id,
//     prompt} per prompt: the turn count and the first prompt
//   active_sessions.json   the sessions a running grok has open (an array;
//     empty when none is running)
// The directory name is grok's own encoding of the cwd and is never decoded:
// summary.json names the cwd itself.
import { join, resolve } from 'node:path'
import { LAYOUT } from '../../accounts.mjs'
import { readTail, jsonLines, line, isoOrNull, isoFromMs, safeList, safeStat, safeRead, PROMPT_MAX } from '../common.mjs'

export const name = 'grok'
export const label = 'Grok'
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function root(homes = {}) { return homes.grok ?? LAYOUT.grok.home() }

function readJson(p) { try { return JSON.parse(safeRead(p) ?? '') } catch { return null } }

function parseSummary(dir, st) {
  const j = readJson(join(dir, 'summary.json'))
  const id = j?.info?.id ?? j?.id
  if (!j || typeof id !== 'string') return null
  const gitRoot = typeof j.git_root_dir === 'string' ? resolve(j.git_root_dir) : null
  return {
    native_id: id,
    cwd: typeof j.info?.cwd === 'string' ? j.info.cwd : null,
    branch: typeof j.head_branch === 'string' ? j.head_branch : null,
    title: line(j.generated_title ?? j.session_summary ?? '') || null,
    started_at: isoOrNull(j.created_at) ?? isoFromMs(st.birthtimeMs),
    updated_at: isoOrNull(j.last_active_at ?? j.updated_at) ?? isoFromMs(st.mtimeMs),
    transcript_path: join(dir, 'chat_history.jsonl'),
    size_bytes: safeStat(join(dir, 'chat_history.jsonl'))?.size ?? 0,
    // session_kind: absent for an interactive session, "subagent" (listed only
    // on request), "headless" (listed: a human asked for it)
    native: { version: j.chat_format_version ?? null, model: j.current_model_id ?? null, git_root_dir: gitRoot, head_commit: j.head_commit ?? null, messages: Number.isFinite(j.num_chat_messages) ? j.num_chat_messages : null, kind: typeof j.session_kind === 'string' ? j.session_kind : 'session', subagent: j.session_kind === 'subagent' },
  }
}

// prompt_history.jsonl for one cwd dir → { [session_id]: { count, first } }
function promptIndex(f, prev) {
  const st = safeStat(f)
  if (!st) return { key: null, map: {} }
  const key = `${st.mtimeMs}:${st.size}`
  if (prev?.key === key) return prev
  const map = {}
  for (const j of jsonLines(safeRead(f))) {
    if (typeof j.session_id !== 'string') continue
    const cur = map[j.session_id] ?? (map[j.session_id] = { count: 0, first: null })
    cur.count += 1
    if (!cur.first && typeof j.prompt === 'string' && !j.prompt.startsWith('/')) cur.first = line(j.prompt, PROMPT_MAX)
  }
  return { key, map }
}

export function liveIds(home) {
  const j = readJson(join(home, 'active_sessions.json'))
  const out = new Set()
  const push = (v) => { if (typeof v === 'string') out.add(v); else if (v && typeof v === 'object') { const id = v.id ?? v.session_id ?? v.info?.id; if (typeof id === 'string') out.add(id) } }
  if (Array.isArray(j)) j.forEach(push)
  else if (j && typeof j === 'object') { for (const [k, v] of Object.entries(j)) { if (Array.isArray(v)) v.forEach(push); else push(k) } }
  return out
}

export function scan({ home, prev = {} }) {
  const root = join(home, 'sessions')
  const entries = {}
  const prompts = {}
  let scanned = 0; let parsed = 0
  const before = prev.entries ?? {}
  for (const cwdDir of safeList(root)) {
    if (!cwdDir.isDirectory()) continue
    const cdir = join(root, cwdDir.name)
    const pi = promptIndex(join(cdir, 'prompt_history.jsonl'), prev.aux?.prompts?.[cwdDir.name])
    prompts[cwdDir.name] = pi
    for (const s of safeList(cdir)) {
      if (!s.isDirectory()) continue
      const dir = join(cdir, s.name)
      const summary = join(dir, 'summary.json')
      const st = safeStat(summary)
      if (!st) continue
      scanned += 1
      const old = before[summary]
      let entry = old && old.mtime === st.mtimeMs && old.size === st.size ? old : null
      if (!entry) {
        const record = parseSummary(dir, st)
        parsed += 1
        if (!record) continue
        entry = { mtime: st.mtimeMs, size: st.size, record }
      }
      const p = pi.map[entry.record.native_id]
      entry.record.turns = p?.count ?? null
      if (!entry.record.title) entry.record.title = p?.first ?? null
      entries[summary] = entry
    }
  }
  const live = liveIds(home)
  for (const e of Object.values(entries)) e.record.live = live.has(e.record.native_id)
  return { entries, aux: { prompts }, scanned, parsed }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n')
  return ''
}

export function messagesFromLines(lines, limit = 8) {
  const out = []
  for (const j of jsonLines(lines.join('\n'))) {
    if (j.type !== 'user' && j.type !== 'assistant') continue
    const text = textOf(j.content).trim()
    if (!text || /^<[a-z_-]+>/i.test(text)) continue
    out.push({ role: j.type, text: text.slice(0, 1500), ts: j.timestamp ?? null })
  }
  return out.slice(-limit)
}

export function messages(record, limit = 8) {
  return messagesFromLines(readTail(record.transcript_path, 4 * 1024 * 1024).split('\n'), limit)
}

// `grok --resume <SESSION_ID>` (grok --help: "-r, --resume [<SESSION_ID_OR_TITLE>]
// Resume a session by ID or title"; a UUID always means the id).
export function resume(record) {
  if (record.native?.subagent) return { supported: false, reason: 'a subagent session belongs to the session that spawned it' }
  if (!ID_RE.test(record.native_id)) return { supported: false, reason: 'the session id is not one grok --resume accepts' }
  return { supported: true, agent: 'grok', args: ['--resume', record.native_id] }
}

export const transcript = 'supported'
