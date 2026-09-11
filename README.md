# baton

Local-first kanban board and meta-harness for coding-agent CLIs. A human drops a
task card and assigns a fallback chain (Claude Code → Codex → Gemini CLI → agy).
Baton runs the first agent headless in its own git worktree, streams progress to
the card, and when that agent hits a usage limit, stalls, or exits without
finishing, writes a context-handoff-bundle and hands the same worktree to the
next agent in the chain. Every judgment call is a button on the board.

**Status: building.** The reuse audit is in `docs/REUSE.md`; every shape change
from the ported sources is one row in `docs/DEVIATIONS.md`. Run steps land with
the launcher.

## Land station

A pipeline that ends in a `land` station lands continuously instead of
collecting a pull request at the end. When a card reaches it, Baton:

1. checks that the repo root is on the trunk branch and clean (otherwise the
   card bounces with `dirty-trunk` and the root is not touched);
2. commits whatever the agents left in the worktree, then rebases the card's
   branch onto trunk; a conflict aborts the rebase and bounces the card with
   `rebase-conflict` and the file list;
3. runs the repo's test command (the card's `test_command`, else `npm test`
   from `package.json`, else `pytest` when there is a `pyproject.toml`, else it
   lands untested with a `land_warning`); red bounces with `tests-red` and the
   last 40 lines;
4. fast-forwards trunk from the repo root (`git merge --ff-only`); if trunk
   moved while the tests ran it rebases once more and retries, then bounces
   with `trunk-moved`;
5. records a `landed` event with the sha, files and line counts.

A bounce sends the card back to its `build` station with the failure written
into the handoff bundle's Open findings, so the next agent starts from it.
Three bounces (test or land, `BATON_MAX_LAND_ATTEMPTS`) fail the card. Size
cards to land within about an hour. `land_mode: pr` opens a pull request
instead (built as `gh pr create` argv; stub-only in this build) and parks the
card for a human.

## Optional syncs

Baton ships its own board. Two mirrors exist, both off unless you set the
flag in `.env` (copy `.env.example`):

- **OpenClaw Workboard** (`BATON_SYNC_WORKBOARD=1`): every card create,
  status change and completion runs `openclaw workboard add|move|done …` as an
  argv child of the ledger (no shell). On the machine this was built on the
  plugin is disabled and the CLI answers, verbatim:

  > The `openclaw workboard` command is unavailable because `plugins.allow` excludes "workboard". Add "workboard" to `plugins.allow` if you want that bundled plugin CLI surface.

  Baton records that once as a `status` event on the card and stays silent
  afterwards (a marker file under `BATON_HOME`; delete it to retry). The verb
  mapping in `src/sync/workboard.mjs` is written against a stub; check it
  against `openclaw workboard --help` once the plugin is enabled.
- **DashClaw** (`BATON_SYNC_DASHCLAW=1` plus `DASHCLAW_URL` and
  `DASHCLAW_API_KEY`): every ledger event is recorded as a DashClaw action
  (`POST /api/actions` with `agent_id`, `action_type: baton_<event>`,
  `declared_goal`, `status`, `systems_touched`, `input_summary`) over native
  https with a 5 s timeout. A failed record is buffered in the card's
  `unsynced.jsonl` and replayed by `node src/ledger.mjs sync`. Verified live
  on 2026-09-10: one card create produced one `baton_card_created` action.

Neither sync can block or fail a card; a sync failure is one `status` event
per minute at most.

## Hard constraints

- Logged-in subscription CLIs only, never per-token API. Every spawn deletes
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
  `OPENAI_API_KEY` from the child environment. Stderr saying "another auth
  source is set" counts as a failed launch, never a limit.
- Agents keep their own permission and sandbox modes. No skip-permissions or
  YOLO flags, ever, by default or otherwise.
- Human surface first: the board is the product, the CLI is secondary.
- One-command launcher: `npm start` boots, health-checks, opens the board,
  streams prefixed logs, tears down on Ctrl+C. Argv subprocesses only.
- No shell spawns anywhere; secrets redacted from every log.
