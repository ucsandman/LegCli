# Changelog

## 0.3.0 (2026-09-11)

Closing the gaps against the two tweets: a limit path proved live, waiting
instead of quitting, collisions stopped instead of flagged, and more than one
human on the board.

- `baton sessions simulate-limit <id>`: the same `StopFailure` `rate_limit`
  payload Claude Code sends goes through Baton's hook, so the whole path runs
  for real (limit status, bundle, agent stopped, the next agent started in the
  same terminal). Verified live: a haiku session handed off to codex, which
  read `.baton/RESUME.md` on its first turn. The simulated wall clears after
  two minutes and is never kept as evidence. agy: the RESOURCE_EXHAUSTED line
  is appended to the session's own log. codex is refused (use `handoff`).
- The first real claude `StopFailure`, codex `usage_limit_exceeded` or agy
  `RESOURCE_EXHAUSTED` is saved with secrets scrubbed under
  `fixtures/live/<agent>/` (dev clone) or `~/.baton/live/`, and the docs rows
  for it flip from docs-only to observed-live (`scripts/live-limits.mjs`).
- `BATON_CLAUDE_ARGS`, `BATON_CODEX_ARGS`, `BATON_AGY_ARGS`: extra arguments
  for a leg Baton starts after a hand-off (keep a chain on cheap models).
- codex's card no longer shows the injected AGENTS.md block as the task.
- When every option is out the terminal no longer exits 3: it prints the reset
  times, counts down to the first one, and starts that agent from the bundle
  when it arrives (`src/wait.mjs`). The card shows `waiting for <agent> at
  <time>`. Ctrl-C, or End on the card, quits with exit 3. Verified live: with
  codex and agy walled for 80 s, a simulated limit on a haiku session waited
  and then started codex from `.baton/RESUME.md`.
- A second live session in a checkout that already has one gets its own git
  worktree, `<repo>/.baton-worktrees/<session-id>` on branch
  `baton/<session-id>`, cut from the branch the checkout has out; the terminal
  prints one line saying where. `--no-worktree` shares the checkout (the flag
  never reaches the agent).
- **Land** on the card of a session with its own worktree sends its branch
  through the merge queue: commit what the agent left, rebase onto the base,
  run the tests, fast-forward only, or bounce with the reason
  (`rebase-conflict` with the files, `tests-red` with the output tail,
  `dirty-trunk` when the checkout has local changes the landing would
  overwrite). The landed-on-trunk list says who landed each commit
  (`~/.baton/landings.jsonl`). Remove takes the worktree and branch along only
  when the worktree is clean and the branch is already on its base. Verified
  live: three haiku sessions in a throwaway repo, the second and third in
  worktrees both appending to README.md; Land on one ran the tests and
  fast-forwarded main, Land on the other bounced with `rebase-conflict` on
  README.md.
- `baton share`: more than one human on the board, off by default. `baton share
  on` binds the Tailscale address (or `--bind lan`, or one you name) and gives
  every human a name and their own token, kept as a sha256 hash and printed
  once (`baton share rotate <name>` issues a new one). A terminal belongs to
  the human who started it (`BATON_PERSON`). Another human's card is
  read-only: no prompt, no file names, no paths, no limit text, no bundle, no
  events, no logs, and one **Request handoff** button that the owner approves
  or dismisses on their own card; the pipeline side stays the owner's. The
  security pass: a token on every `/api` route including the event stream
  (which is computed per viewer), 403 for a guest on anything that is not
  theirs, 20 wrong tokens from one address then a minute's wait, 600 requests
  a minute per human, and tests that send a bad and a missing token to every
  route. Verified live over Tailscale with two terminals on one machine, one
  wes's and one sam's: sam's board redacted wes's card, and sam's request was
  approved on wes's board and handed the terminal off.
- The merge queue's test run no longer blocks its process, so the board keeps
  answering while a Land runs the tests.
- Fixed: a board that asks for a token answered `ensureBoard`'s health probe
  with 401, and Baton read that as "no board" and started a second one.
- `/api/health` asks each adapter where its binary is instead of running the
  bare name, so the board no longer says `codex: false` while the runner starts
  codex fine.
- When the claude usage endpoint 404s, answers with something that is not JSON,
  or changes shape, the card says `usage unknown (<why>) · the limit still
  hands off` instead of showing empty bars; the wall still arrives through the
  `StopFailure` hook. `BATON_CLAUDE_USAGE_URL` (or `fetchClaudeUsage({ url })`)
  accepts an http test double.
- Fixed: the first dirty file on a card (and in the bundle notes) lost its
  first letter (`EADME.md`) because the porcelain status was trimmed;
  `.dashclaw-local/` no longer counts as a file being touched, and it joins
  `.baton/`, `.baton-worktrees/` and `.context-handoffs/` in
  `.git/info/exclude` so a landing never commits it.
- `BATON_NO_BOARD=1` runs a session without the board; a stub-agent end-to-end
  test (`test/attach-e2e.test.mjs`) now runs `baton claude` through the hook,
  the hand-off, the wait and the restart in CI.

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
