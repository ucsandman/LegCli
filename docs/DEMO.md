# Demo: a usage limit hands the card to the next agent

A background card starts on `fake-claude`, hits a recorded Claude usage limit,
Baton writes a context handoff bundle, and `fake-codex` resumes in the same
worktree and finishes the work. The two fake adapters replay the shapes the real
CLIs print and spend no subscription usage. The same sequence against the real
CLIs is in [real-run.md](real-run.md).

The replay uses a throwaway git repo, a throwaway board home and a port of its
own, so it cannot reach a board you already have running on 4747. At the delay
set below the card took 53 seconds of wall time: two legs of 20 seconds, plus
the few seconds it took to read the row and click **Approve** between them.

Five stills of the run on 2026-09-15 (03:55 to 03:56 UTC) are in
`docs/screenshots/`, taken from the live board at 1280x800:

```
demo-1-claude-running.png   leg 1 running on fake-claude
demo-2-limit-hit.png        limit hit, bundle written, the row waiting on you
demo-3-handoff-bundle.png   the row expanded: bundle path, run signal, timeline
demo-4-codex-running.png    leg 2 running on fake-codex
demo-5-done.png             done, both legs on the chain
```

The ledger of that run is `fixtures/demo/events.jsonl`.

## Replay it

### 1. A throwaway repo

PowerShell:

```
mkdir C:\baton-demo\toy-demo
cd C:\baton-demo\toy-demo
git init -b main
"# toy" | Out-File -Encoding utf8 README.md
git add -A
git commit -m init
```

bash:

```
mkdir -p ~/baton-demo/toy-demo && cd ~/baton-demo/toy-demo
git init -b main
echo '# toy' > README.md
git add -A && git commit -m init
```

The stills were taken with the repo at `C:\baton-demo\toy-demo`. Any path works;
a different one only changes the paths the board prints.

### 2. A throwaway board on its own port

`FAKE_DELAY_MS` is how long each fake agent waits before it acts. At 20000 each
leg runs for 20 seconds, which is enough time to read the row while it is in
flight.

PowerShell, from the Baton checkout:

```
cd C:\Projects\baton
$env:BATON_HOME = 'C:\baton-demo\home'
$env:BATON_PORT = '4851'
$env:FAKE_DELAY_MS = '20000'
npm start
```

bash:

```
cd /path/to/baton
BATON_HOME=~/baton-demo/home BATON_PORT=4851 FAKE_DELAY_MS=20000 npm start
```

It prints a preflight table, then
`ready http://127.0.0.1:4851  (scheduler max 2, 0 cards)`, and opens that
address in your browser. The board polls every three seconds, so nothing below
needs a reload.

The page is one column, read top to bottom: the instrument head with one row per
login, then **Terminals**, **Landed on main**, **Background tasks**, and
**Settings**. This demo happens entirely in **Background tasks**. On a fresh
board home the head reads `no reading` on every rail, because no agent has
reported usage into this home yet.

### 3. Queue the card

Click **New card** in the **Background tasks** head. The dialog opens on **New
background card**.

1. **Repo path**: `C:\baton-demo\toy-demo`.
2. **Task**: `Add a file greeting.txt containing 'hello from baton'`.
3. Leave **Run now** ticked.
4. Open **Advanced options**.
5. Set **Scripted first agent (test/demo only)**, which sits below **Fallback
   agents**, to `fake-claude (test/demo)`. The row under **First-agent
   permissions and limits** is rebuilt for that adapter: it is labelled
   `First: fake-claude` and now ends in a box marked `test behavior`. Type
   `limit` in that box. **First agent** higher up still names a real agent; the
   scripted adapter takes its place for this card. Set the scripted adapter
   before you type in that row, because changing it rebuilds the row.
6. Under **Fallback agents** Baton has already filled in the real agents it
   found. Click **Remove** on each of those rows.
7. Click **Add fallback agent**. In the new `Fallback 1` row set the agent to
   `fake-codex (test/demo)`, type `success` in its `test behavior` box, and tick
   **approval before start** so the handoff stops and waits for you.
8. Click **Create card**.

The recorded chain is `fake-claude>fake-codex`.

### 4. Leg 1, on fake-claude

The card appears as a row in **Background tasks**. The line beside the region
title reads `1 running`, and the row reads left to right:

- `fake-claude`, `build`, `running`
- the title, and under it the one sentence
  `leg_started: leg started: adapter=fake-claude run=1 mode=acceptEdits`
  followed by the local time
- `toy-demo@main`, the worktree path in short form, the chain
  `fake-claude · running · fake-codex · pending`, and the lease `**`
- the elapsed clock, then **Pause**, **Hand off now**, **Reassign**, **Kill**

This is `demo-1-claude-running.png`.

### 5. The limit, and the bundle

Twenty seconds in, `fake-claude` prints the recorded limit line and exits 1.
Baton records `limit_detected`, writes the handoff bundle, and stops for the
approval you ticked. Within a second or two the row changes on its own:

- the line beside the region title reads `1 waiting on you`
- the status word is `needs approval` and the agent is now `fake-codex`
- the sentence is `waiting on you at station build since 11:56 PM`, with the
  local time it stopped
- the chain reads `fake-claude · handed off · fake-codex · pending`
- the elapsed clock is `--:--` and the buttons are **Approve**, **Reassign**,
  **Kill**

This is `demo-2-limit-hit.png`.

### 6. What Baton wrote

Click the card title. The detail opens in flow directly under the row, not as an
overlay, and the row it belongs to stays visible above it. It holds, in order,
**Task**, **Where**, **Pipeline**, **Runs**, **Timeline** and **Log**:

- **Where** prints the full paths, never shortened: `repo`, `trunk`,
  `worktree`, `leases`, and `bundle`, which is the context handoff bundle
  written for this leg, under `.context-handoffs` inside the worktree.
- **Runs** reads `run 1  fake-claude, limit, signal claude-session-limit, exit 1`.
  `claude-session-limit` is the fixture the fake adapter replayed.
- **Timeline** is newest first: `approval_needed`, `handoff_written` with the
  bundle id and `after limit; next: fake-codex`, `limit_detected`,
  `leg_started`, `card_created`.
- **Log** is the last line `fake-claude` printed, which is the recorded Claude
  shape:

```
{"type":"result","subtype":"error","is_error":true,"result":"You've hit your session limit","session_id":"sess-fake"}
```

This is `demo-3-handoff-bundle.png`, framed on the bundle path, the run and the
timeline. Click the title again, or **Close** at the top of the detail, to
collapse it.

### 7. Approve, and leg 2

Click **Approve** on the row. `fake-codex` starts in the same worktree, reading
the bundle Baton wrote. The status word is `running` again, the run is `run=2`,
and the chain reads `fake-claude · handed off · fake-codex · running`. This is
`demo-4-codex-running.png`.

Twenty seconds later the station finishes. The line beside the region title
reads `1 finished`, the status word is `done`, the sentence is
`done after 2 runs, card done: all 1 station(s) complete`, the chain reads
`fake-claude · handed off · fake-codex · done`, and the buttons are **Rerun**
and **Remove**. This is `demo-5-done.png`.

The worktree named in **Where** now holds the file the fake agent wrote,
`hello-fake.txt`, and `.baton/DONE`.

### 8. Stop

Ctrl-C in the terminal running `npm start`. It prints `stopping (SIGINT)` and
`stopped`, and kills any agent still running. `baton down` from another terminal
does the same.

## The same demo headless

`card run` runs the card in the terminal you type it in and exits with its
status. No board is needed. Run these from the Baton checkout, in a shell with
`BATON_HOME` set the way step 2 sets it:

```
node bin/baton.mjs card add --repo "C:\baton-demo\toy-demo" --task "Add greeting.txt" --chain fake-claude,fake-codex --fake-mode "fake-claude=limit,fake-codex=success" --fake-target fake-codex=greeting.txt --title "Greeting file"
node bin/baton.mjs card run <card-id>
node bin/baton.mjs card events <card-id>
```

`card add` prints the card id, `card run` prints `<card-id> done at build`, and
`card events` prints eight lines: `card_created`, `leg_started`,
`limit_detected`, `handoff_written`, `leg_started`, `leg_exited`,
`station_done`, `done`.

Two differences from the click-through. There is no `--approve`, so the card
does not stop between the legs, and the ledger has no `approval_needed` or
`approved` in it: the ten-line ledger in `fixtures/demo/events.jsonl` is the
click-through. And the fake agent writes the file named by
`FAKE_TARGET`, default `hello-fake.txt`; it never reads the task, which is why
the headless replay passes `--fake-target fake-codex=greeting.txt` and the
click-through leaves `hello-fake.txt` in the worktree.
