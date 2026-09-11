# Vocabulary

One page of the words Baton uses for state, events and actions, pulled
straight from the source (not invented). Each table lists the exact
identifiers the code uses; UI copy is allowed to be more readable ("Hand off
now" for `handoff_now`) but must not use a different word for the same thing.
Regenerate this by re-running the greps in each section header if the source
changes.

## Session statuses

One interactive terminal under `baton claude|codex|agy`. Source:
`src/sessions.mjs` `SESSION_STATUSES`; board labels from `STATUS` in
`src/board/sessions.js`.

| status | board label | active? | meaning |
|--------|-------------|---------|---------|
| `starting` | starting | yes | the runner registered the session; the agent has not reported in yet |
| `running` | running | yes | the agent is up and taking turns |
| `warning` | near limit | yes | a usage window crossed `BATON_WARN_PCT` (default 85) |
| `limit` | limit hit | yes | the agent reported its usage limit; the account is walled |
| `handing_off` | handing off | yes | the bundle is being saved and the next option chosen |
| `waiting` | waiting for reset | yes | every option is walled; the terminal counts down to the first reset (`session.waiting`) and then starts that agent from the bundle |
| `handed_off` | handed off | no | this leg is done; the next agent owns the terminal |
| `ended` | ended | no | the agent exited, or End was pressed |
| `lost` | lost | no | the runner process that owned the terminal is gone; never shown as live |

The six active statuses are what the board counts as a live session for
overlap flags and for the accounts strip's live dot.

## Session event types

Source: the `appendEvent`/`updateSession` call sites in `src/attach.mjs`,
`src/sessions.mjs`, `src/taps/claude.mjs` and `src/server.mjs`; written to
`$BATON_HOME/sessions/<id>/events.jsonl`.

| type | meaning |
|------|---------|
| `started` | the session was created: agent, account and directory |
| `leg` | one agent is starting in this terminal, noting whether it starts from a handoff bundle |
| `agent_ready` | the agent reported its own session id (claude's `SessionStart` hook, codex's rollout `session_meta`) |
| `turn` | a human prompt was submitted; carries the turn number and the first 120 characters |
| `turn_done` | the agent's reply for that turn, first 160 characters |
| `warning` | a usage window crossed the warning threshold; names the window, the percentage and the next option |
| `limit` | a usage limit was detected; carries the agent's own wording, `(simulated)` when `baton sessions simulate-limit` produced it |
| `handoff_requested` | someone pressed Hand off now, or ran `baton sessions handoff` |
| `handoff` | the switch happened: from, to, reason, bundle id |
| `all_out` | every option is walled; the resets are printed and the terminal waits for the first one (`ended` with "quit while waiting" if Ctrl-C or End cuts the wait short, exit 3) |
| `agent_exit` | the agent process exited, with its code |
| `ended` | the session ended |
| `lost` | the runner pid is gone; the session was marked `lost` |
| `error` | a spawn error, a tap error, a failed bundle checkpoint, or an error the agent reported |
| `status` | a note that does not fit another type |

## Card statuses

Source: `src/chain.mjs` `TERMINAL` + `NON_TERMINAL`.

| status | terminal? | meaning |
|--------|-----------|---------|
| `backlog` | no | card created, not yet queued |
| `queued` | no | waiting for the scheduler to start a leg under its leases |
| `running` | no | a leg (agent/test/land station) is executing |
| `handing_off` | no | the leg ended (limit/incomplete/no_progress/stalled/failed) and Baton is writing the handoff bundle |
| `waiting_human` | no | parked at a `human` station for a button press |
| `needs_approval` | no | next chain entry has `approve: true`; parked for Approve |
| `paused` | no | human paused it; child killed, bundle written |
| `done` | yes | all pipeline stations complete |
| `failed` | yes | chain exhausted, an environment fault, or land attempts exhausted |
| `killed` | yes | killed from the board |

## Leg outcomes

Source: `src/limits.mjs` `OUTCOMES` (`classify()`'s return value).

| outcome | meaning |
|---------|---------|
| `completed` | exit 0 and `.baton/DONE` present |
| `incomplete` | exit 0 with changes but no DONE marker |
| `no_progress` | exit 0, no DONE marker, no changes |
| `limit` | an adapter-specific or generic usage-limit signal fired |
| `stalled` | the kill timer fired before the leg finished |
| `auth_failed` | an auth signal fired, or stderr says another auth source is set; not treated as a limit |
| `launch_failed` | the CLI failed to spawn, or a launch signal fired |
| `killed` | killed from the board |
| `failed` | none of the above; non-zero exit with no recognized signal |

`limit`, `incomplete`, `no_progress`, `stalled` and `failed` hand off to the
next adapter in the chain (`HANDOFF_OUTCOMES`); `auth_failed` and
`launch_failed` do not advance the chain: a human fixes the environment and
clicks Rerun (`NO_ADVANCE_OUTCOMES`).

## Station kinds

Source: `src/pipeline.mjs` `KINDS`.

| kind | meaning |
|------|---------|
| `agent` | runs the station's chain (one or more adapters) with that station's prompt |
| `human` | parks the card for a button press; no automatic work |
| `test` | runs the repo's test command; bounces the card on red |
| `land` | merge queue: rebase, test, fast-forward trunk (see Bounce reasons below); at most one, must be last |

## Event types

Source: `src/ledger.mjs` `EVENT_TYPES`, written by `ledgerAppend`/`ev()` calls
across `src/chain.mjs`, `src/orchestrator.mjs`, `src/scheduler.mjs`,
`src/land.mjs` and `src/store.mjs`.

| type | meaning |
|------|---------|
| `card_created` | a card was added |
| `leg_started` | an adapter leg started running |
| `leg_progress` | progress recorded mid-leg |
| `leg_exited` | the adapter process exited |
| `limit_detected` | a limit signal fired during a leg |
| `handoff_written` | the handoff bundle was written for the next leg |
| `leg_resumed` | a leg resumed from a bundle (pause/resume, or a bounce) |
| `station_done` | a station finished and the card advanced |
| `bounced` | a test or land failure sent the card back to `build` |
| `landed` | the land station merged the card's work onto trunk |
| `land_warning` | the land station landed without running tests (no test command found) |
| `land_retry` | trunk moved during land; one fast-forward retry |
| `blocked_by` | the scheduler could not start the card because a lease is held |
| `scheduler_started` | the scheduler process started |
| `scheduler_stopped` | the scheduler process stopped |
| `approval_needed` | the card is parked for Approve (gated leg or a PR was opened) |
| `approved` | a human clicked Approve |
| `reassigned` | a human changed the current leg's adapter/mode |
| `paused` | a human clicked Pause |
| `resumed` | a human clicked Resume |
| `killed` | a human clicked Kill |
| `done` | the card finished all stations |
| `failed` | the card failed (chain exhausted, land attempts exhausted, or an environment fault) |
| `error` | an unexpected error (orchestrator crash, handoff bundle write failure, land station crash) |
| `status` | a status note that doesn't fit another type (e.g. "rerun from build leg 0") |

## Actor types

Source: `src/ledger.mjs` (`parseActor`/`actorKey`).

| type | meaning |
|------|---------|
| `agent` | an adapter CLI acting on a leg; carries `adapter` (and optionally `model`) |
| `human` | a person acting through the board or CLI; carries `id` |
| `baton` | Baton itself (scheduler, orchestrator) acting with no human or agent behind it |

## Human actions and board buttons

Source: `src/chain.mjs` `HUMAN_ACTIONS`; board labels from
`ACTION_LABELS` in `src/board/board.js` (~line 17).

| action | board button | what it does |
|--------|--------------|--------------|
| `pause` | Pause | stop after the current leg |
| `resume` | Resume | pick up where it stopped |
| `kill` | Kill | stop the running agent; card ends as `killed` |
| `reassign` | Reassign | pick the next adapter/mode from a picker instead of the chain order |
| `handoff_now` | Hand off now | end the current leg, write the bundle, start the next adapter |
| `approve` | Approve | release a leg gated with `approve: true`, or clear a `waiting_human` station |
| `rerun` | Rerun | start the station over from the last bundle |

The board also shows a **Run** button for `enqueue` (queues a `backlog` card;
API path `run`). `enqueue` moves a card via the station machine's
`backlog`→`queued` transition and is not in `HUMAN_ACTIONS`, since it is
reached through card creation/queueing rather than `humanAction()`.

## Bounce reasons (land station)

Source: `src/mergequeue.mjs` (`bounce()` call sites, documented in the
file's own header comment).

| reason | meaning |
|--------|---------|
| `dirty-trunk` | the repo root isn't on the trunk branch, or has uncommitted changes; root is left untouched |
| `rebase-conflict` | rebasing the card's branch onto trunk conflicted |
| `tests-red` | the land station's own test run (no test command found → falls back per `land_warning`, otherwise `test_command`/`npm test`/`pytest`) failed |
| `trunk-moved` | trunk moved while tests ran; one fast-forward retry also failed |

Card-level `bounce_reason` is stored as `"<reason>: <detail>"`
(`src/orchestrator.mjs`); the board's status chip shows the text up to the
first colon, truncated to 24 characters. The separate pipeline `test`
station (kind `test`, distinct from a `land` station's own internal test
step) bounces with its own free-text reason ("test red (…): …"), not one of
the four words above, it is a different failure path through the same
`bounced` event type.

## Cross-check against visible strings

Checked against `src/board/board.js`, `src/board/floor.js`,
`src/board/index.html`, `src/board/floor.html`, `bin/baton.mjs`'s usage text
and `README.md`.

- Board button labels (`ACTION_LABELS`, `WAIT_LABELS`) match README's "Board
  buttons" table word for word (Run, Approve, Pause, Resume, Hand off now,
  Reassign, Kill, Rerun).
- Board status labels (`STATUS_LABELS`) and chain-rail glyphs
  (`stateGlyph`: ✓ done, ↷ handed, ✗ failed, ● active, · pending) match the
  README's drawer description.
- Station kinds shown in the drawer (`${name} (${kind})`) and README's
  "Station kinds" list both use `agent`/`human`/`test`/`land`.
- CLI human-action verbs in `bin/baton.mjs` (`pause`, `resume`, `kill`,
  `approve`, `handoff-now`, `rerun`, `reassign`) are the same 7 words as
  `HUMAN_ACTIONS`, spelled with hyphens instead of underscores on the CLI
  surface (`handoff-now` vs `handoff_now`), a deliberate, consistent
  per-surface convention, not a mismatch.
- No mismatch requiring a board-file fix was found; nothing above needed
  changing in `src/board/*`.
