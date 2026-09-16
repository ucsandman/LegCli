// Claude Code discovery — what `~/.claude` (CLAUDE_CONFIG_DIR) keeps, read only.
// Observed live, Claude Code 2.1.237–2.1.273 (2026-09-16, 798 transcripts):
//   projects/<encoded cwd>/<sessionId>.jsonl   one transcript per session. Only
//     user/assistant/attachment/system lines carry cwd, gitBranch, sessionId,
//     version and timestamp; control lines carry type + sessionId + payload:
//     `custom-title` {customTitle} and `ai-title` {aiTitle} (repeated as the
//     title changes, the LAST one is current), `worktree-state`
//     {worktreeSession:{originalCwd, worktreePath, worktreeBranch, originalBranch}},
//     `history-suppression` (Claude Code hides that session itself). Sidechain
//     (subagent) lines and the <sessionId>/ directory beside the file
//     (subagents/, tool-results/) are not the conversation and are not listed.
//   history.jsonl        {display, timestamp, project, sessionId} per prompt:
//     the cheap turn count and the fallback title, one pass, keyed by sessionId.
//   sessions/<pid>.json  {pid, sessionId, cwd, status} for a running process:
//     the only "is it live" signal, and it goes stale, so the pid is checked.
// The project directory name is Claude's own (lossy) encoding of the cwd and
// is never decoded here: the cwd comes from the transcript lines themselves.
import { join } from 'node:path'
import { LAYOUT } from '../../accounts.mjs'
import { pidAlive } from '../../sessions.mjs'
import { messagesFromLines } from '../../taps/claude.mjs'
import { readHead, readTail, jsonLines, line, isoOrNull, isoFromMs, safeList, safeStat, safeRead, PROMPT_MAX } from '../common.mjs'

export const name = 'claude'
export const label = 'Claude Code'
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function root(homes = {}) { return homes.claude ?? LAYOUT.claude.home() }

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n')
  return ''
}

// One transcript's metadata from its head and tail; null when the file is not
// a conversation (no line names a session).
function parseTranscript(path, st) {
  const head = jsonLines(readHead(path))
  const tail = jsonLines(readTail(path))
  let sessionId = null; let cwd = null; let branch = null; let version = null; let startedAt = null; let firstPrompt = null
  const titles = { custom: null, ai: null }
  let worktree = null; let hidden = false
  const control = (j) => {
    if (j.type === 'custom-title' && typeof j.customTitle === 'string') titles.custom = line(j.customTitle)
    else if (j.type === 'ai-title' && typeof j.aiTitle === 'string') titles.ai = line(j.aiTitle)
    else if (j.type === 'worktree-state' && j.worktreeSession && typeof j.worktreeSession.worktreePath === 'string') worktree = { path: j.worktreeSession.worktreePath, branch: j.worktreeSession.worktreeBranch ?? null, original_cwd: j.worktreeSession.originalCwd ?? null, original_branch: j.worktreeSession.originalBranch ?? null }
    else if (j.type === 'history-suppression') hidden = true
  }
  for (const j of head) {
    if (!sessionId && typeof j.sessionId === 'string') sessionId = j.sessionId
    control(j)
    if (j.type !== 'user' && j.type !== 'assistant') continue
    if (j.isSidechain) continue
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd
    if (!branch && typeof j.gitBranch === 'string' && j.gitBranch) branch = j.gitBranch
    if (!version && typeof j.version === 'string') version = j.version
    if (!startedAt && j.timestamp) startedAt = isoOrNull(j.timestamp)
    if (!firstPrompt && j.type === 'user') {
      const text = textOf(j.message?.content).trim()
      if (text && !/^<[a-z-]+>/.test(text)) firstPrompt = line(text, PROMPT_MAX)
    }
  }
  // the tail is where the current title and the latest worktree move sit
  for (const j of tail) control(j)
  if (!sessionId) return null
  let updatedAt = null
  for (const j of [...tail].reverse()) { if (j.timestamp) { updatedAt = isoOrNull(j.timestamp); if (updatedAt) break } }
  return {
    native_id: sessionId,
    cwd, branch,
    title: titles.custom ?? titles.ai ?? firstPrompt ?? null,
    started_at: startedAt ?? isoFromMs(st.birthtimeMs) ?? isoFromMs(st.mtimeMs),
    updated_at: updatedAt ?? isoFromMs(st.mtimeMs),
    transcript_path: path,
    size_bytes: st.size,
    native: { version, kind: 'transcript', hidden, worktree },
  }
}

// history.jsonl → prompts per session (count, first display), re-read only
// when the file changed.
function promptIndex(home, prev) {
  const f = join(home, 'history.jsonl')
  const st = safeStat(f)
  if (!st) return { key: null, map: {} }
  const key = `${st.mtimeMs}:${st.size}`
  if (prev?.key === key) return prev
  const map = {}
  for (const j of jsonLines(safeRead(f))) {
    if (typeof j.sessionId !== 'string') continue
    const cur = map[j.sessionId] ?? (map[j.sessionId] = { count: 0, first: null })
    cur.count += 1
    if (!cur.first && typeof j.display === 'string' && j.display && !j.display.startsWith('/') && !j.display.startsWith('[Pasted')) cur.first = line(j.display, PROMPT_MAX)
  }
  return { key, map }
}

// sessions/<pid>.json → id → status for every process still alive.
export function liveIds(home) {
  const out = new Map()
  for (const d of safeList(join(home, 'sessions'))) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue
    const j = (() => { try { return JSON.parse(safeRead(join(home, 'sessions', d.name)) ?? '') } catch { return null } })()
    if (j && typeof j.sessionId === 'string' && pidAlive(j.pid)) out.set(j.sessionId, typeof j.status === 'string' ? j.status : 'busy')
  }
  return out
}

// { entries: { [transcript path]: { mtime, size, record } }, aux, scanned, parsed }
export function scan({ home, prev = {} }) {
  const projects = join(home, 'projects')
  const entries = {}
  let scanned = 0; let parsed = 0
  const before = prev.entries ?? {}
  for (const dir of safeList(projects)) {
    if (!dir.isDirectory()) continue // a junction or symlink is never followed
    const pdir = join(projects, dir.name)
    for (const f of safeList(pdir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const path = join(pdir, f.name)
      const st = safeStat(path)
      if (!st) continue
      scanned += 1
      const old = before[path]
      if (old && old.mtime === st.mtimeMs && old.size === st.size) { entries[path] = old; continue }
      const record = parseTranscript(path, st)
      parsed += 1
      if (record) entries[path] = { mtime: st.mtimeMs, size: st.size, record }
    }
  }
  const prompts = promptIndex(home, prev.aux?.prompts)
  const live = liveIds(home)
  for (const e of Object.values(entries)) {
    const r = e.record
    const p = prompts.map[r.native_id]
    r.turns = p?.count ?? null
    if (!r.title && p?.first) r.title = p.first
    r.live = live.has(r.native_id)
    r.native.status = live.get(r.native_id) ?? null
  }
  return { entries, aux: { prompts }, scanned, parsed }
}

// The last messages, from the tail of the file only: a transcript can run to
// tens of megabytes and the drawer wants eight lines of it.
export function messages(record, limit = 8) {
  const text = readTail(record.transcript_path, 4 * 1024 * 1024)
  return messagesFromLines(text.split('\n'), limit)
}

// `claude --resume <session-id>` (claude --help, 2.1.273: "-r, --resume [value]
// Resume a conversation by session ID"). The picker filters by cwd, and the
// id form does not, but the conversation's files live in its cwd, so that is
// where Leg starts it.
export function resume(record) {
  if (!ID_RE.test(record.native_id)) return { supported: false, reason: 'the session id is not one claude --resume accepts' }
  return { supported: true, agent: 'claude', args: ['--resume', record.native_id] }
}

export const transcript = 'supported'
