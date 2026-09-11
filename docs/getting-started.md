# Getting started

For a developer setting up Baton for the first time on their own machine. The
first four sections get an interactive agent running with the board alongside
it. The v0.1 pipeline flow is section 7 onward.

## 1. Prerequisites

- Node 22 or newer (`package.json` sets `"engines": {"node": ">=22"}`).
- git.
- Python 3 with pip, for the `context-handoff-bundle` CLI. This is what writes
  and reads the handoff bundles.
- At least one coding-agent CLI, logged in: `claude`, `codex` or `agy`. You do
  not need all three. With one installed you get the board and the usage
  tracking; with two or more you also get the hand-off.

## 2. Install

```
npm install -g baton-agents
pip install -U context-handoff-bundle
```

From a clone instead: `git clone https://github.com/ucsandman/baton.git && cd
baton && npm install && npm link`.

## 3. Run an agent

```
cd <any repo>
baton claude
```

That is the whole setup. `baton claude` runs the real Claude Code in this
terminal with your own settings, hooks and skills. Anything after the agent
name passes straight through:

```
baton claude --model haiku
baton codex -m gpt-5.3-codex-spark
baton agy
```

The first `baton <agent>` starts the board on http://127.0.0.1:4747 and opens
it once in your browser. Later sessions reuse the same board. Set
`BATON_NO_OPEN=1` to skip the browser.

Baton strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
and `OPENAI_API_KEY` from the agent's environment, so the subscription login is
always what runs. Nothing in `~/.claude`, `~/.codex` or agy's home is edited.

## 4. What you get while it runs

- A card on the board for this terminal: agent, account, repo@branch, the first
  prompt, turns, the files being touched, 5h and 7d usage.
- A warning at 85 % of either window (`BATON_WARN_PCT`): amber card, an event,
  one terminal bell.
- A `context-handoff-bundle` for this session, refreshed every two minutes and
  at every warning, limit and hand-off.
- At the limit: the bundle is saved, the agent is stopped, and the next option
  starts in the same terminal from `.baton/RESUME.md`. Order is other logins of
  the same agent first, then the remaining agents (claude, codex, agy). When
  every option is out, Baton prints each reset time, soonest first, and exits 3.

Force a hand-off at any time with the **Hand off now** button on the card, or
`baton sessions handoff <id>`.

## 5. Watching and steering from the CLI

```
baton sessions ls            every session and its usage
baton sessions show <id>
baton sessions events <id>
baton sessions handoff <id>  same as the board button
baton sessions end <id>
baton sessions rm <id>       forget an ended session
baton sessions simulate-limit <id>   drive the real limit path without a real wall (claude, agy)
baton accounts ls            logins and their 5h/7d usage
baton open | down | status   the board
```

## 6. Where files live

Everything Baton writes goes under `BATON_HOME` (default `~/.baton`):

```
~/.baton/
  sessions/<session-id>/
    session.json           the live record the board renders
    events.jsonl           the timeline
    control.json           board to runner requests
    hook.log               what Claude Code's hooks sent
    claude-settings.json   the per-session --settings file
    agy.log                agy's --log-file, agy sessions only
  usage/<agent>--<account>.json
  accounts/<agent>/<name>/ extra logins (see configuration.md)
  board.pid                the board server's pidfile
  board.log                the board server's output
```

In the repo you run in, Baton writes `.baton/` (session notes, `RESUME.md`) and
`.context-handoffs/` (the bundles). Both are added to `.git/info/exclude`, so
they never show up in `git status`.

`baton uninstall --yes` removes `~/.baton` and nothing else.

## 7. Pipelines (extras)

Version 0.1 worked the other way round: you dropped a task card on the board
and Baton ran the agents headless in a git worktree, one per card, with a
fallback chain, path leases, a scheduler and a merge queue. All of that still
works and lives below the Terminals lane. It is no longer the way in.

### Preflight

```
baton up --dry
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
stop` (which runs `baton down`).

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
baton card add --repo <path-to-a-git-repo> --task "Add a LICENSE file" --chain claude --queue
```

Other flags `card add` accepts: `--pipeline <preset|file>`, `--mode
<adapter>=<mode>`, `--max-turns <adapter>=<n>`, `--leases <glob,glob>`,
`--trunk <branch>`, `--land-mode ff|pr`, `--test-command "<cmd>"`, `--title
"<text>"`, `--slug <id>`, `--approve <adapter,...>`.

The command prints the new card id. Show it, or run it directly:

```
baton card show <card-id>
baton card run <card-id>
baton card events <card-id>
```

### Try a pipeline with no real agent

The `fake` adapter drives `bin/fake-agent.mjs`, a stand-in CLI, so you can see
a full run without a subscription login:

```
baton card add --repo <path-to-a-git-repo> --task "demo" --chain fake --fake-mode fake=limit --queue
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
~/.baton/
  cards/<card-id>/
    card.json                    the card's current state
    events-<actor-key>.jsonl     one append-only file per writer
    runs/<n>/
      run.json                   this run's status, outcome, exit code
      prompt.txt                 the exact prompt sent to the adapter
      out.log                    the adapter's stdout
      err.log                    the adapter's stderr
      supervisor.log             the runner's own log for this run
  ACTIVE.md                      generated summary of open cards
  baton.pid                      written by `baton up`, removed on stop
  scheduler.pid                  written by `baton scheduler start`
```

A card's own git worktree lives in the repo it targets, not under
`BATON_HOME`: `<repo>/.baton-worktrees/<card-id>` on branch `baton/<card-id>`.

## Next

- [concepts.md](concepts.md): sessions, accounts, usage windows, the
  interactive hand-off, then cards, stations, chains, leases and the land
  station.
- [board-guide.md](board-guide.md): every element of the board.
- [configuration.md](configuration.md): every environment variable.
