# Changelog

## 0.3.1 (2026-09-11)

A security and correctness pass over 0.3.0, after an adversarial review. No new
features; 44 fixes, all covered by the test suite (281 tests).

- **`baton share` security.** A guest could read the owner's pipeline through
  `/api/trunk` (now on the guest deny-list) and through the SSE stream (the
  card/removed broadcasts now carry the per-viewer filter, and every push
  re-checks the viewer against the live roster). `share add|rotate|rm` now take
  effect on a live board instead of after a restart: the server re-reads
  `share.json` per request, so a removed or rotated link stops at once and a new
  one works at once. `baton share add` before `baton share on` can no longer
  make a guest the board's owner. A non-loopback bind also listens on 127.0.0.1
  so the owner keeps a tokenless URL while a remote peer still needs a token.
  Cross-origin state-changing requests are refused. New `test/share-security.test.mjs`
  sends a missing, wrong, other-human, rotated and removed token to every route
  including SSE.
- **No lost work.** Land refuses a worktree with a rebase/merge already in
  progress (it used to commit the half-state and then abort it, deleting the
  human's uncommitted files). Remove and `baton sessions rm` no longer drop a
  session record while its worktree still holds unlanded commits. `git branch -d`
  before `-D`. A Land never commits a `.env`. A git failure during a Land no
  longer crashes the board process.
- **No lost writes.** `session.json` and the usage files are written under a
  cross-process lock with a reducer form, so concurrent hooks, taps and pollers
  stop losing files, turns and limit walls to a last-writer-wins race.
- **The limit path.** The handoff chooser skips agents that are not installed
  (a missing next agent used to kill the session exit 127), the all-out wait
  counts down to the true soonest reset including the current agent, a weekly
  wall is no longer recorded as a 5-hour one, and agy reset durations with more
  than one unit (`71h19m42s`) are summed, not truncated. `live-capture` now
  redacts the home and repo paths, not only secret shapes. The env sanitizer
  also strips the Google/Gemini keys the agy leg kept.
- A hung test command no longer leaves a card in `landing` forever and wedging
  the repo's merge queue. A crash during `git worktree add` no longer orphans a
  worktree with no card. Two sessions in one checkout get their own
  `RESUME-<id>.md`.

## 0.3.0 (2026-09-11)

Closing the gaps against the two tweets: a limit path proved live, waiting
instead of quitting, collisions stopped instead of flagged, and more than one
human on the board.

- `baton sessions simulate-limit <id>`: a `StopFailure` `rate_limit` payload in
  the shape Claude Code sends (marked simulated) goes through Baton's hook, so
  the whole path runs for real (limit status, bundle, agent stopped, the next
  agent started in the same terminal). Verified live: a haiku session handed
  off to codex, which read `.baton/RESUME.md` on its first turn. The simulated
  wall clears after two minutes and is never kept as evidence. agy: the
  RESOURCE_EXHAUSTED line is appended to the session's own log. codex is
  refused (use `handoff`).
- The first real claude `StopFailure` is saved with secrets scrubbed under
  `fixtures/live/<agent>/` in a dev clone (outside a clone it goes to
  `~/.baton/live/`, a path nothing has written yet), and the docs row for it
  flips from docs-only to observed-live (`scripts/live-limits.mjs`). The same
  capture is wired for codex `usage_limit_exceeded` and agy
  `RESOURCE_EXHAUSTED`; no real payload for either has been kept yet, and
  their rows are still docs-only.
- `BATON_CLAUDE_ARGS`, `BATON_CODEX_ARGS`, `BATON_AGY_ARGS`: extra arguments
  for a leg Baton starts after a hand-off (keep a chain on cheap models).
- codex's card no longer shows the injected AGENTS.md block as the task.
- When every option is out the terminal no longer exits 3: it prints the reset
  times, counts down to the first one, and starts that agent from the bundle
  when it arrives (`src/wait.mjs`). The card shows `waiting for <agent> at
  <time>`. End on the card quits with exit 3; Ctrl-C is wired to the same exit
  (the End path is the one under test). Verified live: with codex walled for
  80 s and agy for 200 s, a simulated limit on a haiku session waited and then
  started codex from `.baton/RESUME.md`.
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
  read-only: no prompt, no file names, no paths, no limit message, no bundle,
  no events, no logs — the agent, the branch, the usage bars and the reset
  time still show — and one **Request handoff** button that the owner
  approves or dismisses on their own card; the pipeline side stays the
  owner's. The security pass: a token on every `/api` route including the
  event stream (which is computed per viewer), 403 for a guest on anything
  that is not theirs, a lockout after repeated wrong tokens from one address
  and a per-human request ceiling (defaults 20 failures and 600 requests a
  minute, `src/ratelimit.mjs`; the tests drive both at lower thresholds), and
  tests that send a bad and a missing token to every route. Verified live
  over Tailscale with two terminals on one machine, one wes's and one sam's:
  sam's board redacted wes's card, and sam's **Request handoff** reached
  wes's board (the approve-then-hand-off step is covered by tests).
- The merge queue runs its tests through an async spawn instead of a blocking
  one, so a Land no longer parks the board's event loop.
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
  stripped; Baton writes its own per-session settings file
  (`~/.baton/sessions/<id>/claude-settings.json`) and passes it with
  `--settings`, instead of editing `~/.claude`, `~/.codex` or agy's home.
- The board opens once and is reused; every session in every terminal is a
  card: agent, account, repo@branch, task, turns, files being touched, 5h/7d
  usage, warning/limit/handoff state. Two live sessions editing the same file
  in one repo are flagged on both cards. A "landed on trunk" list per repo.
  Buttons: Hand off now, End, Remove.
- Usage tracking per agent and account. claude: Claude Code's usage endpoint
  with the stored login (a status-line JSON route is written as a fallback;
  on the build machine, Claude Code 2.1.268 was not seen running a custom
  status line — see docs/adapters.md) plus the `StopFailure` `rate_limit`
  hook. codex: the session rollout file
  (`token_count.rate_limits`, `usage_limit_exceeded`). agy: its log
  (`RESOURCE_EXHAUSTED`, "it resets in"); no percentage is exposed.
- A context-handoff-bundle per session, refreshed every two minutes and at
  every warning/limit/handoff (`save --update <slug>`).
- Hand-off on limit or on request: bundle, stop the agent, restore the
  terminal, start the next option in the same terminal from `.baton/RESUME.md`.
  Order: other logins of the same agent, then the next agents (claude → codex
  → agy). When every option is out: each reset time, soonest first, then exit
  3. (0.3.0 waits for the first reset instead.)
- Optional second logins: `baton accounts add <claude|codex> <name>` (config-dir
  junctions for the shared harness, one login line to paste). Both vendors'
  terms are in the README and are printed by `baton accounts terms`.
- `baton uninstall` removes only `~/.baton` (it prints what it will remove and
  asks for confirmation).
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
