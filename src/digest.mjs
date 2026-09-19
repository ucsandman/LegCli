// digest — what happened while you were away, from what is already on disk.
//
// The audit trail (src/audit.mjs) is the flat list of who did what. This is
// the other question a person asks at a desk after eight hours off: which
// terminals are still mine, what needs me now, which walls hit and where each
// terminal went, what landed, and what a card came back with. Grouped by
// repository, attention first, every count beside the volume it was read
// from. Nothing new is recorded here.
//
// Owner only on a shared board (src/server.mjs): it names repositories,
// prompts and people.
import { listSessions, readEvents as readSessionEvents, readLandings, isActive } from './sessions.mjs'
import { listCards, readEvents as readCardEvents } from './store.mjs'
import { listUsage, wallActive, fmtReset } from './usage.mjs'
import { canonPath } from './fsx.mjs'

export const DEFAULT_SINCE = '8h'
const shortId = (id) => String(id ?? '').split('-').pop()
const ms = (iso) => { const n = Date.parse(iso ?? ''); return Number.isFinite(n) ? n : null }

// `8h`, `30m`, `2d`, or an ISO timestamp. Anything else is refused by name:
// a window nobody asked for is a wrong number in disguise.
export function parseSince(value, nowMs = Date.now()) {
  const s = String(value ?? DEFAULT_SINCE).trim()
  const m = /^(\d+)(m|h|d)$/i.exec(s)
  if (m) return nowMs - parseInt(m[1], 10) * { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()]
  const iso = Date.parse(s)
  if (Number.isFinite(iso)) return iso
  throw new Error(`bad --since "${s}" (8h, 30m, 2d, or an ISO time)`)
}

// The events a person wants to see per terminal, in the order they happened.
const NOTED = new Set(['limit', 'handoff', 'all_out', 'lost', 'ended', 'landed', 'bounced', 'continued', 'harness_blocked'])

function terminalEntry(s, sinceMs) {
  const events = readSessionEvents(s.session_id)
  const inWindow = events.filter((e) => (ms(e.ts) ?? 0) >= sinceMs)
  const noted = inWindow.filter((e) => NOTED.has(e.type)).map((e) => ({ at: e.ts, type: e.type, summary: String(e.summary ?? '') }))
  const errors = inWindow.filter((e) => e.type === 'error').length
  // a human being waited on (from the Notification hook) or the all-out clock;
  // only while the terminal is live: a dead terminal waits on nobody
  const waiting = isActive(s) && s.waiting && typeof s.waiting === 'object'
    ? { type: s.waiting.type ?? null, message: s.waiting.message ?? null, since: s.waiting.since ?? null, resets_at: s.waiting.resets_at ?? null, agent: s.waiting.agent ?? null, account: s.waiting.account ?? null }
    : null
  return {
    session_id: s.session_id, short: shortId(s.session_id),
    agent: s.agent, account: s.account, model: s.model ?? null, status: s.status,
    started_at: s.started_at, ended_at: s.ended_at ?? null, exit_code: s.exit_code ?? null,
    live: isActive(s),
    task: s.task ? String(s.task).replace(/\s+/g, ' ').slice(0, 160) : null,
    branch: s.branch ?? null, worktree: Boolean(s.worktree),
    turns: s.turns ?? 0, files_touched: (s.files_touched ?? []).length, ahead: s.ahead ?? null,
    waiting, errors, events: inWindow.length, noted,
  }
}

function cardEntry(c, sinceMs) {
  const events = readCardEvents(c.card_id)
  const inWindow = events.filter((e) => (ms(e.ts) ?? 0) >= sinceMs)
  const last = inWindow.length ? inWindow[inWindow.length - 1] : null
  return {
    card_id: c.card_id, title: c.title ?? String(c.task ?? '').replace(/\s+/g, ' ').slice(0, 120),
    status: c.status, station: c.station, leg: c.leg ?? 0,
    updated_at: c.updated_at ?? null,
    events: inWindow.length,
    last: last ? { at: last.ts, type: last.type, summary: String(last.summary ?? '') } : null,
    bounce_reason: c.bounce_reason ?? null, land_attempts: c.land_attempts ?? 0,
  }
}

// → { since, until, volume, attention, repos, walls }
export function buildDigest({ since = DEFAULT_SINCE, now = Date.now(), sessions = null, cards = null, landings = null, usage = null } = {}) {
  const sinceMs = typeof since === 'number' ? since : parseSince(since, now)
  const allSessions = sessions ?? listSessions()
  const allCards = cards ?? listCards()
  const allLandings = landings ?? readLandings()
  const allUsage = usage ?? listUsage()

  // a terminal counts when it moved in the window or is still live now
  const terminals = allSessions
    .filter((s) => isActive(s) || (ms(s.updated_at) ?? 0) >= sinceMs || (ms(s.ended_at) ?? 0) >= sinceMs)
    .map((s) => terminalEntry(s, sinceMs))
  const cardRows = allCards
    .filter((c) => (ms(c.updated_at) ?? 0) >= sinceMs || ['running', 'handing_off', 'queued', 'waiting_human', 'needs_approval', 'paused'].includes(c.status))
    .map((c) => cardEntry(c, sinceMs))
  // landings.jsonl keeps bounces too (status 'bounced'); only what reached
  // trunk is a landing. A line from before `status` existed carries `reason`
  // only when it bounced.
  const landed = allLandings.filter((l) => (ms(l.ts) ?? 0) >= sinceMs && (l.status ?? (l.reason ? 'bounced' : 'landed')) === 'landed')
    .map((l) => ({ at: l.ts, repo: l.repo ?? null, session_id: l.session_id ?? null, short: shortId(l.session_id), agent: l.agent ?? null, by: l.by ?? null, commits: Array.isArray(l.commits) ? l.commits.length : null, summary: l.what ?? null }))

  // group by repository; a terminal outside any repo groups under its cwd
  const groups = new Map()
  const groupFor = (repo, name) => {
    const key = repo ? (() => { try { return canonPath(repo) } catch { return String(repo).toLowerCase() } })() : '(no repository)'
    if (!groups.has(key)) groups.set(key, { repo: repo ?? null, repo_name: name ?? repo ?? '(no repository)', terminals: [], cards: [], landed: [] })
    return groups.get(key)
  }
  for (const t of terminals) {
    const s = allSessions.find((x) => x.session_id === t.session_id)
    groupFor(s.repo ?? s.cwd ?? null, s.repo_name ?? s.cwd ?? null).terminals.push(t)
  }
  for (const c of cardRows) {
    const card = allCards.find((x) => x.card_id === c.card_id)
    groupFor(card.repo ?? null, card.repo ? String(card.repo).split(/[\\/]/).filter(Boolean).pop() : null).cards.push(c)
  }
  for (const l of landed) groupFor(l.repo, l.repo ? String(l.repo).split(/[\\/]/).filter(Boolean).pop() : null).landed.push(l)
  const repos = [...groups.values()].sort((a, b) => String(a.repo_name).localeCompare(String(b.repo_name)))
  for (const g of repos) {
    g.terminals.sort((a, b) => (a.live === b.live ? String(b.started_at).localeCompare(String(a.started_at)) : a.live ? -1 : 1))
    g.landed.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  // what needs a person, most urgent first: a question on a live terminal,
  // a card parked for a human, a failed card, a terminal that was lost
  const attention = []
  for (const t of terminals) {
    if (t.waiting && t.waiting.type && t.waiting.type !== 'reset') attention.push({ kind: 'waiting_on_you', id: t.session_id, short: t.short, agent: t.agent, account: t.account, since: t.waiting.since, message: t.waiting.message, rank: 0 })
    else if (t.waiting && t.waiting.type === 'reset') attention.push({ kind: 'all_out', id: t.session_id, short: t.short, agent: t.agent, account: t.account, since: t.waiting.since, resets_at: t.waiting.resets_at, message: `every option is out; waiting for ${t.waiting.agent ?? '?'}${t.waiting.account && t.waiting.account !== 'default' ? '/' + t.waiting.account : ''}`, rank: 2 })
    else if (t.status === 'lost' && (ms(t.ended_at) ?? 0) >= sinceMs) attention.push({ kind: 'lost', id: t.session_id, short: t.short, agent: t.agent, account: t.account, since: t.ended_at, message: 'the terminal closed or crashed; its bundle is on disk', rank: 4 })
  }
  for (const c of cardRows) {
    if (['waiting_human', 'needs_approval', 'paused'].includes(c.status)) attention.push({ kind: 'card_' + c.status, id: c.card_id, short: shortId(c.card_id), since: c.updated_at, message: `${c.title} is ${c.status.replace('_', ' ')} at ${c.station}`, rank: 1 })
    else if (c.status === 'failed' && (ms(c.updated_at) ?? 0) >= sinceMs) attention.push({ kind: 'card_failed', id: c.card_id, short: shortId(c.card_id), since: c.updated_at, message: `${c.title} failed at ${c.station}${c.last ? ': ' + c.last.summary.slice(0, 120) : ''}`, rank: 3 })
  }
  attention.sort((a, b) => a.rank - b.rank || String(a.since ?? '').localeCompare(String(b.since ?? '')))

  // logins that are out right now, account-wide or per model
  const nowS = Math.floor(now / 1000)
  const walls = []
  for (const u of allUsage) {
    if (u.limited_until && u.limited_until > nowS) walls.push({ agent: u.agent, account: u.account, model: null, until: u.limited_until, reason: u.limited_reason ?? 'limit' })
    for (const [model, w] of Object.entries(u.walls ?? {})) if (wallActive(w, nowS)) walls.push({ agent: u.agent, account: u.account, model, until: w.limited_until, reason: w.limited_reason ?? 'limit' })
  }
  walls.sort((a, b) => (a.until ?? 0) - (b.until ?? 0))

  return {
    since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(),
    // L2: the verdict carries the volume it was read from
    volume: {
      terminals: terminals.length, cards: cardRows.length, landings: landed.length,
      events: terminals.reduce((n, t) => n + t.events, 0) + cardRows.reduce((n, c) => n + c.events, 0),
      sessions_on_disk: allSessions.length, cards_on_disk: allCards.length,
    },
    attention, repos, walls,
  }
}

// ---- the terminal rendering ----
const rel = (iso, nowMs) => {
  const t = ms(iso)
  if (t === null) return 'unknown'
  const d = Math.max(0, nowMs - t)
  const m = Math.round(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}
const clock = (iso) => { const t = ms(iso); return t === null ? '?' : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
const login = (agent, account, model = null) => `${agent}${account && account !== 'default' ? '/' + account : ''}${model ? '/' + model : ''}`

export function renderDigest(d, { now = Date.now() } = {}) {
  const out = []
  const v = d.volume
  out.push(`since ${new Date(d.since).toLocaleString()} (${rel(d.since, now)}): ${v.terminals} terminal${v.terminals === 1 ? '' : 's'}, ${v.cards} card${v.cards === 1 ? '' : 's'}, ${v.landings} landing${v.landings === 1 ? '' : 's'}, ${v.events} events read (${v.sessions_on_disk} sessions and ${v.cards_on_disk} cards on disk)`)
  if (!v.terminals && !v.cards && !v.landings) { out.push('nothing moved in that window.'); return out.join('\n') }
  out.push('')
  out.push(d.attention.length ? `needs you: ${d.attention.length}` : 'needs you: nothing')
  for (const a of d.attention) {
    const who = a.agent ? `${a.kind === 'lost' ? 'lost' : a.kind === 'all_out' ? 'all out' : 'waiting on you'} · leg#${a.short} ${login(a.agent, a.account)}` : `card #${a.short}`
    out.push(`  ${who} · ${rel(a.since, now)}${a.message ? ` · ${a.message}` : ''}${a.resets_at ? ` · back ${fmtReset(a.resets_at)}` : ''}`)
  }
  for (const g of d.repos) {
    out.push('')
    out.push(`${g.repo_name}${g.repo && g.repo !== g.repo_name ? `  (${g.repo})` : ''}`)
    for (const t of g.terminals) {
      const state = t.live ? t.status : t.status === 'lost' ? `lost ${rel(t.ended_at, now)}` : `${t.status}${t.exit_code !== null && t.exit_code !== undefined ? ` exit ${t.exit_code}` : ''} ${rel(t.ended_at ?? t.started_at, now)}`
      const facts = [`${t.turns} turn${t.turns === 1 ? '' : 's'}`, t.files_touched ? `${t.files_touched} file${t.files_touched === 1 ? '' : 's'}` : null, Number.isFinite(t.ahead) && t.ahead > 0 ? `+${t.ahead} ahead` : null, t.errors ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : null].filter(Boolean)
      out.push(`  leg#${t.short}  ${login(t.agent, t.account, t.model)}${t.branch ? ` @${t.branch}` : ''}  ${state} · ${facts.join(' · ')}`)
      if (t.task) out.push(`    task: ${t.task}`)
      for (const e of t.noted) out.push(`    ${clock(e.at)}  ${e.type.padEnd(9)} ${e.summary.slice(0, 160)}`)
    }
    for (const c of g.cards) {
      out.push(`  card#${shortId(c.card_id)}  [${c.status}] at ${c.station}  ${c.title}`)
      if (c.last) out.push(`    ${clock(c.last.at)}  ${c.last.type.padEnd(9)} ${c.last.summary.slice(0, 160)}`)
    }
    for (const l of g.landed) out.push(`  landed ${clock(l.at)}  ${l.commits !== null ? `${l.commits} commit${l.commits === 1 ? '' : 's'} ` : ''}by leg#${l.short}${l.agent ? ` (${l.agent})` : ''}${l.by ? `, Land pressed by ${l.by}` : ''}`)
  }
  if (d.walls.length) {
    out.push('')
    out.push('walls standing now:')
    for (const w of d.walls) out.push(`  ${login(w.agent, w.account, w.model)}  ${w.reason} until ${fmtReset(w.until)}`)
  }
  return out.join('\n')
}
