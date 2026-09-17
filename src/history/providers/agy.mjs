// Antigravity (agy) discovery — what `~/.gemini/antigravity-cli` keeps, read only.
// Observed live, agy 1.2.0 (2026-09-16):
//   history.jsonl   {display, timestamp (ms), workspace, conversationId, type?}
//     per prompt: the only plain-text record of what was asked and where. One
//     conversation is the group of lines sharing a conversationId.
//   annotations/<conversationId>.pbtxt   one line of protobuf text, `title:"…"`:
//     the title agy gave the conversation.
//   presence/<conversationId>.lock   zero bytes; its mtime is the last activity.
//   conversations/<id>.db and conversation_summaries.db are SQLite and are not
//     opened: the transcript is "unsupported" here rather than read through a
//     database driver Leg does not ship. There is no live marker.
import { join } from 'node:path'
import { LAYOUT } from '../../accounts.mjs'
import { jsonLines, line, isoFromMs, safeStat, safeRead, PROMPT_MAX } from '../common.mjs'

export const name = 'agy'
export const label = 'Antigravity'
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function root(homes = {}) { return homes.agy ?? LAYOUT.agy.home() }

// annotations/<id>.pbtxt → the title, or null
function titleOf(home, id) {
  const text = safeRead(join(home, 'annotations', `${id}.pbtxt`))
  if (!text) return null
  const m = /^title:\s*"((?:[^"\\]|\\.)*)"/m.exec(text)
  if (!m) return null
  return line(m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ')) || null
}

export function scan({ home, prev = {} }) {
  const f = join(home, 'history.jsonl')
  const st = safeStat(f)
  if (!st) return { entries: {}, aux: {}, scanned: 0, parsed: 0 }
  const prevEntries = prev.entries ?? {}
  const old = Object.values(prevEntries)[0]
  const unchanged = old && old.mtime === st.mtimeMs && old.size === st.size
  const groups = {}
  if (!unchanged) {
    for (const j of jsonLines(safeRead(f))) {
      if (typeof j.conversationId !== 'string') continue
      const g = groups[j.conversationId] ?? (groups[j.conversationId] = { native_id: j.conversationId, cwd: null, branch: null, title: null, first: null, started_at: null, updated_at: null, transcript_path: null, size_bytes: 0, turns: 0, live: null, native: { version: null, kind: 'conversation' }, _min: Infinity, _max: 0 })
      g.turns += 1
      const ts = Number(j.timestamp)
      if (Number.isFinite(ts)) { g._min = Math.min(g._min, ts); g._max = Math.max(g._max, ts) }
      if (!g.cwd && typeof j.workspace === 'string') g.cwd = j.workspace
      const text = typeof j.display === 'string' ? j.display : ''
      if (!g.first && text && j.type !== 'slash_command' && !text.startsWith('/')) g.first = line(text, PROMPT_MAX)
    }
  }
  // one entry per conversation, all keyed under the one file so a changed file
  // rebuilds them together and a vanished file drops them together
  const entries = {}
  let parsed = unchanged ? 0 : 1
  const list = unchanged ? Object.values(prevEntries).map((e) => e.record) : Object.values(groups)
  for (const g of list) {
    if (!unchanged) {
      g.started_at = isoFromMs(g._min === Infinity ? null : g._min) ?? isoFromMs(st.mtimeMs)
      g.updated_at = isoFromMs(g._max) ?? isoFromMs(st.mtimeMs)
      delete g._min; delete g._max
    }
    if (g.first !== undefined) g.native.first = g.first // kept so a removed annotation falls back to it
    delete g.first
    // the title and the activity mark live one file per conversation. Each is
    // stat'ed every pass and read again only when its own mtime moved: a
    // retitle rewrites the file in place and a turn touches the lock, and
    // neither changes the directory's mtime, so the directory is no signal.
    const key = `${f}#${g.native_id}`
    const anno = safeStat(join(home, 'annotations', `${g.native_id}.pbtxt`))?.mtimeMs ?? 0
    const presence = safeStat(join(home, 'presence', `${g.native_id}.lock`))?.mtimeMs ?? 0
    const was = prevEntries[key]
    if (unchanged && was && was.anno === anno && was.presence === presence) { entries[key] = was; continue }
    g.title = titleOf(home, g.native_id) ?? g.native.first ?? null
    if (presence > (Date.parse(g.updated_at ?? 0) || 0)) g.updated_at = isoFromMs(presence)
    if (unchanged) parsed += 1
    entries[key] = { mtime: st.mtimeMs, size: st.size, anno, presence, record: g }
  }
  return { entries, aux: {}, scanned: 1, parsed }
}

export function messages() { return null }

// `agy --conversation <id>` (agy --help, 1.2.0: "--conversation  Resume a
// previous conversation by ID"). agy works from the workspace it was given,
// so Leg starts it in the conversation's own workspace.
export function resume(record) {
  if (!ID_RE.test(record.native_id)) return { supported: false, reason: 'the conversation id is not one agy --conversation accepts' }
  return { supported: true, agent: 'agy', args: ['--conversation', record.native_id] }
}

export const transcript = 'unsupported'
