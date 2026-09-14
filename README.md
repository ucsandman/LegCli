# baton

**Type `baton claude`, `baton codex` or `baton agy` instead of the bare command. You get the same interactive agent; Baton opens a board next to it, watches the usage limit, keeps a handoff bundle current, and when the limit hits it starts the next agent in the same terminal from that bundle.**

[![License: commercial](https://img.shields.io/badge/license-commercial-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-lightgrey.svg)](package.json)
[![Local first](https://img.shields.io/badge/runs-on%20your%20machine-informational.svg)](#network-exposure)

![The Baton board: three live claude terminals on one repo, two of them in their own worktrees and flagged for changing README.md; one landed on main through the merge queue, the other bounced naming the conflicting file, and the landed-on-trunk list says which terminal landed the commit](https://baton-agents.vercel.app/img/terminals-1280.png)

You keep using your coding agents exactly as you do today, in any terminal,
from your own config directory: Baton adds its hooks in a separate per-session
settings file and never edits yours. `baton claude --model opus` is
`claude --model opus` with four things running alongside it:

1. **A board.** Opened once in your browser, reused after that. Every Baton
   session in every terminal is a card on it: agent, account, repo and branch,
   the task, the files it is touching, its 5h and 7d usage, what has landed on
   trunk. Two sessions editing the same file in one repo are flagged on both
   cards, and a second session in a checkout that already has one gets its
   own worktree and a **Land** button instead of writing over the first.
2. **Usage tracking** per agent and account, from what each CLI already
   exposes: Claude Code's usage endpoint and its `StopFailure` hook, Codex's
   read-only app-server rate-limit read, agy's log.
3. **A context handoff bundle** ([context-handoff-bundle](https://pypi.org/project/context-handoff-bundle/))
   refreshed as the session goes, so the work is always ready to hand off.
4. **The handoff itself.** Near the limit you get a warning. At the limit Baton
   saves the bundle, stops the agent, and starts the next option in the same
   terminal from that bundle: another login of the same agent if you added
   one, otherwise the next agent in the order shown on the terminal card.
   The default is claude → codex → agy, and Settings changes the default for
   new terminals. Nothing is retyped.
   When every option is out, it tells you which resets first and when, waits
   for that reset with a countdown, and starts that agent from the bundle.

Subscription logins only: Baton strips `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_EFFORT`, and `CLAUDE_PLUGIN_DATA` before any agent
starts. It then sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for a detached
Claude print session. Baton never edits `~/.claude/settings.json`,
`~/.codex/config.toml` or any other file of yours; `baton uninstall` removes
only `~/.baton`.

## Contents

- [60-second run](#60-second-run)
- [What Baton reads from each agent](#what-baton-reads-from-each-agent)
- [How a handoff works](#how-a-handoff-works)
- [Two sessions in one repo](#two-sessions-in-one-repo)
- [More than one human](#more-than-one-human)
- [The board](#the-board)
- [Second accounts, and what the terms say](#second-accounts-and-what-the-terms-say)
- [What is and is not touched](#what-is-and-is-not-touched)
- [CLI reference](#cli-reference)
- [Background tasks: the v0.1 extras](#background-tasks-the-v01-extras)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## 60-second run

Prerequisites: Node 22 or newer, git, Python 3 with pip, and at least one
logged-in agent CLI (`claude`, `codex` or `agy`).

```
npm install -g baton-agents
pip install -U context-handoff-bundle
cd <any repo>
baton claude
```

That is the whole setup. The first `baton <agent>` starts the board on
http://127.0.0.1:4747 and opens it; later sessions reuse it. Anything after the
agent name passes straight through (`baton codex -m gpt-5.3-codex-spark`,
`baton claude --resume`). The agent's own prompt and permission flags pass
through unchanged, and your settings file is never edited: Baton's hooks ride
in a separate per-session `--settings` file.

Maintainers with repository access can install from a clone instead:
`git clone https://github.com/ucsandman/baton.git && cd baton && npm install && npm link`.

## What Baton reads from each agent

Nothing is guessed from screen scraping. Each tap was read from the CLI's
source or documentation and then checked on a real machine (2026-09-11,
Claude Code 2.1.268, codex-cli 0.153.4, agy 1.2.0); the rightmost column says
which.

| agent | usage percentages | the wall (limit hit) | how Baton attaches | status |
|-------|-------------------|----------------------|--------------------|--------|
| claude | `GET api.anthropic.com/api/oauth/usage` with the login Claude Code stored, the same data as `/usage` and the built-in status line (`five_hour`, `seven_day`, `utilization`, `resets_at`); polled every 60 s | `StopFailure` hook with `error: rate_limit` ([docs](https://code.claude.com/docs/en/hooks#stopfailure)) | one extra settings file per session via `--settings`, carrying only Baton's own hooks; `autoContinueAtUsageLimit` is set to `false` because Baton owns the handoff | observed live |
| codex | read-only `account/rateLimits/read` through the app-server, polled every 60 s by the board and active attach; windows are identified by duration (300 minutes = 5h, 10080 = 7d) | `task_complete.error.codex_error_info: usage_limit_exceeded`, message "You've hit your usage limit … try again at …" (`codex-rs/protocol/src/error.rs`) | no model turn and no hook are injected; the board reads the CLI backend and records only returned windows | verified by source and regression tests |
| agy | none exposed (agy's own status line fetches a quota summary that is written nowhere) | `RESOURCE_EXHAUSTED`, "it resets in …", "out of quota" in the log | `--log-file` per session; `~/.gemini/antigravity-cli/history.jsonl` gives the prompts and conversation id | observed live (a real `RESOURCE_EXHAUSTED` with its reset was read from the log on 2026-09-11) |

Why not Claude Code's status line JSON (`rate_limits.five_hour.used_percentage`):
on 2.1.268 the custom `statusLine` Baton passes through `--settings` did not
run, so the endpoint poll is the source. Baton still writes a `statusLine`
entry that records the same fields, so the moment a build honours it the poll
becomes a fallback.

For Codex, Baton does not infer availability from a lower percentage: only an
explicit available answer from the backend clears an earlier wall. The board
labels each bar as `<n>% used` and marks an old reading as stale rather than
presenting it as current.

## How a handoff works

1. **Warning.** At 85 % of any window (`BATON_WARN_PCT`) the session card turns
   amber, the event log names the next option, and the terminal bell rings once.
2. **Limit.** claude: the `StopFailure` hook fires with `rate_limit`. codex: the
   rollout reports `usage_limit_exceeded`. agy: the log says
   `RESOURCE_EXHAUSTED`. The account is marked walled until the reset the CLI
   reported (or the soonest known window reset).
3. **Bundle.** Baton writes structured notes (task, the last messages from the
   transcript, `git diff --stat`, dirty files, files edited this session, recent
   commits, why it stopped) and runs `context-handoff-bundle save --repo-local`
   with one slug per leg; each save writes its own timestamped bundle next to
   the last one. A checkpoint of the same bundle is taken every two minutes
   while the session is active.
4. **Switch.** The agent process is stopped, the terminal is restored, and the
   next option starts in the same terminal with a short pointer prompt:
   read `.baton/RESUME.md` (the `context-handoff-bundle load` output plus the
   reason for the switch), check `git status` and `git diff`, continue, do not
   ask the human to restate the task. `claude "<prompt>"`, `codex "<prompt>"`
   and `agy -i "<prompt>"` all open the normal interactive session with that
   first turn.
5. **Order.** Other accounts of the same agent come first, then every other
   agent in the saved order, each tried once. The order is a priority list, not
   a rotation: put agy at the bottom and agy is the last option from a Claude
   terminal and from a Codex terminal alike. The board shows the exact
   sequence with the agent running now skipped, plus the preferred option and
   the first option eligible from current install and limit state. Use **Change
   order** on a terminal card to change that terminal, or Settings to set the
   default copied by new terminals. An option whose CLI is missing or whose
   wall has not reset is skipped.
6. **All out.** The terminal prints each option with its reset time, soonest
   first, then stays open with a countdown to the first reset and starts that
   agent from the bundle when it arrives. The card says `waiting for <agent>
   at <time>`. Ctrl-C (or End on the card) quits with exit 3 instead.

You can force a handoff any time: the **Hand off now** button on the card, or
`baton sessions handoff <id>`. Verified on this machine: `baton claude` opened
the real Claude Code TUI with Baton's hooks firing into the session log, the
usage poll recorded 36 % of the 5h window and 74 % of the 7d window, the
warning fired at 96 % of the 7d window and named codex as the next option, and
a limit saved the bundle, stopped claude and started codex in the same
terminal with the pointer prompt. A real `StopFailure` arrived on 2026-09-11
and is kept at `fixtures/live/claude/limit-rate_limit.json`; to drive the path
on demand, `baton sessions simulate-limit <id>` sends the same `StopFailure`
`rate_limit` payload Claude Code would send through Baton's hook: verified end
to end on a haiku session, the hook set the limit, the runner saved the
bundle, stopped claude and started codex, which read `.baton/RESUME.md` on its
first turn. The simulated wall clears after two minutes and is never kept as
evidence. The first real `StopFailure` was saved that way, with secrets
scrubbed, at `fixtures/live/claude/limit-rate_limit.json`, and the claude docs
row flipped to observed-live (`node scripts/live-limits.mjs`). The same
capture is wired for codex `usage_limit_exceeded` and agy `RESOURCE_EXHAUSTED`;
no payload for either has been kept yet.

Terminals started by this version can change order while they run. An older
terminal stays on the order it started with; its card says a restart is needed
and can save the desired default for the next launch. A normal agent exit ends
the terminal. It does not trigger a handoff.

## Two sessions in one repo

Two agents in one working tree write over each other's files. So when you
start `baton codex` in a checkout where `baton claude` is already live, the new
session gets its own git worktree, `<repo>/.baton-worktrees/<session-id>` on
branch `baton/<session-id>`, cut from the branch the checkout has out, and the
terminal prints one line saying where it is. The agent starts there; the card,
the usage tracking and the handoff work the same. `--no-worktree` shares the
checkout on purpose (Baton takes the flag out; the agent never sees it).

The card of a session with its own worktree has a **Land** button. It sends
the branch through the merge queue: whatever the agent left uncommitted is
committed on the branch, the branch is rebased onto its base, the repo's test
command runs (`package.json` `test`, `pytest`, or none with a warning), and the
base is fast-forwarded, never merged. When a step fails nothing lands and the
card says why: `rebase-conflict` with the files, `tests-red` with the end of
the output, `dirty-trunk` when the checkout has local changes the landing
would overwrite. Local changes it would not touch are left alone. The
landed-on-trunk list says which terminal landed each commit. **Remove** safely
prunes a finished session only when its worktree is clean and its branch is
already on the base. **Remove record** is a separate visible button with a
confirmation: it removes only Baton's saved session record and deliberately
keeps the worktree, branch, unmerged commits, and dirty files.

Verified live on 2026-09-11 with three haiku sessions in a throwaway repo. The
first stayed in the checkout; the second and third each got a worktree and
appended a line to README.md. Land on the second, clicked on the real board,
ran the repo's tests and fast-forwarded main; Land on the third bounced with
`rebase-conflict` on README.md and kept its commit on its branch; the
landed-on-trunk list named the second terminal (the screenshot above).

## More than one human

Off until you run it. `baton share on` binds the board to your Tailscale
address (or `--bind lan`, or an address you name) and gives every human their
own name and token; until then the board stays on `127.0.0.1` and there is no
token at all.

```
baton share on              your own link, printed once
baton share add sam         sam's link, printed once
baton share                 who is on the board (never a token again)
baton share rotate sam      sam's old link stops working
baton share off             back to 127.0.0.1; every link stops working
```

A token is kept as a sha256 hash, so a lost link is re-issued, never re-read.
The board takes the token out of the address bar and keeps it in the browser.
Your own browser on this machine needs no token.

![What a guest sees: their own terminal in full, the other human's terminal read-only with the prompt hidden and one Request handoff button](https://baton-agents.vercel.app/img/share-guest-1280.png)

What another human sees is the terminals lane, read-only. Each card says whose
terminal it is. On a card that is not theirs there is no prompt, no file name,
no path, no bundle and no event log; what stays is the agent, the status,
repo@branch, the usage bars and the reset it is waiting for, and the only
button is **Request handoff**; it lands on the owner's card as `sam asked for
a hand-off` with Approve and Dismiss. The pipeline side of the board (cards, logs, the
floor) stays the owner's alone. A terminal belongs to the human who started it:
`BATON_PERSON=sam baton claude` on the same machine is sam's card, not yours.

The security pass that goes with it: every `/api` route needs a token, the
event stream included; twenty wrong tokens from one address and that address
waits a minute; one identity gets 600 requests a minute; a guest gets 403 on
everything that is not theirs; and the tests send a bad and a missing token to
every route. There is still no TLS, so keep this on Tailscale or a network you
trust. Verified live on 2026-09-11: two terminals on one machine, one wes's and
one sam's; sam's board showed wes's card with the prompt hidden and only
**Request handoff**, and sam's request reached wes's board (`~/.baton/board.log`:
"hand-off requested … by sam").

## The board

`baton <agent>` opens it; `baton open` reopens it; `baton down` stops it.

- **Accounts strip**: one pill per login with the 5h and 7d bars, a live dot
  when a session is running on it, "limit · back <time>" when walled.
- **Terminal cards**: agent and account, status (starting, running, near limit,
  limit hit, handing off, ended, lost), the first prompt, repo@branch, turns,
  HEAD, usage bars, the files being touched (chips), and the warning, limit or
  handoff line. Two live sessions on one repo touching the same file get a red
  border and a "⚠ claude (claude-ae85) is changing README.md in another
  checkout; whoever lands second rebases" line on both cards. A
  session with its own worktree shows `own worktree · from <branch>` and, after
  a Land, `✓ landed on main · <sha>` or `✗ bounced (<reason>): <why>`.
- **Landed on trunk**: the last commits on `main` (or `master`) of every repo
  with a live session; a commit a Land put there says `landed by <agent>
  (<session>)`.
- **Buttons**: Land (sessions with their own worktree), Hand off now, End
  (stops the agent), Remove (ended sessions).
- Below it, optional **Background tasks** an agent runs in a separate worktree
  without joining the terminal conversation (see below).

The board reads `~/.baton/sessions/*/session.json` over server-sent events; a
session whose runner process is gone is marked `lost`, never shown as live.

## Second accounts, and what the terms say

Optional. `baton accounts add claude work` creates
`~/.baton/accounts/claude/work`, junctions your `hooks`, `skills`, `agents`,
`commands`, `plugins`, `rules`, `scripts`, `output-styles` and `tools` into it,
copies `settings.json`, `CLAUDE.md` and the status-line scripts (refreshed from
your real `~/.claude` before every launch), and prints one line to paste:

```
$env:CLAUDE_CONFIG_DIR='C:\Users\you\.baton\accounts\claude\work'; claude auth login
```

Same for codex (`CODEX_HOME`; `config.toml`, `AGENTS.md`, `skills`, `prompts`,
`rules`, `plugins`, `agents`, `hooks`, `memories` shared). agy 1.2.0 has no
config-directory override, so it stays one account. Only the login lives in
the account directory; `baton accounts rm` removes the junctions and the
directory and never touches your real home.

The terms, as published (effective dates below):

- Anthropic Consumer Terms (effective 2025-10-08): "You may not share your
  Account login information, Anthropic API key, or Account credentials with
  anyone else" and you "must not … bypass any of our systems or protective
  measures."
- Anthropic Usage Policy (effective 2025-09-15): do not "Coordinate malicious
  activity across multiple accounts to avoid detection or circumvent product
  guardrails" or "Utilize automation in account creation."
- OpenAI Terms of Use (effective 2026-01-01): "You may not share your account
  credentials or make your account available to anyone else" and you may not
  "circumvent any rate limits or restrictions or bypass any protective
  measures."

Owning two paid subscriptions is not named as prohibited by either. Rotating to
a second account of the same vendor because the first one is rate-limited sits
close to OpenAI's "circumvent any rate limits" wording and Anthropic's
"circumvent product guardrails". Baton's default chain switches vendors
(claude → codex → agy), which is plainly fine. Same-vendor rotation only
happens after you run `baton accounts add`; that is your call.

## What is and is not touched

- **Never edited**: `~/.claude/settings.json`, `~/.claude.json`,
  `~/.codex/config.toml`, agy's files, your repo's settings. Claude Code gets
  hooks through a per-session `--settings` file under `~/.baton`; codex and
  agy get nothing injected.
- **Written in your repo**: `.baton/` (session notes, `RESUME.md`),
  `.context-handoffs/` (the bundles) and `.baton-worktrees/` (a second
  session's worktree), all added to `.git/info/exclude`, plus the
  `baton/<session-id>` branch of a session with its own worktree. Landing
  fast-forwards your branch; nothing is ever pushed.
- **Stripped from every agent's environment**: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`,
  `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
  `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLAUDECODE`,
  `CLAUDE_CODE_*`, `CLAUDE_EFFORT`, and `CLAUDE_PLUGIN_DATA`. `CLAUDE_CODE_*`
  does not include `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`: Baton sets that one
  to `0` for a detached Claude print session.
- **Read but never written or printed**: Claude Code's stored login, sent only
  to `api.anthropic.com` for the usage numbers. The ledger scrubs bearer tokens
  and key shapes from every line regardless.
- **`baton uninstall --yes`**: removes `~/.baton` (sessions, usage, extra
  account directories with their junctions, v0.1 cards, the board pidfile) and
  nothing else; then `npm rm -g baton-agents`.

## CLI reference

```
baton claude|codex|agy [agent args…]   the interactive agent, board alongside, handoff on limit
      [--no-worktree]                  share the checkout with a live session instead of a worktree
baton sessions ls [--json]             every session and its usage
baton sessions show|events <id>
baton sessions handoff|end <id>        same as the board buttons
baton sessions rm <id>                 forget an ended session
baton sessions simulate-limit <id>     the real limit path without a real wall (claude, agy)
baton accounts ls                      logins and their 5h/7d usage
baton accounts add <claude|codex> <name> | rm <agent> <name> | terms
baton license                          trial days left, or the license on this machine
baton license activate <key> | deactivate | refresh   (refresh renews a Team key)
baton share                            who is on the board (off by default; Team plan)
baton share on [--bind tailscale|lan|<addr>] [--port N] | off
baton share add|rotate|rm <name>       one link per human, printed once
baton open | down | status             the board
baton uninstall [--yes]
```

Environment, all optional: `BATON_HOME` (default `~/.baton`), `BATON_PORT`
(4747), `BATON_ACCOUNT` (start on a named login), `BATON_WARN_PCT` (85),
`BATON_NO_HANDOFF=1` (warn and record, never switch), `BATON_NO_OPEN=1` (do not
open the browser), `BATON_USAGE_POLL_MS` (60000), `BATON_CLAUDE_ARGS` /
`BATON_CODEX_ARGS` / `BATON_AGY_ARGS` (extra args for a leg Baton starts after
a hand-off, e.g. `-m gpt-5.3-codex-spark`), `BATON_CLAUDE_BIN`,
`BATON_CODEX_BIN`, `BATON_AGY_BIN`, `BATON_CHB_BIN`, `BATON_PERSON` (whose
terminal this is when the board is shared), `BATON_RATE_MAX` (600 requests a
minute per human) and `BATON_RATE_MAX_FAILURES` (20 wrong tokens per address).

## Background tasks: the v0.1 extras

Version 0.1 was the other way round: you dropped a task card on the board and
Baton ran the agents headless in a git worktree, one per card, with a fallback
chain, path leases, a scheduler and a merge queue. All of that still works and
lives below the terminals lane, but it is no longer the way in.

The New background card form starts with a repo, task, and real first agent.
**Run now** queues it; turning that off saves a draft in Backlog. The default
**Build only** workflow stops with its changes in the card's worktree and does
not merge them. The Advanced **Build, test, and merge** and **Factory**
workflows include an automatic land station; their labels say so before you
choose them. Fallback agents, permissions, approval gates, turn caps, leases,
trunk, merge method, tests, title, and scripted test/demo adapters are also
under Advanced options.

- `baton up` boots the board with the scheduler and merge queue and streams
  redacted logs; `baton card add --repo <path> --task "<t>" --chain claude,codex --queue`
  creates a card; presets `build`, `build-land`, `factory`; station kinds
  agent, test, land, human.
- Adapters spawn the CLIs headless as argv, never through a shell, with their
  own permission modes and never a bypass flag: `claude -p --output-format json
  --permission-mode <m>`, `codex exec --json -s <m> -C <worktree>`,
  `agy -p --output-format json --mode <m> --add-dir <worktree>`; `fake`,
  `fake-claude`, `fake-codex`, `fake-agy` for tests and demos.
- A leg that ends on a limit signal, a stall, a crash or exit 0 without
  `.baton/DONE` hands off with a bundle to the next adapter in the same
  worktree; a `land` station rebases, tests and fast-forwards trunk or bounces
  the card with the failure in the bundle.
- Optional mirrors, off unless set in `.env`: OpenClaw Workboard
  (`BATON_SYNC_WORKBOARD=1`) and DashClaw (`BATON_SYNC_DASHCLAW=1`).

The full v0.1 story, with the fake-limit demo and the real claude→codex run,
is in [docs/concepts.md](docs/concepts.md), [docs/DEMO.md](docs/DEMO.md),
[docs/real-run.md](docs/real-run.md) and [docs/board-guide.md](docs/board-guide.md).

### Network exposure

Baton binds `127.0.0.1`. `baton share on` is the supported way to listen
anywhere else: it binds your Tailscale or LAN address and every human gets
their own token (see [More than one human](#more-than-one-human)). Without
share, setting `BATON_BIND` to a non-loopback address needs `BATON_TOKEN` too,
or the server refuses to start (exit 3), and requests then need
`Authorization: Bearer <token>`. Tokenless owner access also requires a
loopback hostname (`127.0.0.1`, `localhost`, or `[::1]`), which prevents a
DNS-rebound hostname from inheriting local access. Either way there is no TLS.

## Troubleshooting

- **The board did not open**: `baton open`, or visit http://127.0.0.1:4747.
  `~/.baton/board.log` has the server's output.
- **claude's card shows "usage unknown"**: Claude Code has no stored claude.ai
  login in that config directory (run `claude auth login`), the stored token
  expired (start `claude` once, it refreshes), or the usage endpoint answered
  with something Baton does not recognise. The card says which. The wall is
  still caught through the hook; only the percentages are missing.
- **codex usage is unavailable or stale**: the read-only Codex app-server quota
  request failed or has not completed in the last five minutes. The board
  retries every minute; an active Codex session also keeps its rollout tap as a
  fallback for percentages and the wall signal.
- **agy's card has no percentage**: expected, agy exposes none. Baton sees the
  wall when agy hits it.
- **A session shows `lost`**: the terminal that ran `baton <agent>` is gone
  (closed, crashed, machine slept through a kill). Remove it from the board.
- **Nested session**: `baton claude` typed inside a Claude Code shell works;
  the parent's `CLAUDECODE` markers are stripped so the child starts.
- **`npm install` dies with `edgesOut`** (clone only): the global npm is older
  than Node; run `npx --yes npm@latest install` once.

More in [docs/faq.md](docs/faq.md).

## Documentation

| guide | read it when |
|-------|--------------|
| [Getting started](docs/getting-started.md) | you want `baton claude` running in five minutes |
| [Concepts](docs/concepts.md) | sessions, accounts, bundles, and the v0.1 cards, stations, chains and leases |
| [Board guide](docs/board-guide.md) | every chip, glyph and button explained |
| [Configuration](docs/configuration.md) | environment variables and options |
| [Adapters](docs/adapters.md) | what each CLI exposes and how Baton attaches to it |
| [CLI contracts](docs/cli-contracts.md) | exact argv per CLI and the limit-signal table with sources |
| [FAQ](docs/faq.md) | a question the others did not answer |
| [Demo](docs/DEMO.md) and [real run](docs/real-run.md) | the v0.1 handoff, fake and real |
| [Vocabulary](docs/VOCABULARY.md) | statuses, outcomes and event types |
| [Roadmap v2](docs/ROADMAP-v2.md) | where this is going |
| [Reuse](docs/REUSE.md) and [deviations](docs/DEVIATIONS.md) | what was ported and every place the plan changed |
| [Website](site/) | the public page: static HTML in `site/`, preview with `python -m http.server 4780 --directory site`, deployed to Vercel from that directory; PRODUCT.md and DESIGN.md at the root carry its brief and tokens |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for the dev setup and the rules (zero runtime deps, argv spawns only, no
bypass flags, a privacy check on every commit). Security reports go through
[SECURITY.md](SECURITY.md).

```
npm install
npm test          # node --test + privacy check
npm run lint
```

Any real agent session started only to test Baton runs on the cheapest model
(`baton claude --model haiku`); the live checks in `test/` never start one.

Maintainer releases use npm trusted publishing with no `NPM_TOKEN`. Bump the
package, lockfile, site metadata and release notes, then push `main`. CI waits
for the Ubuntu and Windows test matrix, validates the exact version against
npm, and publishes only when that version is missing and newer than the stable
`latest`. Existing versions skip cleanly; older, prerelease, and registry-error
cases fail the job. The npm trusted publisher is bound to
`ucsandman/baton` and `.github/workflows/ci.yml`. The repository stays private,
so publication uses `--provenance=false`.

## Privacy and attribution

Parts of the runner, ledger and git snapshot were ported from a private
repository that was MIT licensed (see [NOTICE](NOTICE) and
[docs/REUSE.md](docs/REUSE.md)), with chat identifiers, machine paths and
personal names removed. The test suite runs a privacy check on every commit,
and the fixtures store home paths as `~`.

## License and pricing

Baton is commercial software under the [Baton License Agreement](LICENSE).
It ships as readable JavaScript so you can see what it does on your machine,
and you may modify it for your own use, but not redistribute it or work
around the license check. Versions 0.2.0 and 0.3.0 were published under MIT
and remain available. The version in this source tree is 0.4.3; see
[npm](https://www.npmjs.com/package/baton-agents) for published versions and
[CHANGELOG.md](CHANGELOG.md) for release notes.

Using it: a 14-day trial starts the first time you type `baton <agent>`,
every feature on, no card. After that a license: **Personal, $79 once**, one
human on any number of machines, every release for 12 months and the version
you have keeps working after that; **Team, $12 per seat per month**,
Personal plus `baton share` for more than one human on the board. Buy at
the site, then `baton license activate <key>`. A key is a signed token
checked offline with the public key in `src/license.mjs`; only a Team key
renewal talks to the site. The bare agent CLIs are never affected by any of
this; only what Baton adds is licensed.
