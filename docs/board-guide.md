# Board guide

For anyone using the Leg board day to day: what every element means and when
it shows up. The board is one page, read top to bottom: **the verdict** (one
sentence saying what to do next), **the logins** (one panel each), **Terminals**
(one row each), **the ledger** (finished terminals, what landed, background
tasks, as three counts that open), then **Settings**. Start a session
(`leg claude`) or the background-task board (`npm start`), see
[getting-started.md](getting-started.md), then use this as a reference.

The visual system, and why it is what it is, is `DESIGN.md` at the repo root.

## Screenshots

`docs/screenshots/` (listed here so you know what exists before you look for
one). All nineteen were retaken on 2026-09-15 against the current build, after
the dark-product-surface redesign and the card-row port that followed it:

```
terminals-1280.png        the board at 1280 px, four terminals on one login
board-400px.png           the same board at 400 px
board-details-open.png    a terminal with its expansion open
board-empty.png           no background tasks at all
board-running.png         one card running its first agent
board-handoff.png         the limit hit, the card waiting on you
board-drawer.png          that card expanded: bundle, runs, timeline
board-done.png            the card finished, on the agent that finished it
floor.png                 /floor with nothing queued
floor-landing.png         /floor with every lane full
floor-final-1280.png      /floor after a card finished
floor-final-400.png       the same at 400 px
share-owner-1280.png      a shared board as its owner
share-guest-1280.png      the same board as a guest: prompts and repos redacted
demo-1-claude-running.png  leg 1 running on fake-claude
demo-2-limit-hit.png       limit hit, bundle written, the row waiting on you
demo-3-handoff-bundle.png  the row expanded: bundle path, run signal, timeline
demo-4-codex-running.png   leg 2 running on fake-codex
demo-5-done.png            done, both legs on the chain
```

The five `demo-*.png` are one run of the sequence in [DEMO.md](DEMO.md), all at
1280 px.

To retake one, seed a board with the shape a real one has and drive it to the
state the shot needs:

```
node scripts/seed-wes-board.mjs     # 4 live terminals, 5 finished, long paths
node scripts/seed-floor-board.mjs   # cards in every floor lane, plus a landing
node scripts/board-shots.mjs <port> <tag>   # shoot 1280 and 400, print the numbers
```

Each seeder writes a throwaway `LEG_HOME` under the OS temp dir; serve it on a
spare port with `LEG_TRUST=never`. **Never use port 4747**, that is the live
board, with real sessions on it.

Measure against those seeds and never against a board of healthy terminals:
styling scoped to live rows and measured on a clean board reported 40px terminal
rows while the real screen showed 400px.

## The verdict and the logins

`src/board/sessions.js` draws both, from the `accounts` array of
`GET /api/sessions` and the sessions beside it.

**The verdict** is the largest thing on the page and it is a sentence, not a
number. It names the one fact that decides what happens next:

```
All 4 terminals are on claude, and claude has 5% left.
```

One login carrying every terminal is one point of failure, so that is what the
sentence says. With the terminals spread across logins it names the one closest
to a wall instead; with nothing running it says so, and names any login that is
walled. The number it prints is what is **left**, because that is the quantity
you are deciding against.

Under it, one line carrying the age of the reading and which direction it is
wrong in:

```
Measured 2h 13m ago. 4 terminals have been running since, so the real figure is
higher than 95 percent, never lower.
```

A reading taken two hours ago is a floor, not a measurement, and saying so is
the entire reason to print its age. Any login at a wall other than the one in
the headline is named on the same line.

**The logins** sit under the verdict, one panel each, and how much surface a
panel gets is the design saying how much it matters:

- The login carrying the terminals gets a wide panel, lit one step brighter than
  the rest, with both of its windows drawn. The window closest to a wall is the
  full-size instrument; the other is the same instrument at half height with a
  smaller numeral, so which one to read is not a question.
- A login with a single fact to report gets a half panel: its gauge if it has a
  reading, then the fact. A walled login reads `At the wall` and
  `Back Saturday 10:11 PM. Nothing runs on codex until then.`
- A login that publishes no figure draws no instrument at all. agy's panel says
  `agy publishes no usage figure, ever. Leg shows its terminals and their
  elapsed time instead.` An empty track reads as a measurement of zero to anyone
  glancing at it, so none is drawn.

**The gauge** is a track, a fill and a numeral. The fill runs in the login's own
identity colour up to 85 percent and in the over colour past it, and a 2px notch
is cut through the bar at 85 at all times, including at zero fill: you can see
the reserve before you reach it. A window that has never been read draws no fill
and prints `no reading`, because a zero is a reading and Leg does not print
one it does not have.

Nothing here is on hover. A screen reader gets the whole answer from each
track's `aria-valuetext`, including the reset, the source and the staleness; a
window with no value is not a `meter` at all and carries the same sentence as
its label. The caption under the logins reads `Times are local.`

For Codex, the board reads the app-server's read-only
`account/rateLimits/read` response every 60 seconds and maps its 300- and
10080-minute windows to 5h and 7d. The active `leg codex` attach also polls
that response. A percentage alone does not clear a limit wall: Leg waits for
an explicit available answer from the backend.

## Terminals

`src/board/sessions.js` renders the region from `GET /api/sessions`, refreshed
by the server-sent `sessions` event, re-sorted every 15 s, with the elapsed
clocks ticking every second. With no sessions it prints `No terminal is running.
Start one in any repo: leg claude, leg codex or leg agy. It appears here
within a second of the agent's first turn.`

The region head carries one verdict with its volume: `3 running, 2 waiting on
you`, or `3 running, nothing is waiting on you`, or `nothing is running`, with
`, last landed 11:02 PM` appended when a terminal on the page has landed.

### Terminal row

One row per live session, inside a single panel, separated from its siblings by
a hairline. Rows that need an answer come first; the rest follow in start order.
A row that needs you says `waiting on you` where its status word would be, so
the state is never carried by colour or position alone.

Reading across the row: what it is doing, what it is working on, how long it has
been at it, and what you can do about it.

- **The register**, one line of the smallest type on the board: the status word
  with its dot, then where the work is (`leg on main`, or the folder when it
  is not a repo), then anything unusual about this terminal as plain words, the
  account when it is not `default`, the owner on a shared board, `from <agent>`
  when it was handed off, `own worktree, from main` when it cut its own.
- **The prompt**, as a button: the first prompt of the session, carried in full
  in its tooltip and in the expansion. A pasted screenshot arrives as an
  `<image name=... path=...>` tag with an absolute temp path in it; the tag is
  replaced by `(image)` and the text, so the operator's home directory is not on
  screen and the sentence starts where the sentence starts.
- **Under the prompt**, exactly one sentence, the highest-ranked thing true
  about this terminal, then `also: <names>` naming every sentence it is holding
  back, then the files this session is touching as comma-separated **basenames**
  up to six, then `, and N more`. The whole path stays on the title and in the
  expansion; printed in full it was ninety characters of temp path per file. A
  file another live session is also touching is printed in the warning colour.
  A terminal that is merely running prints no sentence at all: its own row
  already says so, and four rows each saying `activity` is four lines of noise.
- **The clock**: elapsed since the session started (`4h 24m`), and the session's
  short id. The id used to print as `claude-7f3a` immediately after the word
  `claude`; the prefix is the agent name twice and it is gone.
- **The buttons**, in a fixed 2x2 grid so every row's controls sit in the same
  place: Land, Hand off now, Details, End. Land is the primary action only when
  it can actually run, when it is blocked the accent moves to Hand off now,
  because a disabled control should not wear the one accent colour in the
  design. When Land is disabled its reason is printed, never left in a tooltip.

**A fact true of every row is said once, at the region.** Three rows all reading
`this terminal works in the checkout itself: there is no branch of its own to
land` is one fact and two lines of noise, so it is hoisted to the region head as
`every terminal here works in the checkout itself...`. The per-row copy stays in
the DOM, visually hidden, so each Land button's `aria-describedby` still resolves
to its own reason. The same applies to any sentence two or more terminals would
print identically, except muted ones: `turn 12, last activity 1:04 AM` is shared
by coincidence, not a fact about the board.

**Finished terminals leave this panel.** A terminal that has ended or been lost
is history, and after a day's work it is most of the list. It moves to the
ledger (below) as part of a count that opens. A finished terminal that still
needs you, or whose expansion you have open, stays in place.

With the portable harness on, the register also carries one chip for the leg
now running: `harness synced`, `harness partial`, `harness stale`, `harness
attention` or `harness refused` (`harness.md`, "States"). Nothing shows when
the feature is off.

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
| Land | always, disabled with the reason printed under it when the session has no worktree of its own, while it is landing, or when the worktree is gone | `POST /api/sessions/:id/land` (202): commits what the agent left on `leg/<id>`, rebases it onto its base, runs the tests, fast-forwards the base or bounces; the panel's sentence shows the result |
| Request handoff | the board is shared and this terminal is someone else's | `POST /api/sessions/:id/request-handoff` (202): asks the owner; nothing happens until they approve |
| Approve `<name>` / Dismiss `<name>` | the board is shared and someone asked for a hand-off on your terminal | `POST /api/sessions/:id/requests/<name>/approve` (or `/dismiss`): approving hands the terminal off, and the event says who it was for |
| Details | any terminal of yours | `GET /api/sessions/:id/detail`: the transcript, the files changed with their line counts, the timeline and the current bundle; `GET /api/sessions/:id/diff?file=<path>` for one file, capped at 400 lines, refused for any path outside that terminal's own tree |
| Hand off now | the session is active | `POST /api/sessions/:id/handoff`: saves the bundle, stops this agent, starts the next option in the same terminal |
| Change order | inside the expansion, while the status is `starting`, `running`, `warning`, `limit` or `waiting` | saves its validated claude/codex/agy priority; an older wrapper instead saves the machine default and says to restart the terminal |
| End | the session is active | `POST /api/sessions/:id/end`: stops the agent, ends the session |
| Remove | the session is not active | `DELETE /api/sessions/:id`: safely prunes the session record, worktree, and merged branch only when the worktree is clean and the branch is already on its base; otherwise it leaves them and explains why |
| Remove record | the session is not active and has an own worktree | `DELETE /api/sessions/:id?force=1&keep_worktree=1`: removes only Leg's record and keeps the worktree, branch, unmerged commits, and dirty files |

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
   shape Leg does not recognise.
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
   editor, the current bundle id, and whether `.leg/RESUME.md` still describes
   the repository (recomputed from git on every poll).
8. **Harness** (only when the [portable harness](harness.md) is on): the
   source client, when it was captured and synced, the policy, one line for
   the leg now running (`codex harness partial · 8/8 components, 3 dropped ·
   1 file(s) written`), a row per component with its state and `carried /
   total`, **Needs you** for a hand-edited file or an unreadable config,
   **Dropped** with a reason per item (`excluded by policy` when the drop was
   yours), and the last eight entries of the harness trail. Every word comes
   from what the session recorded when the leg started, never from a guess.

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

## The ledger

Below the terminals, four counts sitting on the ground with no panel, because a
raised surface here would compete with the terminals that are live. Each is a
heading, a line of detail and a button that opens the detail below the row.

- **N finished**, the terminals that have ended or been lost, `4 lost, 2 ended,
  in leg, costclaw, declick`. **View all N** opens them as full rows. On a real
  board after a day's work this is most of the list, which is exactly why it is a
  count and not the list.
- **N landed**, what has landed on trunk across every repo the board can see,
  `newest 38 minutes ago, on leg@main, recruiting-tool@main`. **View N
  commits** opens them grouped by repo, newest first: the subject and, for a
  commit a Land put there, `3 hours ago, by claude`, read from
  `~/.leg/landings.jsonl`, which outlives the session; any other commit shows
  its git author. Shown in full it was eighteen rows of `git log` at the same
  visual weight as the live terminals, so the loudest thing on the page was a
  commit from eleven days ago. With nothing landed it reads `Nothing landed yet`
  and explains what Land does.
- **N conversations**, every coding-agent conversation on this machine, `799
  claude, 198 codex, 92 agy, 14 grok, 5 copilot; looked 2m ago`: the sessions
  Leg started and the ones the agents keep in their own stores, read from
  there and never moved ([history.md](history.md)). **Browse N** opens a
  drawer with filters (agent, search, repository, only what Leg started), a
  page of fifty rows newest first and **Show 50 more**. A row is the title as a
  button, then the agent chip, `leg` or `external` (`, live` when a process is
  still on it), `repo on branch`, the prompt count and the short id. The title
  opens the conversation in place: agent, who started it, folder, repository,
  worktree, times, prompts, transcript path, id, the `leg history continue
  <id>` command with **Copy the continue command** where the agent can resume
  by id (or the reason it cannot), **Copy folder path**, and the last eight
  messages newest first, each redacted the way the terminal drawer's are. Below
  the rows, **Checkouts**: every worktree Leg can see with its repo and branch,
  owner (the checkout itself, a Leg session, a Leg card, or not Leg's), how
  many conversations point at it, and `missing`, `orphaned`, `stale`, `clean`
  or `N uncommitted`. Nothing here is pushed over the live stream; the count
  re-reads itself once a minute while the drawer is closed. On a shared board
  a guest sees `The owner of this machine sees them.` and nothing else.
- **N background tasks**, the card runtime below, as a count with **View N
  cards**, plus **New card**. With none it reads `Nothing is queued. Leg starts
  the next login only when a terminal hands off.`

## A shared board (more than one human)

With `leg share` on (off by default), the Terminals region head carries a chip
reading `you are wes, 2 on this board`, with `, a guest` after the name for
anyone who is not the owner, and every row carries an owner word in its
register: `wes, you` on yours, `wes` on someone else's. There is no colour
difference between the two.

A row that belongs to someone else carries exactly one sentence, `read-only: wes
owns this terminal`. Its prompt reads `prompt hidden`; it has no file names, no
path beyond the repo and branch, no bundle and no event log; and its only button
is **Request handoff**. A guest's login panels say `Usage for this login is not
shared with guests` and draw no instrument. The owner sees `sam asked to take
this terminal at 11:04 PM` on their own row, with **Approve sam** and **Dismiss
sam**.

A guest's board has no background tasks cell, no New card button and no Floor
link: that side belongs to the owner of the machine, and the API answers 403.

## Background tasks: page layout

Everything from here down is the v0.1 card runtime. Each card runs separately
from the interactive terminal conversations, in its own git worktree. It is the
third ledger cell, and its rows open in a drawer under the ledger.

The masthead (`src/board/index.html`) has the Leg wordmark on the left and, on
the right, the connection word (`connecting` / `live` / `reconnecting…`) with its
dot, the scheduler status (`scheduler running, 2 max`), and the **Floor** link.
**New card** is in the ledger cell, not the masthead, and **Settings** is the
last region of the page, in flow. Nothing on the board is sticky: the verdict is
what you came for and it is at the top, so there is nothing to pin.

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
events as the board. Its top bar has the Leg floor brand, the same connection
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
- [configuration.md](configuration.md): `LEG_BIND` / `LEG_TOKEN` (the
  Settings token field), `LEG_PORT`.
