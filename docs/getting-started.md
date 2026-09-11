# Getting started

For a developer setting up Baton for the first time on their own machine, to
run one card end to end. It assumes Node and git are already usable from a
terminal.

## 1. Prerequisites

- Node 22 or newer (`package.json` sets `"engines": {"node": ">=22"}`).
- git.
- Python 3 with pip, for the `context-handoff-bundle` CLI (this is what
  writes and reads the handoff bundles between agent legs).
- At least one coding-agent CLI, logged in: `claude`, `codex`, `gemini`, or
  `agy`. You do not need all four; a chain only needs the adapters it names.
- No real agent CLI installed yet? Skip straight to
  [Try it with no real agent](#7-try-it-with-no-real-agent) below; the `fake`
  adapter needs nothing installed.

## 2. Install

```
npm install
pip install -U context-handoff-bundle
```

## 3. Read the preflight table

Before starting anything, check what Baton can see on this machine:

```
node bin/baton.mjs up --dry
```

This prints one row per dependency (node, git, `context-handoff-bundle`, each
registered adapter) with `ok` or `missing`, and exits without spawning
anything. A `missing` adapter is fine as long as you are not chaining it.

## 4. Start Baton

```
npm start
```

`npm start` runs the same preflight, boots the board server on
`http://127.0.0.1:4747`, opens it in your browser, and streams prefixed,
redacted logs to the terminal. Ctrl-C stops the server and any agent it
started.

## 5. Create your first card from the board

Click **New card**. The form asks for:

- **Repo path**: an absolute path to a local git repository (must have at
  least one commit).
- **Task**: the text prompt every agent leg gets.
- **Pipeline**: `factory`, `build`, `build-land`, or `custom JSON` (paste a
  station array).
- **Chain**: one row per adapter, in fallback order. Each row picks an
  adapter and mode; **Add chain row** adds another.
- **Leases** (comma separated path globs), **Trunk branch** (default
  `main`), **Land mode** (`ff` or `pr`), **Test command**, **Title**.
- **Queue immediately**: leave it checked to start the card right away.

Press **Create**. The card appears in its first column and, once queued, the
scheduler starts it.

## 6. Create your first card from the CLI

```
node bin/baton.mjs card add --repo <path-to-a-git-repo> --task "Add a LICENSE file" --chain claude --queue
```

Other flags `card add` accepts: `--pipeline <preset|file>`, `--mode
<adapter>=<mode>`, `--max-turns <adapter>=<n>`, `--leases <glob,glob>`,
`--trunk <branch>`, `--land-mode ff|pr`, `--test-command "<cmd>"`, `--title
"<text>"`, `--slug <id>`, `--approve <adapter,...>` (gate a leg behind a
human approval before it runs).

The command prints the new card id. Show it, or run it directly:

```
node bin/baton.mjs card show <card-id>
node bin/baton.mjs card run <card-id>
```

## 7. Try it with no real agent

The `fake` adapter drives `bin/fake-agent.mjs`, a stand-in CLI, so you can see
a full run without a subscription login or spending any usage:

```
node bin/baton.mjs card add --repo <path-to-a-git-repo> --task "demo" --chain fake --fake-mode fake=limit --queue
```

`FAKE_MODE` (set per adapter with `--fake-mode <adapter>=<mode>`) picks its
behaviour: `success` (write the target file and `.baton/DONE`), `incomplete`,
`limit` (replay a recorded usage-limit signal), `stall`, `auth`, `crash`,
`no_progress`, and the land-demo modes `break-test` / `fix-test` /
`resolve-rebase`. A chain of two fake adapters (`--chain fake-claude,fake-codex
--fake-mode "fake-claude=limit,fake-codex=success"`) shows a full handoff; see
[docs/DEMO.md](DEMO.md) for the walkthrough with screenshots.

## 8. Watching it run

With the board open (`npm start`), a card's column, chip and chain-rail pills
update live over server-sent events; click the card's title to open the
detail drawer (task, worktree, pipeline, event timeline, runs, bundle, log
tail). See [docs/board-guide.md](board-guide.md) for what every element
means.

From the CLI:

```
node bin/baton.mjs card events <card-id>
node bin/baton.mjs card show <card-id>
```

## 9. Where files live

Everything Baton writes goes under `BATON_HOME` (default `~/.baton`; set the
`BATON_HOME` environment variable to move it):

```
~/.baton/
  cards/<card-id>/
    card.json                    the card's current state
    events-<actor-key>.jsonl     one append-only file per writer (agent/human/baton)
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
`BATON_HOME`: `<repo>/.baton-worktrees/<card-id>` on branch
`baton/<card-id>`.

## 10. Stopping

- Ctrl-C in the terminal running `npm start` stops the server, the scheduler
  and any agent process it launched.
- From another terminal: `npm run stop` (runs `baton down`).

## Next

- [docs/concepts.md](concepts.md): cards, stations, chains, outcomes,
  handoffs, leases, the land station.
- [docs/board-guide.md](board-guide.md): every element of the board and the
  floor view.
- [docs/configuration.md](configuration.md): every environment variable.
