// limits — classify how a leg ended. Built from fixtures/limits/**/*.json,
// each tagged observed-live or docs-only with the command or URL that produced
// it; docs/cli-contracts.md's Limit signals table is generated from the same
// files (scripts/limits-table.mjs). Only explicit signals become `limit`;
// everything else that stops early is still handed off, under a truer name.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'limits')

export const OUTCOMES = ['completed', 'incomplete', 'no_progress', 'limit', 'stalled',
  'auth_failed', 'launch_failed', 'killed', 'failed']

function loadSignals() {
  const out = []
  for (const dir of readdirSync(FIXTURES).sort()) {
    for (const file of readdirSync(join(FIXTURES, dir)).sort()) {
      if (!file.endsWith('.json')) continue
      const s = JSON.parse(readFileSync(join(FIXTURES, dir, file), 'utf8'))
      for (const k of ['id', 'adapter', 'source', 'produced_by', 'where', 'text', 'classification']) {
        if (s[k] === undefined) throw new Error(`fixture ${dir}/${file} missing ${k}`)
      }
      s.re = new RegExp(s.pattern ?? s.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      s.group = dir
      out.push(s)
    }
  }
  return out
}

export const SIGNALS = loadSignals()

const AUTH_SOURCE_RE = /another auth source is set/i

function haystack(where, input) {
  const stdout = input.stdout ?? ''
  const stderr = input.stderr ?? ''
  const result = input.result ? (typeof input.result === 'string' ? input.result : JSON.stringify(input.result)) : ''
  if (where === 'stdout') return stdout
  if (where === 'stderr') return stderr
  if (where === 'result.json') return result
  if (where === 'exit_code') return ''
  return `${stdout}\n${stderr}\n${result}`
}

function matches(s, input) {
  if (s.where === 'exit_code') return s.exit_code !== null && input.exitCode === s.exit_code
  if (s.re.source === '^$') return false // the empty-stdout negative fixture is handled by the no_progress rule
  return s.re.test(haystack(s.where, input))
}

// Adapter-specific signals first, then generic ("*"), so the signal name in
// the ledger is the most specific one that fired. The bare `fake` adapter
// replays any recorded fixture, so for it every adapter's signals are eligible
// (still before the generic ones); `fake-claude` / `fake-codex` emulate one CLI
// and are classified as that CLI (the runner passes `adapter.emulates`).
function firstMatch(input, classification) {
  const own = SIGNALS.filter((s) => s.adapter === input.adapter && s.classification === classification)
  const others = input.adapter === 'fake'
    ? SIGNALS.filter((s) => s.adapter !== '*' && s.adapter !== 'fake' && s.classification === classification)
    : []
  const generic = SIGNALS.filter((s) => s.adapter === '*' && s.classification === classification)
  return [...own, ...others, ...generic].find((s) => matches(s, input)) ?? null
}

// input: { adapter, exitCode, stdout, stderr, result, doneMarker, diff:{changed,files},
//          killedByTimer, killedByHuman, spawnError }
// → { outcome, signal, handoff, reason }
export function classify(input) {
  const i = { stdout: '', stderr: '', result: null, doneMarker: false, diff: null, ...input }
  const out = (outcome, handoff, reason, signal = 'none') => ({ outcome, signal, handoff, reason })

  if (i.spawnError) return out('launch_failed', true, `spawn error: ${i.spawnError}`)
  if (AUTH_SOURCE_RE.test(i.stderr)) {
    return out('auth_failed', false, 'stderr says another auth source is set (subscription login shadowed)', 'auth-source-set')
  }
  const auth = firstMatch(i, 'auth')
  if (auth) return out('auth_failed', false, `auth signal: ${auth.id}`, auth.id)
  if (i.killedByHuman) return out('killed', false, 'killed from the board')
  if (i.killedByTimer) return out('stalled', true, 'kill timer fired before the leg finished')
  if (i.exitCode === 0 && i.doneMarker) return out('completed', false, 'exit 0 and .baton/DONE present')
  const limit = firstMatch(i, 'limit')
  if (limit) return out('limit', true, `${limit.source} limit signal: ${limit.id}`, limit.id)
  const launch = firstMatch(i, 'launch')
  if (launch) return out('launch_failed', true, `launch signal: ${launch.id}`, launch.id)
  const budget = firstMatch(i, 'budget')
  const signal = budget ? budget.id : 'none'
  const changed = Boolean(i.diff && (i.diff.changed || (i.diff.files ?? 0) > 0))
  if (i.exitCode === 0 && !i.doneMarker && changed) {
    return out('incomplete', true, budget ? `budget signal ${budget.id}; exit 0 with changes but no DONE marker` : 'exit 0 with changes but no DONE marker', signal)
  }
  if (i.exitCode === 0 && !i.doneMarker) {
    return out('no_progress', true, 'exit 0, no DONE marker, no changes', signal)
  }
  return out('failed', true, budget ? `budget signal ${budget.id}; exit ${i.exitCode}` : `exit ${i.exitCode}`, signal)
}
