// sync fan-out — best effort, off by default, never throws into the ledger.
// The ledger calls notify() after it has written its own files; a sync that
// fails becomes one `status` event (`[sync:<name>] …`) at most once a minute
// and a buffered retry for DashClaw (unsynced.jsonl, flushed by `ledger sync`).
import { existsSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dashclawConfig, record } from './dashclaw.mjs'
import { workboardEnabled, mirror } from './workboard.mjs'

export function enabledSyncs(env = process.env) {
  const out = []
  if (workboardEnabled(env)) out.push('workboard')
  if (dashclawConfig(env)) out.push('dashclaw')
  return out
}

function throttled(home, name, minMs = 60000) {
  const f = join(home, `sync-${name}.last-failure`)
  if (existsSync(f) && Date.now() - statSync(f).mtimeMs < minMs) return true
  writeFileSync(f, new Date().toISOString())
  return false
}

// Called by the ledger. `report(summary)` appends the status event through the
// ledger's own writer (passed in to avoid a circular import).
export async function notify({ kind, ev, card, home, env = process.env, report = () => {} }) {
  const results = {}
  if (workboardEnabled(env) && card && (kind === 'create' || kind === 'status')) {
    try {
      const r = mirror(card.status === 'done' && kind === 'status' ? 'done' : kind, card, { home, env })
      results.workboard = r
      if (r.first_unavailable) report(`[sync:workboard] unavailable (plugin disabled): ${r.message}`)
      else if (r.error && !throttled(home, 'workboard')) report(`[sync:workboard] failed: ${r.error}`)
    } catch (err) {
      results.workboard = { error: err.message }
      if (!throttled(home, 'workboard')) report(`[sync:workboard] failed: ${err.message}`)
    }
  }
  const cfg = dashclawConfig(env)
  if (cfg && ev) {
    try {
      const r = await record(cfg, ev, card)
      results.dashclaw = r
      if (!r.ok) {
        if (ev.card_id) appendFileSync(join(home, 'cards', ev.card_id, 'unsynced.jsonl'), JSON.stringify({ op: 'record', ev, card: card ? { repo: card.repo, task: card.task } : null }) + '\n')
        if (!throttled(home, 'dashclaw')) report(`[sync:dashclaw] failed (${r.status}): ${String(r.text).slice(0, 120)}; buffered`)
      }
    } catch (err) {
      results.dashclaw = { ok: false, text: err.message }
      if (!throttled(home, 'dashclaw')) report(`[sync:dashclaw] failed: ${err.message}`)
    }
  }
  return results
}
