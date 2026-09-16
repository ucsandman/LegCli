// Codex discovery — what `~/.codex` (CODEX_HOME) keeps, read only.
// Observed live, codex-cli 0.84.0–0.154.0 (2026-09-16, 358 rollouts):
//   sessions/YYYY/MM/DD/rollout-<local stamp>-<uuid>.jsonl   one thread per file;
//     the first line is session_meta {id (this thread), session_id (the root
//     thread), cwd, timestamp (UTC), cli_version, originator, source, thread_source,
//     git {branch, commit_hash, repository_url}} (src/taps/codex.mjs readMeta
//     reads it bounded). A subagent thread has source {subagent: {...}} (older
//     versions: thread_source "subagent") and is listed only on request.
//     `base_instructions.text` is the system prompt and never surfaces.
//   session_index.jsonl  {id, thread_name, updated_at}: the title Codex gave
//     (sparse: not every thread is in it).
//   history.jsonl        {session_id, ts (seconds), text} per prompt: the turn count.
// Codex keeps no "live" marker Leg can read; `live` stays null (unknown).
import { join } from 'node:path'
import { LAYOUT } from '../../accounts.mjs'
import { readMeta, parseLines } from '../../taps/codex.mjs'
import { readHead, readTail, jsonLines, line, isoOrNull, isoFromMs, safeList, safeStat, safeRead, PROMPT_MAX } from '../common.mjs'

export const name = 'codex'
export const label = 'Codex'
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function root(homes = {}) { return homes.codex ?? LAYOUT.codex.home() }

// only what a human said and what the agent answered: a `developer` message
// is injected harness text (AGENTS.md, model notices), never shown
function conversationLines(lines) {
  return lines.filter((l) => {
    if (!l.includes('"role"')) return true
    try { const j = JSON.parse(l); const p = j.payload ?? {}; return !(j.type === 'response_item' && p.type === 'message' && p.role !== 'user' && p.role !== 'assistant') } catch { return false }
  })
}

function parseRollout(path, st) {
  const headText = readHead(path)
  let meta = readMeta(path)
  if (!meta) { // a BOM or a torn first line: try the bounded head ourselves
    const first = jsonLines(headText.split('\n')[0] ?? '')[0]
    meta = first?.type === 'session_meta' ? first.payload : null
  }
  if (!meta || typeof meta.id !== 'string') return null
  const parsed = parseLines(conversationLines(headText.split('\n').slice(1)))
  const first = parsed.messages.find((m) => m.role === 'user')
  let updatedAt = null
  for (const j of jsonLines(readTail(path)).reverse()) { if (j.timestamp) { updatedAt = isoOrNull(j.timestamp); if (updatedAt) break } }
  const subagent = (typeof meta.source === 'object' && meta.source !== null && Boolean(meta.source.subagent)) || meta.thread_source === 'subagent'
  return {
    native_id: meta.id,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    branch: typeof meta.git?.branch === 'string' ? meta.git.branch : null,
    title: first ? line(first.text, PROMPT_MAX) : null, // session_index wins below when it names this thread
    started_at: isoOrNull(meta.timestamp) ?? isoFromMs(st.birthtimeMs) ?? isoFromMs(st.mtimeMs),
    updated_at: updatedAt ?? isoFromMs(st.mtimeMs),
    transcript_path: path,
    size_bytes: st.size,
    native: {
      version: meta.cli_version ?? null, originator: meta.originator ?? null, kind: subagent ? 'subagent' : 'thread', subagent,
      root_id: typeof meta.session_id === 'string' ? meta.session_id : null,
      parent_id: meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
      commit: meta.git?.commit_hash ?? null, remote: meta.git?.repository_url ?? null,
    },
  }
}

function fileIndex(f, prev, fold) {
  const st = safeStat(f)
  if (!st) return { key: null, map: {} }
  const key = `${st.mtimeMs}:${st.size}`
  if (prev?.key === key) return prev
  const map = {}
  for (const j of jsonLines(safeRead(f))) fold(map, j)
  return { key, map }
}

export function scan({ home, prev = {} }) {
  const root = join(home, 'sessions')
  const entries = {}
  let scanned = 0; let parsed = 0
  const before = prev.entries ?? {}
  const digits = (d) => d.isDirectory() && /^\d+$/.test(d.name)
  for (const y of safeList(root).filter(digits)) {
    for (const m of safeList(join(root, y.name)).filter(digits)) {
      for (const d of safeList(join(root, y.name, m.name)).filter(digits)) {
        const dir = join(root, y.name, m.name, d.name)
        for (const f of safeList(dir)) {
          if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue
          const path = join(dir, f.name)
          const st = safeStat(path)
          if (!st) continue
          scanned += 1
          const old = before[path]
          if (old && old.mtime === st.mtimeMs && old.size === st.size) { entries[path] = old; continue }
          const record = parseRollout(path, st)
          parsed += 1
          if (record) entries[path] = { mtime: st.mtimeMs, size: st.size, record }
        }
      }
    }
  }
  const titles = fileIndex(join(home, 'session_index.jsonl'), prev.aux?.titles, (map, j) => { if (typeof j.id === 'string' && typeof j.thread_name === 'string') map[j.id] = line(j.thread_name) })
  const turns = fileIndex(join(home, 'history.jsonl'), prev.aux?.turns, (map, j) => { if (typeof j.session_id === 'string') map[j.session_id] = (map[j.session_id] ?? 0) + 1 })
  for (const e of Object.values(entries)) {
    const r = e.record
    if (titles.map[r.native_id]) r.title = titles.map[r.native_id]
    r.turns = turns.map[r.native_id] ?? null
    r.live = null
  }
  return { entries, aux: { titles, turns }, scanned, parsed }
}

export function messages(record, limit = 8) {
  const text = readTail(record.transcript_path, 4 * 1024 * 1024)
  // task_complete repeats the last agent message the response_item already
  // carried: one turn, one row
  const out = []
  for (const m of parseLines(conversationLines(text.split('\n').filter(Boolean))).messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role && prev.text === m.text) continue
    out.push(m)
  }
  return out.slice(-limit)
}

// `codex resume <SESSION_ID>` (codex resume --help, 0.154.0: "Session id (UUID)
// or session name"; an explicit id bypasses the cwd-filtered picker). A
// subagent thread is not a session a human can resume.
export function resume(record) {
  if (record.native?.subagent) return { supported: false, reason: 'a subagent thread belongs to the thread that spawned it' }
  if (!ID_RE.test(record.native_id)) return { supported: false, reason: 'the thread id is not one codex resume accepts' }
  return { supported: true, agent: 'codex', args: ['resume', record.native_id] }
}

export const transcript = 'supported'
