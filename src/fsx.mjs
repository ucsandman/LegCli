// fsx — atomic JSON writes that survive Windows. Readers (board, orchestrator,
// tests) poll card.json and run.json; write-then-rename keeps them from seeing
// a torn file, but on Windows a rename over a file another process has open
// fails with EPERM/EBUSY for a moment. Retry briefly, then fall back to a
// direct write rather than lose the record (the supervisor's final run.json
// once went missing this way and the orchestrator read a stale 'running').
import { writeFileSync, renameSync, unlinkSync, existsSync, realpathSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'

// Canonical form for comparing paths: symlinks resolved and, on Windows, 8.3
// short names expanded (a GitHub runner's temp dir is C:\Users\RUNNER~1\...
// while git reports C:\Users\runneradmin\...). A path that does not exist
// yet is canonicalised through its deepest existing ancestor.
export function canonPath(p) {
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
  if (rest.length) out = join(out, ...rest)
  return process.platform === 'win32' ? out.toLowerCase() : out
}

const sleepSync = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } }

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
