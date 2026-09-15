// live-capture — the first time a real limit signal arrives from an agent
// (claude StopFailure, codex usage_limit_exceeded, agy RESOURCE_EXHAUSTED),
// keep the payload with secrets scrubbed, so the docs rows that say
// "docs-only" can become "observed-live" with evidence. One file per
// (agent, signal); a later arrival never overwrites the first. A payload a
// `baton sessions simulate-limit` produced is marked and never captured.
// Where: BATON_LIVE_DIR, else this checkout's fixtures/live/ when it exists
// (a dev clone), else <BATON_HOME>/live/. In a dev clone the matching docs
// rows are flipped in the same call (scripts/live-limits.mjs).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { redact } from './redact.mjs'
import { home } from './store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES_LIVE = join(ROOT, 'fixtures', 'live')
const FLIP_SCRIPT = join(ROOT, 'scripts', 'live-limits.mjs')

// A real limit payload (claude StopFailure, codex, agy) carries cwd,
// transcript_path and scratchpad_dir. redact() strips secret shapes and the
// values of the well-known key variables this process holds; this also folds
// the home and repo roots to placeholders (in every slash form, including the
// doubled backslashes JSON escaping produces) so nothing path-shaped is written
// into a git-tracked fixtures/live/ file.
function redactPaths(s) {
  let out = redact(String(s))
  for (const [root, tag] of [[homedir(), '[redacted-home]'], [ROOT, '[redacted-repo]']]) {
    if (!root) continue
    for (const variant of [root.replace(/\\/g, '\\\\'), root.replace(/\\/g, '/'), root]) out = out.split(variant).join(tag)
  }
  return out
}

export function liveDir() {
  if (process.env.LEG_LIVE_DIR || process.env.BATON_LIVE_DIR) return process.env.LEG_LIVE_DIR || process.env.BATON_LIVE_DIR
  if (existsSync(FIXTURES_LIVE) && existsSync(join(ROOT, '.git'))) return FIXTURES_LIVE
  return join(home(), 'live')
}

export function isSimulated(payload) {
  if (payload && typeof payload === 'object' && (payload.leg_simulated || payload.baton_simulated)) return true
  return /simulated by (?:leg|baton)/i.test(typeof payload === 'string' ? payload : JSON.stringify(payload ?? ''))
}

export function livePath(agent, signal, dir = liveDir()) {
  return join(dir, agent, `limit-${String(signal).replace(/[^a-z0-9_-]+/gi, '_')}.json`)
}

// → { path, written: bool } | null (simulated, or nothing to keep)
export function captureLive(agent, signal, payload, { sessionId = null, flipDocs = true } = {}) {
  if (!agent || !signal || payload === undefined || isSimulated(payload)) return null
  const dir = liveDir()
  const file = livePath(agent, signal, dir)
  if (existsSync(file)) return { path: file, written: false }
  mkdirSync(dirname(file), { recursive: true })
  const record = {
    agent, signal, captured_at: new Date().toISOString(), session_id: sessionId,
    source: 'observed-live',
    payload: JSON.parse(redactPaths(JSON.stringify(payload))),
  }
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  if (flipDocs && dir === FIXTURES_LIVE) {
    try { spawnSync(process.execPath, [FLIP_SCRIPT], { windowsHide: true, encoding: 'utf8', timeout: 8000 }) } catch {}
  }
  return { path: file, written: true }
}
