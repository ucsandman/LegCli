// workboard sync — mirrors cards to the OpenClaw Workboard through the
// `openclaw workboard` CLI, argv only (node <openclaw.mjs> …, never a shell).
// Off unless BATON_SYNC_WORKBOARD=1. On the build machine the plugin is
// disabled (`plugins.allow` excludes "workboard"; fixtures/sync/workboard-help.txt
// holds the verbatim message), so the verb mapping below is written against
// the argv stub in test/sync.test.mjs. When the plugin is enabled, adjust
// VERBS here from `openclaw workboard --help`; nothing else needs to change.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveNpmCliEntry } from '../adapters/resolve.mjs'

export const VERBS = {
  create: (card) => ['add', '--title', card.title ?? card.task, '--id', card.card_id, '--column', card.status],
  status: (card) => ['move', card.card_id, card.status === 'done' ? 'done' : card.status],
  done: (card) => ['done', card.card_id],
}

export function workboardEnabled(env = process.env) { return (env.LEG_SYNC_WORKBOARD || env.BATON_SYNC_WORKBOARD) === '1' }

export function resolveOpenclaw(env = process.env) {
  if (env.OPENCLAW_BIN && /\.(mjs|cjs|js)$/.test(env.OPENCLAW_BIN)) return { bin: process.execPath, prefix: [env.OPENCLAW_BIN] }
  const entry = resolveNpmCliEntry('openclaw', 'openclaw', { pkgDir: env.OPENCLAW_PKG_DIR })
  if (entry) return { bin: process.execPath, prefix: [entry] }
  return null
}

const UNAVAILABLE_RE = /is unavailable because|plugins\.allow/i

function markerPath(home) { return join(home, 'sync-workboard.unavailable') }

// Returns { ran, argv, unavailable, first_unavailable, error }.
export function mirror(kind, card, { home, env = process.env } = {}) {
  const verb = VERBS[kind]
  if (!verb) return { ran: false, error: `unknown mirror kind ${kind}` }
  const marker = home ? markerPath(home) : null
  if (marker && existsSync(marker)) return { ran: false, unavailable: true, first_unavailable: false }
  const oc = resolveOpenclaw(env)
  if (!oc) return { ran: false, error: 'openclaw not installed (set OPENCLAW_PKG_DIR or OPENCLAW_BIN)' }
  const argv = ['workboard', ...verb(card)]
  const r = spawnSync(oc.bin, [...oc.prefix, ...argv], { windowsHide: true, encoding: 'utf8', timeout: 20000, env })
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (UNAVAILABLE_RE.test(text)) {
    if (marker) writeFileSync(marker, `${new Date().toISOString()} ${text.trim().split('\n')[0]}\n`)
    return { ran: true, argv, unavailable: true, first_unavailable: true, message: text.trim().split('\n')[0] }
  }
  if (r.error || r.status !== 0) return { ran: true, argv, error: (r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) }
  return { ran: true, argv, ok: true }
}

export function unavailableMessage(home) {
  const p = markerPath(home)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
}
