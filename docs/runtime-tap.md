# Runtime tap: turn boundaries, usage and a safe place to hand off

`src/taps/mod.mjs` is Leg's seam for an agent runtime that publishes structured
events about itself while it runs. It is optional, it is off until one line
wires it in, and nothing in Leg depends on it existing.

## The gap it closes

Leg's per-agent taps read whatever each CLI leaves behind: an OAuth usage
endpoint every 60 s, a rollout file, a transcript tail. None of those says when
a turn ends. So when a limit lands, `killTree()` fires at an arbitrary instant:
mid-tool, mid-answer, with a subagent still running. The handoff bundle then
describes a moment nobody chose.

A runtime that publishes events closes that gap. The tap folds the stream into
one small record of signals, and the one Leg never had is `cleanBoundary`: the
turn is closed, no tool call is in flight, no subagent is still running.

| Field | What Leg gains |
| --- | --- |
| `turnOpen`, `lastTurnCompletedAt` | where a turn starts and ends, to the millisecond |
| `inFlightTools` | tool calls requested with no completion yet |
| `subagentsLive` | subagents still running under this session |
| `cleanBoundary` | all three at rest: a handoff here loses no work and no answer |
| `usage.contextPercent`, `contextTokens`, `contextWindow` | how full the window is, which degrades an agent long before a rate limit stops it |
| `usage.fiveHourPercent`, `sevenDayPercent` (+ their reset times) | the same two windows Leg already stores, without the 60 s poll |
| `usage.costUsd` | what the session has spent |
| `model`, `lastError` | which model is answering, and the last tool failure or denial |

## Why the runtime side stays optional

The events come from a plugin installed in the agent's own harness, not from
anything Leg installs or launches. Leg's launcher needs no new flag, no
`--plugin-dir`, and no change to any adapter's argv: the plugin is already
installed, or it is not.

`findEventsFile()` returns `null` when the session has no events file, and that
is the ordinary case, never an error:

- the runtime has no such plugin installed
- the plugin is installed but this session has not flushed yet
- the agent is not the one that writes these events at all (codex, agy, grok)

In every one of those cases the tap does nothing, calls back never, and Leg
behaves exactly as it does today. That is the acceptance condition for this
seam: with the events file absent, no Leg behaviour changes.

## Where the events come from

One file per runtime session, JSON per line, appended and flushed on a timer
and at the end of every main-loop turn:

```
<config dir>/mods/state/events/<sessionId>.jsonl
```

`<sessionId>` is the runtime's own session id, which Leg stores as
`agent_session_id` once its transcript names it (not Leg's `sid`).
`<config dir>` is the config directory that session ran under, which for Leg is
`spec.env.CLAUDE_CONFIG_DIR` (each account gets its own). `eventsDirFor()`
builds that path; `LEG_RUNTIME_EVENTS_DIR` overrides it outright, which is what
the tests use.

The runtime's own event names live in exactly one place in Leg: the `KIND`
table at the top of `src/taps/mod.mjs`. `deriveSignals()` and `toLegEvents()`
read that table, and every shape the tap exports is Leg's own, so a second
runtime with a different vocabulary is a second table and nothing else.

## Wiring it in (one line)

Two lines total, both in `src/attach.mjs`, neither of which changes any
existing behaviour.

The import, with the other tap imports (after the `./taps/claude-usage.mjs`
line):

```js
import { pollRuntimeTap, eventsDirFor } from './taps/mod.mjs'
```

The wiring itself, inside `if (agent === 'claude') {`, on the line straight
after `usageTimer.unref?.()`:

```js
const runtimeStop = pollRuntimeTap({ sessionId: () => readSession(sid)?.agent_session_id, dir: eventsDirFor(spec.env.CLAUDE_CONFIG_DIR || LAYOUT.claude.home()), onSignals: (signals, { legEvents, advice }) => { for (const ev of legEvents) appendEvent(sid, ev); updateSession(sid, { runtime: { ...signals, advice } }) } })
```

`readSession`, `updateSession`, `appendEvent` and `LAYOUT` are already imported
there. `sessionId` is a getter on purpose: neither the id nor the file exists
when a leg starts, so the tap keeps looking until both do and the caller needs
no lazy bookkeeping in the poll loop.

Teardown is optional. The interval is `unref`'d, so it never holds the process
open, and a finished session's file simply stops growing (one `stat` every
2 s until the leg exits). To stop it exactly, declare `let runtimeStop = null`
beside `let usageTimer = null`, drop the `const` above, and add
`runtimeStop?.()` next to `if (usageTimer) clearInterval(usageTimer)`.

What the line buys, immediately: turn-level board events (`turn_done`, the
prompt, subagents, tool failures) instead of a poll-shaped guess, and a
`session.runtime` record the board can render.

Two follow-ups this seam makes possible, both deliberately not wired here:

- feed the percentages to the chooser through the door every other tap uses:
  `recordUsage('claude', account, toLegUsage(signals), 'runtime events')`
  (`recordUsage` is already imported in `attach.mjs`)
- hand off at a boundary Leg chose, by acting on `advice.shouldHandoff` in the
  same place the limit handoff already fires

## Handing off on purpose

`handoffAdvice(signals, thresholds)` answers with `{ shouldHandoff, reason }`.
Defaults:

| Threshold | Default | Why |
| --- | --- | --- |
| `contextPercent` | 80 | a full window degrades an agent long before a limit stops it |
| `fiveHourPercent` | 90 | just under the wall Leg already hands off at |
| `sevenDayPercent` | 95 | a last resort; the 7-day window rarely moves first |

Being over a threshold is not enough. Over a threshold but mid-turn returns
`shouldHandoff: false` with a reason that says what it is waiting for
("context at 84% of the window, waiting for a clean boundary (a turn is
open)"), so the board can show the wait rather than a silent stall. A
percentage the runtime has not published yet never triggers a handoff.

## The API

| Function | Answers |
| --- | --- |
| `findEventsFile(sessionId, { dir })` | the path, or `null` when this session publishes nothing |
| `readRuntimeEvents(path, cursor)` | `{ events, cursor }` from a byte offset; a half-written last line is left for the next read, a truncated file restarts at 0, a corrupt line is skipped |
| `deriveSignals(events, prev)` | the signals record above; pure, and folding in batches equals folding at once |
| `toLegEvents(events)` | `{ type, summary }` board events, as `appendEvent(sid, ev)` takes them |
| `toLegUsage(signals)` | `{ five_hour: { pct, resets_at }, seven_day: ... }`, the window shape `recordUsage()` already stores |
| `handoffAdvice(signals, thresholds)` | `{ shouldHandoff, reason }` |
| `pollRuntimeTap({ sessionId, dir, intervalMs, thresholds, onSignals })` | the whole tap on a timer; returns `stop()` |

`emptySignals()` is the zero state, and it is what `deriveSignals([])` returns:
nothing seen, nothing in flight, every percentage `null`.

## Tests

`test/taps-mod.test.mjs`, 11 tests, run by `node --test`. The fixture
`fixtures/runtime-events.jsonl` is one real captured session (29 events, one
turn, four tool calls, the usage frame last) with the local user name scrubbed
out of the paths and nothing else changed. Subagent, denial and error cases are
built in the test, because that capture has none.

Covered: incremental reads across a torn line, truncation and a corrupt line;
`cleanBoundary` shut by an open turn and by a tool with no completion, and
released by the turn that closes; a live subagent, a denied one, and a tool
call inside a subagent's own loop; usage extraction and its mapping to Leg's
window shape; advice at 80% context only at a clean boundary; and the no-file
fallback, where every entry point answers and nothing throws.
