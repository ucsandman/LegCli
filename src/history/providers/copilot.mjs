// GitHub Copilot CLI discovery — what `~/.copilot` keeps, read only. Copilot
// is a provider Leg can DISCOVER without being one it can supervise or hand
// off to: it lists here, its transcript reads here, and `continue` says no.
// Observed live, copilot 1.0.80 (2026-09-16):
//   session-state/<sessionId>/workspace.yaml   flat `key: value` lines: id, cwd,
//     git_root, repository, branch, name, user_named, created_at, updated_at
//   session-state/<sessionId>/events.jsonl     {type, data, id, timestamp, parentId};
//     user.message {data.content} and assistant.message {data.content} are the
//     conversation; session.start.data.context carries cwd, gitRoot, branch
//   session.db beside them is SQLite and is not opened.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readTail, jsonLines, line, isoOrNull, isoFromMs, safeList, safeStat, safeRead } from '../common.mjs'

export const name = 'copilot'
export const label = 'Copilot CLI'
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function root(homes = {}) { return homes.copilot ?? process.env.COPILOT_HOME ?? join(homedir(), '.copilot') }

// the flat YAML copilot writes: one `key: value` per line, no nesting, no quoting
function flatYaml(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function parseSession(dir, st) {
  const y = flatYaml(safeRead(join(dir, 'workspace.yaml')))
  if (typeof y.id !== 'string' || !y.id) return null
  const events = join(dir, 'events.jsonl')
  const est = safeStat(events)
  return {
    native_id: y.id,
    cwd: y.cwd || null,
    branch: y.branch || null,
    title: line(y.name ?? '') || null,
    started_at: isoOrNull(y.created_at) ?? isoFromMs(st.birthtimeMs) ?? isoFromMs(st.mtimeMs),
    updated_at: isoOrNull(y.updated_at) ?? isoFromMs(est?.mtimeMs) ?? isoFromMs(st.mtimeMs),
    transcript_path: est ? events : null,
    size_bytes: est?.size ?? 0,
    turns: null,
    live: null,
    native: { version: null, kind: 'session', repository: y.repository || null, git_root: y.git_root || null, user_named: y.user_named === 'true' },
  }
}

export function scan({ home, prev = {} }) {
  const root = join(home, 'session-state')
  const entries = {}
  let scanned = 0; let parsed = 0
  const before = prev.entries ?? {}
  for (const d of safeList(root)) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name)
    const ws = join(dir, 'workspace.yaml')
    const st = safeStat(ws)
    if (!st) continue
    scanned += 1
    const old = before[ws]
    // the yaml's updated_at moves with the session, so its stat is the key
    if (old && old.mtime === st.mtimeMs && old.size === st.size) { entries[ws] = old; continue }
    const record = parseSession(dir, st)
    parsed += 1
    if (record) entries[ws] = { mtime: st.mtimeMs, size: st.size, record }
  }
  return { entries, aux: {}, scanned, parsed }
}

export function messagesFromLines(lines, limit = 8) {
  const out = []
  for (const j of jsonLines(lines.join('\n'))) {
    if (j.type !== 'user.message' && j.type !== 'assistant.message') continue
    const text = String(j.data?.content ?? '').trim()
    if (!text) continue
    out.push({ role: j.type === 'user.message' ? 'user' : 'assistant', text: text.slice(0, 1500), ts: j.timestamp ?? null })
  }
  return out.slice(-limit)
}

export function messages(record, limit = 8) {
  if (!record.transcript_path) return []
  return messagesFromLines(readTail(record.transcript_path, 4 * 1024 * 1024).split('\n'), limit)
}

// copilot --help (1.0.80) has --continue (the most recent session) and
// --connect[=sessionId] (a remote session); no resume-by-id Leg has verified,
// and copilot is not an agent `leg <agent>` supervises.
export function resume() { return { supported: false, reason: 'copilot is not an agent Leg supervises, and no resume-by-id flag is verified' } }

export const transcript = 'supported'
