// fsx — atomic JSON writes that survive Windows. Readers (board, orchestrator,
// tests) poll card.json and run.json; write-then-rename keeps them from seeing
// a torn file, but on Windows a rename over a file another process has open
// fails with EPERM/EBUSY for a moment. Retry briefly, then fall back to a
// direct write rather than lose the record (the supervisor's final run.json
// once went missing this way and the orchestrator read a stale 'running').
import { writeFileSync, renameSync, unlinkSync } from 'node:fs'

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
