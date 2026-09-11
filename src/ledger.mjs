#!/usr/bin/env node
// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
// ledger — the ONLY writer of Baton's card ledger files under $BATON_HOME/cards/<id>/.
// Subcommands: create | append | update | sync. Every event carries a validated
// actor, the card id, the station and the leg, and lands in that actor's own
// events-<actor-key>.jsonl. Importable: readEvents, parseActor, actorKey.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'

export const EVENT_TYPES = ['card_created', 'leg_started', 'leg_progress', 'leg_exited',
  'limit_detected', 'handoff_written', 'leg_resumed', 'station_done', 'bounced', 'landed',
  'land_warning', 'land_retry', 'blocked_by', 'scheduler_started', 'scheduler_stopped',
  'approval_needed', 'approved', 'reassigned', 'paused', 'resumed', 'killed', 'done',
  'failed', 'error', 'status']
export const STATUSES = ['backlog', 'queued', 'running', 'handing_off', 'waiting_human',
  'needs_approval', 'paused', 'done', 'failed', 'killed']
const CLOSED = ['done', 'failed', 'killed']
// card.json keys `update --patch` may set (everything else goes through a named flag)
export const PATCHABLE = ['pipeline', 'leases', 'land_attempts', 'land_mode', 'test_command', 'title', 'trunk',
  'bounce_reason', 'kill_requested', 'worktree', 'next_leg', 'handoff_outcome', 'resume_from_bundle', 'failure', 'last_bundle']
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i

export const ROOT = process.env.BATON_HOME || join(homedir(), '.baton')

function die(code, msg) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      die(2, `bad argument pair near "${argv[i]}"`)
    }
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

function need(args, key, allowed) {
  const v = args[key]
  if (!v) die(2, `missing --${key}`)
  if (allowed && !allowed.includes(v)) {
    die(2, `invalid --${key} "${v}" (allowed: ${allowed.join(', ')})`)
  }
  return v
}

// Actor: who wrote the event. {type:'agent', adapter, model?} | {type:'human', id} | {type:'baton'}.
// Returns the normalized actor or null when the shape is wrong.
export function parseActor(raw) {
  let a = raw
  if (typeof raw === 'string') {
    try { a = JSON.parse(raw) } catch { return null }
  }
  if (!a || typeof a !== 'object') return null
  if (a.type === 'agent') {
    if (typeof a.adapter !== 'string' || !NAME_RE.test(a.adapter)) return null
    if (a.model !== undefined && typeof a.model !== 'string') return null
    return a.model === undefined ? { type: 'agent', adapter: a.adapter } : { type: 'agent', adapter: a.adapter, model: a.model }
  }
  if (a.type === 'human') {
    if (typeof a.id !== 'string' || !NAME_RE.test(a.id)) return null
    return { type: 'human', id: a.id }
  }
  if (a.type === 'baton') return { type: 'baton' }
  return null
}

export function actorKey(actor) {
  if (actor.type === 'agent') return `agent-${actor.adapter.toLowerCase()}`
  if (actor.type === 'human') return `human-${actor.id.toLowerCase()}`
  return 'baton'
}

const ACTOR_HELP = 'invalid --actor (expected JSON {"type":"agent","adapter":"<name>"} | {"type":"human","id":"<id>"} | {"type":"baton"})'

function cardDir(id) {
  const dir = join(ROOT, 'cards', id)
  if (!existsSync(join(dir, 'card.json'))) die(3, `card not found: ${id}`)
  return dir
}

function readCard(dir) {
  const file = join(dir, 'card.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    die(2, `corrupt card.json: ${file}`)
  }
}

function writeActive() {
  const cardsRoot = join(ROOT, 'cards')
  const lines = ['# Active cards', '']
  if (existsSync(cardsRoot)) {
    for (const id of readdirSync(cardsRoot).sort()) {
      const file = join(cardsRoot, id, 'card.json')
      if (!existsSync(file)) continue
      let c
      try {
        c = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        process.stderr.write(`warning: skipping corrupt card.json: ${file}\n`)
        continue
      }
      if (CLOSED.includes(c.status)) continue
      lines.push(`- ${c.card_id} [${c.status}] station=${c.station} leg=${c.leg} — ${String(c.task).slice(0, 100)}`)
    }
  }
  if (lines.length === 2) lines.push('(none)')
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, 'ACTIVE.md'), lines.join('\n') + '\n')
}

function appendEvent(id, ev) {
  appendFileSync(join(ROOT, 'cards', id, `events-${actorKey(ev.actor)}.jsonl`),
    JSON.stringify(ev) + '\n')
}

// All writers' events for one card, merged and sorted by ts (stable within a writer).
export function readEvents(id) {
  const dir = join(ROOT, 'cards', id)
  if (!existsSync(dir)) return []
  const events = []
  for (const name of readdirSync(dir).sort()) {
    if (!/^events-.*\.jsonl$/.test(name)) continue
    const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      try { events.push({ ev: JSON.parse(lines[i]), file: name, i }) } catch { continue }
    }
  }
  events.sort((a, b) => (a.ev.ts < b.ev.ts ? -1 : a.ev.ts > b.ev.ts ? 1 : a.file === b.file ? a.i - b.i : a.file < b.file ? -1 : 1))
  return events.map((e) => e.ev)
}

// --- DashClaw sync (best-effort observability; never blocks the ledger) ---
// Endpoint paths live here so phase 9 can point them at the real target.
const SYNC_PATHS = {
  create: '/api/team-tasks',
  events: (id) => `/api/team-tasks/${id}/events`,
  update: (id) => `/api/team-tasks/${id}`,
}

function eventSyncBody(ev) {
  return {
    ts: ev.ts, card_id: ev.card_id, actor: ev.actor, from_agent: actorKey(ev.actor),
    station: ev.station, leg: ev.leg,
    type: ev.type, summary: ev.summary, body: ev.body, action_id: ev.action_id,
  }
}

function loadDashclawConfig() {
  let url = process.env.DASHCLAW_URL
  let key = process.env.DASHCLAW_API_KEY
  if (!url || !key) {
    const envFile = join(ROOT, '.env.dashclaw')
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^\s*(DASHCLAW_URL|DASHCLAW_API_KEY)\s*=\s*(.+?)\s*$/.exec(line)
        if (m) {
          if (m[1] === 'DASHCLAW_URL' && !url) url = m[2]
          if (m[1] === 'DASHCLAW_API_KEY' && !key) key = m[2]
        }
      }
    }
  }
  return url && key ? { url: url.replace(/\/$/, ''), key } : null
}

async function dashclawRequest(cfg, op) {
  const body = JSON.stringify(op.body)
  const url = new URL(cfg.url + op.path)
  const client = url.protocol === 'https:' ? https : http
  return await new Promise((resolvePromise) => {
    const req = client.request(url, {
      method: op.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
        'x-api-key': cfg.key,
      },
      timeout: 5000,
    }, (res) => {
      res.resume()
      res.on('end', () => {
        // 409 on create = already synced; treat as success
        resolvePromise((res.statusCode >= 200 && res.statusCode < 300)
          || (op.op === 'create' && res.statusCode === 409))
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolvePromise(false))
    req.end(body)
  })
}

function bufferUnsynced(cardId, op) {
  appendFileSync(join(ROOT, 'cards', cardId, 'unsynced.jsonl'), JSON.stringify(op) + '\n')
}

async function syncOp(cardId, op) {
  const cfg = loadDashclawConfig()
  if (!cfg) return
  const ok = await dashclawRequest(cfg, op)
  if (!ok) bufferUnsynced(cardId, op)
}

const SECRET_PATTERNS = [
  ['api key (sk-)', /sk-[A-Za-z0-9]{8,}/],
  ['DashClaw key (oc_live_)', /oc_live_[a-f0-9]/],
  ['bearer token', /Bearer\s+[A-Za-z0-9._-]{16,}/],
  ['GitHub token (ghp_)', /ghp_[A-Za-z0-9]{20,}/],
  ['AWS key (AKIA)', /AKIA[0-9A-Z]{12,}/],
  ['Slack token (xox)', /xox[bp]-/],
  ['key=value secret', /api[_-]?key\s*[=:]\s*\S/i],
]

function assertNoSecrets(...values) {
  for (const v of values) {
    if (!v) continue
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(v)) die(2, `refusing to log: value matches a secret pattern (${name})`)
    }
  }
}

function unsyncedFiles(onlyCardId) {
  const cardsRoot = join(ROOT, 'cards')
  if (!existsSync(cardsRoot)) return []
  const ids = onlyCardId ? [onlyCardId] : readdirSync(cardsRoot).sort()
  return ids
    .map((id) => join(cardsRoot, id, 'unsynced.jsonl'))
    .filter((f) => existsSync(f))
}

async function flushUnsynced(onlyCardId) {
  const cfg = loadDashclawConfig()
  let anyRemaining = false
  for (const file of unsyncedFiles(onlyCardId)) {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    const survivors = []
    for (const line of lines) {
      const op = JSON.parse(line)
      const ok = cfg && await dashclawRequest(cfg, op)
      if (!ok) survivors.push(line)
    }
    if (survivors.length) {
      writeFileSync(file, survivors.join('\n') + '\n')
      anyRemaining = true
    } else {
      unlinkSync(file)
    }
  }
  return anyRemaining
}

function parseChain(raw) {
  let chain
  try { chain = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(chain) || chain.length === 0) return null
  const out = []
  for (const entry of chain) {
    if (!entry || typeof entry !== 'object') return null
    if (typeof entry.adapter !== 'string' || !NAME_RE.test(entry.adapter)) return null
    const e = { adapter: entry.adapter, mode: entry.mode ?? null, max_turns: entry.max_turns ?? null }
    if (e.mode !== null && typeof e.mode !== 'string') return null
    if (e.max_turns !== null && !Number.isInteger(e.max_turns)) return null
    if (entry.model !== undefined) e.model = String(entry.model)
    out.push(e)
  }
  return out
}

const now = () => new Date().toISOString()

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (cmd === 'create') {
    const slug = need(args, 'slug')
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(slug)) {
      die(2, `invalid --slug "${slug}" (lowercase alphanumerics and hyphens, max 30)`)
    }
    const task = need(args, 'task')
    const repo = need(args, 'repo')
    const chain = parseChain(need(args, 'chain'))
    if (!chain) die(2, 'invalid --chain (expected a non-empty JSON array of {adapter, mode?, max_turns?, model?})')
    const actor = parseActor(args.actor ?? '{"type":"human","id":"local"}')
    if (!actor) die(2, ACTOR_HELP)
    assertNoSecrets(task, args.title)
    // Pipeline: validated upstream by src/pipeline.mjs (bin/baton.mjs); here
    // only the shape is checked. Default = the `build` preset over the chain.
    let pipeline
    try {
      pipeline = args.pipeline ? JSON.parse(args.pipeline)
        : [{ name: 'build', kind: 'agent', prompt: 'build', chain: chain.map((c) => ({ adapter: c.adapter, ...(c.mode ? { mode: c.mode } : {}), ...(c.max_turns ? { maxTurns: c.max_turns } : {}), ...(c.model ? { model: c.model } : {}) })) }]
    } catch { die(2, 'invalid --pipeline (expected a JSON array of stations)') }
    if (!Array.isArray(pipeline) || !pipeline.length || pipeline.some((s) => !s || typeof s.name !== 'string' || typeof s.kind !== 'string')) {
      die(2, 'invalid --pipeline (expected a non-empty JSON array of {name, kind, chain?, prompt?})')
    }
    let leases = []
    if (args.leases) {
      try { leases = JSON.parse(args.leases) } catch { die(2, 'invalid --leases (expected a JSON array of path globs)') }
      if (!Array.isArray(leases) || leases.some((l) => typeof l !== 'string')) die(2, 'invalid --leases (expected a JSON array of path globs)')
    }
    const landMode = args['land-mode'] ?? 'ff'
    if (!['ff', 'pr'].includes(landMode)) die(2, `invalid --land-mode "${landMode}" (allowed: ff, pr)`)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const id = `card-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${slug}`
    const dir = join(ROOT, 'cards', id)
    if (existsSync(dir)) die(2, `card already exists: ${id}`)
    mkdirSync(join(dir, 'runs'), { recursive: true })
    const card = {
      card_id: id, title: args.title || task.slice(0, 80), task, repo, trunk: args.trunk || 'main', chain,
      pipeline, station: '-', leg: 0, leases, status: 'backlog',
      land_mode: landMode, test_command: args['test-command'] || null, land_attempts: 0,
      worktree: null, bounce_reason: null, kill_requested: false,
      session_id: null, created_at: now(), updated_at: now(), actor,
    }
    writeFileSync(join(dir, 'card.json'), JSON.stringify(card, null, 2) + '\n')
    const createdEvent = {
      ts: now(), card_id: id, actor, station: card.station, leg: card.leg, type: 'card_created',
      summary: `card created (chain=${chain.map((c) => c.adapter).join('>')})`,
    }
    appendEvent(id, createdEvent)
    writeActive()
    await syncOp(id, {
      op: 'create', method: 'POST', path: SYNC_PATHS.create,
      body: { id, instruction: task, title: card.title, repo, chain, status: card.status, actor },
    })
    await syncOp(id, {
      op: 'append', method: 'POST', path: SYNC_PATHS.events(id),
      body: eventSyncBody(createdEvent),
    })
    process.stdout.write(id + '\n')
  } else if (cmd === 'append') {
    const id = need(args, 'card')
    assertNoSecrets(args.summary, args.body)
    const card = readCard(cardDir(id))
    const actor = parseActor(need(args, 'actor'))
    if (!actor) die(2, ACTOR_HELP)
    let leg = card.leg
    if (args.leg !== undefined) {
      leg = parseInt(args.leg, 10)
      if (!Number.isInteger(leg) || leg < 0) die(2, `invalid --leg "${args.leg}"`)
    }
    const ev = {
      ts: now(), card_id: id, actor,
      station: args.station || card.station, leg,
      type: need(args, 'type', EVENT_TYPES),
      summary: need(args, 'summary'),
    }
    if (args.body) ev.body = args.body
    if (args.action) ev.action_id = args.action
    appendEvent(id, ev)
    await syncOp(id, {
      op: 'append', method: 'POST', path: SYNC_PATHS.events(id),
      body: eventSyncBody(ev),
    })
  } else if (cmd === 'update') {
    const id = need(args, 'card')
    const dir = cardDir(id)
    const card = readCard(dir)
    const patch = {}
    if (args.status) {
      card.status = need(args, 'status', STATUSES)
      patch.status = card.status
    }
    if (args['session-id']) {
      card.session_id = args['session-id']
      patch.session_id = card.session_id
    }
    if (args.station) {
      card.station = args.station
      patch.station = card.station
    }
    if (args.leg !== undefined) {
      const leg = parseInt(args.leg, 10)
      if (!Number.isInteger(leg) || leg < 0) die(2, `invalid --leg "${args.leg}"`)
      card.leg = leg
      patch.leg = leg
    }
    if (args.patch) {
      // Orchestrator/board fields; allowlisted so the ledger stays the schema owner.
      let p
      try { p = JSON.parse(args.patch) } catch { die(2, 'invalid --patch (expected a JSON object)') }
      if (!p || typeof p !== 'object' || Array.isArray(p)) die(2, 'invalid --patch (expected a JSON object)')
      for (const k of Object.keys(p)) {
        if (!PATCHABLE.includes(k)) die(2, `--patch key "${k}" not allowed (allowed: ${PATCHABLE.join(', ')})`)
        card[k] = p[k]
        patch[k] = p[k]
      }
    }
    card.updated_at = now()
    writeFileSync(join(dir, 'card.json'), JSON.stringify(card, null, 2) + '\n')
    writeActive()
    await syncOp(id, {
      op: 'update', method: 'PATCH', path: SYNC_PATHS.update(id),
      body: patch,
    })
  } else if (cmd === 'log') {
    // Non-card events (scheduler start/stop): $BATON_HOME/events-<actor-key>.jsonl
    assertNoSecrets(args.summary, args.body)
    const actor = parseActor(need(args, 'actor'))
    if (!actor) die(2, ACTOR_HELP)
    const ev = { ts: now(), card_id: null, actor, station: '-', leg: 0, type: need(args, 'type', EVENT_TYPES), summary: need(args, 'summary') }
    if (args.body) ev.body = args.body
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(join(ROOT, `events-${actorKey(actor)}.jsonl`), JSON.stringify(ev) + '\n')
  } else if (cmd === 'sync') {
    const anyRemaining = await flushUnsynced(args.card)
    process.exit(anyRemaining ? 1 : 0)
  } else {
    die(2, `unknown command "${cmd ?? ''}" (expected create|append|update|log|sync)`)
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) await main()
