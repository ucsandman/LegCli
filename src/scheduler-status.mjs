// scheduler-status — the scheduler's pidfile and its two cheap readers,
// split out of src/scheduler.mjs so a caller that only wants "is the
// scheduler running" (the launcher, `leg status`) does not have to pull in
// the whole orchestrator → land/mergequeue/stations/chain/pipeline/contract/
// commands/runner/limits graph. src/scheduler.mjs re-exports both, so every
// existing import of them keeps working unchanged.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'

export const MAX_CONCURRENT = Math.max(1, parseInt((process.env.LEG_MAX_CONCURRENT || process.env.BATON_MAX_CONCURRENT) || '2', 10) || 2)

export function pidfile() { return join(home(), 'scheduler.pid') }

export function schedulerStatus() {
  const f = pidfile()
  if (!existsSync(f)) return { running: false, pid: null }
  const pid = parseInt(readFileSync(f, 'utf8').trim(), 10)
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  return { running: alive, pid, stale: !alive }
}
