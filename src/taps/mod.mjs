// runtime tap — the optional seam between Leg and an agent runtime that
// publishes structured events about itself while it runs.
//
// Leg's per-agent taps read whatever each CLI happens to leave behind: an
// OAuth usage endpoint, a rollout file, a transcript tail. None of them says
// when a turn ends, so a handoff lands at an arbitrary instant: mid-tool,
// mid-answer, with a subagent still running. A runtime that publishes events
// gives Leg the signal it never had, a safe handoff boundary, plus context
// percentage, the 5h/7d windows, cost and live subagents in one place.
//
// The seam is optional by construction. No events file for a session means
// findEventsFile() returns null, nothing here runs, and Leg behaves exactly as
// it does today. Nothing in Leg may depend on the file existing.
//
// One vocabulary, one place: KIND below is the only spot in Leg that names a
// runtime's own event kinds. deriveSignals() and toLegEvents() consult that
// table; every exported shape (signals, leg events, advice) is Leg's own, so
// supporting a second runtime is a second KIND table and nothing else.
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// The event kinds of the runtime adapter Leg reads today. A kind Leg has no
// use for is simply absent: an unknown kind is counted and ignored.
const KIND = Object.freeze({
  sessionStarted: 'SessionStarted',
  promptSubmitted: 'PromptSubmitted',
  turnStarted: 'TurnStarted',
  turnCompleted: 'TurnCompleted',
  modelStep: 'ModelStep',
  contextChanged: 'ContextChanged',
  toolRequested: 'ToolRequested',
  toolCompleted: 'ToolCompleted',
  subagentStarted: 'SubagentStarted',
  subagentCompleted: 'SubagentCompleted',
  usageChanged: 'UsageChanged',
  errorOccurred: 'ErrorOccurred',
})

// Hand off when any of these is reached AND the runtime is at a clean
// boundary. Context first: a full window degrades an agent long before a
// rate limit stops it. The 5h wall is the one Leg already hands off at, so
// advice fires just under it; the 7d window is a last resort.
export const DEFAULT_THRESHOLDS = Object.freeze({
  contextPercent: 80,
  fiveHourPercent: 90,
  sevenDayPercent: 95,
})

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/

// Where the adapter writes: <config dir>/mods/state/events/<sessionId>.jsonl.
// The only vendor path in this file, and a caller that knows better passes
// `dir` explicitly (Leg runs each account under its own config dir).
export function eventsDirFor(configDir) {
  return join(configDir, 'mods', 'state', 'events')
}

export function defaultEventsDir() {
  return process.env.LEG_RUNTIME_EVENTS_DIR
    || eventsDirFor(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
}

// The runtime session id (Leg stores it as `agent_session_id`), not Leg's sid.
// Returns null when the runtime publishes nothing for this session, which is
// the ordinary case and never an error.
export function findEventsFile(sessionId, { dir = defaultEventsDir() } = {}) {
  if (!sessionId || !dir) return null
  if (!SESSION_ID_RE.test(String(sessionId))) return null
  const path = join(dir, `${sessionId}.jsonl`)
  return existsSync(path) ? path : null
}

// Incremental read from a byte offset. The writer flushes on a timer, so the
// last line is routinely half-written: consume up to the final newline only
// and leave the cursor there, so the next read sees the whole line.
export function readRuntimeEvents(path, cursor = 0) {
  const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0
  if (!path || !existsSync(path)) return { events: [], cursor: from }
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    // shorter than the cursor: the file was truncated or replaced, so start
    // over rather than read from the middle of a line
    const start = size < from ? 0 : from
    if (size === start) return { events: [], cursor: start }
    const buf = Buffer.allocUnsafe(size - start)
    const got = readSync(fd, buf, 0, buf.length, start)
    const chunk = buf.subarray(0, got)
    const end = chunk.lastIndexOf(0x0a)
    if (end === -1) return { events: [], cursor: start } // one partial line so far
    const events = []
    for (const line of chunk.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch {} // a torn or corrupt line is skipped, never fatal
    }
    return { events, cursor: start + end + 1 }
  } catch {
    return { events: [], cursor: from }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

export function emptySignals() {
  return {
    seen: 0,
    turnOpen: false,
    lastTurnCompletedAt: null,
    inFlightTools: 0,
    subagentsLive: 0,
    // carried so deriveSignals can resume from its own previous answer
    pendingToolIds: [],
    liveSubagentIds: [],
    usage: {
      contextTokens: null, contextWindow: null, contextPercent: null,
      fiveHourPercent: null, fiveHourResetsAt: null,
      sevenDayPercent: null, sevenDayResetsAt: null,
      costUsd: null,
    },
    model: null,
    lastError: null,
    cleanBoundary: true,
  }
}

function percentOf(tokens, window) {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return null
  return Math.round((tokens / window) * 100)
}

// Fold a batch of events onto the previous answer. Pure: `prev` is not
// mutated, and deriveSignals(all) equals deriveSignals(second, deriveSignals(first)).
export function deriveSignals(events = [], prev = null) {
  const base = emptySignals()
  const s = prev ? { ...base, ...prev, usage: { ...base.usage, ...(prev.usage ?? {}) } } : base
  const pending = new Set(s.pendingToolIds ?? [])
  const subagents = new Set(s.liveSubagentIds ?? [])

  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    s.seen += 1
    const d = e.data ?? {}
    if (e.kind === KIND.subagentStarted) {
      if (!d.denied && d.childAgentId) subagents.add(d.childAgentId)
      continue
    }
    if (e.kind === KIND.subagentCompleted) {
      if (e.agentId && subagents.has(e.agentId)) subagents.delete(e.agentId)
      else if (subagents.size) subagents.delete([...subagents][0])
      continue
    }
    // any other event carrying an agentId happened inside a subagent's own
    // loop: it must not open the main-loop turn or count as a main-loop tool
    if (e.agentId) continue
    switch (e.kind) {
      case KIND.sessionStarted:
        if (d.model) s.model = d.model
        break
      case KIND.turnStarted:
        s.turnOpen = true
        break
      case KIND.turnCompleted:
        s.turnOpen = false
        s.lastTurnCompletedAt = Number.isFinite(e.t) ? e.t : null
        // a tool call cannot outlive the turn that asked for it, so a
        // completion lost to a crash must not wedge the boundary shut
        pending.clear()
        break
      case KIND.modelStep:
        if (d.model) s.model = d.model
        break
      case KIND.contextChanged:
        if (Number.isFinite(d.contextTokens)) {
          s.usage.contextTokens = d.contextTokens
          s.usage.contextPercent = percentOf(d.contextTokens, s.usage.contextWindow) ?? s.usage.contextPercent
        }
        break
      case KIND.toolRequested:
        if (d.tool_use_id) pending.add(d.tool_use_id)
        break
      case KIND.toolCompleted:
        if (d.tool_use_id) pending.delete(d.tool_use_id)
        if (d.isError || d.denied) {
          s.lastError = { tool: d.tool ?? null, error: d.denied ? `denied: ${d.denied}` : String(d.preview ?? 'tool error'), at: Number.isFinite(e.t) ? e.t : null }
        }
        break
      case KIND.errorOccurred:
        s.lastError = { tool: d.tool ?? null, error: String(d.error ?? 'error'), at: Number.isFinite(e.t) ? e.t : null }
        break
      case KIND.usageChanged:
        if (d.context) {
          if (Number.isFinite(d.context.tokens)) s.usage.contextTokens = d.context.tokens
          if (Number.isFinite(d.context.window)) s.usage.contextWindow = d.context.window
          s.usage.contextPercent = Number.isFinite(d.context.percent)
            ? d.context.percent
            : (percentOf(s.usage.contextTokens, s.usage.contextWindow) ?? s.usage.contextPercent)
        }
        for (const w of d.rateLimits ?? []) {
          if (!w || !Number.isFinite(w.percentUsed)) continue
          if (w.kind === 'five_hour') { s.usage.fiveHourPercent = w.percentUsed; s.usage.fiveHourResetsAt = w.resetsAt ?? null }
          if (w.kind === 'seven_day') { s.usage.sevenDayPercent = w.percentUsed; s.usage.sevenDayResetsAt = w.resetsAt ?? null }
        }
        if (Number.isFinite(d.cost?.usd)) s.usage.costUsd = d.cost.usd
        break
      default:
        break
    }
  }

  s.pendingToolIds = [...pending]
  s.liveSubagentIds = [...subagents]
  s.inFlightTools = pending.size
  s.subagentsLive = subagents.size
  // the signal Leg never had: nothing is mid-flight, so a handoff here loses
  // no work and no answer
  s.cleanBoundary = !s.turnOpen && s.inFlightTools === 0 && s.subagentsLive === 0
  return s
}

const clip = (text, n = 140) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : 'unknown time')

// The one mapping function: runtime kinds in, Leg board events out
// ({ type, summary } as appendEvent(sid, ev) takes them). Kinds that carry no
// board meaning map to nothing rather than to a noisy status line.
export function toLegEvents(events = []) {
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const d = e.data ?? {}
    switch (e.kind) {
      case KIND.sessionStarted:
        out.push({ type: 'status', summary: `runtime events attached${d.model ? ` (${d.model})` : ''}` })
        break
      case KIND.promptSubmitted:
        out.push({ type: 'human', summary: clip(d.preview ?? `${d.chars ?? 0} chars`) })
        break
      case KIND.turnCompleted:
        out.push({ type: 'turn_done', summary: `turn ${d.reason ?? 'done'} in ${secs(d.durationMs)}${Number.isFinite(d.answerChars) ? `, ${d.answerChars} chars` : ''}` })
        break
      case KIND.subagentStarted:
        out.push({ type: 'agent', summary: d.denied ? `subagent ${d.type ?? 'task'} denied` : `subagent ${d.type ?? 'task'} started${d.model ? ` (${d.model})` : ''}` })
        break
      case KIND.subagentCompleted:
        out.push({ type: 'agent', summary: `subagent ${d.type ?? 'task'} ${d.reason ?? 'finished'} in ${secs(d.durationMs)}` })
        break
      case KIND.errorOccurred:
        out.push({ type: 'error', summary: clip(`${d.tool ?? 'runtime'}: ${d.error ?? 'error'}`) })
        break
      case KIND.toolCompleted:
        if (d.denied) out.push({ type: 'error', summary: clip(`${d.tool ?? 'tool'} denied: ${d.denied}`) })
        else if (d.isError) out.push({ type: 'error', summary: clip(`${d.tool ?? 'tool'} failed`) })
        break
      default:
        break
    }
  }
  return out
}

// Signals → the window shape recordUsage()/updateSession() already take
// ({ five_hour: { pct, resets_at }, seven_day: ... }, resets_at in epoch
// seconds), so the runtime's percentages reach the board and the chooser
// through the same door as every other tap's.
function legWindow(percent, resetsAt) {
  if (!Number.isFinite(percent)) return null
  const ms = resetsAt ? Date.parse(resetsAt) : NaN
  return { pct: percent, resets_at: Number.isFinite(ms) ? Math.floor(ms / 1000) : null }
}

export function toLegUsage(signals) {
  const u = signals?.usage ?? {}
  return {
    five_hour: legWindow(u.fiveHourPercent, u.fiveHourResetsAt),
    seven_day: legWindow(u.sevenDayPercent, u.sevenDayResetsAt),
  }
}

function blockedBy(signals) {
  if (signals?.turnOpen) return 'a turn is open'
  if (signals?.inFlightTools) return `${signals.inFlightTools} tool call${signals.inFlightTools === 1 ? '' : 's'} in flight`
  if (signals?.subagentsLive) return `${signals.subagentsLive} subagent${signals.subagentsLive === 1 ? '' : 's'} still running`
  return 'the runtime is busy'
}

// Should Leg hand this session over, and may it do so right now? A reason is
// returned either way: over a threshold but mid-turn is "wait", not "no", and
// the board can say which. An unknown percentage never triggers a handoff.
export function handoffAdvice(signals, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) }
  const u = signals?.usage ?? {}
  const reasons = []
  if (Number.isFinite(u.contextPercent) && u.contextPercent >= t.contextPercent) reasons.push(`context at ${u.contextPercent}% of the window`)
  if (Number.isFinite(u.fiveHourPercent) && u.fiveHourPercent >= t.fiveHourPercent) reasons.push(`5-hour window at ${u.fiveHourPercent}%`)
  if (Number.isFinite(u.sevenDayPercent) && u.sevenDayPercent >= t.sevenDayPercent) reasons.push(`7-day window at ${u.sevenDayPercent}%`)
  if (!reasons.length) return { shouldHandoff: false, reason: null }
  const why = reasons.join('; ')
  if (!signals?.cleanBoundary) return { shouldHandoff: false, reason: `${why}, waiting for a clean boundary (${blockedBy(signals)})` }
  return { shouldHandoff: true, reason: why }
}

// The whole tap in one call, for the single line that wires it into a leg.
// Not wired anywhere yet. onSignals(signals, { events, legEvents, advice })
// fires only when a batch arrived, so a quiet session costs one stat per tick.
// Neither the id nor the file is known when a leg starts (Leg learns the
// runtime's session id from its transcript, and the runtime writes the file on
// its first flush), so `sessionId` may be a getter and every tick looks again
// until both exist. That is what lets the caller wire this in one line.
export function pollRuntimeTap({ sessionId, dir = defaultEventsDir(), intervalMs = 2000, thresholds = DEFAULT_THRESHOLDS, onSignals } = {}) {
  let path = null
  let cursor = 0
  let signals = emptySignals()
  let stopped = false

  const tick = () => {
    if (stopped) return
    try {
      if (!path) {
        path = findEventsFile(typeof sessionId === 'function' ? sessionId() : sessionId, { dir })
        if (!path) return
      }
      const r = readRuntimeEvents(path, cursor)
      cursor = r.cursor
      if (!r.events.length) return
      signals = deriveSignals(r.events, signals)
      onSignals?.(signals, { events: r.events, legEvents: toLegEvents(r.events), advice: handoffAdvice(signals, thresholds) })
    } catch {} // a tap never takes the leg down with it
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return () => { stopped = true; clearInterval(timer) }
}
