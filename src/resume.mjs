// resume — the pointer that cannot describe a picture that is no longer true.
//
// `.baton/RESUME.md` is the file humans and other agents open by habit. It used
// to be an unowned convenience copy: written once per hand-off, never touched
// again, with no stamp and no expiry, so a normally exited terminal left hours
// old text sitting there looking live.
//
// Two rules fix that, and they are the whole module:
//   1. Every resume file Baton writes carries a stamp of the git state and the
//      live terminals it was written against (an HTML comment, invisible in
//      rendered markdown).
//   2. Freshness is never remembered — it is recomputed from git at READ time.
//      A file cannot lie about HEAD to a reader who re-asks git.
// Baton owns the file: it rewrites it when a session ends and when the board
// starts, so nothing is left describing a terminal that is gone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { canonPath } from './fsx.mjs'
import { isActive, listSessions, reapLost, workRoot } from './sessions.mjs'

export const STAMP_PREFIX = '<!-- leg-resume '
export const LEGACY_STAMP_PREFIX = '<!-- baton-resume '
const STAMP_SUFFIX = ' -->'
const STAMP_VERSION = 1
// Baton's own directories dirty the tree on every write; a reader must not see
// Baton's bookkeeping as the human's work moving on.
const LEG_DIRS = /^(\.leg|\.baton|\.context-handoffs|\.dashclaw-local)[\\/]/
const MAX_REASONS = 5

// fresh and its idle twin are the only states a script should keep going on.
export const EXIT = { fresh: 0, stale: 1, unstamped: 1, missing: 3 }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return r.status === 0 ? r.stdout.trim() : ''
}

// A count and a sorted hash, never the names: a shared board must not leak
// what the human is working on, and a list would make the stamp unbounded.
export function dirtyFingerprint(cwd) {
  const lines = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((f) => !LEG_DIRS.test(f))
    .sort()
  if (!lines.length) return { count: 0, hash: null }
  return { count: lines.length, hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12) }
}

// What git says right now. Every field is null outside a repository, which
// makes a pointer in a non-repo directory permanently undriftable rather than
// permanently stale.
export function gitState(cwd) {
  const head = git(cwd, ['rev-parse', 'HEAD']) || null
  const branch = head ? (git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null) : null
  return { head, short: head ? head.slice(0, 7) : null, branch, dirty: dirtyFingerprint(cwd) }
}

// How many commits landed between the stamp's HEAD and this one. null when the
// two are not on one line of history (a rebase, a reset, a different clone).
function commitsSince(cwd, then) {
  if (!then) return null
  const n = git(cwd, ['rev-list', '--count', `${then}..HEAD`])
  return /^\d+$/.test(n) ? Number(n) : null
}

export function resumeFile(cwd) {
  const leg = join(cwd, '.leg', 'RESUME.md')
  const baton = join(cwd, '.baton', 'RESUME.md')
  if (existsSync(leg)) return leg
  if (existsSync(baton)) return baton
  if (existsSync(join(cwd, '.baton')) && !existsSync(join(cwd, '.leg'))) return baton
  return leg
}
export function perSessionFile(cwd, id) {
  const leg = join(cwd, '.leg', `RESUME-${id}.md`)
  const baton = join(cwd, '.baton', `RESUME-${id}.md`)
  if (existsSync(leg)) return leg
  if (existsSync(baton)) return baton
  if (existsSync(join(cwd, '.baton')) && !existsSync(join(cwd, '.leg'))) return baton
  return leg
}

// An agent started deeper in the tree still finds its checkout's pointer.
export function findResume(startDir) {
  // resolve(), not realPath(). The walk only needs an absolute path, and
  // realPath() also rewrites the spelling: on a Windows host whose temp
  // directory is reached by an 8.3 short name it returns C:\Users\runneradmin
  // for a caller who said C:\Users\RUNNER~1, so the root handed back names a
  // path the caller never used. Two spellings of one checkout are reconciled by
  // canonPath() at the points that compare them, not by quietly renaming the
  // directory the caller asked about.
  let dir = resolve(startDir)
  for (;;) {
    const file = resumeFile(dir)
    if (existsSync(file)) return { root: dir, file }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// ---- the stamp ----

export function renderStamp(stamp) { return STAMP_PREFIX + JSON.stringify(stamp) + STAMP_SUFFIX }

export function readStamp(text) {
  const line = String(text ?? '').split('\n', 1)[0].trim()
  let pfx = null;
  if (line.startsWith(STAMP_PREFIX)) pfx = STAMP_PREFIX;
  else if (line.startsWith(LEGACY_STAMP_PREFIX)) pfx = LEGACY_STAMP_PREFIX;
  if (!pfx || !line.endsWith(STAMP_SUFFIX)) return null;
  try {
    const stamp = JSON.parse(line.slice(pfx.length, -STAMP_SUFFIX.length))
    return stamp && typeof stamp === 'object' ? stamp : null
  } catch { return null }
}

// The text without its stamp: what a human reads and what `baton resume` prints.
export function bodyOf(text) {
  const s = String(text ?? '')
  return readStamp(s) ? s.slice(s.indexOf('\n') + 1).replace(/^\n+/, '') : s
}

// Stamp a body, replacing any stamp it already carries so re-writes never stack.
export function stampBody(stamp, body) { return `${renderStamp(stamp)}\n\n${bodyOf(body).replace(/^\n+/, '')}` }

// The live terminals in one checkout, oldest first. This is the set a pointer
// is written against: when it changes, the pointer is describing a different
// room than the one the reader is standing in.
export function liveIn(root, sessions = listSessions()) {
  const key = canonPath(root)
  return sessions.filter(isActive).filter((s) => { const r = workRoot(s); return r && canonPath(r) === key })
}

function makeStamp({ kind, session, root, why, bundle, live }) {
  const g = gitState(root)
  return {
    v: STAMP_VERSION, kind,
    session: session?.session_id ?? null,
    agent: session?.agent ?? null,
    account: session?.account ?? null,
    head: g.head, branch: g.branch, dirty: g.dirty,
    live: live.map((s) => ({ id: s.session_id, agent: s.agent })),
    bundle: bundle?.id ?? null,
    why: why ?? null,
    written_at: new Date().toISOString(),
  }
}

// ---- writing the pointer ----

function note(session, others) {
  const mine = `This file describes Leg terminal ${session.session_id} (${session.agent}); its own copy is .leg/RESUME-${session.session_id}.md.`
  if (!others.length) return mine
  const rest = others.map((o) => `${o.session_id} (${o.agent}), whose own hand-off would be .leg/RESUME-${o.session_id}.md`).join('; ')
  return `${mine}\nAlso live in this checkout: ${rest}. RESUME.md describes only the terminal named above.`
}

// The hand-off pointer: one stamped body in .baton/RESUME-<session>.md (the
// file the next agent's prompt names) and the same text in RESUME.md (the file
// everyone opens). Returns the text written.
export function writeHandoffPointer(session, body, { bundle = null, why = null } = {}) {
  const root = workRoot(session)
  if (!root) return null
  const dir = existsSync(join(root, '.baton')) && !existsSync(join(root, '.leg')) ? join(root, '.baton') : join(root, '.leg')
  mkdirSync(dir, { recursive: true })
  const live = liveIn(root)
  const others = live.filter((s) => s.session_id !== session.session_id)
  const stamp = makeStamp({ kind: 'handoff', session, root, why, bundle, live: live.length ? live : [session] })
  const text = stampBody(stamp, `${note(session, others)}\n\n${bodyOf(body)}`)
  writeFileSync(perSessionFile(root, session.session_id), text)
  try { writeFileSync(resumeFile(root), text) } catch { /* a read-only checkout still gets the per-session file */ }
  return text
}

// The newest hand-off this checkout has seen, for the "nothing in flight"
// pointer to name. Sessions outlive their terminals, so this survives the one
// that wrote the hand-off ending.
export function lastHandoffIn(root, sessions = listSessions()) {
  const key = canonPath(root)
  const when = (s) => s.handoff?.at ?? s.bundle?.updated_at ?? s.ended_at ?? s.updated_at ?? ''
  const rows = sessions
    .filter((s) => { const r = workRoot(s); return r && canonPath(r) === key })
    .filter((s) => s.lineage?.to || s.bundle)
    .sort((a, b) => (when(a) < when(b) ? 1 : -1))
  const s = rows[0]
  if (!s) return null
  const file = perSessionFile(root, s.session_id)
  return {
    session_id: s.session_id, agent: s.agent,
    from: s.lineage?.from ?? s.agent, to: s.lineage?.to ?? null,
    at: when(s) || null, bundle: s.bundle?.id ?? null,
    // a checkpoint bundle is not a hand-off, and only a hand-off leaves a
    // per-session resume file; naming one that was never written is the same
    // class of lie this module exists to stop
    handed_off: Boolean(s.lineage?.to), file: existsSync(file) ? (file.includes('.leg') ? `.leg/RESUME-${s.session_id}.md` : `.baton/RESUME-${s.session_id}.md`) : null,
  }
}

function idleBody(last, live) {
  const lines = ['# Baton: nothing in flight', '']
  lines.push(live.length
    ? `No hand-off is waiting to be picked up here. Still live in this checkout: ${live.map((s) => `${s.session_id} (${s.agent})`).join(', ')}.`
    : 'No Baton terminal is live in this checkout.')
  lines.push('')
  if (last) {
    const at = last.at ? String(last.at).slice(0, 16).replace('T', ' ') : 'an unrecorded time'
    const bundle = last.bundle ? ` (bundle ${last.bundle})` : ''
    lines.push(last.handed_off
      ? `The last hand-off here was ${last.from ?? 'an agent'} -> ${last.to} on ${at}${bundle}, in terminal ${last.session_id}.`
      : `The last bundle saved here was a checkpoint from terminal ${last.session_id} (${last.agent ?? 'an agent'}) on ${at}${bundle}; no agent handed off.`)
    if (last.file) lines.push(`Its full text is still in ${last.file}. It describes that moment, not this one.`)
  } else {
    lines.push('No hand-off has been recorded in this checkout.')
  }
  lines.push('', 'Before you trust any resume file here, run `leg resume --check`: it recomputes freshness from git at read time and exits non-zero when the file no longer matches the repository.')
  lines.push('')
  return lines.join('\n')
}

// The "nothing in flight" pointer. Always writes; the callers that must not
// create a file in a checkout Baton never handed off in check first.
export function writeIdlePointer(root, { sessions = listSessions() } = {}) {
  if (!root) return null
  const dir = existsSync(join(root, '.baton')) && !existsSync(join(root, '.leg')) ? join(root, '.baton') : join(root, '.leg')
  mkdirSync(dir, { recursive: true })
  const live = liveIn(root, sessions)
  const last = lastHandoffIn(root, sessions)
  const stamp = makeStamp({ kind: 'idle', session: null, root, why: 'session ended', bundle: last?.bundle ? { id: last.bundle } : null, live })
  const text = stampBody(stamp, idleBody(last, live))
  writeFileSync(resumeFile(root), text)
  return text
}

// A session ending must not leave its hand-off sitting there looking live.
// Only ever rewrites a pointer that already exists: Baton owns RESUME.md where
// it wrote one, and creates none in a checkout it never handed off in.
export function endSessionPointer(session) {
  const root = workRoot(session)
  if (!root || !existsSync(resumeFile(root))) return null
  return writeIdlePointer(root)
}

// Board start: every checkout Baton wrote a pointer in gets it recomputed, so a
// terminal that crashed instead of exiting cannot leave a live-looking hand-off
// behind. A checkout whose terminal really is live keeps its hand-off text.
// Returns the roots rewritten.
export function refreshPointers() {
  // a crashed terminal still reads `running` until its dead pid is noticed
  const sessions = reapLost()
  const roots = new Map()
  for (const s of sessions) {
    const r = workRoot(s)
    if (r && existsSync(resumeFile(r))) roots.set(canonPath(r), r)
  }
  const touched = []
  for (const root of roots.values()) {
    const v = resumeVerdict(root, { sessions })
    if (v.state === 'fresh') continue
    // The terminal that wrote a hand-off owns it while it is still running: its
    // text is the live description, and "the repo moved on" is for `baton resume
    // --check` to report, not for the board to overwrite. Anything else — a
    // hand-off from a terminal that is gone, a file no Baton stamped — is
    // replaced even when some OTHER terminal happens to be live in the
    // checkout, which is the case that left three day old text sitting there.
    if (v.session?.active) continue
    // the raw root, the way the session recorded it: this list is deduped by
    // canonPath() above and then only logged, so normalising the spelling here
    // renamed the checkout in the log line for no gain
    try { writeIdlePointer(root, { sessions }); touched.push(root) } catch { /* a checkout that moved or went read-only */ }
  }
  return touched
}

// ---- reading the pointer: the verdict, from git, now ----

function describe(list) { return list.map((s) => `${s.id ?? s.session_id} (${s.agent})`).join(', ') }

// Recomputed on every read. Nothing here trusts the file about the present:
// the stamp says what was true when it was written, git says what is true now,
// and the verdict is the difference.
export function resumeVerdict(cwd, { sessions = listSessions() } = {}) {
  const found = findResume(cwd)
  if (!found) {
    return { state: 'missing', exit_code: EXIT.missing, root: null, file: null, kind: null, stamp: null, reasons: ['there is no .baton/RESUME.md in this checkout'], summary: 'no resume pointer in this checkout', head: null, dirty: null, live: null, session: null, written_at: null, age_ms: null }
  }
  const { root, file } = found
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { /* raced a rewrite */ }
  const stamp = readStamp(text)
  if (!stamp) {
    return { state: 'unstamped', exit_code: EXIT.unstamped, root, file, kind: null, stamp: null, reasons: ['this file carries no Baton stamp, so its freshness cannot be checked against git'], summary: 'cannot be checked: no Baton stamp', head: null, dirty: null, live: null, session: null, written_at: null, age_ms: null }
  }

  const now = gitState(root)
  const headMoved = Boolean(stamp.head) && Boolean(now.head) && stamp.head !== now.head
  const since = headMoved ? commitsSince(root, stamp.head) : 0
  const thenDirty = stamp.dirty ?? { count: 0, hash: null }
  const dirtyChanged = (thenDirty.hash ?? null) !== (now.dirty.hash ?? null)
  const live = liveIn(root, sessions)
  const wasLive = Array.isArray(stamp.live) ? stamp.live : []
  const gone = wasLive.filter((w) => !live.some((s) => s.session_id === w.id))
  const started = live.filter((s) => !wasLive.some((w) => w.id === s.session_id))
  const named = stamp.session ? sessions.find((s) => s.session_id === stamp.session) ?? null : null
  const written = stamp.written_at ? Date.parse(stamp.written_at) : NaN

  const reasons = []
  // A hand-off describes a moment in the repository; a commit or an edit since
  // then means the description no longer matches what the reader will see.
  if (stamp.kind === 'handoff') {
    if (headMoved) reasons.push(since === null ? 'HEAD is a different commit than this was written at' : `${since} commit${since === 1 ? '' : 's'} landed since this was written`)
    if (dirtyChanged) reasons.push(`the working tree changed since this was written (${thenDirty.count} uncommitted file${thenDirty.count === 1 ? '' : 's'} then, ${now.dirty.count} now)`)
  }
  // Both kinds claim which terminals are live. That claim is falsifiable now.
  if (gone.length) reasons.push(`terminal ${describe(gone)} is no longer live`)
  if (started.length) reasons.push(`terminal ${describe(started)} started after this was written`)

  const state = reasons.length ? 'stale' : 'fresh'
  const summary = state === 'fresh'
    ? `current${Number.isFinite(written) ? ` (written ${ago(Date.now() - written)})` : ''}`
    : reasons.slice(0, MAX_REASONS).join('; ')
  return {
    state, exit_code: EXIT[state], root, file,
    kind: stamp.kind ?? null, stamp,
    reasons: reasons.slice(0, MAX_REASONS), summary,
    head: { then: stamp.head ?? null, now: now.head, moved: headMoved, commits_since: since, branch: now.branch },
    dirty: { then: thenDirty.count, now: now.dirty.count, changed: dirtyChanged },
    live: live.map((s) => ({ id: s.session_id, agent: s.agent, status: s.status })),
    session: stamp.session ? { id: stamp.session, status: named?.status ?? null, active: Boolean(named && isActive(named)) } : null,
    written_at: stamp.written_at ?? null,
    age_ms: Number.isFinite(written) ? Date.now() - written : null,
  }
}

export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.round(ms / 60000)
  if (m < 1) return 'less than a minute ago'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

// What the board may see: the verdict without the local paths. A guest never
// reaches the drawer, but a screenshot of it travels further than the machine.
export function verdictForBoard(v) {
  if (!v) return null
  const { root, file, stamp, ...rest } = v
  void root; void file; void stamp
  return { ...rest, bundle: stamp?.bundle ?? null, why: stamp?.why ?? null }
}
