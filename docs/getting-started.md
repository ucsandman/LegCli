# Getting started

For a developer setting up Leg for the first time on their own machine. The
first four sections get an interactive agent running with the board alongside
it. The v0.1 pipeline flow is section 7 onward.

## 1. Prerequisites

- Node 22 or newer (`package.json` sets `"engines": {"node": ">=22"}`).
- git.
- Python 3 with pip, for the `context-handoff-bundle` CLI. This is what writes
  and reads the handoff bundles.
- At least one coding-agent CLI, logged in: `claude`, `codex`, `agy` or
  `grok`. You do not need all four. With one installed you get the board
  and the usage tracking; with two or more you also get the hand-off.

## 2. Install

```
npm install -g @ucsandman/legcli
pip install -U context-handoff-bundle
```

`npm install -g leg-agents` is the same release: it pins this version of
`@ucsandman/legcli` and exposes the same `leg` binary.

The source repository is private, so there is no clone to install from. The
source you run ships in the package: `$(npm root -g)/legcli/src`, plain
`.mjs`, nothing bundled. Read it before you trust it.

## 3. Run an agent

```
cd <any repo>
leg claude
```

That is the whole setup. `leg claude` runs the real Claude Code in this
terminal with your own settings, hooks and skills. Anything after the agent
name passes straight through:

```
leg claude --model haiku
leg codex -m gpt-5.3-codex-spark
leg agy
```

The first `leg <agent>` starts the board on http://127.0.0.1:4747 and opens
it once in your browser. Later sessions reuse the same board. Set
`LEG_NO_OPEN=1` to skip the browser.

Leg strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_API_BASE`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_EFFORT`, and `CLAUDE_PLUGIN_DATA` from the agent's
environment, then sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for a detached
Claude print session. The subscription login is always what runs. Nothing in
`~/.claude`, `~/.codex` or agy's home is edited.

## 4. What you get while it runs

- A card on the board for this terminal: agent, account, repo@branch, the first
  prompt, turns, the files being touched, 5h and 7d usage.
- A warning at 85 % of either window (`LEG_WARN_PCT`): amber card, an event,
  one terminal bell.
- For Codex, the board and active attach poll the read-only app-server
  `account/rateLimits/read` response every 60 seconds. Leg maps the returned
  300- and 10080-minute durations to 5h and 7d, shows `<n>% used`, and labels
  old readings stale. Only an explicit backend available answer clears a prior
  wall; no model turn or hardcoded quota is used.
- A `context-handoff-bundle` for this session, refreshed every two minutes and
  at every warning, limit and hand-off.
- At the limit: the bundle is saved, the agent is stopped, and the next option
  starts in the same terminal from `.leg/RESUME-<session-id>.md`, copied to
  `.leg/RESUME.md`. Order is other logins of
  the same agent first, then the remaining agents (claude, codex, agy). When
  every option is out, Leg prints each reset time, soonest first, waits with
  a countdown, and starts the first one back from the bundle. Ctrl-C quits.

Force a hand-off at any time with the **Hand off now** button on the card, or
`leg sessions handoff <id>`.

## Is the resume file still true?

```powershell
leg resume --check      # exit 0 current, 1 stale or unstamped, 3 none here
leg resume              # the same verdict, then the pointer itself
```

Leg stamps every resume file with the commit, the working tree and the
terminals it was written against, and recomputes freshness from git when you
read it. A commit landing, the tree moving, or the terminal it described going
away all make it stale; the terminal card's drawer shows the same verdict under
"What happens next". A session ending rewrites `RESUME.md` to say nothing is in
flight, and the board does the same at start for a terminal that crashed, so
nothing is left describing work that has moved on.

## 5. Watching and steering from the CLI

```
leg sessions ls            every session and its usage
leg sessions show <id>
leg sessions events <id>
leg sessions handoff <id>  same as the board button
leg sessions end <id>
leg sessions rm <id>       forget an ended session
leg sessions simulate-limit <id>   drive the real limit path without a real wall (claude, agy)
leg accounts ls            logins and their 5h/7d usage
leg open | down | status   the board
```

On the board, **Remove** safely prunes an ended session only when its worktree
is clean and its branch is already merged into the base. For a session that
needs to be removed from the board while preserving its work, use the visible
**Remove record** button, read its confirmation, and keep the worktree, branch,
unmerged commits, and dirty files intact.

## 6. Where files live

Everything Leg writes goes under `LEG_HOME` (default `~/.leg`):

```
~/.leg/
  sessions/<session-id>/
    session.json           the live record the board renders
    events.jsonl           the timeline
    control.json           board to runner requests
    hook.log               what Claude Code's hooks sent
    claude-settings.json   the per-session --settings file
    agy.log                agy's --log-file, agy sessions only
  usage/<agent>--<account>.json
  accounts/<agent>/<name>/ extra logins (see configuration.md)
  landings.jsonl           every Land, for the landed-on-trunk list
  board.log                the board server's output
```

In the repo you run in, Leg writes `.leg/` (session notes, `RESUME.md` and
one `RESUME-<session-id>.md` per hand-off) and `.context-handoffs/` (the
bundles). Both are added to `.git/info/exclude`, so they never show up in
`git status`.

`leg uninstall --yes` removes `~/.leg` and nothing else.

## 7. Pipelines (extras)

Version 0.1 worked the other way round: you dropped a task card on the board
and Leg ran the agents headless in a git worktree, one per card, with a
fallback chain, path leases, a scheduler and a merge queue. All of that still
works and lives below the Terminals lane. It is no longer the way in.

### Preflight

```
leg up --dry
```

One row per dependency (node, git, `context-handoff-bundle`, each registered
adapter) with `ok` or `missing`, then exit without spawning anything. A
`missing` adapter only matters if a card's chain names it.

### Start the board with the scheduler

```
npm start
```

`npm start` runs the same preflight, boots the board server on
`http://127.0.0.1:4747`, opens it, and streams prefixed, redacted logs. Ctrl-C
stops the server and any agent it started. From another terminal: `npm run
stop` (which runs `leg down`).

### A card from the board

Click **New card**. The form asks for:

- **Repo path**: an absolute path to a local git repository (at least one
  commit).
- **Task**: the text prompt every agent leg gets.
- **Pipeline**: `factory`, `build`, `build-land`, or `custom JSON`.
- **Chain**: one row per adapter, in fallback order.
- **Leases** (comma separated path globs), **Trunk branch** (default `main`),
  **Land mode** (`ff` or `pr`), **Test command**, **Title**.
- **Queue immediately**: leave it checked to start the card right away.

### A card from the CLI

```
leg card add --repo <path-to-a-git-repo> --task "Add a LICENSE file" --chain claude --queue
```

Other flags `card add` accepts: `--pipeline <preset|file>`, `--mode
<adapter>=<mode>`, `--max-turns <adapter>=<n>`, `--leases <glob,glob>`,
`--trunk <branch>`, `--land-mode ff|pr`, `--test-command "<cmd>"`, `--title
"<text>"`, `--slug <id>`, `--approve <adapter,...>`.

The command prints the new card id. Show it, or run it directly:

```
leg card show <card-id>
leg card run <card-id>
leg card events <card-id>
```

### Try a pipeline with no real agent

The `fake` adapter drives `bin/fake-agent.mjs`, a stand-in CLI, so you can see
a full run without a subscription login:

```
leg card add --repo <path-to-a-git-repo> --task "demo" --chain fake --fake-mode fake=limit --queue
```

`FAKE_MODE` (set per adapter with `--fake-mode <adapter>=<mode>`) picks its
behaviour: `success`, `incomplete`, `limit`, `stall`, `auth`, `crash`,
`no_progress`, and the land-demo modes `break-test` / `fix-test` /
`resolve-rebase`. A chain of two fake adapters (`--chain
fake-claude,fake-codex --fake-mode "fake-claude=limit,fake-codex=success"`)
shows a full handoff; see [DEMO.md](DEMO.md) for the walkthrough with
screenshots.

### Where a card's files live

```
~/.leg/
  cards/<card-id>/
    card.json                    the card's current state
    events-<actor-key>.jsonl     one append-only file per writer
    driver.lock                  the process driving the card, only while it runs
    unsynced.jsonl               DashClaw records to retry (`ledger sync`), if any
    runs/<n>/
      run.json                   this run's status, outcome, exit code
      prompt.txt                 the exact prompt sent to the adapter
      out.log                    the adapter's stdout
      err.log                    the adapter's stderr
      supervisor.log             the runner's own log for this run
  locks/land-<hash>.json         the merge queue's turn, one per repo root, while a land runs
  ACTIVE.md                      generated summary of open cards
  leg.pid                        written by `leg up`, removed on stop
  scheduler.pid                  written by `leg scheduler start`
```

A card's own git worktree lives in the repo it targets, not under
`LEG_HOME`: `<repo>/.leg-worktrees/<card-id>` on branch `leg/<card-id>`.

## Next

- [concepts.md](concepts.md): sessions, accounts, usage windows, the
  interactive hand-off, then cards, stations, chains, leases and the land
  station.
- [board-guide.md](board-guide.md): every element of the board.
- [configuration.md](configuration.md): every environment variable.
