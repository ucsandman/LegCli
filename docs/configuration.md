# Configuration

The user-facing settings Leg reads, the seller settings for its checkout
site, and the card-level options that configure one card instead of the whole
install. For a developer who needs to change a default or point Leg at a
non-default binary.

Environment variables use the `LEG_` prefix with automatic fallback to legacy
`BATON_*` variables if set.

## `.env`

`npm start` and `npm run dev` run
`node --env-file-if-exists=.env bin/leg.mjs up`: `npm start` and `npm run
dev` automatically load a `.env` file in the repo root through that Node flag.
Inherited shell values are still honored and take precedence. Copy
`.env.example` to `.env` and edit it; `.env` is gitignored. Running `node
bin/leg.mjs` directly does not automatically load `.env`; export the
variables yourself in that case.

## Interactive sessions

These apply to `leg claude|codex|agy|grok`.

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `LEG_ACCOUNT` | `default` | start the session on a named login instead of the CLI's own home | `src/attach.mjs` |
| `LEG_AUTO_APPROVE` | `1` | launch interactive agents in auto-approve mode (set to `0`, `false`, or `off` to disable) | `src/preferences.mjs` |
| `LEG_NO_AUTO_APPROVE` | (unset) | set to `1` to opt out of auto-approve mode | `src/preferences.mjs` |
| `LEG_WARN_PCT` | `85` | the percentage of either usage window that turns the card amber, records a `warning` event and rings the terminal bell once | `src/usage.mjs` |
| `LEG_NO_HANDOFF` | (unset, hand-off on) | set to `1` to warn and record but never switch agents | `src/attach.mjs` |
| `LEG_NO_OPEN` | (unset, opens once) | set to `1` to start the board without opening a browser | `bin/leg.mjs` |
| `LEG_NO_BOARD` | (unset) | set to `1` to run a session with no board at all (the record under `$LEG_HOME/sessions/` is still kept; the test suite uses this) | `src/attach.mjs` |
| `LEG_WAIT_TICK_MS` | `1000` | how often the all-out countdown redraws and re-checks Ctrl-C / End while waiting for the first reset | `src/attach.mjs` |
| `LEG_USAGE_POLL_MS` | `60000` | how often an active attach polls its usage source; Claude uses its usage endpoint and Codex uses read-only app-server rate limits | `src/attach.mjs` |
| `LEG_ATTACH_POLL_MS` | `2000` | how often the session loop re-reads the taps; git is re-read every third poll | `src/attach.mjs` |
| `LEG_CLAUDE_USAGE_URL` | `https://api.anthropic.com/api/oauth/usage` | the usage endpoint, for a test double | `src/taps/claude-usage.mjs` |
| `LEG_CLAUDE_ARGS`, `LEG_CODEX_ARGS`, `LEG_AGY_ARGS` | (none) | space-separated extra arguments for a leg Leg starts on its own after a hand-off (your own `leg <agent> …` args never apply to the next agent); e.g. `LEG_CODEX_ARGS="-m gpt-5.3-codex-spark"` keeps a test chain on cheap models | `src/attach.mjs` |
| `LEG_LIVE_DIR` | `fixtures/live/` in a dev clone, else `~/.leg/live/` | where the first real limit payload per agent and signal is kept, secrets scrubbed (`src/live-capture.mjs`); a `leg sessions simulate-limit` payload is never kept | `src/live-capture.mjs`, `scripts/live-limits.mjs` |

| `LEG_PERSON` | the board's owner | whose terminal this is when the board is shared (`leg share`); it is the name on the card and the one that decides who may control it | `src/share.mjs` `whoami` |

`LEG_SESSION` is not an input: Leg sets it in the agent's environment to
the session id, so a hook or a script inside the session can find its own
record under `$LEG_HOME/sessions/`.

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are set for the child when the session
runs on a named account; see [Accounts](#accounts) below.

### Auto-approve launch mode

By default, Leg starts interactive sessions (`leg claude`, `leg codex`, `leg agy`, and `leg grok`) in permissive auto-approve mode so you never sit through repetitive tool permission prompts:

- Claude: `--dangerously-skip-permissions`
- Codex: `--ask-for-approval never`
- agy: `--dangerously-skip-permissions`
- Grok: `--always-approve`

These flags are injected at spawn time and only affect sessions launched through Leg. Your global CLI configurations (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`) remain untouched.

To opt out and keep standard approval prompts:

1. CLI flag: pass `--no-auto-approve` when starting a session (e.g. `leg claude --no-auto-approve`).
2. Environment variable: set `LEG_AUTO_APPROVE=0` or `LEG_NO_AUTO_APPROVE=1` (or legacy `BATON_AUTO_APPROVE=0` / `BATON_NO_AUTO_APPROVE=1`).
3. Persistent preference: set `"auto_approve": false` in `~/.leg/preferences.json`.

## Core

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `LEG_HOME` | `~/.leg` | where sessions, usage, accounts, cards, runs and the pidfiles live | `src/store.mjs`, `src/ledger.mjs`, `src/runner.mjs`, `src/worktree.mjs`, `src/cards.mjs`, `src/sessions.mjs`, `src/usage.mjs`, `src/accounts.mjs` |
| `LEG_PORT` | `4747` | board server port | `src/server.mjs`, `src/launcher.mjs`, `bin/leg.mjs` (`open`) |
| `LEG_BIND` | `127.0.0.1` | board server bind address | `src/server.mjs`, `src/launcher.mjs` |
| `LEG_TOKEN` | (none) | bearer token required for `/api/*` and the event stream once set | `src/server.mjs`, `src/auth.mjs` |
| `LEG_MAX_CONCURRENT` | `2` | how many cards the scheduler runs at once | `src/scheduler.mjs` |
| `LEG_MAX_LAND_ATTEMPTS` | `3` | shared cap on test-station and land-station bounces before a card fails | `src/chain.mjs`, `src/mergequeue.mjs` (test-run timeout uses a separate variable, below) |
| `LEG_NO_SCHEDULER` | (unset, scheduler on) | set to `1` to boot the board server without its embedded scheduler | `src/server.mjs` |
| `LEG_QUIET` | (unset, logs on) | set to `1` to silence the `[leg]`/`[board]` log lines | `src/orchestrator.mjs`, `src/server.mjs` (the launcher always starts its child with `LEG_QUIET=0` so `leg up`'s own log stream is not silenced by an inherited `1`) |
| `LEG_POLL_MS` | `2000` | how often the orchestrator polls a run's `run.json` while it waits | `src/orchestrator.mjs` |
| `LEG_TIMERS_MS` | `1800000,5400000` | `<notify-ms>,<kill-ms>[,<kill-verify-ms>]`: when the supervisor logs a "still running" notice, when it kills the leg, and how long it waits before retrying/declaring a kill failed (verify defaults to `30000`) | `src/runner.mjs` |
| `LEG_COMMIT_VERIFY` | (unset, hooks skipped) | set to `1` to run the repo's git hooks when the land station commits the worktree (default passes `--no-verify`) | `src/mergequeue.mjs` |
| `LEG_LAND_TEST_TIMEOUT_MS` | `600000` | timeout for the land station's own test run | `src/mergequeue.mjs` |
| `LEG_HEALTH_TIMEOUT_MS` | `20000` | how long `leg up` waits for `/api/health` before giving up | `src/launcher.mjs` |

## Optional syncs

Off unless explicitly enabled; a sync failure never blocks or fails a card
(see [concepts.md](concepts.md) and the README's "Optional syncs" section).

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `LEG_SYNC_WORKBOARD` | `0` | set to `1` to mirror cards to the OpenClaw Workboard CLI | `src/sync/workboard.mjs` |
| `OPENCLAW_BIN` | (none) | path to an `openclaw` `.mjs`/`.cjs`/`.js` entry, overriding resolution | `src/sync/workboard.mjs` |
| `OPENCLAW_PKG_DIR` | (none) | directory to resolve the `openclaw` npm package from | `src/sync/workboard.mjs` |
| `LEG_SYNC_DASHCLAW` | `0` | set to `1` (with the two variables below) to record every ledger event as a DashClaw action | `src/sync/dashclaw.mjs` |
| `DASHCLAW_URL` | (none) | DashClaw API base URL | `src/sync/dashclaw.mjs` |
| `DASHCLAW_API_KEY` | (none) | DashClaw API key, sent as `x-api-key` | `src/sync/dashclaw.mjs` |

## Seller and checkout site

These are for the checkout/key-delivery site and its deployment helpers, not
normal Leg use.

| variable | meaning | read in |
|----------|---------|---------|
| `LEG_SITE` | buyer-site origin used by the CLI for its purchase link; defaults to `https://legcli.com` | `src/license.mjs` |
| `LEG_SITE_ORIGIN` | site origin included in checkout and email links; defaults to `https://legcli.com` | `site/api/_lib.js`, `scripts/vercel-env.mjs` |
| `STRIPE_SECRET_KEY`, `STRIPE_TEST_SECRET_KEY` | live or test Stripe secret key supplied to the deployment helper | `scripts/vercel-env.mjs` |
| `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_WEBHOOK_SECRET` | test or live webhook input selected by the deployment helper and deployed as `STRIPE_WEBHOOK_SECRET` | `scripts/vercel-env.mjs` |
| `STRIPE_WEBHOOK_SECRET` | deployed webhook verification secret used by the webhook handler | `site/api/webhook.js` |
| `RESEND_API_KEY` | Resend key used to email a paid license key | `site/api/_lib.js` |
| `LEG_MAIL_FROM`, `LEG_MAIL_REPLY_TO` | runtime site API sender and reply-to overrides; `scripts/vercel-env.mjs` currently deploys its own fixed sender and reply-to values | `site/api/_lib.js`, `scripts/vercel-env.mjs` |
| `LEG_LICENSE_PRIVATE_KEY` | private signing key for license issuance; never commit it | `site/api/key.js`, `scripts/vercel-env.mjs` |
| `NPM_TOKEN` | external npm publishing automation only; repository scripts do not read it | (none) |

## Adapter binary overrides

Each points at a specific CLI binary (or, when it ends `.mjs`/`.cjs`/`.js`,
a Node entry point run via `node <entry>`), instead of Leg's own
resolution logic. See [adapters.md](adapters.md) for what each adapter
resolves to by default.

| variable | adapter | read in |
|----------|---------|---------|
| `LEG_CLAUDE_BIN` | claude | `src/adapters/claude.mjs` |
| `LEG_CODEX_BIN` | codex | `src/adapters/codex.mjs` |
| `LEG_AGY_BIN` | agy | `src/adapters/agy.mjs` |
| `LEG_GROK_BIN` | grok (not registered by default) | `src/adapters/grok.mjs` |
| `LEG_GH_BIN` | the `pr` land-mode stub | `src/stations/pr.mjs`; unset, `land_mode: pr` returns an error rather than running a real `gh` |
| `LEG_CHB_BIN` | `context-handoff-bundle` | `src/handoff.mjs`; unset, Leg tries `context-handoff-bundle` on PATH, then `python -m context_handoff_bundle` |

## Accounts

An extra login is a directory under `$LEG_HOME`, never a change to your real
home. `src/accounts.mjs` `LAYOUT` is the whole definition.

```
~/.leg/
  accounts.json                     the named accounts per agent
  accounts/claude/<name>/
    hooks/ skills/ agents/ commands/ plugins/ rules/ scripts/
    output-styles/ tools/           junctions back to ~/.claude
    settings.json settings.local.json CLAUDE.md keybindings.json
    statusline.ps1 statusline-combined.ps1
                                    copies, refreshed before every launch
    .credentials.json               the login, written by claude itself
  accounts/codex/<name>/
    skills/ prompts/ rules/ plugins/ agents/ hooks/ memories/ superpowers/
    junctions back to ~/.codex
    config.toml AGENTS.md           copies, refreshed before every launch
```

| agent | config-dir variable | default home |
|-------|---------------------|--------------|
| claude | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| codex | `CODEX_HOME` | `~/.codex` |
| agy | none in 1.2.0, so one account only | `~/.gemini/antigravity-cli` |

Commands:

```
leg accounts ls                      logins and their 5h/7d usage
leg accounts add <claude|codex> <name>
leg accounts rm <claude|codex> <name>
leg accounts terms                   what both vendors' terms say
```

`add` creates the directory, junctions the shared directories in, copies the
settings files, and prints one line to paste to log in. `rm` removes the
junctions as links, never following them, then deletes the directory. Nothing
under your real home is written at any point. Start a session on a named
account with `LEG_ACCOUNT=<name>`, or let a limit hand off to it.

## Test and development seams

Not meant for normal use; documented for completeness.

| variable | meaning | read in |
|----------|---------|---------|
| `LEG_SKIP_KILL` | set to `1` to make the supervisor skip actually killing a leg's process (used by tests that need an "unkillable agent") | `src/runner.mjs` |
| `LEG_SERVER_SCRIPT` | override the server script path the launcher spawns | `src/launcher.mjs` |

## Network exposure

Leg binds `127.0.0.1` by default: no token is required, and only
processes on the same machine can reach it. Setting `LEG_BIND` to any
other address without also setting `LEG_TOKEN` makes the server refuse to
start, exit code `3` (`src/auth.mjs` `checkBind`/`BindRefused`). With a
token set, every `/api/*` request needs an `Authorization: Bearer <token>`
header; the event stream (`EventSource`, which cannot set headers) accepts
the same token as a `?token=` query parameter instead. There is no TLS; keep
`LEG_BIND` on loopback unless you are using `leg share`, which gives
each human their own token (see [Share](#share-more-than-one-human)).

## Share (more than one human)

Off until `leg share on` writes `$LEG_HOME/share.json`. That file is the
switch and the roster; the env variables below only tune the limits.

| field | meaning |
|-------|---------|
| `on` | share is on (it also needs a `bind` and at least one person) |
| `bind`, `bind_kind`, `port` | where the board listens: the Tailscale address by default, `lan`, or one you named |
| `owner` | the name a terminal belongs to when nothing else says (`LEG_PERSON`), and the name a loopback browser is treated as |
| `people[]` | `{ name, role: owner\|guest, token_sha256, created_at }`; the token itself is printed once and never stored |
| `loopback_owner` | default `true`: a browser on this machine is the owner without a token. Set it to `false` to ask for a link even here |

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `LEG_RATE_MAX` | `600` | requests a minute per human (per address for an unnamed one); over it the board answers 429 with `Retry-After` | `src/ratelimit.mjs` |
| `LEG_RATE_MAX_FAILURES` | `20` | wrong tokens a minute from one address before that address waits the window out; a request with no token at all is not counted | `src/ratelimit.mjs` |

`LEG_TOKEN` is the single-token mode and is ignored while share is on.

## Card-level options

These configure one card, not the whole install (set with `card add` flags
or the New card form; see [getting-started.md](getting-started.md) and
[board-guide.md](board-guide.md)):

- **leases**: path globs the card claims for scheduling (`src/leases.mjs`).
- **land_mode**: `ff` (fast-forward, the merge queue) or `pr` (stub;
  requires `LEG_GH_BIN`) (`src/land.mjs`).
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

- [adapters.md](adapters.md): what each `LEG_<ADAPTER>_BIN` overrides,
  and each adapter's default resolution.
- [concepts.md](concepts.md): leases, the scheduler, and the land station
  these variables tune.
