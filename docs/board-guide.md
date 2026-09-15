# Board guide

For anyone using the Baton board day to day: what every element means and when
it shows up. The board is one page, read top to bottom: a sticky instrument
head with one row per login, then four regions in this order, **Terminals**,
**Landed on main**, **Background tasks**, **Settings**. Start a session
(`baton claude`) or the background-task board (`npm start`), see
[getting-started.md](getting-started.md), then use this as a reference.

## Screenshots

`docs/screenshots/` (listed here so you know what exists before you look for
one). These six were taken on 2026-09-14 against the current build:

```
terminals-1280.png        the board at 1280 px, three terminals
board-400px.png           the same board at 400 px, condensed head
board-details-open.png    a terminal with its expansion open
floor.png                 /floor at 1280 px
floor-final-1280.png      /floor at 1280 px
floor-final-400.png       /floor at 400 px
```

These five were taken on 2026-09-15, one demo run of the sequence walked through
in [DEMO.md](DEMO.md), all at 1280x800:

```
demo-1-claude-running.png   leg 1 running on fake-claude
demo-2-limit-hit.png        limit hit, bundle written, the row waiting on you
demo-3-handoff-bundle.png   the row expanded: bundle path, run signal, timeline
demo-4-codex-running.png    leg 2 running on fake-codex
demo-5-done.png             done, both legs on the chain
```

The other files in that directory were taken on 2026-09-10 and 2026-09-11 and
show the board as it was before the 2026-09-14 redesign. `board-done.png`,
`board-drawer.png`, `board-empty.png`, `board-handoff.png` and
`board-running.png` are background-task card states; `share-owner-1280.png` and
`share-guest-1280.png` are a shared board seen by its owner and by a guest; and
`floor-landing.png` is the floor's trunk lane with three landed commits. Each of
those needs a run that produces the state before it can be retaken.

## The instrument head

`src/board/sessions.js` draws it on the board and `src/board/floor.js` draws the
same head on the floor, from the `accounts` array of `GET /api/sessions`. It is
sticky: it stays on screen while the page scrolls under it.

One row per login, `<agent>` for the default account and `<agent>/<name>` for a
named one. Each row reads left to right in four registers:

- **Who**: the login name in its agent colour, and a chip counting the sessions
  running on it, `1 live terminal` or `3 live terminals`.
- **The rails**: the 5h window above the 7d window. Each rail is a track, a
  percentage and a reset. The fill crosses its zones at 60 and 85, and the tick
  at 85 is drawn only for a window that has been read. A window with no reading
  prints `no reading` in place of the number and draws no fill, because a zero
  is a reading and Baton does not print one it does not have. The reset reads
  `resets 11:38 PM, in 6m`.
- **How it is going, and where the number came from**: a burn-rate sentence
  under the 5h rail, either `at this rate the 11:38 PM reset arrives first` or
  `at this rate the 5h window is gone about 11:12 PM, 26 min before the 11:38 PM
  reset`. It is absent under 30 minutes of elapsed window, because a rate drawn
  from the first tenth of a window describes the last turn and not the next four
  hours. Below it the provenance line, `read 11:03 PM, claude statusline, 28m
  ago, stale`, naming the source Baton read and when it read it.
- **The state in one word**: `under 60`, `over 60`, `over 85`, `stale 28m`,
  `at the wall`, `no reading` or `not shared`. Colour never carries this alone.

A login at its wall keeps both rails and everything they were already printing.
Nothing is replaced; the state register grows to three lines instead, `at the
wall`, `back Sat 10:11 PM`, `in 4d 22h`, and the fill is hatched.

agy publishes no percentage, so its row prints `agy publishes no usage
percentage. Baton sees the wall when agy hits it.` where a burn rate would be.

Nothing here is on hover: every number, its reset and its source are printed. A
screen reader gets the same sentence from each rail's `aria-valuetext`.

At 619 px and narrower the head shows one row, the login closest to a wall, with
both of its windows, and names the rest rather than counting them:
`also: claude stale 28m, agy no reading`. That button opens the others. The
caption under the head reads `Times are local.`

For Codex, the board reads the app-server's read-only
`account/rateLimits/read` response every 60 seconds and maps its 300- and
10080-minute windows to 5h and 7d. The active `baton codex` attach also polls
that response. A percentage alone does not clear a limit wall: Baton waits for
an explicit available answer from the backend.

## Terminals

`src/board/sessions.js` renders the region from `GET /api/sessions`, refreshed
by the server-sent `sessions` event, re-sorted every 15 s, with the elapsed
clocks ticking every second. With no sessions it prints `No terminal is running.
Start one in any repo: baton claude, baton codex or baton agy. It appears here
within a second of the agent's first turn.`

The region head carries one verdict with its volume: `3 running, 2 waiting on
you`, or `3 running, nothing is waiting on you`, or `nothing is running`, with
`, last landed 11:02 PM` appended when a terminal on the page has landed.

### Terminal panel

One full-width panel per session, not a card in a grid. Panels that need an
answer come first; the rest follow in start order. A panel that needs you sits
one elevation step up with a 2 px bar down its left edge and says `waiting on
you` where its status word would be, so the state is never carried by elevation
alone.

- **Who**: the agent name in its colour, the session's id tail (`claude-7f3a`),
  the status word, and chips for the account when it is not `default`, the owner
  on a shared board, and `from <agent>` when this terminal was handed off from
  another.
- **What**: the first prompt as a button, clamped to three lines on screen and
  carried in full in its tooltip and in the expansion. Under it exactly one
  sentence, the highest-ranked thing true about this terminal, then
  `also: <names>` naming every sentence it is holding back, then the files this
  session is touching as comma-separated text, up to six, then `, and N more`. A
  file another live session is also touching is printed in the warning colour
  and named in the overlap sentence above it.
- **Where**: `repo@branch`, and `own worktree, from main` when this session cut
  its own worktree.
- **When, and what you can do**: the elapsed clock since the session started,
  the buttons, and, when Land is disabled, the reason printed under it.

### The one sentence

`rankedNotes` in `src/board/sessions.js` is the single source of every sentence
a panel prints. It builds the list, sorts it, prints the first, and names the
rest behind `also:`. Rank 1 is worst.

| rank | what it says |
|------|--------------|
| 1 | `every option is out, first back: codex 10:11 PM`, or `limit: <reason>, back <time>` |
| 2 | a bounced Land, or `the landing was cut off (the board restarted); press Land again` |
| 3 | an overlap with another live session |
| 4 | `sam asked to take this terminal at 11:04 PM` |
| 5 | `waiting for codex at 10:11 PM` |
| 6 | `handing off to codex, <reason>, 2m` |
| 7 | `landing <branch> onto main: commit, rebase, test, fast-forward` |
| 8 | `near the 5h wall, next: codex` |
| 9 | a finished Land, `nothing to land`, or the button you last pressed |
| 10 | `turn 14, last activity 11:04 PM`, the fallback that is always true |

A sentence at rank 4 or better is what raises the panel, sorts it to the top and
counts it in the region head, so those three cannot disagree.

Two of them in full, because they are what the board exists to say:

- **Overlap**, two live sessions in one repo whose `files_touched` or
  `files_dirty` sets intersect (`sessions.overlaps`), so it catches a file one
  agent has edited and another has only made dirty. In separate checkouts:
  `codex (codex-99ab) is changing src/server.mjs in another checkout; whoever
  lands second rebases`. In the same checkout: `codex (codex-99ab) is editing
  src/server.mjs too`. Three file names, then `, and N more`.
- **A Land**. Bounced: `Land was attempted at 6:40 PM onto main and bounced:
  CONFLICT (content): Merge conflict in src/server.mjs. The branch still holds
  every commit; nothing was lost.` Finished: `landed on <base>, <7-char sha>,
  <n> files, +<added>/-<removed>`, with `, untested` when the land recorded no
  test run. A finished Land stops being printed ten minutes after it happened.
  Nothing to land: `nothing to land: <branch> has no changes beyond main`.

### Status words

| status | word |
|--------|------|
| `starting` | starting |
| `running` | running |
| `warning` | near limit |
| `limit` | limit hit |
| `handing_off` | handing off |
| `waiting` | waiting for reset |
| `handed_off` | handed off |
| `ended` | ended |
| `lost` | lost |

The word carries the meaning. The 7 px square beside it is `aria-hidden` and
only repeats the tone. `waiting` means every option is walled and the terminal
is counting down to the first reset; its sentence reads `waiting for <agent> at
<time>`, and End quits that terminal with exit 3. `lost` means the runner
process that owned that terminal is gone. It is never counted as live.

### Terminal buttons

The order is fixed, Land, Hand off now, Details, End, and it never reflows by
availability: a button that does not apply is omitted, never moved.

| button | shown when | what it does |
|--------|------------|--------------|
| Land | always, disabled with the reason printed under it when the session has no worktree of its own, while it is landing, or when the worktree is gone | `POST /api/sessions/:id/land` (202): commits what the agent left on `baton/<id>`, rebases it onto its base, runs the tests, fast-forwards the base or bounces; the panel's sentence shows the result |
| Request handoff | the board is shared and this terminal is someone else's | `POST /api/sessions/:id/request-handoff` (202): asks the owner; nothing happens until they approve |
| Approve `<name>` / Dismiss `<name>` | the board is shared and someone asked for a hand-off on your terminal | `POST /api/sessions/:id/requests/<name>/approve` (or `/dismiss`): approving hands the terminal off, and the event says who it was for |
| Details | any terminal of yours | `GET /api/sessions/:id/detail`: the transcript, the files changed with their line counts, the timeline and the current bundle; `GET /api/sessions/:id/diff?file=<path>` for one file, capped at 400 lines, refused for any path outside that terminal's own tree |
| Hand off now | the session is active | `POST /api/sessions/:id/handoff`: saves the bundle, stops this agent, starts the next option in the same terminal |
| Change order | inside the expansion, while the status is `starting`, `running`, `warning`, `limit` or `waiting` | saves its validated claude/codex/agy priority; an older wrapper instead saves the machine default and says to restart the terminal |
| End | the session is active | `POST /api/sessions/:id/end`: stops the agent, ends the session |
| Remove | the session is not active | `DELETE /api/sessions/:id`: safely prunes the session record, worktree, and merged branch only when the worktree is clean and the branch is already on its base; otherwise it leaves them and explains why |
| Remove record | the session is not active and has an own worktree | `DELETE /api/sessions/:id?force=1&keep_worktree=1`: removes only Baton's record and keeps the worktree, branch, unmerged commits, and dirty files |

End, Remove and Remove record confirm first: the button row is replaced in place
by one sentence and two buttons, focus moves to Cancel, and Escape cancels.
There is no modal and no browser `confirm()`. Settings has the same order editor
for the default copied by new terminals.

### The expansion

**Details**, or a click on the prompt, expands a region in flow directly under
that panel; the page grows and the panel stays where it is. Nothing slides in
from the right, and the page keeps one scroll container
(`docs/screenshots/board-details-open.png`). Sections, top to bottom:

1. A header with the agent, the id tail, **Pause updates** and **Close**.
2. **Now**: the status word, the turn count and the last activity time, the last
   thing the agent said, then `path`, `branch`, `cut from`, `transcript` and
   `head` in full, never shortened. `usage unknown (<why>); the limit still
   hands off` sits here when the endpoint had no numbers for this login: no
   login in that config directory, a 404, a 429, a body that is not JSON, or a
   shape Baton does not recognise.
3. **Task**: the prompt in full.
4. **Conversation**: the last 8 turns, newest first, headed `showing 8 of 34
   turns`; **show 40 more** raises the cap.
5. **Files**: every file changed, with `uncommitted`, `+<adds>`, `-<dels>`, or
   `new` or `committed` when there are no counts against `HEAD`. A row expands
   to that file's diff, capped at 400 lines.
6. **Timeline**: the last 40 events, newest first.
7. **What happens next**: `now: claude, then codex, then agy`, which fallback is
   preferred and which is eligible now, the line `Used after a usage limit or
   Hand off now. A normal exit ends this terminal.`, the **Change order**
   editor, the current bundle id, and whether `.baton/RESUME.md` still describes
   the repository (recomputed from git on every poll).

It refetches every 3 seconds while it is open, and stops on **Pause updates**,
when the tab is in the background, or when it is closed. The rest of the page
stays live, so the panel's own buttons keep working. Messages and diffs are
scrubbed for secrets on the way out, and the whole region is refused for a
terminal that belongs to someone else. **Close** or the Escape key closes it.

**Change order** moves the three agents without removing one; same-agent
secondary accounts still come before the other agents. The list is an absolute
priority: an agent moved to the bottom is tried last from every starting agent.
The editor previews the resulting priority, with the agent running now skipped,
before saving.

## Landed on main

Below the terminals, one flat list across every repo the board can see, newest
first. One row per commit: the short sha, the subject, a `repo@branch` chip, and
when plus who. A commit a Land put there says `3 hours ago, landed by claude
(claude-7f3a)` in the ok colour, read from `~/.baton/landings.jsonl`, which
outlives the session; any other commit shows its git author. The region head
names the volume and the branches, `the last 12 commits on baton@main,
callclaw@main`. With nothing landed it reads `Nothing has landed on main from
this board yet. The Land button commits this terminal's work, rebases it onto
main, runs the tests and fast-forwards.`

## A shared board (more than one human)

With `baton share` on (off by default), the Terminals region head carries a chip
reading `you are wes, 2 on this board`, with `, a guest` after the name for
anyone who is not the owner, and every panel carries an owner chip: `wes, you`
on yours, `wes` on someone else's. There is no colour difference between the
two.

A panel that belongs to someone else sits at the lowest elevation and carries
exactly one sentence, `read-only: wes owns this terminal`. Its prompt reads
`prompt hidden`; it has no file names, no path beyond `repo@branch`, no bundle
and no event log; and its only button is **Request handoff**. The instrument
head prints `not shared` in every percentage slot. The owner sees `sam asked to
take this terminal at 11:04 PM` on their own panel, with **Approve sam** and
**Dismiss sam**.

A guest's board has no Background tasks region, no New card button and no Floor
link: that side belongs to the owner of the machine, and the API answers 403.

## Background tasks: page layout

Everything from here down is the v0.1 card runtime. Each card runs separately
from the interactive terminal conversations, in its own git worktree. It sits
below Landed on main.

The top bar (`src/board/index.html`) has, left to right: the Baton brand, the
connection word (`connecting` / `live` / `reconnecting…`) with a 24 px rule
under it, the scheduler status (`scheduler running, 2 max`), then a spacer and
the **Floor** link. **New card** is in the Background tasks region head, not the
top bar, and **Settings** is the last region of the page, in flow.

With no cards the region prints `No background task. New card queues one. They
run headless in their own worktree and report on the floor.` With cards the
region head prints the counts instead: `2 running, 1 queued, 3 finished`.

**Settings** holds the **API token** field (only needed when the server is bound
off loopback; see [configuration.md](configuration.md#network-exposure)), the
**New terminal handoff order** editor used by terminals started after you save,
and the board's own facts: version and bind address, who you are signed in as,
whether share is on, the scheduler, and the board home. Its region head says
`No API token set, requests reach 127.0.0.1:4747 unauthenticated`, or `API token
set, sent to 127.0.0.1:4747 as a bearer token` once a token is stored.

## Order

There are no columns. Cards are rows in one list, ordered by status (`ROW_RANK`
in `src/board/board.js`), then by start time within a rank:

| rank | statuses |
|------|----------|
| 0 | `needs_approval`, `waiting_human` |
| 1 | `failed`, `killed` |
| 2 | `running`, `handing_off` |
| 3 | `paused` |
| 4 | `queued` |
| 5 | `backlog` |
| 6 | `done` |

Rows are re-appended only when that order actually changes, so a row does not
move out from under the cursor.

## Card row

Each card row reads in the same four registers as a terminal panel:

- **Who**: an adapter chip in that agent's colour (or `no agent`), the station
  name when it is not `-`, and the status word.
- **What**: the title (the card's `title`, or the first 60 characters of the
  task) as a button that opens the [expansion](#card-expansion), and one
  sentence under it.
- **Where**: `repo@trunk`, the worktree path shortened to its tail with the full
  path in its tooltip, the chain rail, and the lease chips, one per claimed
  lease or `**` (the whole repo) when none were set, plus `blocked by lease`
  when the scheduler says so.
- **When**: the elapsed clock, `mm:ss` while a leg is running and `--:--`
  otherwise, then the buttons.

The log is not on the row. It is in the expansion.

### The one sentence

`cardSentence` in `src/board/board.js`, one sentence, the highest-ranked thing
true about the card:

- A bounced land, at `queued`, `running`, `handing_off` or `needs_approval`:
  `Land bounced on attempt 2: rebase-conflict. The worktree still holds every
  commit; nothing was lost.` The reason is printed in full.
- Queued and blocked: the scheduler's own `blocked_by` message.
- `failed` or `killed`: `failed at station build after 2 runs: <last event>`.
- `waiting_human` or `needs_approval`: `waiting on you at station review since
  11:04 PM`.
- `done`: `done after 3 runs, <last event>`.
- Otherwise the last ledger event, `<type>: <summary>`, truncated to 90
  characters, with its time.

### Status words

| status | word | notes |
|--------|------|-------|
| `backlog` | backlog | |
| `queued` | queued | |
| `running` | running, or **landing** | "landing" when the current station is a `land` station |
| `handing_off` | handing off | |
| `waiting_human` | waiting human, or **PR open** | "PR open" when the card carries a `pr_url` (land mode `pr`) |
| `needs_approval` | needs approval | |
| `paused` | paused | |
| `done` | done | |
| `failed` | failed | |
| `killed` | killed | |

### Chain rail

One pair of tokens per chain entry at the current station: the adapter name in
its agent colour, then that leg's state as a word, `pending`, `running`, `done`,
`handed off` or `failed` (`stateGlyph` in `src/board/board.js`). There are no
glyphs: the subset fonts carry no check, cross or arrow. A gated `approve: true`
entry is not marked on the rail; **Approve** appears in the row's buttons when
the card reaches `needs_approval`.

## Card expansion

Click a card's title to expand a region in flow under that row. Sections, top to
bottom:

1. **Title**.
2. **Task**: the full task text, headed `card <id>`.
3. **Where**: `repo`, `trunk`, `worktree`, `leases` and the bundle path, full
   paths never shortened, with a **Copy worktree path** button.
4. **Pipeline**: one row per station, its name and its kind, the current one
   marked `, this station`; the heading says `station 2 of 5`.
5. **Runs**: one row per run: run number, adapter, outcome or status, signal,
   exit code.
6. **Timeline**: the ledger, newest first.
7. **Log**: the tail of the active or most recent run's combined log, up to 2000
   lines.

**Close** or the Escape key collapses it, and focus returns to the title.

## New card form

The dialog opened by **New card** (`src/board/index.html`):

| field | notes |
|-------|-------|
| Repo path | required; an absolute path to a git repository |
| Task | required; the prompt every leg gets |
| First agent | required; real agents appear here and Claude is preferred when installed |
| Run now | checked by default; unchecking saves the card as a draft in `backlog` |
| Workflow (Advanced) | Build only stops unmerged in the worktree; Build-land runs test then land; Factory runs plan, build, review, test, and land; custom JSON reveals a station-array textarea |
| First-agent controls (Advanced) | allowed permission mode, approval gate, max turns, and scripted behavior when the test/demo override is selected |
| Fallback agents (Advanced) | one understandable row per later adapter, tried in displayed order only if the previous agent cannot continue |
| Scripted first agent (Advanced) | explicitly test/demo only; keeps fake adapters out of the normal first-agent default |
| File leases (Advanced) | comma-separated path globs to reserve so overlapping cards wait |
| Trunk branch | default `main` |
| Merge method | `ff` or `pr`; relevant to a workflow with a land station |
| Test command | overrides the land station's auto-detected command |
| Title | optional; defaults to the task's first 80 characters |

**Cancel** closes without creating a card; **Create card** posts it and closes on
success (errors show inline above the form).

## Buttons

Which buttons a card shows depends on its status (`src/chain.mjs`
`availableActions`, labels from `src/board/board.js` `ACTION_LABELS`). The order
is fixed: Approve, Run, Resume, Pause, Hand off now, Rerun, Reassign, Kill.

| button | shown when | what it does |
|--------|------------|--------------|
| Run | `backlog` | queues the card (`enqueue`) |
| Pause | `running` | stop after the current leg, child killed, bundle written |
| Hand off now | `running`, at an `agent` station that has a later chain entry | end the current leg as if it were incomplete, write the bundle, start the next adapter |
| Resume | `paused` | pick up where it stopped |
| Approve | `needs_approval` or `waiting_human` | release a gated leg, or clear a human station |
| Kill | any non-terminal status | stop the running agent; card ends `killed` |
| Reassign | any non-terminal status, and the current station is an `agent` station | pick a different adapter/mode for the current leg from a picker |
| Rerun | `done`, `failed`, `killed` | start the station over from the last bundle |
| Remove | `done`, `failed`, `killed` | delete the card record, its events and its runs; the worktree is kept (confirms first) |

## What a state looks like

| state | row rank | status word | typical buttons |
|-------|----------|-------------|------------------|
| backlog | 5 | backlog | Run |
| queued | 4 | queued | Kill, Reassign* |
| blocked by lease | 4 | queued, with a `blocked by lease` chip | Kill, Reassign* |
| running | 2 | running (or landing) | Pause, Hand off now†, Kill, Reassign* |
| handing off | 2 | handing off | Kill, Reassign* |
| needs approval | 0 | needs approval | Approve, Kill, Reassign* |
| waiting human | 0 | waiting human (or PR open) | Approve, Kill |
| paused | 3 | paused | Resume, Kill, Reassign* |
| done | 6 | done | Rerun, Remove |
| failed | 1 | failed | Rerun, Remove |
| killed | 1 | killed | Rerun, Remove |

\* Reassign only shows when the current station is an `agent` station.
† Hand off now only shows when that station has a later chain entry.

## Floor view

`/floor` (`docs/screenshots/floor.png`) is the scheduler-eye view across every
card. It carries the same instrument head as the board, then polls `/api/floor`
and `/api/trunk?since=1h` every 2 seconds and refreshes on the same server-sent
events as the board. Its top bar has the Baton floor brand, the same connection
word and 24 px rule, a repos list, the scheduler status, running/queued/waiting/
done counts, then a spacer and the **Board** link. Five tables:

| section | columns |
|---------|---------|
| Running | Card, Station, Agent / leg, Leases, Last event, Elapsed, Actions |
| Waiting on humans | Card, Station, Status, Since, Actions |
| Queued | Card, Station, Leases, Blocked by |
| Leases | Lease, Card, Station, Since |
| Trunk lane | Time, Card, Summary |

Each region head names its own count, `0 running`, `0 landed in the last hour`,
and an empty table is replaced by a sentence saying what would put a row there.
The Trunk lane lists commits landed in the last hour, newest first. The Leases
table is `src/leases.mjs` `held()`: one row per lease currently claimed by a
running or handing-off card.

## Keyboard and accessibility

- Every interactive element (links, buttons, inputs, selects, textareas,
  summaries) gets a visible focus ring: `outline: 2px solid var(--focus);
  outline-offset: 2px` on `:focus-visible` only (`src/board/board.css`). There
  is no bare `:focus` rule, so a mouse click leaves no ring behind it.
- Escape closes the open expansion, the terminal's and the card's. If a confirm
  row is open, Escape cancels that first. The floor has neither, so Escape does
  nothing there.
- Buttons carry descriptive `aria-label`s (for example "Pause `<card title>`",
  "Reassign adapter for `<card title>`") so a screen reader announces which card
  an action applies to, not just the button label.
- A terminal's expansion is a `role="region"` labelled "What this terminal is
  doing", and both expansions set `aria-hidden` and `hidden` on open and close.
- The 7 px status mark is an `aria-hidden` decoration; the status word beside it
  carries the meaning. The chain rail prints each leg's state as a word, so
  nothing on it is hidden from a screen reader either.
- No state is carried by colour alone: a panel that needs you also says `waiting
  on you` and gains a 2 px bar, and every usage tier prints its word beside the
  rail.
- `@media (prefers-reduced-motion: reduce)` is respected in
  `src/board/board.css`: the status mark's annunciation animation and every
  transition on the page are disabled for readers who ask for it.

## See also

- [concepts.md](concepts.md): what each status and outcome means underneath
  the board.
- [configuration.md](configuration.md): `BATON_BIND` / `BATON_TOKEN` (the
  Settings token field), `BATON_PORT`.
