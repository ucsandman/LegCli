# Board guide

For anyone using the Baton board day to day: what every element means and
when it shows up. The board has two halves: the **Terminals** lane at the top
(the sessions started with `baton claude|codex|agy`) and the v0.1 **Pipelines**
columns below it. Start a session (`baton claude`) or the pipeline board
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
`terminals-1280.png` is the Terminals lane.

## Terminals lane

`src/board/sessions.js` renders it from `GET /api/sessions`, refreshed by the
server-sent `sessions` event and re-rendered every 15 s so the elapsed and
reset times stay honest. With no sessions yet it says so and names the command
to run.

### Accounts strip

One pill per login, `<agent>` for the default account and `<agent>/<name>` for
a named one:

- **5h and 7d usage bars**, green under 60 %, amber from 60 %, red from 85 %.
  A window with no reading shows an em dash. Hover gives the exact percentage
  and when the window resets.
- **A live dot** next to the name when a session is running on that login;
  hovering says how many.
- **`limit · back <time>`** instead of the bars when that login is walled. The
  time is when it comes back.
- **`no % from agy`** for agy, which exposes no percentage at all.
- Hovering the pill names the source of the reading and how long ago it
  arrived.

### Terminal card

One per session, active sessions first, then by start time:

- **Head row**: an agent pill (with the account name when it is not
  `default`), the status chip, a `from <agent>` chip when this terminal started
  on another agent and was handed off, and elapsed time since the session
  started.
- **Task**: the first prompt, truncated to 140 characters, or "no prompt yet".
- **Meta**: `repo@branch` (the full path on hover), the turn count, and the
  short HEAD sha.
- **Usage bars**: the 5h and 7d windows for this session's login.
- **Warning line** at `BATON_WARN_PCT`: `⚠ <window> window at <n>% · next:
  <agent>`, naming the option Baton would hand to.
- **Limit line**: `limit: <reason> · resets <time>`, the raw limit text on
  hover.
- **Handoff line**: `<from> → <to> (<reason>) · bundle <id>`.
- **All-out line**: `every option is out · first back: <agent> <time>`.
- **File chips**: up to 8 of the files this session is touching, then `+n`. A
  chip turns red when another live session is touching the same file.
- **Overlap flags**: one line per overlapping session, `⚠ <agent> (<id tail>)
  is editing <files> too`. The whole card gets a red border. An overlap is two
  live sessions in the same repo whose `files_touched` or `files_dirty` sets
  intersect (`sessions.overlaps`), so it catches a file one agent has edited
  and another has only made dirty.

| status | chip label |
|--------|------------|
| `starting` | starting |
| `running` | running |
| `warning` | near limit |
| `limit` | limit hit |
| `handing_off` | handing off |
| `handed_off` | handed off |
| `ended` | ended |
| `lost` | lost |

`lost` means the runner process that owned that terminal is gone. It is never
counted as live.

### Terminal buttons

| button | shown when | what it does |
|--------|------------|--------------|
| Hand off now | the session is active | `POST /api/sessions/:id/handoff`: saves the bundle, stops this agent, starts the next option in the same terminal |
| End | the session is active | `POST /api/sessions/:id/end`: stops the agent, ends the session |
| Remove | the session is not active | `DELETE /api/sessions/:id`: forgets the session record |

Each press shows a toast; **Hand off now** says the terminal switches agents in
a few seconds, because the switch happens in the terminal, not the browser.

### Landed on trunk

Below the cards, one block per repo with a live session:
`landed on <branch> · <repo>`, then the last 6 commits of the first of `main`,
`master` or `trunk` that exists, with sha, subject, when and author. It answers
"what actually got in" without leaving the board.

## Pipelines: board layout

Everything from here down is the v0.1 pipeline board, unchanged in 0.2.0. It
sits below the Terminals lane.

The top bar (`src/board/index.html`) has, left to right: the Baton brand, an
SSE connection dot and text (`connecting` / `live` / `reconnecting…`), a
scheduler status line, a **New card** button, a **Floor** link, and a
**Settings** disclosure holding the **API token** field (only needed when
the server is bound off loopback; see
[configuration.md](configuration.md#network-exposure)).

Below that: an empty-state message with its own **New card** button when
there are no cards yet ("No pipeline cards. Terminals above are the main way
in; a card runs an agent chain headless.",
`docs/screenshots/board-empty.png`), or the column board.

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

`docs/screenshots/board-handoff.png` shows the ↷ glyph on a claude leg next
to a needs-approval card.

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
| Pipeline | `factory`, `build`, `build-land`, or `custom JSON` (reveals a textarea for a station array) |
| Chain | one row per adapter: adapter select, mode select (populated from that adapter's allowed modes), an approve checkbox, a max-turns number, a fake-mode text field; **Add chain row** appends another |
| Leases | comma-separated path globs |
| Trunk branch | default `main` |
| Land mode | `ff` or `pr` |
| Test command | overrides the land station's auto-detected command |
| Title | optional; defaults to the task's first 80 characters |
| Queue immediately | checked by default; unchecking leaves the card in `backlog` |

**Cancel** closes without creating a card; **Create** posts it and closes on
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
