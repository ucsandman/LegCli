// sessions — the store behind `leg claude|codex|agy`. One directory per
// interactive terminal session under $BATON_HOME/sessions/<id>/:
//   session.json   the live record the board renders (atomic writes)
//   events.jsonl   timeline (started, turn, warning, limit, handoff, ended)
//   control.json   board → runner requests ({ handoff: true })
// The runner (src/attach.mjs) is the only writer of session.json; hooks and
// taps go through recordFromTap() so every write is one atomic replace.
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'
import { scrub } from './redact.mjs'
import { HANDOFF_AGENTS, ALL_HANDOFF_AGENTS, normalizeHandoffOrder } from './preferences.mjs'

export const AGENTS = HANDOFF_AGENTS
export const SUPERVISED_AGENTS = ALL_HANDOFF_AGENTS
export const HANDOFF_ORDER_CAPABILITY = 'handoff_order_v1'
export const SESSION_STATUSES = ['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting', 'handed_off', 'ended', 'lost']
const ACTIVE = ['starting', 'running', 'warning', 'limit', 'handing_off', 'waiting']

const now = () => new Date().toISOString()

export function sessionsRoot() { return join(home(), 'sessions') }
export function sessionDir(id) { return join(sessionsRoot(), id) }

export function newSessionId(agent) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `s-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${agent}-${randomBytes(2).toString('hex')}`
}

export function readSession(id) {
  const f = join(sessionDir(id), 'session.json')
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

export function listSessions() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root).filter((n) => n.startsWith('s-')).sort().map(readSession).filter(Boolean)
}

export function isActive(s) { return ACTIVE.includes(s?.status) }

// The checkout this session's files live in: its own worktree when Leg gave
// it one (repo stays the main checkout, for grouping and landing), else the repo.
export function workRoot(s) { return s?.worktree?.path ?? s?.repo ?? s?.cwd ?? null }

export function createSession({ id, agent, account = 'default', cwd, repo = null, branch = null, argv = [], runner_pid = process.pid, chain = [], worktree = null, owner = null, handoffOrder = AGENTS, installed = null, runtimeCapabilities = [] }) {
  const session = {
    session_id: id, agent, account, cwd, repo, branch, argv, worktree, owner,
    repo_name: repo ? repo.split(/[\\/]/).filter(Boolean).pop() : null,
    status: 'starting', runner_pid, pid: null,
    started_at: now(), updated_at: now(), ended_at: null, last_activity: now(),
    agent_session_id: null, transcript_path: null,
    task: null, turns: 0,
    files_touched: [], files_dirty: [], head: null, head_at_start: null,
    limits: null, limit: null, warning: null,
    bundle: null, handoff: null, chain, checkpoints: [],
    handoff_order: normalizeHandoffOrder(handoffOrder), installed,
    runtime_capabilities: [...new Set(runtimeCapabilities)],
    lineage: { from: null, to: null },
    // the portable-harness outcome for the leg now running (src/harness/index.mjs);
    // null until the feature is enabled and a leg has been prepared
    harness: null,
    exit_code: null,
  }
  mkdirSync(sessionDir(id), { recursive: true })
  writeJsonAtomic(join(sessionDir(id), 'session.json'), session)
  appendEvent(id, { type: 'started', summary: `${agent} (${account}) started in ${cwd}` })
  return session
}

// Patch the record; arrays replace, `merge` deep-merges one level (limits).
// `patch` may be a function (cur) => delta: the read, the compute and the write
// then happen inside one cross-process lock, so concurrent hook/tap/poller
// processes cannot lose an accumulated field (files_touched, turns) to a
// last-writer-wins race. Callers that only set fixed values pass a plain object.
export function updateSession(id, patch, { event } = {}) {
  return withFileLock(join(sessionDir(id), '.session.lock'), () => {
    const cur = readSession(id)
    if (!cur) return null
    const delta = typeof patch === 'function' ? patch(cur) : patch
    const next = { ...cur, ...delta, updated_at: now() }
    if (delta.limits && cur.limits) next.limits = { ...cur.limits, ...delta.limits }
    // every agent conversation this session has been: a hand-off overwrites
    // agent_session_id with the next agent's, and history (src/history) still
    // needs to know the earlier legs were this session's too
    if (delta.agent_session_id && delta.agent_session_id !== cur.agent_session_id) {
      const seen = cur.agent_sessions ?? []
      if (!seen.some((x) => x.agent === next.agent && x.agent_session_id === delta.agent_session_id)) {
        next.agent_sessions = [...seen, { agent: next.agent, agent_session_id: delta.agent_session_id, transcript_path: delta.transcript_path ?? null, at: now() }].slice(-24)
      }
    }
    writeJsonAtomic(join(sessionDir(id), 'session.json'), next)
    if (event) appendEvent(id, event)
    return next
  })
}

export function appendEvent(id, ev) {
  const dir = sessionDir(id)
  if (!existsSync(dir)) return
  const line = { ts: now(), session_id: id, ...ev, summary: scrub(String(ev.summary ?? '')) }
  if (line.body) line.body = scrub(String(line.body)).slice(0, 4000)
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(line) + '\n')
}

export function readEvents(id) {
  const f = join(sessionDir(id), 'events.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// Board → runner. The runner polls this file; a consumed request is deleted.
// Merge, never replace: an `end` and a later `handoff` (or a second board
// command in the same poll window) both survive to be seen by takeControl,
// instead of the second write silently dropping the first.
export function requestControl(id, req) {
  const f = join(sessionDir(id), 'control.json')
  return withFileLock(join(sessionDir(id), '.control.lock'), () => {
    let existing = {}
    if (existsSync(f)) { try { existing = JSON.parse(readFileSync(f, 'utf8')) } catch {} }
    writeJsonAtomic(f, { ...existing, ...req, requested_at: now() })
  })
}
export function takeControl(id) {
  const f = join(sessionDir(id), 'control.json')
  return withFileLock(join(sessionDir(id), '.control.lock'), () => {
    if (!existsSync(f)) return null
    let req = null
    try { req = JSON.parse(readFileSync(f, 'utf8')) } catch {}
    rmSync(f, { force: true })
    return req
  })
}

export function removeSession(id) { rmSync(sessionDir(id), { recursive: true, force: true }) }

// Land state for one session: land.json is written by the board server only
// (the runner owns session.json), so a land result never races a tap write.
export function readLand(id) {
  const f = join(sessionDir(id), 'land.json')
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}
export function writeLand(id, land) {
  if (!existsSync(sessionDir(id))) return
  writeJsonAtomic(join(sessionDir(id), 'land.json'), land)
}

// Hand-off requests from another human (share mode). Server-owned, like land.json.
export function readRequests(id) {
  const f = join(sessionDir(id), 'requests.json')
  if (!existsSync(f)) return []
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(j) ? j : [] } catch { return [] }
}
export function writeRequests(id, list) {
  if (!existsSync(sessionDir(id))) return
  writeJsonAtomic(join(sessionDir(id), 'requests.json'), list.slice(-20))
}

// Who landed what: one line per landing, kept after the session is removed.
const landingsFile = () => join(home(), 'landings.jsonl')
export function appendLanding(entry) {
  mkdirSync(home(), { recursive: true })
  appendFileSync(landingsFile(), JSON.stringify({ ts: now(), ...entry }) + '\n')
}
export function readLandings() {
  if (!existsSync(landingsFile())) return []
  return readFileSync(landingsFile(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

export function pidAlive(pid) {
  if (!pid) return false
  // EPERM means the process exists but is not ours to signal (e.g. an elevated
  // terminal): it is alive. Only ESRCH ("no such process") means gone.
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// A session whose runner process is gone (terminal closed, crash) is marked
// lost so the board never shows a dead terminal as live.
export function reapLost(sessions = listSessions()) {
  const out = []
  for (const s of sessions) {
    if (isActive(s) && !pidAlive(s.runner_pid)) {
      out.push(updateSession(s.session_id, { status: 'lost', ended_at: now() }, { event: { type: 'lost', summary: `runner pid ${s.runner_pid} is gone; session marked lost` } }) ?? s)
    } else out.push(s)
  }
  return out
}

// Two live sessions on one repo touching the same file: both get flagged.
export function overlaps(sessions) {
  const live = sessions.filter(isActive).filter((s) => s.repo)
  const out = new Map()
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]; const b = live[j]
      if (a.repo.toLowerCase() !== b.repo.toLowerCase()) continue
      const setB = new Set([...(b.files_touched ?? []), ...(b.files_dirty ?? [])])
      const shared = [...new Set([...(a.files_touched ?? []), ...(a.files_dirty ?? [])])].filter((f) => setB.has(f))
      if (!shared.length) continue
      // separate: each has its own checkout, so the clash waits for the second landing
      const separate = String(workRoot(a)).toLowerCase() !== String(workRoot(b)).toLowerCase()
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!out.has(x.session_id)) out.set(x.session_id, [])
        out.get(x.session_id).push({ session_id: y.session_id, agent: y.agent, files: shared, separate })
      }
    }
  }
  return out
}
