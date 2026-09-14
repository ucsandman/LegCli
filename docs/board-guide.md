# Board guide

For anyone using the Baton board day to day: what every element means and
when it shows up. The board has two halves: the **Terminals** lane at the top
(the sessions started with `baton claude|codex|agy`) and optional **Background
tasks** below it. Start a session (`baton claude`) or the background-task board
(`npm start`), see [getting-started.md](getting-started.md), then use this as a
reference.

## Screenshots

`docs/screenshots/` (listed here so you know what exists before you look
for one):

```
board-400px.png          board-done.png            board-drawer.png
board-empty.png           board-handoff.png          board-running.png
demo-1-claude-running.png demo-2-limit-hit.png       demo-3-handoff-bundle.png
demo-4-codex-running.png  demo-5-done.png
floor-final-1280.png      floor-final-400.png        floor-landing.png
floor.png
kanban-final-1280.png     kanban-final-400.png
```

The `demo-*` sequence is walked through in [DEMO.md](DEMO.md).
`share-owner-1280.png` and `share-guest-1280.png` are the same shared board
seen by its owner and by a guest (2026-09-11, live over Tailscale).
`terminals-1280.png` is the Terminals lane after a live Land (2026-09-11, three
haiku sessions on a throwaway repo): one card landed on main, the other
bounced with `rebase-conflict` on README.md, and the landed-on-trunk list names
the terminal that landed the commit.

## Terminals lane

`src/board/sessions.js` renders it from `GET /api/sessions`, refreshed by the
server-sent `sessions` event and re-rendered every 15 s so the elapsed and
reset times stay honest. With no sessions yet it says so and names the command
to run.

### Accounts strip

One pill per login, `<agent>` for the default account and `<agent>/<name>` for
a named one:

- **5h and 7d usage bars**, green under 60 %, amber from 60 %, red from 85 %.
  The label is `<n>% used`; a window with no reading shows an em dash. Hover
  gives the exact percentage and when the window resets.
- **A live dot** next to the name when a session is running on that login;
  hovering says how many.
- **`limit · back <time>`** instead of the bars when that login is walled. The
  time is when it comes back.
- **`no % from agy`** for agy, which exposes no percentage at all.
- Hovering the pill names the source of the reading and how long ago it
  arrived. A reading older than five minutes is labelled stale.

For Codex, the board reads the app-server's read-only
`account/rateLimits/read` response every 60 seconds and maps its 300- and
10080-minute windows to 5h and 7d. The active `baton codex` attach also polls
that response. A percentage alone does not clear a limit wall: Baton waits for
an explicit available answer from the backend.

### Terminal card

One per session, active sessions first, then by start time:

- **Head row**: an agent pill (with the account name when it is not
  `default`), the status chip, a `from <agent>` chip when this terminal started
  on another agent and was handed off, and elapsed time since the session
  started.
- **Task**: the first prompt, truncated to 140 characters, or "no prompt yet".
- **Meta**: `repo@branch` (the full path on hover), the turn count, and the
  short HEAD sha. A session that started while another was live in the same
  checkout adds an `own worktree · from <base>` chip; hover gives the worktree
  path and branch.
- **Handoff order**: `Now: <agent/account>` followed by the exact fallback
  candidates. The line below distinguishes the preferred first option from
  the first one currently eligible when a CLI is missing or an account is at
  its limit. **Change order** moves the three agents without removing one;
  same-agent secondary accounts still come before the other agents. The list
  is an absolute priority: an agent moved to the bottom is tried last from
  every starting agent. The editor previews the resulting priority, with the
  agent running now skipped, before saving.
  The sequence is used only after a usage limit or **Hand off now**. A normal
  exit ends the terminal.
- **Usage bars**: the 5h and 7d windows for this session's login. When the
  endpoint has no numbers for them the card says `usage unknown (<why>) · the
  limit still hands off` instead: no login in that config directory, a 404, a
  429, a body that is not JSON, or a shape Baton does not recognise.
- **Warning line** at `BATON_WARN_PCT`: `⚠ <window> window at <n>% · next:
  <agent>`, naming the option Baton would hand to.
- **Limit line**: `limit: <reason> · resets <time>`, the raw limit text on
  hover.
- **Handoff line**: `<from> → <to> (<reason>) · bundle <id>`.
- **Waiting line** while status is `waiting`: `⏳ waiting for <agent> at
  <time>`; the terminal starts that agent from the bundle at the reset.
- **All-out line** on an ended card: `every option is out · first back:
  <agent> <time>` (the terminal was quit while waiting).
- **File chips**: up to 8 of the files this session is touching, then `+n`. A
  chip turns red when another live session is touching the same file.
- **Overlap flags**: one line per overlapping session, `⚠ <agent> (<id tail>)
  is editing <files> too` when both work in the same checkout, or `⚠ <agent>
  (<id tail>) is changing <files> in another checkout; whoever lands second
  rebases` when they work in different ones. The whole card gets a red border.
  An overlap is two live sessions in the same repo whose `files_touched` or
  `files_dirty` sets intersect (`sessions.overlaps`), so it catches a file one
  agent has edited and another has only made dirty.
- **Land line** after a Land: `landing <branch> onto <base>: rebase, tests,
  fast-forward…` while it runs, then `✓ landed on <base> · <sha> · <n> files
  +<ins>/-<del>` (with `· untested` when the repo has no test command),
  `✗ bounced (<reason>): <first line>` with the whole reason on hover, or
  `nothing to land`. If the board restarted in the middle it reads `the landing
  was cut off`; press Land again.

| status | chip label |
|--------|------------|
| `starting` | starting |
| `running` | running |
| `warning` | near limit |
| `limit` | limit hit |
| `handing_off` | handing off |
| `waiting` | waiting for reset |
| `handed_off` | handed off |
| `ended` | ended |
| `lost` | lost |

`waiting` means every option is walled and the terminal is counting down to
the first reset; the card's line reads `⏳ waiting for <agent> at <time>`, and
End quits that terminal with exit 3. `lost` means the runner process that owned that terminal is gone. It is never
counted as live.

### Terminal buttons

| button | shown when | what it does |
|--------|------------|--------------|
| Land | the session has its own worktree, active or not; disabled with the reason on hover while it is landing or when the worktree is gone | `POST /api/sessions/:id/land` (202): commits what the agent left on `baton/<id>`, rebases it onto its base, runs the tests, fast-forwards the base or bounces; the land line shows the result |
| Request handoff | the board is shared and this terminal is someone else's | `POST /api/sessions/:id/request-handoff` (202): asks the owner; nothing happens until they approve |
| Approve `<name>` / Dismiss | the board is shared and someone asked for a hand-off on your terminal | `POST /api/sessions/:id/requests/<name>/approve` (or `/dismiss`): approving hands the terminal off, and the event says who it was for |
| Hand off now | the session is active | `POST /api/sessions/:id/handoff`: saves the bundle, stops this agent, starts the next option in the same terminal |
| Change order | a terminal is active and has not committed a handoff | saves its validated claude/codex/agy priority; an older wrapper instead saves the machine default and says to restart the terminal |
| End | the session is active | `POST /api/sessions/:id/end`: stops the agent, ends the session |
| Remove | the session is not active | `DELETE /api/sessions/:id`: safely prunes the session record, worktree, and merged branch only when the worktree is clean and the branch is already on its base; otherwise it leaves them and explains why |
| Remove record | the session is not active and has an own worktree | confirmation, then `DELETE /api/sessions/:id?force=1&keep_worktree=1`: removes only Baton's record and keeps the worktree, branch, unmerged commits, and dirty files |

Each press shows a toast; **Hand off now** says the terminal switches agents in
a few seconds, because the switch happens in the terminal, not the browser.
Settings has the same order editor for the default copied by new terminals.

### Landed on trunk

Below the cards, one block per repo with a live session or a session with its
own worktree: `landed on <branch> · <repo>`, then the last 6 commits of the
first of `main`, `master` or `trunk` that exists, with sha, subject and when. A
commit a Land put there says `landed by <agent> (<id tail>)` in green (from
`~/.baton/landings.jsonl`, which outlives the session); any other commit shows
its git author. It answers "what actually got in, and from which terminal"
without leaving the board.

## A shared board (more than one human)

With `baton share` on (off by default), the head of the terminals lane says
`you are <name>` and how many people are on the board, and every card carries
an owner chip: green when the terminal is yours, grey when it is not
(`docs/screenshots/share-owner-1280.png` is the owner's board,
`share-guest-1280.png` the same moment as a guest).

A card that belongs to someone else is drawn with a dashed border and says
`read-only: <name> owns this terminal`. Its prompt reads `prompt hidden`, it
has no file chips, no bundle line and no log, and the limit line keeps only
the reason and the reset time (never the raw limit text); its only button is
**Request handoff**. The owner sees `<name> asked for a hand-off
<when>` on their own card with **Approve** and **Dismiss**.

A guest's board has no Background tasks section, no New card button and no Floor link:
that side belongs to the owner of the machine, and the API answers 403.

## Background tasks: board layout

Everything from here down is the v0.1 card runtime. Each card runs separately
from the interactive terminal conversations, in its own git worktree. It sits
below the Terminals lane.

The top bar (`src/board/index.html`) has, left to right: the Baton brand, an
SSE connection dot and text (`connecting` / `live` / `reconnecting…`), a
scheduler status line, a **New card** button, a **Floor** link, and a
**Settings** disclosure holding the new-terminal handoff order and **API
token** field (the token is only needed when the server is bound off loopback;
see [configuration.md](configuration.md#network-exposure)).

Below that: an empty-state message with its own **New card** button when
there are no cards yet. It explains that terminals are live conversations and
a Build-only background card stops without merging its worktree changes.
Otherwise the column board appears.

## Columns

Columns come from the pipeline, not a fixed list: `backlog`, `queued`, then
every station name across all visible cards in a stable order (`plan`,
`build`, `review`, `test`, `land` first if present, then any custom station
name alphabetically), then `done`, `failed`. A `killed` card also appears in
the `failed` column (both map to the same column bucket). Each column header
shows a live count.

## Card

Each card (`docs/screenshots/board-running.png`) shows, top to bottom:

- **Title** (the card's `title`, or the first 60 characters of the task) as
  a button that opens the [drawer](#drawer).
- **Meta row**: repo name, a station chip (current station name, when not
  `-`), the **status chip**, and a **bounce chip** if the card carries a
  `bounce_reason` and is not yet terminal.
- **Chain rail**: one pill per chain entry at the current station (see
  [Chain rail glyphs](#chain-rail-glyphs)).
- **Lease chips**: one per claimed lease, or `**` (the whole repo) when
  none were set.
- **Elapsed**: `mm:ss` while a leg is actively running, else `--:--`.
- **Last event line**: the most recent ledger event's type and summary,
  truncated to 90 characters (hover for the full text when it is a
  `blocked_by` event).
- **Log tail**: the last 8 lines of the active/most recent run's log,
  loaded on demand; a **show more** button expands it to 200 lines.
- **Action buttons** (see [Buttons](#buttons)).

### Status chip

| status | label | notes |
|--------|-------|-------|
| `backlog` | backlog | |
| `queued` | queued, or **blocked by lease** / **blocked: `<reason>`** | when the last event is `blocked_by`; hover shows the full scheduler message |
| `running` | running, or **landing** | "landing" when the current station is a `land` station |
| `handing_off` | handing off | |
| `waiting_human` | waiting human, or **PR open** | "PR open" when the card carries a `pr_url` (land mode `pr`); hover shows the URL |
| `needs_approval` | needs approval | |
| `paused` | paused | |
| `done` | done | |
| `failed` | failed | |
| `killed` | killed | |

### Bounce chip

Shown while the card is `queued`, `running`, `handing_off` or
`needs_approval` and carries a `bounce_reason`: `bounced: <reason> (attempt
N)`, the reason truncated to 24 characters up to its first `(` or `:`; hover
shows the full reason.

### Chain rail glyphs

Each pill is one chain entry at the current station: adapter name, mode (if
set), a state glyph, and a lock glyph if that entry is gated with
`approve: true` (`src/board/board.js` `stateGlyph`):

| glyph | state | meaning |
|-------|-------|---------|
| ✓ | `done` | this leg completed |
| ↷ | `handed` | this leg handed off to the next one |
| ✗ | `failed` | this leg failed |
| ● | `active` | this leg is currently running |
| · | (default) | this leg has not run yet |
| 🔒 | (approve) | this leg is gated: it needs Approve before it starts |

`docs/screenshots/demo-2-limit-hit.png` shows the ↷ glyph on the fake-claude
leg of a needs-approval card, with the 🔒 lock on the gated fake-codex leg
next to it.

## Drawer

Click a card's title to open the drawer (`docs/screenshots/board-drawer.png`).
Sections, top to bottom:

1. **Title**.
2. **Task**: the full task text.
3. **Worktree**: the path relative to the repo (the tooltip carries the
   full path; a shared board should not print an operator's home
   directory).
4. **Pipeline**: an ordered list, `<station> (<kind>)`, with the current
   station highlighted.
5. **Events**: the full timeline, one row per ledger event (timestamp,
   type, actor, summary), with a `body` disclosure when the event carries
   one.
6. **Runs**: one line per run: run number, adapter, outcome/status,
   signal, exit code.
7. **Bundle**: the latest handoff bundle's id and path with a **Copy path**
   button, or "no bundle" if none exists yet.
8. **Log**: up to 2000 lines of the active/most recent run's combined log.

Close with the **Close** button or the Escape key.

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
`availableActions`, labels from `src/board/board.js` `ACTION_LABELS`):

| button | shown when | what it does |
|--------|------------|--------------|
| Run | `backlog` | queues the card (`enqueue`) |
| Pause | `running` | stop after the current leg, child killed, bundle written |
| Hand off now | `running` | end the current leg as if it were incomplete, write the bundle, start the next adapter |
| Resume | `paused` | pick up where it stopped |
| Approve | `needs_approval` or `waiting_human` | release a gated leg, or clear a human station |
| Kill | any non-terminal status | stop the running agent; card ends `killed` |
| Reassign | any non-terminal status, and the current station is an `agent` station | pick a different adapter/mode for the current leg from a picker |
| Rerun | `done`, `failed`, `killed` | start the station over from the last bundle |
| Remove | `done`, `failed`, `killed` | delete the card and its worktree (confirms first; cannot be undone) |

## What a state looks like

| state | column | status chip | typical buttons |
|-------|--------|-------------|------------------|
| backlog | `backlog` | backlog | Run |
| queued | `queued` | queued | Kill, Reassign* |
| blocked by lease | `queued` | blocked by lease | Kill, Reassign* |
| running | current station | running (or landing) | Pause, Hand off now, Kill, Reassign* |
| handing off | current station | handing off | Kill, Reassign* |
| needs approval | current station | needs approval | Approve, Kill, Reassign* |
| waiting human | current station | waiting human (or PR open) | Approve, Kill |
| paused | current station | paused | Resume, Kill, Reassign* |
| done | `done` | done | Rerun, Remove |
| failed | `failed` | failed | Rerun, Remove |
| killed | `failed` | killed | Rerun, Remove |

\* Reassign only shows when the current station is an `agent` station.

## Floor view

`/floor` (`docs/screenshots/floor-landing.png`, `floor.png`) is the
scheduler-eye view across every card, polling `/api/floor` and `/api/trunk`
and refreshing on the same server-sent events as the board. Its top bar adds
a repos list, running/queued/waiting/done counts, and the same SSE dot. Five
tables:

| section | columns |
|---------|---------|
| Running | Card, Station, Agent / leg, Leases, Last event, Elapsed, Actions |
| Waiting on humans | Card, Station, Status, Since, Actions |
| Queued | Card, Station, Leases, Blocked by |
| Leases | Lease, Card, Station, Since |
| Trunk lane | Time, Card, Summary |

The Trunk lane lists landed commits as they happen, oldest to newest. The
Leases table is `src/leases.mjs` `held()`: one row per lease currently
claimed by a running or handing-off card.

## Keyboard and accessibility

- Every interactive element (buttons, links, inputs, selects) gets a
  visible focus ring: `outline: 2px solid #58a6ff; outline-offset: 2px` on
  `:focus-visible` and `:focus` (`src/board/board.css`).
- Escape closes the open drawer.
- Buttons carry descriptive `aria-label`s (e.g. "Pause `<card title>`",
  "Reassign adapter for `<card title>`") so a screen reader announces which
  card an action applies to, not just the button label.
- The drawer sets `aria-hidden` on open/close.
- Chain-rail glyphs and lock icons are `aria-hidden="true"` decorations;
  the adapter name and mode text carry the meaning.
- `@media (prefers-reduced-motion: reduce)` is respected in
  `src/board/board.css`: animation and transition are disabled for users
  who ask for it.

## See also

- [concepts.md](concepts.md): what each status and outcome means underneath
  the board.
- [configuration.md](configuration.md): `BATON_BIND` / `BATON_TOKEN` (the
  Settings token field), `BATON_PORT`.
