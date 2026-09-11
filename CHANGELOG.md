# Changelog

## 0.2.0 (2026-09-11)

The way in is now `baton claude`, `baton codex` or `baton agy`: the normal
interactive agent in your terminal, with Baton alongside it. The v0.1 form,
pipelines, leases and merge queue stay as extras.

- `baton <agent> [args…]` starts the real interactive CLI with your settings,
  hooks and skills; extra args pass straight through. API-key variables are
  stripped; nothing in `~/.claude`, `~/.codex` or agy's home is edited.
- The board opens once and is reused; every session in every terminal is a
  card: agent, account, repo@branch, task, turns, files being touched, 5h/7d
  usage, warning/limit/handoff state. Two live sessions editing the same file
  in one repo are flagged on both cards. A "landed on trunk" list per repo.
  Buttons: Hand off now, End, Remove.
- Usage tracking per agent and account. claude: Claude Code's usage endpoint
  with the stored login (the status-line JSON route is written but Claude Code
  2.1.268 does not run custom status lines; see docs/adapters.md) plus the
  `StopFailure` `rate_limit` hook. codex: the session rollout file
  (`token_count.rate_limits`, `usage_limit_exceeded`). agy: its log
  (`RESOURCE_EXHAUSTED`, "it resets in"); no percentage is exposed.
- A context-handoff-bundle per session, refreshed every two minutes and at
  every warning/limit/handoff (`save --update <slug>`).
- Hand-off on limit or on request: bundle, stop the agent, restore the
  terminal, start the next option in the same terminal from `.baton/RESUME.md`.
  Order: other logins of the same agent, then the next agents (claude → codex
  → agy). When every option is out: each reset time, soonest first, exit 3.
- Optional second logins: `baton accounts add <claude|codex> <name>` (config-dir
  junctions for the shared harness, one login line to paste). The terms of
  both vendors are printed at add time and documented in the README.
- `baton uninstall [--yes]` removes only `~/.baton`.
- gemini removed everywhere (Google retired Gemini CLI in favour of agy).
- 0 runtime dependencies still. New modules: src/attach.mjs, src/sessions.mjs,
  src/usage.mjs, src/accounts.mjs, src/bundle.mjs, src/hook.mjs, src/taps/*.

## 0.1.0 (2026-09-10)

First public release (source on GitHub; not on npm yet).

- Ported the detached runner, the append-only ledger and the git snapshot tool
  from a private ucsandman repository (team tooling) under the same MIT license,
  with Telegram delivery, chat identifiers and machine paths removed (see
  NOTICE, docs/REUSE.md, docs/DEVIATIONS.md).
- Adapters for claude, codex, gemini and agy, each spawned as argv with a
  sanitized child environment (subscription logins only, no YOLO flags); grok
  written from `--help` but unregistered until a live probe passes.
- Limit detector built from 25 recorded signals (docs/cli-contracts.md keeps
  the observed-live vs docs-only tag per row); DONE-marker completion contract.
- Handoffs through context-handoff-bundle (repo-local bundles, `load` resume
  prompt); pipeline presets factory / build / build-land; scheduler with path
  leases; land station as a merge queue (rebase → test → ff-only, bounce with
  the failure in the bundle); `pr` land mode stub.
- Board (kanban from the pipeline, every judgment a button, detail drawer) and
  floor view (running cards, leases, trunk lane) over a ledger-backed server
  with SSE and a BATON_BIND / BATON_TOKEN seam.
- Launcher: `npm start` = `baton up` (preflight, health check, prefixed
  redacted logs, Ctrl-C teardown), `up --dry`, `down`, `status`, `open`.
- Optional syncs, off by default: OpenClaw Workboard (argv) and DashClaw action
  recording (verified live once).
- Demo (fake limit on the board, five screenshots) and one real run: claude
  hit `--max-turns 2`, codex finished from the bundle, tests green in 2 m 50 s.
- Polish pass: a missing CLI ends the card `failed` (was stuck `running`);
  runs re-attach after `baton down` instead of relaunching; bounce and
  blocked chips name their reason; repo path must be a git root outside
  BATON_HOME; SSE re-reads only the changed card; reduced-motion and contrast
  checks; docs/VOCABULARY.md.
