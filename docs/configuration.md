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
| `LEG_HARNESS_HOME` | the OS home | where the portable harness reads and writes client configuration (`~/.claude`, `~/.codex`, `~/.gemini` under it); the test suite points it at a throwaway directory. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CONFIG_DIR` move one client each, as everywhere else in Leg | `src/harness/registry.mjs` |
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

### The hand-off ladder

`~/.leg/preferences.json` also holds the ladder a terminal falls down when its
login stops (`src/preferences.mjs`), alongside the older `handoff_order`:

```json
{
  "handoff_order": ["claude", "codex", "agy"],
  "handoff_ladder": [
    { "agent": "claude", "account": "default", "model": "fable",  "when": "always", "cost": "plan" },
    { "agent": "claude", "account": "default", "model": "opus",   "when": "always", "cost": "plan" },
    { "agent": "claude", "account": "default", "model": "sonnet", "when": "always", "cost": "plan" },
    { "agent": "codex",  "account": "default", "model": null,     "when": "always", "cost": "plan" },
    { "agent": "agy",    "account": "default", "model": null,     "when": "always", "cost": "free" }
  ],
  "climb_back": "next-handoff",
  "may_spend": false,
  "reserve": {}
}
```

| key | default | meaning |
|-----|---------|---------|
| `handoff_ladder` | `claude/fable`, `claude/opus`, `claude/sonnet`, then one rung per remaining agent in `handoff_order` with model `null` | the fallback list, rung 1 first; each rung is `{agent, account, model, when, cost}`. `model` is `null` or one of that agent's names in `src/buckets.mjs` `MODEL_ALIASES` (only claude has any: `fable`, `opus`, `sonnet`, `haiku`). `account` is `default` or a name this machine has for that agent (`leg accounts ls`); anything else is refused with a sentence, because that string becomes the CLI's config dir and the usage record's file name. `when` is `always`, `below:N`, or `walled-only`. `cost` is `free`, `plan`, `credits`, or `metered`, and is a static label; the live cost a rung would spend right now is computed from the agent and the login, never read off this key, so a ladder migrated from an older `handoff_order` still meets the spending gate on `grok` |
| `climb_back` | `next-handoff` | `next-handoff` picks a recovered higher rung up again at the very next hand-off, with no extra step; `never` keeps a terminal on the rung it downshifted to until a human hands it off there by name |
| `may_spend` | `false` | while `false`, an automatic hand-off skips any rung whose live cost is `credits` or `metered`, and records why; a human's own pick is not gated by this |
| `reserve` | `{}` | `{ "<agent>": percent }`; an automatic hand-off will not take a rung on that login once its binding bucket is above `100 - percent`. A human's own pick still reaches it, and the picker names the reserve on that row instead of hiding it |

A fresh install with no `preferences.json` starts with `claude/fable`,
`claude/opus`, `claude/sonnet`, then every other installed agent from
`handoff_order` with `model: null`.

Leg writes `handoff_ladder` and `handoff_order` together and keeps them in
step: saving a ladder rewrites `handoff_order` from its distinct agent order,
and saving a bare `handoff_order` rewrites the ladder as one `model: null`
rung per agent, so an older install behaves exactly as it did until a rung is
edited. If the file is hand-edited so the two disagree, `handoff_order` wins
and the ladder is rebuilt from it, because the order is the shape a hand
edit is more likely to have meant.

`leg ladder` (`leg ladder ls`) prints the ladder with each rung's live state;
`leg ladder set <n> <agent>[/<account>[/<model>]]`, `leg ladder rm <n>` and
`leg ladder spend on|off` change it. See [cli-contracts.md](cli-contracts.md).

### Notifications

`~/.leg/preferences.json` also holds two toggles for a terminal that is
waiting on you (`src/preferences.mjs` `defaults()`):

| key | default | meaning |
|-----|---------|---------|
| `notify_terminal` | `true` | "Terminal toast when a terminal waits on you": on Claude Code's own `Notification` hook (`permission_prompt`, `idle_prompt`, `agent_needs_input`), send an OSC 9 toast to the window the agent is already running in |
| `notify_board` | `false` | "Browser notification when a terminal waits on you": fire a browser `Notification()` the moment a terminal row becomes `needsYou` and the reader is not looking at the board (a waiting card raises the tab badge and the verdict, not the notification); the board reads `window.isSecureContext` at render time and disables the toggle with an explanatory sentence where that is false |

Both are set from Settings on the board, or by writing the key directly. The
tab title badge (`(1) Leg` plus a favicon dot) has no toggle: it needs no
permission, so it is always on.

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
| `LEG_GROK_BIN` | grok | `src/adapters/grok.mjs` |
| `LEG_<NAME>_BIN` | a custom adapter called `<name>` (dashes become underscores, so `my-agent` reads `LEG_MY_AGENT_BIN`) | `src/adapters/custom.mjs` |
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

## The portable harness

Off until `leg harness enable`. Its settings live in `~/.leg/preferences.json`
beside the hand-off order:

```json
{ "harness": { "enabled": true, "policy": "sync", "source": "claude" } }
```

| key | values | meaning |
|-----|--------|---------|
| `enabled` | `true`, `false` (default) | the consent `leg harness enable` records; `leg harness disable` clears it and removes nothing |
| `policy` | `warn`, `sync` (default on enable), `strict` | what an unattended hand-off may do: report only; write managed state when safe; refuse a destination that cannot be made safe |
| `source` | `claude`, `codex` | the client whose harness is carried; auto-detected from `~/.claude/CLAUDE.md` then `~/.codex/AGENTS.md` when unset |

`~/.leg/harness/policy.json` (optional) names what is deliberately not
carried: sections to drop, hooks, skills and MCP servers to exclude, each with
a reason, and the Codex model ladder. State, backups and the evidence trail
live under `~/.leg/harness/`. Every detail: [harness.md](harness.md).

## Test and development seams

Not meant for normal use; documented for completeness.

| variable | meaning | read in |
|----------|---------|---------|
| `LEG_SKIP_KILL` | set to `1` to make the supervisor skip actually killing a leg's process (used by tests that need an "unkillable agent") | `src/runner.mjs` |
| `LEG_SERVER_SCRIPT` | override the server script path the launcher spawns | `src/launcher.mjs` |
| `COPILOT_HOME` | where `leg history` looks for the Copilot CLI store instead of `~/.copilot` (Claude, Codex and Grok use their own `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`; Antigravity has no variable and is found under the OS home) | `src/history/providers/copilot.mjs` |

## Network exposure

Leg binds `127.0.0.1` by default: no token is required, and only
processes on the same machine can reach it. Setting `LEG_BIND` to any
other address without also setting `LEG_TOKEN` makes the server refuse to
start, exit code `3` (`src/auth.mjs` `checkBind`/`BindRefused`). With a
token set, every `/api/*` request needs an `Authorization: Bearer <token>`
header; the event stream (`EventSource`, which cannot set headers) accepts
the same token as a `?token=` query parameter instead. Keep `LEG_BIND` on
loopback unless you are using `leg share`, which gives each human their own
token (see [Share](#share-more-than-one-human)) and can serve the board over
TLS.

## Share (more than one human)

Off until `leg share on` writes `$LEG_HOME/share.json`. That file is the
switch and the roster; the env variables below only tune the limits.

| field | meaning |
|-------|---------|
| `on` | share is on (it also needs a `bind` and at least one person) |
| `bind`, `bind_kind`, `port` | where the board listens: the Tailscale address by default, `lan`, or one you named |
| `owner` | the name a terminal belongs to when nothing else says (`LEG_PERSON`), and the name a loopback browser is treated as |
| `people[]` | `{ name, role: owner\|operator\|guest, token_sha256, created_at }`; the token itself is printed once and never stored |
| `tls` | `{ cert, key }`, the paths to a certificate pair; absent means plain http |
| `loopback_owner` | default `true`: a browser on this machine is the owner without a token. Set it to `false` to ask for a link even here |

| variable | default | meaning | read in |
|----------|---------|---------|---------|
| `LEG_RATE_MAX` | `600` | requests a minute per human (per address for an unnamed one); over it the board answers 429 with `Retry-After` | `src/ratelimit.mjs` |
| `LEG_RATE_MAX_FAILURES` | `20` | wrong tokens a minute from one address before that address waits the window out; a request with no token at all is not counted | `src/ratelimit.mjs` |

`LEG_TOKEN` is the single-token mode and is ignored while share is on.

### Roles

| role | terminals | cards | this machine |
|------|-----------|-------|--------------|
| `owner` | every one | every one | settings, harness policy, the trunk's repo paths, the history index, the worktree map, the audit trail |
| `operator` | their own; someone else's is read-only and redacted | adds, runs, approves, reassigns, kills | nothing: `/api/settings`, `/api/history`, `/api/worktrees`, `/api/trunk` and `/api/audit` all answer 403, and `/api/health` omits the home path |
| `guest` | their own; someone else's is read-only and redacted, with **Request handoff** as the only button | nothing: 403 | nothing |

A guest and an operator both see their own terminal's hand-off destinations,
so they can use the picker on it — but never the reset times behind them,
which are this machine's usage data. `src/share.mjs` `mayUseCards` and
`mayUseMachine` are the only place a role is turned into permission.

### TLS

Off unless a certificate pair is configured. Leg never issues one: a
self-signed pair teaches everyone on the board to click through a warning,
which is worse than plaintext on a network that is already private. On
Tailscale, `tailscale cert <machine>.<tailnet>.ts.net` issues a pair browsers
already trust.

| variable | meaning | read in |
|----------|---------|---------|
| `LEG_TLS_CERT` | path to the certificate; wins over `share.json`'s `tls.cert` | `src/share.mjs` `readTls` |
| `LEG_TLS_KEY` | path to the private key; wins over `share.json`'s `tls.key` | `src/share.mjs` `readTls` |

`leg share on --tls-cert <file> --tls-key <file>` writes the pair into
`share.json` and reads it once, so a bad pair fails there rather than at the
next board start. With a pair configured the shared address serves https and
every link `leg share` prints says `https://`. The companion listener on
`127.0.0.1` — the one that lets this machine's own browser in without a token
— stays plain http, because the certificate is for the shared name and
loopback traffic never leaves the machine. Half a pair, a missing file, an
unreadable file or an empty one stops the board with exit `3` rather than
falling back to plaintext. A renewed pair is picked up by `leg down && leg up`.

### The audit trail

`GET /api/audit` (owner only) and Settings → **Audit trail** on the board: one
list across every terminal and every card, newest first, of the actions a
person or an agent took — hand-offs, landings, approvals, reassignments,
kills. It reads the events already on disk and stores nothing new. Query
parameters: `limit` (default 200, max 1000), `since` (an ISO timestamp), `who`
(a name), `kind` (`human`, `agent` or `leg`). Every answer carries `scanned`
— how many terminals, cards and events it read — so an empty trail cannot be
mistaken for a quiet week.

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
