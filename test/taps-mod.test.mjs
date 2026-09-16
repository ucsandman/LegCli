import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findEventsFile,
  readRuntimeEvents,
  deriveSignals,
  emptySignals,
  toLegEvents,
  toLegUsage,
  handoffAdvice,
  pollRuntimeTap,
  eventsDirFor,
  DEFAULT_THRESHOLDS,
} from '../src/taps/mod.mjs'

// One real capture from a runtime session (paths scrubbed of the local user
// name, nothing else changed): 29 events, one turn, four tool calls, the
// usage frame last.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'fixtures', 'runtime-events.jsonl')
const RAW = readFileSync(FIXTURE, 'utf8')
const LINES = RAW.split('\n').filter(Boolean)
const SID = '95f81dd2-c2fd-4660-a665-c636497ceb30'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function eventsDir(lines = LINES, sid = SID) {
  const dir = mkdtempSync(join(tmpdir(), 'leg-runtime-tap-'))
  writeFileSync(join(dir, `${sid}.jsonl`), lines.length ? `${lines.join('\n')}\n` : '')
  return dir
}

test('findEventsFile: the session that has a file, and the four ways there is none', () => {
  const dir = eventsDir()
  assert.equal(findEventsFile(SID, { dir }), join(dir, `${SID}.jsonl`))

  // no file for this session, no directory at all, no id, and an id that
  // tries to leave the directory: all of them null, none of them an error
  assert.equal(findEventsFile('no-such-session', { dir }), null)
  assert.equal(findEventsFile(SID, { dir: join(dir, 'nope') }), null)
  assert.equal(findEventsFile(null, { dir }), null)
  assert.equal(findEventsFile('../../etc/passwd', { dir }), null)

  assert.equal(eventsDirFor(join('C:', 'cfg')), join('C:', 'cfg', 'mods', 'state', 'events'))
})

test('readRuntimeEvents: incremental, and the half-written last line waits for its newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leg-runtime-tap-'))
  const path = join(dir, `${SID}.jsonl`)

  // 10 whole lines plus half of the 11th, exactly what a 2s flush leaves
  const head = `${LINES.slice(0, 10).join('\n')}\n`
  const torn = LINES[10].slice(0, 40)
  writeFileSync(path, head + torn)

  const first = readRuntimeEvents(path, 0)
  assert.equal(first.events.length, 10)
  assert.equal(first.cursor, Buffer.byteLength(head))
  assert.equal(first.events[0].kind, 'SessionStarted')
  assert.equal(first.events[9].seq, 10)

  // nothing new yet: the torn line must not be parsed, or counted, twice
  const idle = readRuntimeEvents(path, first.cursor)
  assert.deepEqual(idle.events, [])
  assert.equal(idle.cursor, first.cursor)

  // the writer finishes the line and adds the rest
  appendFileSync(path, `${LINES[10].slice(40)}\n${LINES.slice(11).join('\n')}\n`)
  const rest = readRuntimeEvents(path, idle.cursor)
  assert.equal(rest.events.length, LINES.length - 10)
  assert.equal(rest.events[0].seq, 11)
  assert.equal(rest.cursor, Buffer.byteLength(RAW))
  assert.equal(first.events.length + rest.events.length, LINES.length)
})

test('readRuntimeEvents: truncation restarts, a corrupt line is skipped, a missing file is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leg-runtime-tap-'))
  const path = join(dir, `${SID}.jsonl`)
  writeFileSync(path, `${LINES.join('\n')}\n`)
  const all = readRuntimeEvents(path, 0)
  assert.equal(all.events.length, 29)

  // file replaced by a shorter one (a new session, same id): read from 0
  writeFileSync(path, `${LINES[0]}\n`)
  const after = readRuntimeEvents(path, all.cursor)
  assert.equal(after.events.length, 1)
  assert.equal(after.cursor, Buffer.byteLength(`${LINES[0]}\n`))

  // a corrupt line costs its own event and nothing else
  writeFileSync(path, `${LINES[0]}\n{not json\n${LINES[1]}\n`)
  assert.equal(readRuntimeEvents(path, 0).events.length, 2)

  const missing = readRuntimeEvents(join(dir, 'gone.jsonl'), 0)
  assert.deepEqual(missing, { events: [], cursor: 0 })
})

test('deriveSignals: the whole capture ends at a clean boundary', () => {
  const { events } = readRuntimeEvents(join(eventsDir(), `${SID}.jsonl`), 0)
  const s = deriveSignals(events)

  assert.equal(s.seen, 29)
  assert.equal(s.turnOpen, false)
  assert.equal(s.inFlightTools, 0)
  assert.equal(s.subagentsLive, 0)
  assert.equal(s.cleanBoundary, true)
  assert.equal(s.lastTurnCompletedAt, 1789594968969)
  assert.equal(s.model, 'claude-haiku-4-5-20251001')
  assert.equal(s.lastError, null)

  // folding in two batches is the same answer as folding in one
  const half = deriveSignals(events.slice(0, 14))
  assert.deepEqual(deriveSignals(events.slice(14), half), s)
})

test('deriveSignals: a tool with no completion holds the boundary shut, a closed turn releases it', () => {
  const { events } = readRuntimeEvents(join(eventsDir(), `${SID}.jsonl`), 0)
  const firstRequest = events.findIndex((e) => e.kind === 'ToolRequested')
  const firstCompleted = events.findIndex((e) => e.kind === 'ToolCompleted')

  const open = deriveSignals(events.slice(0, firstRequest + 1))
  assert.equal(open.inFlightTools, 1)
  assert.equal(open.turnOpen, true)
  assert.equal(open.cleanBoundary, false)

  // same slice plus the matching completion: only the tool leg changed, so
  // the boundary is still shut but for the turn alone
  const paired = deriveSignals(events.slice(0, firstCompleted + 1))
  assert.equal(paired.inFlightTools, 0)
  assert.equal(paired.turnOpen, true)
  assert.equal(paired.cleanBoundary, false)

  // a completion lost to a crash must not wedge the boundary for ever: the
  // turn closing clears anything still pending
  const dropped = events.filter((e, i) => !(e.kind === 'ToolCompleted' && i === firstCompleted))
  const healed = deriveSignals(dropped)
  assert.equal(healed.inFlightTools, 0)
  assert.equal(healed.cleanBoundary, true)
})

test('deriveSignals: a live subagent is not a clean boundary, and a denied one was never live', () => {
  const t = 1789594990000
  const started = { seq: 1, t, kind: 'SubagentStarted', source: 'subagent.start', data: { childAgentId: 'child-1', type: 'haiku-scout', model: 'haiku', denied: false } }
  const completed = { seq: 2, t: t + 500, kind: 'SubagentCompleted', source: 'subagent.stop', agentId: 'child-1', data: { type: 'haiku-scout', model: 'haiku', reason: 'answer', durationMs: 500 } }
  const denied = { seq: 3, t, kind: 'SubagentStarted', source: 'subagent.start', data: { childAgentId: 'child-2', type: 'opus-owner', denied: 'capability graph' } }

  const live = deriveSignals([started])
  assert.equal(live.subagentsLive, 1)
  assert.equal(live.cleanBoundary, false)
  assert.equal(deriveSignals([completed], live).subagentsLive, 0)
  assert.equal(deriveSignals([completed], live).cleanBoundary, true)
  assert.equal(deriveSignals([denied]).subagentsLive, 0)

  // a tool call inside the child's own loop is not a main-loop tool
  const childTool = { seq: 4, t, kind: 'ToolRequested', source: 'tool.call', agentId: 'child-1', data: { tool: 'Read', tool_use_id: 'toolu_child' } }
  assert.equal(deriveSignals([started, childTool]).inFlightTools, 0)
})

test('deriveSignals: usage comes off UsageChanged, and maps to the window shape Leg already stores', () => {
  const { events } = readRuntimeEvents(join(eventsDir(), `${SID}.jsonl`), 0)
  const s = deriveSignals(events)

  assert.equal(s.usage.contextPercent, 21)
  assert.equal(s.usage.contextTokens, 42928)
  assert.equal(s.usage.contextWindow, 200000)
  assert.equal(s.usage.fiveHourPercent, 92)
  assert.equal(s.usage.sevenDayPercent, 21)
  assert.equal(s.usage.costUsd, 0.0726214)

  const windows = toLegUsage(s)
  assert.equal(windows.five_hour.pct, 92)
  assert.equal(windows.five_hour.resets_at, Math.floor(Date.parse('2026-09-17T00:00:00.000Z') / 1000))
  assert.equal(windows.seven_day.pct, 21)
  assert.deepEqual(toLegUsage(emptySignals()), { five_hour: null, seven_day: null })
})

test('handoffAdvice: 80% context hands off only at a clean boundary', () => {
  assert.equal(DEFAULT_THRESHOLDS.contextPercent, 80)
  const at = (contextPercent, over) => ({ ...emptySignals(), ...over, usage: { ...emptySignals().usage, contextPercent } })

  const clean = handoffAdvice(at(84))
  assert.equal(clean.shouldHandoff, true)
  assert.match(clean.reason, /context at 84%/)

  // same percentage mid-turn: wait, and say what it is waiting for
  const midTurn = handoffAdvice(at(84, { turnOpen: true, cleanBoundary: false }))
  assert.equal(midTurn.shouldHandoff, false)
  assert.match(midTurn.reason, /waiting for a clean boundary \(a turn is open\)/)

  const midTool = handoffAdvice(at(84, { inFlightTools: 2, cleanBoundary: false }))
  assert.equal(midTool.shouldHandoff, false)
  assert.match(midTool.reason, /2 tool calls in flight/)

  // under the threshold, and an unknown percentage, never hand off
  assert.deepEqual(handoffAdvice(at(79)), { shouldHandoff: false, reason: null })
  assert.deepEqual(handoffAdvice(emptySignals()), { shouldHandoff: false, reason: null })

  // the 5h window of the real capture (92%) only trips a threshold below it
  const { events } = readRuntimeEvents(join(eventsDir(), `${SID}.jsonl`), 0)
  const real = deriveSignals(events)
  assert.equal(handoffAdvice(real).shouldHandoff, true)
  assert.match(handoffAdvice(real).reason, /5-hour window at 92%/)
  assert.equal(handoffAdvice(real, { fiveHourPercent: 95 }).shouldHandoff, false)
})

test('toLegEvents: runtime kinds become board events Leg already knows, and nothing else', () => {
  const { events } = readRuntimeEvents(join(eventsDir(), `${SID}.jsonl`), 0)
  const mapped = toLegEvents(events)
  const known = new Set(['status', 'human', 'turn_done', 'agent', 'error'])

  assert.ok(mapped.length > 0)
  for (const ev of mapped) {
    assert.ok(known.has(ev.type), `unknown board event type ${ev.type}`)
    assert.equal(typeof ev.summary, 'string')
    assert.ok(ev.summary.length > 0)
    assert.deepEqual(Object.keys(ev).sort(), ['summary', 'type'])
  }
  assert.equal(mapped.filter((e) => e.type === 'turn_done').length, 1)
  assert.match(mapped.find((e) => e.type === 'turn_done').summary, /turn answer in 20\.9s, 97 chars/)
  assert.equal(mapped.filter((e) => e.type === 'human').length, 1)

  // a failed and a denied tool are the only tool calls that reach the board
  const trouble = toLegEvents([
    { kind: 'ToolCompleted', data: { tool: 'Bash', tool_use_id: 'a', isError: true } },
    { kind: 'ToolCompleted', data: { tool: 'Write', tool_use_id: 'b', denied: 'scope-lock' } },
    { kind: 'ToolCompleted', data: { tool: 'Read', tool_use_id: 'c', isError: false, denied: null } },
  ])
  assert.deepEqual(trouble.map((e) => e.type), ['error', 'error'])
})

test('no runtime events at all: every entry point answers, nothing throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leg-runtime-tap-'))
  assert.equal(findEventsFile(SID, { dir }), null)

  const s = deriveSignals([])
  assert.equal(s.seen, 0)
  assert.equal(s.turnOpen, false)
  assert.equal(s.inFlightTools, 0)
  assert.equal(s.subagentsLive, 0)
  assert.equal(s.model, null)
  assert.equal(s.lastError, null)
  assert.equal(s.lastTurnCompletedAt, null)
  assert.deepEqual(s.usage, emptySignals().usage)
  assert.equal(s.cleanBoundary, true)
  assert.deepEqual(toLegEvents([]), [])
  assert.deepEqual(handoffAdvice(s), { shouldHandoff: false, reason: null })

  // a session with no file never calls back, and stop() is still safe
  let calls = 0
  const stop = pollRuntimeTap({ sessionId: SID, dir, intervalMs: 5, onSignals: () => { calls += 1 } })
  stop()
  assert.equal(calls, 0)
})

test('pollRuntimeTap: picks up a file that appears after the leg started, then stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leg-runtime-tap-'))
  const path = join(dir, `${SID}.jsonl`)
  const seen = []
  // the id is a getter, as it is in a leg: Leg does not know the runtime's
  // session id until its transcript names it
  let id = null
  const stop = pollRuntimeTap({ sessionId: () => id, dir, intervalMs: 5, onSignals: (signals, extra) => seen.push({ signals, extra }) })

  try {
    assert.equal(seen.length, 0) // no id and no file yet
    writeFileSync(path, `${LINES.slice(0, 3).join('\n')}\n`)
    await sleep(20)
    assert.equal(seen.length, 0, 'the tap read a file before the id was known')
    id = SID
    for (let i = 0; i < 100 && seen.length < 1; i++) await sleep(10)
    assert.equal(seen.length, 1, 'the tap never saw the first batch')
    assert.equal(seen[0].signals.turnOpen, true)
    assert.equal(seen[0].extra.events.length, 3)
    assert.ok(seen[0].extra.legEvents.length > 0)
    assert.equal(seen[0].extra.advice.shouldHandoff, false)

    appendFileSync(path, `${LINES.slice(3).join('\n')}\n`)
    for (let i = 0; i < 100 && seen.length < 2; i++) await sleep(10)
    assert.equal(seen.length, 2, 'the tap never saw the second batch')
    assert.equal(seen[1].signals.seen, 29)
    assert.equal(seen[1].signals.cleanBoundary, true)
    assert.equal(seen[1].extra.advice.shouldHandoff, true)
  } finally {
    stop()
  }

  const after = seen.length
  appendFileSync(path, `${LINES[0]}\n`)
  await sleep(40)
  assert.equal(seen.length, after, 'stop() left the timer running')
})
