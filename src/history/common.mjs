// history/common — the small toolkit every discovery provider shares. A
// provider reads another agent's store and never writes into it, so every
// helper here is read-only, bounded (never the whole of a 200 MB transcript
// for one title) and forgiving (a torn last line, a BOM, a directory where a
// file was expected, all come back as "nothing", never as a throw that would
// take the other providers down with it).
import { existsSync, openSync, readSync, closeSync, fstatSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { redact } from '../redact.mjs'
import { canonPath } from '../fsx.mjs'

export const HEAD_BYTES = 256 * 1024
export const TAIL_BYTES = 256 * 1024
export const TITLE_MAX = 200
export const PROMPT_MAX = 300

export function safeStat(p) { try { return statSync(p) } catch { return null } }
export function safeList(dir) { try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] } }
export function safeRead(p) { try { return readFileSync(p, 'utf8') } catch { return null } }

// The first `bytes` of a file as text. A BOM is dropped; a partial trailing
// line is left in (the caller splits on newline and ignores what fails to parse).
export function readHead(path, bytes = HEAD_BYTES) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const n = Math.min(bytes, size)
    if (!n) return ''
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, 0)
    return buf.toString('utf8').replace(/^\uFEFF/, '')
  } catch { return '' } finally { if (fd !== null) { try { closeSync(fd) } catch {} } }
}

// The last `bytes` of a file as text, cut at the first newline so the first
// returned line is whole.
export function readTail(path, bytes = TAIL_BYTES) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (!size) return ''
    const n = Math.min(bytes, size)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)
    const text = buf.toString('utf8')
    if (n < size) { const nl = text.indexOf('\n'); return nl === -1 ? '' : text.slice(nl + 1) }
    return text.replace(/^\uFEFF/, '')
  } catch { return '' } finally { if (fd !== null) { try { closeSync(fd) } catch {} } }
}

// JSONL text → parsed objects; a line that is not JSON (torn, corrupt) is skipped.
export function jsonLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* torn or corrupt line */ }
  }
  return out
}

// One line of redacted, single-spaced text, cut to `max`. Everything a record
// carries as prose goes through here, so the on-disk index never holds a key
// an agent printed (by shape, or by being a value this process holds in a
// well-known variable) and never holds a whole message.
export function line(text, max = TITLE_MAX) {
  const s = redact(String(text ?? '')).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function isoOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function isoFromMs(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null }

// Where a checkout's git lives, without spawning git: walk up from `dir` to
// the first `.git` entry. A linked worktree has `.git` as a FILE naming the
// main repository's admin dir, so both the worktree and the repo it belongs to
// come out of one read. null when `dir` is not inside a repository, or does
// not exist at all (a conversation from a folder that has since been deleted
// still lists; it just has no repo to group under).
export function gitRootOf(dir) {
  if (!dir || !isAbsolute(dir)) return null
  let cur = resolve(dir)
  if (!existsSync(cur)) return null
  for (let i = 0; i < 64; i++) {
    const dotGit = join(cur, '.git')
    const st = safeStat(dotGit)
    if (st?.isDirectory()) return { repo: cur, worktree: null }
    if (st?.isFile()) {
      const text = safeRead(dotGit) ?? ''
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
      if (!m) return { repo: cur, worktree: null }
      const gitdir = resolve(cur, m[1].trim())
      const wt = /^(.*)[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir)
      // <repo>/.git/worktrees/<name> → the repo is the parent of that .git
      if (wt) return { repo: dirname(wt[1]), worktree: cur }
      return { repo: cur, worktree: null }
    }
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

export function repoNameOf(repo) { return repo ? String(repo).split(/[\\/]/).filter(Boolean).pop() ?? null : null }

export function sameDir(a, b) {
  if (!a || !b) return false
  try { return canonPath(a) === canonPath(b) } catch { return String(a).toLowerCase() === String(b).toLowerCase() }
}

export function canonOrNull(p) { if (!p) return null; try { return canonPath(p) } catch { return null } }
