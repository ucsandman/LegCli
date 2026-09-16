// What one terminal card's drawer shows: the agent's last messages, the files
// this session changed, and the diff for one of them. Read-only, and every
// string is scrubbed on the way out: a transcript and a diff can both carry a
// key the agent printed, and neither has ever left this machine before.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { readEvents, workRoot } from './sessions.mjs'
import { realPath } from './fsx.mjs'
import { scrub } from './redact.mjs'
import { transcriptTail as claudeTail } from './taps/claude.mjs'
import { transcriptTail as codexTail } from './taps/codex.mjs'
import { resumeVerdict, verdictForBoard } from './resume.mjs'

export const MESSAGE_LIMIT = 8
export const DIFF_MAX_LINES = 400
export const EVENT_LIMIT = 200

export class DiffInputError extends Error {}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return null }
}

// A path the session recorded (relative, or absolute in another form: a short
// 8.3 prefix, a symlinked temp dir) → its path inside this session's own tree,
// or null when it is not in that tree at all.
function insideRoot(root, file) {
  if (!root || !file) return null
  const rootR = realPath(root)
  const absR = realPath(isAbsolute(file) ? file : resolve(rootR, file))
  const rel = relative(rootR, absR)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return { rel: rel.split(sep).join('/'), abs: absR }
}

export function sessionMessages(session, limit = MESSAGE_LIMIT) {
  const path = session?.transcript_path
  if (!path) return []
  const tail = session.agent === 'claude' ? claudeTail(path, limit)
    : session.agent === 'codex' ? codexTail(path, limit)
      : [] // agy keeps no transcript Leg can read
  return tail.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: scrub(m.text), ts: m.ts ?? null }))
}

// path → {adds, dels} for everything git can compare against HEAD. A file the
// agent created is not in here; it is still listed, with no counts.
function numstat(root) {
  const out = git(root, ['diff', '--numstat', 'HEAD'])
  const counts = new Map()
  for (const line of (out ?? '').split('\n')) {
    const [adds, dels, path] = line.split('\t')
    if (!path) continue
    counts.set(path.trim(), { adds: Number(adds) || 0, dels: Number(dels) || 0 })
  }
  return counts
}

// Is this a path git already has? A file with no counts against HEAD is either
// one the agent created (nobody tracks it, ignored files included) or one that
// already landed in a commit, and the drawer must not call those the same.
function isTracked(root, rel) {
  const out = git(root, ['ls-files', '--error-unmatch', '--', rel])
  return typeof out === 'string' && out.trim().length > 0
}

export function sessionFiles(session) {
  const root = workRoot(session)
  if (!root) return []
  const counts = numstat(root)
  const dirty = new Set()
  for (const f of session.files_dirty ?? []) { const i = insideRoot(root, f); if (i) dirty.add(i.rel) }
  const files = new Map()
  for (const f of [...(session.files_touched ?? []), ...(session.files_dirty ?? [])]) {
    const i = insideRoot(root, f)
    if (!i || files.has(i.rel)) continue
    const c = counts.get(i.rel) ?? null
    const state = c ? 'modified' : (isTracked(root, i.rel) ? 'committed' : 'new')
    files.set(i.rel, { path: i.rel, adds: c?.adds ?? null, dels: c?.dels ?? null, dirty: dirty.has(i.rel), state })
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function sessionDiff(session, file) {
  const root = workRoot(session)
  if (!root) throw new DiffInputError('this terminal has no repository to diff')
  const inside = insideRoot(root, String(file ?? ''))
  if (!inside) throw new DiffInputError('that file is not in this terminal\'s tree')
  let out = git(root, ['diff', 'HEAD', '--', inside.rel]) ?? ''
  let state = 'modified'
  if (!out.trim()) {
    // nothing to compare against is not one situation: the agent created this
    // file, or it already landed in a commit, or it is gone. Say which.
    const isFile = existsSync(inside.abs) && statSync(inside.abs).isFile()
    if (isFile && !isTracked(root, inside.rel)) {
      let body = ''
      try { body = readFileSync(inside.abs, 'utf8') } catch { body = '' }
      if (body) out = `--- /dev/null\n+++ b/${inside.rel}\n` + body.split('\n').map((l) => '+' + l).join('\n')
      state = 'new'
    } else state = existsSync(inside.abs) ? 'committed' : 'gone'
  }
  const lines = scrub(out).split('\n')
  const truncated = lines.length > DIFF_MAX_LINES
  return { file: inside.rel, diff: lines.slice(0, DIFF_MAX_LINES).join('\n'), truncated, state }
}

// Is the resume pointer in this terminal's checkout still describing the repo
// the reader will find? Recomputed from git on every drawer poll, and handed
// over without its local paths: a screenshot of the drawer travels further
// than this machine.
function resumeFor(session) {
  const root = workRoot(session)
  if (!root) return null
  try { return verdictForBoard(resumeVerdict(root)) } catch { return null }
}

export function sessionDetail(session) {
  return {
    session_id: session.session_id,
    messages: sessionMessages(session),
    files: sessionFiles(session),
    events: readEvents(session.session_id).slice(-EVENT_LIMIT),
    bundle: session.bundle ?? null,
    resume: resumeFor(session),
    ts: new Date().toISOString(),
  }
}
