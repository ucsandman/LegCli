// fsx — atomic JSON writes that survive Windows. Readers (board, orchestrator,
// tests) poll card.json and run.json; write-then-rename keeps them from seeing
// a torn file, but on Windows a rename over a file another process has open
// fails with EPERM/EBUSY for a moment. Retry briefly, then fall back to a
// direct write rather than lose the record (the supervisor's final run.json
// once went missing this way and the orchestrator read a stale 'running').
import { writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, openSync, closeSync, statSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'

// Canonical form for comparing paths: symlinks resolved and, on Windows, 8.3
// short names expanded (a GitHub runner's temp dir is C:\Users\RUNNER~1\...
// while git reports C:\Users\runneradmin\...). A path that does not exist
// yet is canonicalised through its deepest existing ancestor.
export function canonPath(p) {
  const out = realPath(p)
  return process.platform === 'win32' ? out.toLowerCase() : out
}

// The real, long-form path (case preserved): what Baton stores and hands to
// git, so a short or symlinked input never leaks into card.json or worktrees.
export function realPath(p) {
  let base = resolve(p)
  const rest = []
  while (!existsSync(base)) {
    const parent = dirname(base)
    if (parent === base) break
    rest.unshift(basename(base))
    base = parent
  }
  let out = base
  try { out = realpathSync.native(base) } catch {}
  return rest.length ? join(out, ...rest) : out
}

const sleepSync = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } }

// Cross-process advisory lock around a read-modify-write of a shared JSON file.
// `openSync(..., 'wx')` is atomic-create, so only one process (a hook, a tap, a
// poller) holds it at a time. A lock older than staleMs (a crashed holder) is
// stolen. If it cannot be acquired within the budget, fn runs anyway rather
// than hang the caller (a Claude Code hook must never block the user's turn).
export function withFileLock(lockPath, fn, { retries = 60, waitMs = 20, staleMs = 5000 } = {}) {
  let fd = null
  for (let i = 0; i < retries; i++) {
    try { fd = openSync(lockPath, 'wx'); break } catch (err) {
      if (err.code !== 'EEXIST') break
      try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue } } catch {}
      sleepSync(waitMs)
    }
  }
  try { return fn() } finally { if (fd !== null) { try { closeSync(fd) } catch {} try { unlinkSync(lockPath) } catch {} } }
}

export function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n'
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text)
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(err.code)) { try { unlinkSync(tmp) } catch {} throw err }
      sleepSync(25)
    }
  }
  try { unlinkSync(tmp) } catch {}
  writeFileSync(file, text)
}
