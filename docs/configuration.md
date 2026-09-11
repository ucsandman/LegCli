# Configuration

Every environment variable Baton reads, and the card-level options that
configure one card instead of the whole install. For a developer who needs
to change a default or point Baton at a non-default binary.

## `.env`

`npm start` and `npm run dev` run
`node --env-file-if-exists=.env bin/baton.mjs up`: variables come from a
`.env` file in the repo root, read only through that flag, never from a
shell export picked up by other means. Copy `.env.example` to `.env` and
edit it; `.env` is gitignored. Running `node bin/baton.mjs` directly (not
through `npm start`/`npm run dev`) does not read `.env`; export the
variables yourself in that case.

## Core

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `BATON_HOME` | `~/.baton` | where cards, runs, and the pidfiles live | `src/store.mjs`, `src/ledger.mjs`, `src/runner.mjs`, `src/worktree.mjs`, `src/cards.mjs` |
| `BATON_PORT` | `4747` | board server port | `src/server.mjs`, `src/launcher.mjs`, `bin/baton.mjs` (`open`) |
| `BATON_BIND` | `127.0.0.1` | board server bind address | `src/server.mjs`, `src/launcher.mjs` |
| `BATON_TOKEN` | (none) | bearer token required for `/api/*` and the event stream once set | `src/server.mjs`, `src/auth.mjs` |
| `BATON_MAX_CONCURRENT` | `2` | how many cards the scheduler runs at once | `src/scheduler.mjs` |
| `BATON_MAX_LAND_ATTEMPTS` | `3` | shared cap on test-station and land-station bounces before a card fails | `src/chain.mjs`, `src/mergequeue.mjs` (test-run timeout uses a separate variable, below) |
| `BATON_NO_SCHEDULER` | (unset, scheduler on) | set to `1` to boot the board server without its embedded scheduler | `src/server.mjs` |
| `BATON_QUIET` | (unset, logs on) | set to `1` to silence the `[baton]`/`[board]` log lines | `src/orchestrator.mjs`, `src/server.mjs` (the launcher always starts its child with `BATON_QUIET=0` so `baton up`'s own log stream is not silenced by an inherited `1`) |
| `BATON_POLL_MS` | `2000` | how often the orchestrator polls a run's `run.json` while it waits | `src/orchestrator.mjs` |
| `BATON_TIMERS_MS` | `1800000,5400000` | `<notify-ms>,<kill-ms>[,<kill-verify-ms>]`: when the supervisor logs a "still running" notice, when it kills the leg, and how long it waits before retrying/declaring a kill failed (verify defaults to `30000`) | `src/runner.mjs` |
| `BATON_COMMIT_VERIFY` | (unset, hooks skipped) | set to `1` to run the repo's git hooks when the land station commits the worktree (default passes `--no-verify`) | `src/mergequeue.mjs` |
| `BATON_LAND_TEST_TIMEOUT_MS` | `600000` | timeout for the land station's own test run | `src/mergequeue.mjs` |
| `BATON_HEALTH_TIMEOUT_MS` | `20000` | how long `baton up` waits for `/api/health` before giving up | `src/launcher.mjs` |

## Optional syncs

Off unless explicitly enabled; a sync failure never blocks or fails a card
(see [concepts.md](concepts.md) and the README's "Optional syncs" section).

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `BATON_SYNC_WORKBOARD` | `0` | set to `1` to mirror cards to the OpenClaw Workboard CLI | `src/sync/workboard.mjs` |
| `OPENCLAW_BIN` | (none) | path to an `openclaw` `.mjs`/`.cjs`/`.js` entry, overriding resolution | `src/sync/workboard.mjs` |
| `OPENCLAW_PKG_DIR` | (none) | directory to resolve the `openclaw` npm package from | `src/sync/workboard.mjs` |
| `BATON_SYNC_DASHCLAW` | `0` | set to `1` (with the two variables below) to record every ledger event as a DashClaw action | `src/sync/dashclaw.mjs` |
| `DASHCLAW_URL` | (none) | DashClaw API base URL | `src/sync/dashclaw.mjs` |
| `DASHCLAW_API_KEY` | (none) | DashClaw API key, sent as `x-api-key` | `src/sync/dashclaw.mjs` |

## Adapter binary overrides

Each points at a specific CLI binary (or, when it ends `.mjs`/`.cjs`/`.js`,
a Node entry point run via `node <entry>`), instead of Baton's own
resolution logic. See [adapters.md](adapters.md) for what each adapter
resolves to by default.

| variable | adapter | read in |
|----------|---------|---------|
| `BATON_CLAUDE_BIN` | claude | `src/adapters/claude.mjs` |
| `BATON_CODEX_BIN` | codex | `src/adapters/codex.mjs` |
| `BATON_GEMINI_BIN` | gemini | `src/adapters/gemini.mjs` |
| `BATON_AGY_BIN` | agy | `src/adapters/agy.mjs` |
| `BATON_GROK_BIN` | grok (not registered by default) | `src/adapters/grok.mjs` |
| `BATON_GH_BIN` | the `pr` land-mode stub | `src/stations/pr.mjs`; unset, `land_mode: pr` returns an error rather than running a real `gh` |
| `BATON_CHB_BIN` | `context-handoff-bundle` | `src/handoff.mjs`; unset, Baton tries `context-handoff-bundle` on PATH, then `python -m context_handoff_bundle` |

## Test and development seams

Not meant for normal use; documented for completeness.

| variable | meaning | read in |
|----------|---------|---------|
| `BATON_SKIP_KILL` | set to `1` to make the supervisor skip actually killing a leg's process (used by tests that need an "unkillable agent") | `src/runner.mjs` |
| `BATON_SERVER_SCRIPT` | override the server script path the launcher spawns | `src/launcher.mjs` |

## Network exposure

Baton binds `127.0.0.1` by default: no token is required, and only
processes on the same machine can reach it. Setting `BATON_BIND` to any
other address without also setting `BATON_TOKEN` makes the server refuse to
start, exit code `3` (`src/auth.mjs` `checkBind`/`BindRefused`). With a
token set, every `/api/*` request needs an `Authorization: Bearer <token>`
header; the event stream (`EventSource`, which cannot set headers) accepts
the same token as a `?token=` query parameter instead. There is no TLS and
no per-user identity yet; keep `BATON_BIND` on loopback unless you have
reviewed the roadmap's multi-human item ([ROADMAP-v2.md](ROADMAP-v2.md)).

## Card-level options

These configure one card, not the whole install (set with `card add` flags
or the New card form; see [getting-started.md](getting-started.md) and
[board-guide.md](board-guide.md)):

- **leases**: path globs the card claims for scheduling (`src/leases.mjs`).
- **land_mode**: `ff` (fast-forward, the merge queue) or `pr` (stub;
  requires `BATON_GH_BIN`) (`src/land.mjs`).
- **test_command**: overrides the land/test stations' auto-detected command
  (`src/mergequeue.mjs` `resolveTestCommand`).
- **trunk**: the branch a card's worktree is based on and lands onto
  (default `main`).
- Per-adapter chain options: **mode**, **max-turns**, **model**, and
  **approve** (gate that leg behind a human Approve), set per adapter with
  `--mode <adapter>=<mode>`, `--max-turns <adapter>=<n>`, `--model
  <adapter>=<name>`, `--approve <adapter,...>` (`src/pipeline.mjs`
  `normalizeChainEntry`).

## See also

- [adapters.md](adapters.md): what each `BATON_<ADAPTER>_BIN` overrides,
  and each adapter's default resolution.
- [concepts.md](concepts.md): leases, the scheduler, and the land station
  these variables tune.
