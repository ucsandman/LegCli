// dashclaw sync — records every ledger event as a DashClaw action over native
// http/https (LESSONS 07-12: no global fetch). Off unless BATON_SYNC_DASHCLAW=1
// and DASHCLAW_URL + DASHCLAW_API_KEY are set. Field names come from
// DashClaw's validator (app/lib/validate.js ACTION_RECORD_SCHEMA): agent_id,
// action_type and declared_goal are required; status is one of running,
// completed, failed, cancelled, pending, pending_approval, blocked.
import http from 'node:http'
import https from 'node:https'

export function dashclawConfig(env = process.env) {
  if ((env.LEG_SYNC_DASHCLAW || env.BATON_SYNC_DASHCLAW) !== '1') return null
  const url = env.DASHCLAW_URL
  const key = env.DASHCLAW_API_KEY
  if (!url || !key) return null
  return { url: url.replace(/\/$/, ''), key }
}

const STATUS_BY_TYPE = {
  card_created: 'pending', leg_started: 'running', leg_progress: 'running', leg_exited: 'completed',
  limit_detected: 'blocked', handoff_written: 'completed', leg_resumed: 'running', station_done: 'completed',
  bounced: 'failed', landed: 'completed', land_warning: 'completed', land_retry: 'running', blocked_by: 'blocked',
  scheduler_started: 'running', scheduler_stopped: 'completed', approval_needed: 'pending_approval', approved: 'completed',
  reassigned: 'completed', paused: 'blocked', resumed: 'running', killed: 'cancelled', done: 'completed',
  failed: 'failed', error: 'failed', status: 'completed',
}

// One ledger event → one action record (the request body).
export function actionForEvent(ev, card = null) {
  const actor = ev.actor ?? { type: 'baton' }
  const agent = actor.type === 'agent' ? `baton/${actor.adapter}` : actor.type === 'human' ? `baton/human:${actor.id}` : 'baton'
  const body = {
    agent_id: agent,
    action_type: `baton_${ev.type}`,
    declared_goal: String(ev.summary ?? ev.type).slice(0, 2000),
    status: STATUS_BY_TYPE[ev.type] ?? 'completed',
    reversible: true,
    risk_score: ev.type === 'landed' ? 40 : ev.type === 'killed' ? 30 : 10,
    trigger: ev.card_id ? `card ${ev.card_id}` : 'scheduler',
    systems_touched: [ev.card_id, card?.repo].filter(Boolean).slice(0, 50),
    input_summary: JSON.stringify({ card_id: ev.card_id, station: ev.station, leg: ev.leg, actor, task: card?.task ?? null }).slice(0, 4000),
    timestamp_start: ev.ts,
    timestamp_end: ev.ts,
  }
  if (ev.body) body.output_summary = String(ev.body).slice(0, 4000)
  return body
}

export function request(cfg, method, path, body, { timeoutMs = 5000 } = {}) {
  const data = JSON.stringify(body ?? {})
  const url = new URL(cfg.url + path)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolvePromise) => {
    const req = client.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close', 'x-api-key': cfg.key },
      timeout: timeoutMs,
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolvePromise({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text }))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', (err) => resolvePromise({ ok: false, status: 0, text: err.message }))
    req.end(data)
  })
}

export async function record(cfg, ev, card) {
  return request(cfg, 'POST', '/api/actions', actionForEvent(ev, card))
}
