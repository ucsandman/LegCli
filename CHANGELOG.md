# Changelog

## 0.15.0 (2026-09-18)

A second login keeps the conversation, and the runtime does less work per
minute.

- **A hand-off to your other claude login keeps the conversation.** `leg
  accounts add claude <name>` now junctions Claude Code's `projects` store
  into the account beside the harness directories, so the second login sees
  the same conversations and the same auto-memory as the first. At a weekly
  or Fable wall the terminal moves to that login with `claude --resume <id>`
  under its `CLAUDE_CONFIG_DIR` and no bundle prompt, and the timeline says
  `claude/fable → claude/work (kept the conversation)`. One rule decides it
  for the terminal and for the board's picker (`keepsConversation` in
  `src/usage.mjs`): a same-login downshift, or another login whose home can
  see the transcript file, checked at the switch. An account made by an
  older Leg gets the junction the next time it starts. `leg history` lists a
  junctioned store once. codex still takes the bundle across logins.
- **`leg digest`: what happened while you were away.** The default window is
  8 hours (`--since 2d`, `--since 30m`, an ISO time; `--json`; `GET
  /api/digest?since=` on the board, owner only). The first line is the volume
  it was read from, then what needs you (a live terminal waiting on a
  question, a card parked for a human, a failed card, a lost terminal, in
  that order), then one block per repository with every terminal, card and
  landing that moved and the events worth a line, and last the walls
  standing now. Read only, over the records already on disk; a window with
  nothing in it says so with its counts.
- **The runtime does less work per minute, measured before and after.** A
  profiler (`fs` and `child_process` counters plus `--cpu-prof`) sat on every
  path first; the numbers are medians on one Windows 11 box, Node 24, with a
  fake agent, an isolated `LEG_HOME` and a board on 4800–4899, and every
  change carries a test that was seen failing without it.
  - `leg --version` and every other command loaded 68 modules before `main()`
    ran. `bin/leg.mjs` now imports each command group inside its own branch,
    `src/limits.mjs` loads its fixture tree on first use, and the launcher
    asks a new leaf (`src/scheduler-status.mjs`) whether the scheduler runs
    instead of pulling in the orchestrator. `leg --version`: 127 → 52 ms
    wall, 79 → 0 ms CPU after Node's own boot, 254 → 4 fs calls, 68 → 1
    project module; `leg sessions ls` 116 → 75 ms; `leg card ls` 117 → 70 ms
    (`test/cli-lazy.test.mjs`).
  - An idle terminal spawned 59.5 git processes a minute (six per poll round)
    and blocked its own event loop 4.4–10.3 s of every minute doing it. One
    `git status --porcelain=v2 --branch` (`src/git.mjs`) now carries the
    head, the branch, the dirty list and the upstream's own ahead count:
    10.9 git processes a minute, 2.1 s of git wall time, terminal CPU 1.7 →
    0.1 s a minute (`test/git-status.test.mjs`, `test/attach-perf.test.mjs`).
  - The first `leg <agent>` of the day waited for the board it had just
    started (polling `/api/health` for about a second) before the agent got
    its first instruction. The agent starts at once and the wait runs behind
    it; a session that exits within a second still claims the board's
    pidfile before it goes. Time to the agent on that launch: 1,220 → 261 ms.
  - The two-minute bundle checkpoint ran the python CLI synchronously inside
    the poll tick, freezing limit detection and every board button for as
    long as it took (up to its 120 s timeout). It runs beside the tick now,
    one at a time, and the hand-off save waits for a checkpoint still
    writing.
  - `installedAgents()` ran `<agent> --version` for every agent on `PATH` at
    every launch (an 8 s budget each); the answer is kept for a day in
    `$LEG_HOME/installed.json`, keyed by the resolved bin. A `LEG_<AGENT>_BIN`
    override is never cached.
  - An idle board with 43 terminals and one page open rebuilt the whole
    sessions view every 10 s whether or not a byte had changed: 7,294 fs
    calls, 8 git processes and 1.1 CPU seconds a minute for nothing. The
    health tick now asks the same stat fingerprint the watcher asks, runs the
    liveness pass itself (a runner that died moves no file), and pushes only
    when the answer changed; a card that starts or stops waiting on a human
    forces the one push the fingerprint cannot see. Idle: 7,294 → 4,824 fs
    calls, 8.2 → 0 git processes, 1.14 → 0.54 CPU seconds and 6 → 0 sessions
    pushes a minute (what remains is the liveness pass and the scheduler's
    own tick). One
    sessions view also read the usage files 143 times (once per rung per
    terminal, then again for capacity and the accounts panel) and probed three
    paths per terminal for a synthesis file; one reader per view and one
    `readdir` per checkout: `/api/sessions` 53 → 34 ms, 511 → 212 fs calls per
    answer, and each row drops seven runner-bookkeeping fields nothing on the
    board read (8% off every push; `GET /api/sessions/<id>` keeps the whole
    record).
  - A cold `/api/worktrees` ran up to forty git processes on the board's one
    event loop: 9–25 s in which no stylesheet, click or SSE frame was served.
    The list is gathered through `execFile`, four at a time, one refresh per
    query, and a caller that arrives while a refresh runs gets the last list.
    Worst `/api/health` during a cold call: 11.8 → 3.2 s; the rest is the
    history index's synchronous `listHistory`, still open. `/api/trunk`
    (polled every 2 s by the floor) is cached 15 s and cleared by any card
    change or landing: 27.5 → 0.5 ms. A terminal's detail drawer ran one `git
    ls-files` per file it touched every 3 s; one process for the list: 1,247 →
    305 ms.
  - `updateSession` takes the lock budget `run.json` already had (250 tries, a
    10 s steal) instead of running unlocked after 1.2 s; `control.json` is
    cleared under its lock at exit; `src/handoff.mjs` takes `scrub` from
    `src/redact.mjs` instead of the card runner; the 12-leg stop names the
    bundle and `leg resume` instead of promising a hand-off a fresh launch
    never performed.
- **The README's hand-off step 3 said one bundle per leg.** The code has
  written one bundle per session, updated in place, since 0.2.0; the sentence
  now says so. `docs/concepts.md` and the `src/sessions.mjs` header also said
  the runner was the only writer of `session.json`; the usage poller, the
  claude hooks and a board action patch it too, under one lock, and both now
  say that.

## 0.14.0 (2026-09-18)

The 14-day trial is back.

- **Free for 14 days, no key, no card.** The first `leg <agent>` on a machine
  starts a 14-day trial with every gate open, Team's `leg share` included, and
  records it in `$LEG_HOME/trial.json`. `leg license status` shows the days
  left without starting the clock. After the trial, or with a refused key once
  it is over, a session exits 4 with the price and the 30-day guarantee, which
  stays as the second net after buying. Deleting the file resets the clock,
  which is the known limit of an offline trial and is accepted. The license
  agreement gains the trial clause; the site, README, support page and
  `llms.txt` say "free for 14 days" where they said "no trial".
- **The README stops calling the repository private.** It has been public at
  github.com/ucsandman/legcli; two sentences still said otherwise.

## 0.13.1 (2026-09-18)

A one-line fix in the terminal and the marketing site brought up to what 0.13.0 does.

- **The terminal's opening line names rungs.** `next: claude/opus →
  claude/sonnet → codex → agy`, through the same `rungLabel` every other
  surface uses; it read `next: claude → claude → codex → agy` on 0.12.0.
- **The site says what is underneath the handoff.** legcli.com is reorganised
  around the product as it is now: the sample transcript shows a Fable wall
  answered by Opus keeping the conversation and a login wall answered by Codex
  from the bundle; new sections for the ladder, background cards (End as a
  card, Run in the background, Take over), `leg history`, the portable
  harness and custom adapters in one compact group, and a **Never spent
  without you** column beside what is never touched. The structured data's
  `softwareVersion` had been stuck at 0.8.0; the OG image gains Grok; the FAQ
  no longer says a shared board has no TLS.

## 0.13.0 (2026-09-18)

The first day on 0.12.0 with three real terminals found five things. Usage
polling moves out of the terminals into the board, so the endpoint stops
answering 429 and the timeline stops repeating it. Every rung of a ladder can
now name a model from a catalog Leg reads off the installed CLIs, and the new
card form is rebuilt around that. The board holds still under a reader with a
row expanded. The floor is a page you can start work from. And a page whose
files are newer than the process serving them says so.

- **One usage poll per login, in the board.** Every claude terminal used to
  ask Claude's usage endpoint once a minute on its own; three terminals plus
  Claude Code's own polling meant a 429 every other minute, and the terminal's
  timeline logged `claude usage unavailable: usage endpoint 429: {...}` each
  time the answer flipped. The board process now polls each login once per
  `LEG_USAGE_POLL_MS` (60s), backs off to ten minutes on any refusal and snaps
  back on the first good answer, and writes the two windows onto every active
  session of that login. A refusal is recorded once on the usage record
  (`error`, `error_since`, owner only) with one status line, `claude usage
  unavailable since 9:03 AM: usage endpoint 429: rate_limit_error`, and one
  `claude usage is back`; it never erases the measured buckets. Terminals
  poll nothing, so a terminal started before this release keeps its old
  minute-by-minute poll until it is restarted.
- **A model catalog, read from the CLIs you have.** `GET /api/models` lists
  what each provider can run today: claude's aliases (fable, opus, sonnet,
  haiku); codex's `models_cache.json` entries with `visibility: list` plus the
  default from `config.toml` (gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra,
  gpt-5.6-luna, gpt-5.5 on the machine this shipped from); `agy models` and
  `grok models`, each run at most once an hour behind the answer and cached
  under `<LEG_HOME>/models/`. A rung's model is validated by shape for every
  provider and by membership for claude only, so next month's codex model is
  not refused and a saved ladder is never silently reset to the default.
- **The new card form, rebuilt.** Task first, then the repository as a picker
  of known repos or a typed path, the branch to cut from, and **Who runs it**:
  one row per rung with provider, model, permissions, ask before start and max
  turns, reorderable, prefilled from your ladder, with **Save as my default
  ladder** writing it back to Settings. Advanced holds the workflow, scripted
  first agent, leases, merge method, test command and title. The dialog posts
  its chain as one object per rung, so `claude/fable` then `claude/opus` is
  finally two legs and not one. Two columns at 900px, one below; it scrolls on
  a short window instead of hiding Create card below the fold.
- **The one-line entry row is never empty.** It derives its rungs from
  `handoff_order` when a preferences file predates ladders, the ladder noun
  opens both the rung and the model selects, and with only metered providers
  and spending off it says so instead of "no agent is configured".
- **The board holds still.** With a row expanded, a text selection live, the
  pointer on a row or focus in the list, the needs-you re-sort is computed but
  not drawn until you come out (hover and focus release after 30s on their
  own). The expansion is never detached from the document, so its selection,
  scroll offsets and open confirm row survive every 3-second poll; the
  region's top is anchored against rows above it changing height; the
  timeline appends new lines above you without moving what you read, and a
  status line repeated word for word within a minute folds into one with
  `×N`. `scripts/board-jump-probe.mjs` is the regression harness: it printed a
  205px drift on 0.12.0 and 0px now.
- **The floor is a page you start work from.** The four login panels move
  behind the same **Capacity and models** disclosure as on the board, under
  the same one-line strip; the **Run in the background** entry sits under it
  and posts exactly what the board's does; Running, Waiting on you, Queued,
  Backlog and Done today are Background-style rows with counts in their
  headings, a queued row says its position and what it waits for, and j/k and
  Enter work as on the board. `More settings` carries the typed task to the
  board's dialog through `/#new-card=`. The strip and the entry row live once,
  in `src/board/strip.js` and `src/board/entry.js`, loaded by both pages.
- **A page newer than its process says so.** `/api/health` answers with the
  process version; the page files carry theirs. When they differ the board and
  the floor print `This board process runs leg 0.10.0 and the page files are
  0.13.0. Restart it to match: leg down && leg up`, which is the state a board
  left running across an `npm i -g` lands in, and the state that hid every
  0.12.0 feature on the first morning.

## 0.12.0 (2026-09-17)

The board is rebuilt around the two questions you actually open it to answer:
which terminal needs you, and which model is about to run out. Usage stops
being a region and becomes one strip plus a property of every row; a hand-off
can now change the model instead of the CLI; and background work comes back as
rows you can read at a glance instead of a ledger you have to dig through.

- **The board top: a capacity strip, and the login panels behind one
  disclosure.** Under the verdict, one strip prints each login's *binding*
  bucket rather than whichever window happened to be stored: `claude 63%
  6:01 PM`, `codex back Sat 10:11 PM`, `agy no figure`, `grok no reading`. The
  four login panels are not rewritten, they move intact behind **Capacity and
  models** with every gauge, notch and `aria-valuetext` they had, and the
  claude panel head grows a model rail whose chips read `fable 63%` and
  `opus 12%`. Every branch of `verdictLines()` is now asserted under
  `VERDICT_CH` by `test/board-verdict.test.mjs`, so a 52px headline can no
  longer wrap to three lines. Measured on the seeded board at 1280: the first
  terminal row sits at 536px, where it used to sit at 1382px.
- **A terminal row says what it is doing, on which model.** The register reads
  `waiting on you  baton on main  dirty 3  ahead 2  claude/fable`, and a quiet
  agent carries `quiet 5m`. `ahead` is one `git rev-list --count` on the
  existing poll; the model is the alias the leg resolved to, updated from the
  transcript for claude so a silent fallback off Fable becomes visible, and
  never a guessed default. Under the prompt the row prints its binding bucket,
  `63% of the fable week`, and past the warn threshold the rung that would keep
  the terminal.
- **A terminal waiting on a human says so, everywhere.** Leg now wires Claude
  Code's `Notification` hook (`permission_prompt`, `idle_prompt`,
  `agent_needs_input`). The row's status word becomes `waiting on you` and it
  carries the question verbatim: `waiting on you: permission to run Bash(git
  push origin HEAD), asked 2m ago`. That sorts the row first, counts it in the
  region head (`4 running, 2 waiting on you, 4 share the claude login`) and in
  the tab, which becomes `(2) Leg` with a dotted favicon. Codex, agy and grok
  publish no such signal, so their rows say `quiet Nm` and never claim to be
  waiting. `permission_prompt` fires after about six seconds and mostly when
  you look away, so this is a reliable notice, not an instant one.
- **A hand-off can now change the model, not just the CLI.** Destinations are
  rungs of `(agent, account, model)`. The ladder's default is `claude/fable`,
  `claude/opus`, `claude/sonnet`, then each remaining installed agent, and a
  terminal's expansion prints it: `now: claude / fable, then claude / opus,
  then claude / sonnet, then codex, then agy` with `first eligible now:
  claude / opus` under it. A claude downshift with a known session id starts
  `claude --resume <id> --model <alias>` and skips the bundle, so the
  conversation survives the switch; every other rung is primed from the bundle
  as before. `leg ladder` prints and edits the same thing from a terminal
  (`ls`, `set <n> <agent>[/<account>[/<model>]]`, `rm <n>`, `spend on|off`),
  and `leg sessions handoff <id> --to claude/default/opus` names a rung.
- **The wall is attributed to what it actually walled.** A Fable limit walls
  Fable, not the login: `walls{}` is keyed by model and `limited_until` is left
  alone, so `claude/sonnet` keeps working. A session, weekly or spend limit is
  account scoped, and a same-login model rung is then refused as a wasted
  switch with the reason on the row. Wording Leg cannot parse walls the whole
  login and prints the evidence it failed on rather than guessing.
- **Nothing spends money unless you said it could.** `may_spend` is off. An
  automatic hand-off skips any rung that bills credits or a metered balance and
  writes the reason to the ledger; the Settings sentence is *A rung that spends
  usage credits or metered balance may be taken by an automatic hand-off*, and
  today it adds *Usage credits are off, so there is nothing to spend through
  the wall.* rather than offering a dead control. A `reserve` per login holds a
  floor back from automatic hand-offs only: *An automatic hand-off skips a rung
  past the floor; a hand-off you press yourself still takes it, and the picker
  says so.* Climbing back is a radio with the rule printed under it: *Leg never
  interrupts a running turn to climb.*
- **Cards are terminals you are not sitting at.** Live cards are rows in a
  **Background** panel directly under Terminals, in the terminal row's
  register with a measured work stat and the same button grid; a running card
  says `no message until this leg ends, started 8:15 PM`, because `-p
  --output-format json` is mute until the leg exits. Finished cards fall into
  one ledger line, `10 finished cards, 5 done, 5 failed, last 8:15 PM`, so ten
  done cards are one row and not ten. Starting one is a single field,
  `Run in the background:`, over an inferred sentence whose nouns are buttons
  (*in recruiting-tool on main, with claude/fable then claude/opus then
  claude/sonnet then codex then agy, build only*); the old thirteen-field
  dialog is still there as **More settings**.
- **Two verbs for leaving and coming back.** The End confirm row grows
  **End, and keep going as a card**: it writes the bundle, hands the
  terminal's own worktree to a card with its lineage, and says where the work
  went. On a card, **Take over** pauses it and hands back the one command a
  browser cannot run, `leg claude --resume-card <id>`, in an interactive
  terminal primed from the card's bundle.
- **A time figure, or nothing, and never a time without its sample count.**
  `burn()` reads a per-bucket history ring and prints a rate only with at least
  three samples spanning ten minutes inside the current window; the estimate is
  the endpoint slope, capped at the reset, and a flat or falling line prints
  nothing at all. Where it can speak, the row and the verdict say *about 2h 40m
  of Fable left, from 9 samples over 4h*. A reading that comes back unchanged
  more than ten minutes after the last sample is still recorded, so a flat hour
  is a measured zero rather than a starved gate.

Fixes:

- **Fixed: the only live Claude wall Leg ever captured was classified as no
  progress.** The fixture pattern matched `You've hit your Fable limit` and
  Anthropic now writes `You've reached your Fable limit`, so a real wall on the
  headless path scored `{outcome: "no_progress", signal: "none"}` and the
  terminal sat on a dead login. The pattern takes both wordings, and
  `fixtures/limits/claude/claude-fable-limit.json` is a new `observed-live`
  fixture produced from the captured response rather than from the docs.
- **Fixed: the board printed the wrong percentage for a claude login.** The tap
  kept only `five_hour` and `seven_day` out of the usage response and threw the
  rest away, so a login whose binding bucket was the Fable week was reported at
  the account-wide figure. The whole `limits[]` array is now read into
  `buckets[]`, and the strip, the verdict and the row all print the bucket that
  will actually stop you.
- **Fixed: a seeded board's rows were live controls on real repositories.**
  `scripts/seed-wes-board.mjs` named real paths, and a click on a seeded row
  cut a worktree in a real checkout. The seed now names `C:\Projects-seed\...`,
  realistic in shape and impossible in fact. `docs/ERRORS.md` carries the
  entry.

Migration:

- `preferences.json` keeps `handoff_order` and now derives it from the ladder,
  so `validHandoffOrder`, `requireHandoffOrder` and every older terminal keep
  working unchanged. It gains `handoff_ladder` (rungs of `{agent, account,
  model, when, cost}`), `may_spend` (default `false`), `climb_back` (default
  `next-handoff`, or `never`), `reserve` (`{agent: percent}`),
  `notify_terminal` (default `true`) and `notify_board` (default `false`). A
  bare `handoff_order` expands into one `model: null, when: always` rung per
  agent, so behaviour is unchanged until you edit a rung.
- Usage records under `$LEG_HOME/usage/` gain `buckets`, `walls`, `history`,
  `extra_usage` and `facts`. An older Leg ignores them; a record without them
  falls back to the two windows it has always had.
- Session records gain `model`, `waiting` and `ahead`, all nullable. On a
  shared board all three are dropped from someone else's row (`waiting` carries
  the verbatim question, `model` and `ahead` describe this machine's usage and
  someone else's work). Your own terminal is never redacted, so you keep all
  three on it whichever role you hold.
- `playwright` is a dev dependency now, so `scripts/board-shots.mjs` runs from
  a fresh `npm install`. It is not shipped in the package.

Still assumed, and marked as such:

- Whether `codex resume <id> -m <model>` composes. The `resume` subcommand and
  the `-m` flag are each verified from `codex --help`; putting them together is
  not. A codex rung therefore ships primed from the bundle, and only the claude
  rungs claim to keep the conversation.
- Whether codex, agy and grok leave an OSC 2 terminal title alone once the
  child starts drawing. That is why naming the terminal tab is not in this
  release: the browser tab badge needs no such assumption, and ships.

## 0.11.0 (2026-09-17)

- **grok is a card adapter, not just a terminal.** `--chain grok` works. Its
  flags were read from `grok --help` on grok 1.0.34 (`3736acbc8658`) and its
  result envelope out of the shipped binary, both on 2026-09-17, replacing the
  guessed field names the unregistered adapter carried. The prompt now travels
  by `--prompt-file` (a hand-off prompt carries the whole bundle summary, and
  Windows caps a command line near 32k) and `--cwd` is passed explicitly,
  because grok can run against a shared leader process and a leg must edit its
  own worktree. The probe reached the account and came back with a real wall.
- **A grok terminal at the wall now hands off.** An exhausted Grok Build
  account answers `402 Payment Required: Grok Build usage balance exhausted`,
  and none of the rate-limit strings the tap looked for appear in it. The
  terminal sat on a dead login instead of moving on. Both the tap
  (`src/taps/grok.mjs`) and the leg classifier (a new observed-live fixture)
  now read it as a limit. Found by running the probe against an exhausted
  account on 2026-09-17.
- **Any CLI can be a card agent, from a JSON spec and no code.** `leg adapter
  template --name muse > muse.json`, `leg adapter add muse.json`, then
  `--chain muse,claude`. `leg adapter check muse` prints the exact command line
  a leg would run before one does; `leg adapter list|show|rm` are the rest.
  Placeholders (`{{prompt}}`, `{{promptFile}}`, `{{cwd}}`, `{{mode}}`,
  `{{model}}`, `{{resume}}`, `{{maxTurns}}`, `{{runDir}}`) fill the argv, and a
  group in the args is dropped whole when a placeholder inside it is unset, so
  an absent model never leaves a bare `--model`. The flags that turn a
  supervised agent into an unsupervised one are refused whatever a spec says.
  A broken spec is reported by name and reason, never thrown, so one typo
  cannot stop the board. See [docs/adapters.md](docs/adapters.md#custom-adapters).
- **Hand off now can name its destination.** The button still takes the next
  option in the order; Details → **Hand off now to** lists every destination
  with the reason a greyed one cannot be picked, and `leg sessions handoff
  <id> --to codex` is the same choice from a terminal. A destination that is
  not on the chain, not installed, or at its wall is refused at the click with
  the reset time. If the one you picked walls between the click and the
  hand-off, the work continues down the order and the terminal says which
  agent took it instead, rather than going somewhere else in silence.
- **TLS for a shared board.** `leg share on --tls-cert <file> --tls-key <file>`,
  or `LEG_TLS_CERT` / `LEG_TLS_KEY`. Leg issues no certificate: a self-signed
  pair teaches everyone to click through a warning, which is worse than
  plaintext on a network that is already private, so it takes a pair you have
  (`tailscale cert <machine>.<tailnet>.ts.net` is one command). Half a pair, a
  missing file or an empty one stops the board with exit 3 rather than quietly
  serving plaintext. The loopback companion stays http, because the certificate
  is for the shared name and that traffic never leaves the machine.
- **An `operator` role, between owner and guest.** An operator runs the
  pipeline board — adds, runs, approves, reassigns and kills cards — and their
  own terminals, and sees nothing that describes this machine: no settings, no
  home path, no repository paths, no conversation index, no audit. `leg share
  add dana --role operator`. What each role may reach is decided in one place
  (`mayUseCards` / `mayUseMachine` in `src/share.mjs`) instead of per endpoint.
- **An audit trail: who did what, across every terminal and every card.**
  Settings → **Audit trail** on the board, `GET /api/audit` for a script, owner
  only. Hand-offs, landings, approvals, reassignments and kills, newest first,
  each with the person or agent that did it. It reads what the ledger already
  recorded and stores nothing new, and every answer carries how much it read
  (`14 terminals and 3 cards, 812 events read`) so an empty trail cannot be
  mistaken for a quiet week.
- **Fixed: a guest's own terminal leaked the owner's reset times.** The new
  hand-off destination list carried the exact reset timestamp of every
  account, and a guest owns their own terminal, so it reached them through it.
  A guest and an operator now get the destinations and the coarse reason
  (`at its usage limit`) without the timestamp. Caught by the share-security
  suite in the same change.
- **Fixed: the board slowed down as soon as a custom adapter existed.**
  `/api/health` asks every adapter where its binary is, and reading the spec
  directory on each of those calls put a readdir, a read and a JSON parse per
  spec on the event loop the terminals lane is pushed from. The parsed list is
  now cached against the directory's entries with a one-second floor, so a
  spec added or removed is still seen at once.

## 0.10.0 (2026-09-17)

- **The board is responsive again, `leg` starts straight away, and the board
  opens every time.** One running terminal was enough to saturate the board
  server: it rewrites its record every few seconds and takes a control lock
  about once a second, and the watcher over the sessions directory rebuilt the
  whole terminals view — over a second of `git` — for every one of those
  touches, including the lock files and the temp files atomic writes leave
  behind. The server spent all its time in that loop, so it answered a
  stylesheet in fourteen seconds and `/api/health` in seven. Four consequences,
  all fixed:
  - The watcher now drops locks and temp files by name, and checks the rest
    against a stat fingerprint of the files the view is actually built from,
    because a lock taken inside a session directory changes that directory's
    own mtime and arrives as an event naming nothing else. What survives is
    floored to one rebuild per interval. `canLand` is cached per record
    revision with staggered expiries, so twenty worktrees are never re-read in
    one pass. The terminals view went from 2,000 ms to 115 ms; on a board with
    66 sessions `/api/health` went from 14.2 s to 2.4 ms and `/board.css` from
    14.2 s to 1.5 ms.
  - `leg claude` treated a board too busy to answer a health probe as no board
    at all, spawned a second server that could only die of `EADDRINUSE`, then
    polled the dead child for fifteen seconds. A listener on the port is now a
    board: `leg` attaches to it.
  - The board is opened whether or not this terminal is the one that started
    it. Previously the browser was only opened on the path that spawned the
    server, so with a board already running nothing ever opened.
  - One push rebuilt the terminals grid three times (two listeners registered
    for `leg:sessions` and one for the legacy alias, with the payload parsed
    twice per push and one dispatch outside the staleness guard). Every button
    was destroyed and recreated several times a second. One push now rebuilds
    once, and an open confirm row is left alone until it is answered.

- **Remove, Remove record, End and Land work.** Confirming any of them did
  nothing at all. `confirmRow` clears `pendingConfirm` and then calls its
  callback, and the callback read `pendingConfirm.action` — off the variable it
  had just cleared. Every Yes on the Terminals panel threw
  `TypeError: Cannot read properties of null (reading 'action')` into the
  console and never reached the request. The callback now closes over a
  snapshot taken before the row is built.

- **Every conversation on this machine (`leg history`, `leg worktrees`, the
  board's Conversations cell).** One read-only index over the conversations
  Claude Code, Codex, Grok, Antigravity and Copilot CLI keep in their own
  stores, plus Leg's own sessions, deduplicated (a session Leg started and
  the same conversation in the agent's store are one row, marked `leg`; the
  rest are `external`). List, filter by agent, repository or text, open one
  (its last messages, read from the tail of the transcript only when asked),
  and `leg history continue <id>` to start a supervised leg on it where the
  installed CLI documents resume-by-id (claude, codex, grok, agy; copilot
  lists and reads but is not an agent Leg runs). Nothing in an agent's store
  is moved or written; Leg writes only `~/.leg/history/index.json`, refreshed
  incrementally by size and mtime, and never opens a SQLite file. Every
  checkout Leg can see, git's and its own and the ones conversations ran in,
  with owner, uncommitted count, orphaned, stale and missing verdicts, read
  only. On a shared board the whole group is the owner's. Redaction learned
  the shapes another agent's transcript carries (Stripe, Google, xAI, npm,
  GitLab, Hugging Face keys, JWTs, private-key blocks, basic auth, URL
  credentials, `password=`), and the board token joined the values it strips.
  Support matrix and every file read: docs/history.md.
- **History, after its review.** The board's Conversations cell pages past
  150 rows (the total no longer shrank with each cursor page); the board
  refreshes a stale index in a child process instead of its own event loop;
  a cwd on an unreachable network share no longer stalls a refresh; an
  Antigravity retitle or a touched presence lock is seen by an incremental
  refresh, and only that conversation is re-read; an older Leg session id
  still opens the conversation it was one leg of; `leg history` prints a
  failed refresh whatever the last index still lists, `refresh` fails cleanly
  when another Leg holds the lock, `--limit 0` is a usage error (`--all`),
  `--offset` works, a Leg-only row's id prints whole; a malformed id on
  `/api/history/<id>` is a 400; an account name that is a path is ignored;
  titles are cut to 200 as documented and go through the held-value
  redaction too; the Copilot chip has a colour. Redaction no longer eats
  `Basic authentication/authorization`, `cache_key = ...` or
  `refresh_token: string`, and a value never crosses a line break.

## 0.9.0 (2026-09-16)

- **The portable harness (`leg harness`), off by default.** A hand-off can now
  carry the working environment with the task: the source agent's global rules
  (imports inlined), identity, hooks, skills, subagents, slash commands, MCP
  servers and permissions, rendered into the destination client's own files as
  far as it can represent them, with every dropped item explained.
  `leg harness enable` detects clients, captures, shows the plan and writes
  only after consent; `status`, `inspect`, `check`, `explain`, `diff`,
  `history` and `doctor` are read-only; `sync`, `capture`, `source`, `policy`
  and `disable` are the writes. Policies `warn`, `sync` and `strict` decide
  what an unattended hand-off may do; strict refuses a destination it cannot
  make safe and tries the next option. Every written file carries
  `GENERATED by Leg harness`, lives in a marked region or owned key inside
  files you also own, is backed up before an overwrite and skipped when
  hand-edited. Credentials never move (`${NAME}` references). The session
  record, its timeline (`harness`, `harness_blocked`), the card ledger and the
  board (a chip on the row, a **Harness** section in the drawer) show what
  transferred. Source changes are fingerprinted so an unchanged environment
  costs a few stat calls at a hand-off. Docs: `docs/harness.md`.
- **Engine.** The capture, bundle and apply engine is the Agnostic AI port
  engine (MIT), vendored byte for byte under `src/harness/vendor/agnostic-ai/`
  with its upstream commit and per-file hashes pinned; `npm test` refuses a
  local edit. Attribution in `NOTICE`.
- **Existing installs are unchanged.** No client file is touched until
  `leg harness enable`; `preferences.json` gains a `harness` key that reads as
  off when absent.

## 0.8.1 (2026-09-16)

- **Antigravity CLI (`agy`) workspace trust in worktrees and repos.** Leg writes
  the folder trust record to `~/.gemini/antigravity-cli/settings.json`'s
  `trustedWorkspaces` for both the repo root and the worktree directory, with
  exact Windows drive and separator normalization matching Go's `runtime.memequal`
  check so `leg agy` runs completely unattended without interactive trust prompts.
- **Board server resolution in worktrees.** Fixed board asset resolution when
  Leg is executed from within a git worktree.

## 0.8.0 (2026-09-16)

- **The product is called Leg.** Website, CLI help, board logs and onboarding
  copy say **Leg**; the command is `leg`; `legcli.com` is the domain, not the
  product name. `leg up` prefixes lines with `[leg]`. Historical changelog
  entries keep the previous name.
- **Grok is a supervised and handoff agent.** `leg grok` starts Grok the same
  way `leg claude`, `leg codex` and `leg agy` start those agents: board
  alongside, usage tracking, and a live context handoff bundle. At the limit
  the next agent continues in the same terminal.
- **Auto-approve is on by default** for new sessions. Leg injects each agent's
  fully-permissive flag at spawn (`--dangerously-skip-permissions` for Claude
  and agy, `--ask-for-approval never` for Codex, `--always-approve` for Grok).
  Opt out with `--no-auto-approve`, `LEG_AUTO_APPROVE=0` /
  `LEG_NO_AUTO_APPROVE=1`, or `"auto_approve": false` in `preferences.json`.
- **`leg-agents` is the unscoped alias installer.** It pins the same version of
  `@ucsandman/legcli` and exposes the same `leg` binary. CI publishes both
  packages together; `npm test` fails if their versions drift.

## 0.7.0 (2026-09-15)

- **Rebranded to Leg.** Package is now `legcli` on npm, binary command is `leg`,
  and site domain is `https://legcli.com`.
- **Clean break on the binary:** The `baton` CLI binary is removed; use `leg`.
- **State migration and fallback:** Leg stores its state in `~/.leg` (or
  repo-local `.leg/`), and reads from `~/.baton` (or `.baton/`) as fallback.
  Environment variables now use the `LEG_` prefix (`LEG_PUBLIC_KEY_B64`,
  `LEG_TRUST`, `LEG_SITE`, `LEG_CHB_BIN`, `LEG_SYNC_DASHCLAW`) with automatic
  fallback to `BATON_*`.
- **License keys:** Newly issued licenses carry the `LEG-` prefix. The CLI
  accepts both `LEG-` and legacy `BATON-` keys indefinitely. Activations normalize
  and store the `LEG-` form.

## 0.6.1 (2026-09-15)

- **The documentation is on the web.** The repository is private and stays
  private, which meant every "read the source", README, FAQ and changelog link
  on the site and in the package pointed at a 404 for anyone who is not the
  owner — the first click a stranger makes. `npm run docs` renders the public
  subset of `docs/` plus the README and this changelog to static pages under
  `/docs`, committed to the repo because Vercel serves `site/` with no build
  step. CI regenerates them and fails if the committed output has drifted.
  Working files (DECISIONS, DEVIATIONS, ERRORS, REUSE, ROADMAP-v2, DEMO) stay
  out.
- **Nothing dangles at a 404.** The clone instructions in the README and
  getting-started are replaced by where the source actually is for a buyer:
  `$(npm root -g)/baton-agents/src`, plain `.mjs`, nothing bundled. Links to
  files with a public home go there; links to files that only ship inside the
  package point at the package. The README's images are now absolute URLs,
  because npm rewrites relative image paths to `raw.githubusercontent.com`,
  which 404s for a private repository — the hero image on the npm page had been
  broken.
- **A support page**, at `/support`: one address, the refund terms, license-key
  troubleshooting, what to put in a bug report, and the security reporting path.
  A private repository has no issue tracker to point at, so this is the whole
  path. `SECURITY.md` said only `0.1.x` was supported, four minor versions late,
  and pointed at a GitHub advisory form strangers cannot reach.
- **The claims check themselves.** `fixtures/verified.json` pins the verified
  CLI versions, the verification date and the test count. `npm test` now asserts
  every public surface agrees with it, and a weekly job
  (`npm run claims:drift`) compares the pins against what those CLIs publish
  now, because "verified against Claude Code 2.1.268" quietly stops being true.
  On its first run it found `llms.txt` claiming 463 tests and the landing page
  claiming 406 while the suite reported 454, and that all three pinned CLIs had
  already moved.
- **The handoff is on film.** The landing page carries the 53-second recording
  of a real run — claude's five-hour gauge reaching 100 percent, the headline
  turning to *at the wall*, the terminal continuing on codex — and the README
  leads with a GIF of the same moment. `preload="none"`, so the page weight is
  unchanged until someone presses play.
- **macOS is in CI.** The matrix was Ubuntu and Windows only.
- Removed a stray `hello-fake.txt` that a fake-agent run had committed to the
  repository root.

## 0.6.0 (2026-09-15)

- **Removed: the 14-day trial.** Baton is bought up front, and the risk
  reversal is a **30-day money-back guarantee** instead. A trial suits a product
  used daily by habit; Baton's value is bursty — it pays off in the one moment a
  limit lands mid-flow, which a fortnight of evaluation does not reliably
  contain, and a fortnight in which it never fires reads as "meh". The buyer is
  already paying for two or three agent subscriptions, so at $79 they are not
  price-sensitive, they are trust-sensitive, and a trial does not answer trust.
  `trial.json`, `TRIAL_DAYS` and the trial branch in `entitlement()` are gone;
  `baton <agent>` without a key exits 4 and names the buy URL and the guarantee.
- **Fixed: the card row was never ported to the dark product surface.** `.r1`
  through `.r4` — the card row's whole four-column layout — carried no rule in
  `board.css`, so Background tasks rendered on browser defaults while every
  other row had been redesigned. `.row-title` never reset the native button
  either, which put the board's near-white text on the user agent's light-grey
  fill and made the card title unreadable.
- **Fixed: a finished card named the wrong agent.** `summarize()` read its
  adapter off `chain[card.leg]`, which is reset when a station ends, so a card
  that handed off from one agent to the next and finished reported the agent
  that *started* the work. A finished card also showed `--:--` where its run
  time belongs, and now shows how long it took.
- **Fixed: the settings panel asked for a token no one could need.** On a
  loopback board with share off, `src/auth.mjs` lets the request in with no
  token at all, so the API token field is no longer drawn there. It comes back
  for a token already stored, for a guest, for an off-loopback bind, and
  whenever health has not answered. No message names an address the server did
  not give: a refused or redacted health call used to print `127.0.0.1:4747` at
  someone looking at a different machine, and the owner of a shared board was
  told their requests were "unauthenticated" when auth had recognised them.
- **Fixed: three places set a flat `.chip` against other text with no gap**
  (`claudeclaude-2fbf`, `Files2 changed`, `10:40 AMstarted`), the floor printed
  `blocked by blocked by card "X"`, and it showed the raw key `needs_approval`
  where the board says `needs approval`.
- All nineteen screenshots in `docs/screenshots/` retaken against the current
  build. `scripts/seed-wes-board.mjs` and the new
  `scripts/seed-floor-board.mjs` produce the fixtures they need.
- The landing page shows a real handoff and the real board, not only
  recreations, and says what a second agent gets without assuming the reader
  knows git worktrees.

## 0.5.1 (2026-09-15)

- **Fixed: "All the terminal is on claude".** The verdict's plural sentence is
  about everything riding on one login, and with a single terminal there is no
  "all" to make. One terminal now reads `Your terminal is on claude, and claude
  has 1% left.` Caught by rendering the real board rather than the seeded one.
- The tab mark is grey, not the accent blue, and the board and the site carry
  the same mark. The site favicon had spent the one colour that means "this is
  the action to take" on a browser tab, and the board carried a third, older
  mark from before the identity colours settled.
- **Fixed: a merge to `main` did not deploy the site.**
  `ignoreCommand: git diff --quiet HEAD^ HEAD .` asks whether the single most
  recent commit touched `site/`. A push is not a commit: five commits landed
  with `site/` changed in the first, so Vercel cancelled the build and reported
  it as a green tick. Removed; every push to `main` deploys.

## 0.5.0 (2026-09-15)

- **The board is a dark product surface, and the largest thing on it is a
  sentence.** The instrument that shipped through 0.4.3 was built against a
  brief in `DESIGN.md` reading "exact, unhurried, mechanical, the printed
  operator's manual for a piece of test equipment": a saturated navy ground,
  hairline rules as the only structure, 2px radii, no elevation, and a monospace
  face for prose. Six rounds were built against it and all six were rejected.
  The brief, not the execution, was the defect, and it has been rewritten. What
  ships instead:
  - The board opens with the finding, not the data: "All 4 terminals are on
    claude, and claude has 5% left", at 52px, written from the live view. Under
    it sits the age of the reading and which direction it is wrong in — "Measured
    2h 13m ago. 4 terminals have been running since, so the real figure is higher
    than 95 percent, never lower." A reading taken two hours ago is a floor, and
    saying so is the whole reason to print its age.
  - Size encodes importance. The login carrying the terminals gets a wide panel
    lit from above with both of its gauges; a login with one fact to report gets
    a half panel; a login that publishes no figure draws no instrument at all,
    because an empty track reads as a measurement of zero. Previously every login
    got an identical row, so the layout said nothing before you read it.
  - A terminal is a row inside one panel, not a card of its own: state, where,
    the prompt, elapsed, and its buttons in a fixed 2x2 grid so every row's
    controls sit in the same place. Land is the primary action only when it can
    actually run; when it is blocked the accent goes to Hand off now, because a
    disabled control should not wear the one accent colour in the design.
  - Finished terminals, what landed on trunk and background tasks leave the live
    area entirely and become three counts on the ground that open on click. On a
    real board after a day's work those were most of the list and they buried the
    one or two terminals that were live.
  - A fact true of every terminal is said once, at the region, instead of once
    per row. The per-row copy stays in the DOM, visually hidden, so each Land
    button's `aria-describedby` still resolves to its own reason.
  - Ground `#0E1012` neutral near-black, panels raised with a 1px top highlight
    and a shadow beneath, 16px radii, type from 13 to 52px (it ran 13 to 21,
    which is why it read as a spreadsheet), one accent blue spent on the primary
    action and nowhere else, and severity painted inside a gauge track rather
    than used as the colour of a word.
  - Measured against a board shaped like a real one — mostly `lost` and `ended`
    terminals with long absolute paths — the page went from 3,302px to 2,107px at
    1280 and from 6,530px to 3,937px at 400, with terminal rows from 180-277px
    down to 135-165px.
- **Prompts, file lists and the trunk log stop printing machine noise.** A pasted
  screenshot arrived in the prompt as an `<image name=... path=...>` tag carrying
  an absolute temp path with the operator's home directory in it, and printed as
  two lines of noise in front of the sentence; it now reads `(image)` and the
  text. A touched file prints its basename, not 90 characters of temp path. The
  trunk log shows what landed as a count that opens, instead of eighteen rows of
  `git log` at the same visual weight as the live terminals.
- **The marketing site runs on the board's own hex values.** `site/` was a light
  page recreating the board in a different palette, from the card anatomy the
  board stopped having two commits earlier. Both recreations are rebuilt against
  what the board actually renders now, the page is on the same ramp as the
  product, emphasis between folds is elevation rather than a slab of hue, and the
  brand mark, favicon and OG card follow. `llms.txt` and every "card" in the copy
  corrected. A marketing page that recreates the product in a different palette
  is a picture of a different product.
- `DESIGN.md` rewritten to describe what ships, opening with what it replaced and
  why it must not come back, and covering both surfaces from one set of tokens.
- `README.md` and its screenshot recaptured against the board that now exists.

- **A resume pointer that cannot describe a picture that is no longer true.**
  `.baton/RESUME.md` used to be an unowned convenience copy: written once per
  hand-off, never touched again, with no stamp and no expiry, so a terminal that
  exited normally left hours old text sitting there looking live. Four changes,
  in `src/resume.mjs`:
  - Every resume file Baton writes carries a stamp (an HTML comment, invisible
    in rendered markdown) of the commit, branch, working-tree fingerprint and
    live terminals it was written against. The fingerprint is a count and a
    12-character hash of the sorted paths, never the file names, so a shared
    board cannot leak what someone is working on.
  - Baton owns `RESUME.md`. A session ending rewrites it to "nothing in flight",
    naming the last hand-off, its date and where its full text still lives; the
    board rewrites it at start for any checkout whose pointer describes a
    terminal that is gone, or that no Baton stamped. A terminal that is still
    running keeps its own hand-off text.
  - `baton resume [--check] [--json] [--path <dir>]` recomputes freshness from
    git at read time and never from the file: exit 0 current, 1 stale or
    unstamped, 3 no pointer in this checkout. Stale still prints the body behind
    a loud banner, because a stale hand-off beats nothing when a human chooses
    to read it; the exit code is what scripts and hooks key on.
  - The terminal drawer's "What happens next" section carries the same verdict,
    recomputed on every poll.
- **The terminal drawer reads newest first.** The conversation and the timeline
  both put the last thing that happened at the top, so the drawer can be left
  open beside the work without scrolling to find the current state.
- **Fixed: a scrolled box in the drawer snapped back to the top every three
  seconds.** The panel is rebuilt on every poll so relative timestamps stay
  honest, which threw away where the reader had scrolled inside the task box, a
  message or the timeline. Every scrollable box now carries a stable key and its
  offset is carried across the rebuild.

## 0.4.3 (2026-09-14)

- **Choose terminal handoff order.** Settings stores the priority order copied
  by new terminals, and each newly attached terminal can change its own order
  while it is running. The order is absolute, not a rotation anchored on the
  agent running now: an agent moved to the bottom (agy, say) is the last option
  from every starting agent instead of jumping to the front of the list for the
  agents above it. The card shows Now, the exact fallback candidates, the
  preferred next option, and the first currently eligible option. Missing CLIs,
  usage walls, same-agent account fallback, all-out waiting, owner controls,
  and normal-exit behavior are unchanged. Older terminals say that a restart
  is required and can save the next-launch default.
- **See what a terminal is doing.** **Details** on a terminal card (or a click
  on its prompt) opens a drawer: the agent's last turn, the prompt the terminal
  started from, its last eight messages, every file it changed with the line
  counts and a diff per file, the event timeline, and the handoff order that
  comes next. It refreshes every three seconds while open and pauses with the
  tab or the button. Transcripts and diffs are scrubbed for secrets before they
  leave the machine, and a terminal that belongs to another human on a shared
  board stays refused.
- **The terminal is left the way the agent found it.** An agent killed by End,
  Hand off now or the usage limit never runs its own cleanup, so its terminal
  modes outlived it: the mouse wheel printed raw mouse reports into the shell
  after the session ended, and a leftover scrolling region made the next leg's
  output land on top of the lines already on screen. The restore now turns off
  every mouse reporting mode, bracketed paste and focus events, puts cursor
  keys, the keypad and autowrap back, resets the scrolling region without
  moving the cursor, and clears only the dead agent's half-drawn frame.
- **Clearer background cards.** The New background card form leads with repo,
  task, and a real first agent; explains its separate worktree and Run now
  versus draft; and puts workflow, fallback, permissions, approvals, limits,
  leases, landing, tests, titles, and labeled test/demo adapters under Advanced
  options. Build only explicitly says it does not merge, while workflows with
  an automatic merge say so in their labels.

## 0.4.2 (2026-09-14)

- **Automatic npm publication.** A successful push to `main` now waits for the
  complete Ubuntu and Windows CI matrix, validates package and lock metadata,
  and publishes only when the exact version is missing and newer than npm's
  stable `latest`. It uses npm trusted publishing with OIDC and no repository
  token secret; stale versions and registry errors fail closed.

## 0.4.1 (2026-09-14)

- **Codex quota and account display.** Codex usage now comes from the read-only
  app-server `account/rateLimits/read` response, polled every 60 seconds by the
  board and active attach. Returned 300- and 10080-minute windows map to 5h
  and 7d; an explicit backend available answer clears an old wall. The board
  says `<n>% used` and labels stale readings instead of implying current data.
- **Session and landing safety.** The board offers **Remove record** with a
  confirmation that preserves an own worktree, branch, unmerged commits, and
  dirty files. Normal removal remains a safe prune. Concurrent End and Hand off
  use the session file lock; landing rejects the wrong base branch, proves a
  merged branch before pruning, reruns tests after a retry rebase, and recovers
  orphaned `handing_off` cards.
- **Board freshness and roles.** Switching from a guest token back to an owner
  restores pipeline controls without a reload; guest tokens still reconnect the
  terminal stream. Card-list, drawer, log, Floor, and SSE responses now reject
  stale asynchronous completions.
- **Loopback board authorization.** Tokenless owner access now requires both a
  loopback peer and a loopback `Host`, preventing DNS-rebound hostnames from
  inheriting owner access to read and state-changing API routes.
- **License delivery.** Team refresh is a signed-key POST: an expired signed
  Team key can refresh while its subscription is active, without individual-seat
  revocation. Webhooks accept rotated Stripe `v1` signatures; Resend receives a
  stable event-and-delivery idempotency key, retained by Resend for 24 hours.

## 0.4.0 (2026-09-11)

Baton is a paid product as of 14 September 2026: a 14-day trial, then a Personal
license ($79 once, 12 months of releases) or Team ($12 per seat per month,
adds `baton share`). The license is the Baton License Agreement (commercial, source readable);
0.2.0 and 0.3.0 remain published under MIT and are not deprecated.

- **License gate.** `src/license.mjs`: Ed25519-signed keys checked offline
  against the embedded public key; a Personal key is a window over release
  dates (`RELEASE_DATE`), a Team key expires and `baton license refresh`
  renews it; the trial is recorded under `$BATON_HOME`. `baton <agent>` exits
  4 once nothing is left; `baton share on` needs Team (the trial counts).
  `baton license status|activate|deactivate|refresh`. `scripts/license-sign.mjs`
  signs a key by hand. Ten tests.
- **The npm package runs.** `files` now ships `fixtures/limits` and
  `fixtures/live`, which `src/limits.mjs` and `src/live-capture.mjs` read at
  load; 0.3.0 from npm crashed on every command for that reason. A lessons
  test packs the tarball and checks it.
- **Checkout.** Stripe payment links, a `site/api/key` function that turns a
  paid checkout into a key (deterministic per purchase), a webhook that emails
  it through Resend, and `site/thanks` that shows it. `scripts/stripe-setup.mjs`
  creates the plans, links and webhook idempotently; `scripts/vercel-env.mjs`
  pushes the secrets.
- **A marketing site.** `site/` holds a static page for the product (hero, the handoff played in a recreated terminal, the board and the two-session cards recreated in HTML, the changeover, what is never touched, install), with the SEO floor (title from measured search volume, description, canonical, OG image, robots.txt, sitemap.xml, llms.txt) and Vercel headers. PRODUCT.md and DESIGN.md at the root carry the brief and the design tokens; docs/DECISIONS.md records why cobalt. Not part of the npm package.

## 0.3.2 (2026-09-11)

A second adversarial review over 0.3.1, this time of the whole tree: 49
confirmed bugs fixed, each with a regression test seen red first (340 tests).

- **Cards no longer wedge or double-launch.** Hand off now and Reassign on a
  running leg used to throw out of the orchestrator and leave the card in
  `handing_off` holding a concurrency slot with no bundle; both now stop the
  leg, write the bundle, and continue in the same driver. A card is claimed by
  a `driver.lock` for the whole of `runCard`, so a `card run` beside the board's
  scheduler (or two schedulers: `scheduler start` now refuses when one runs and
  the pidfile is created atomically) can never launch two legs into one
  worktree; `runner launch` writes `run.json` with its driver before spawning
  the supervisor. Kill during the launching window kills the supervisor tree
  instead of nothing. A card left running at a test or land station by a crash
  is recovered by the scheduler. Kill or Pause during a test or land station is
  no longer undone by the late result. A land bounce with no agent station, and
  a red test whose only agent station comes later, fail the card instead of
  throwing or skipping ahead. Hand off now is offered only when a next leg
  exists. `--model <adapter>=<name>` (and a chain entry's `network`) now reach
  the agent argv; they were dropped on the way to the runner.
- **The board stays up.** The test station ran the repo's suite with
  `spawnSync` inside the board server, freezing HTTP, SSE, the scheduler and
  the merge queue for its whole duration; it is async now. The drawer no
  longer refetches on every log byte, the log tail refreshes when the run
  changes, an open drawer is refetched after an SSE reconnect, and the floor
  stops polling on a 401 and shows a way back.
- **No lost writes.** `run.json` and `card.json` are read-modify-written under
  a cross-process lock (a human Kill was silently reverted by a driver's status
  write). `withFileLock` itself treated Windows' EPERM during a sibling's
  unlink as "give up and run unlocked": it now retries, which also closes the
  hole in the 0.3.1 session and usage locks. `ledger sync` renames the buffer
  before flushing so a record buffered mid-flush survives, and refuses clearly
  when sync is off. The merge queue's turn is a file lock keyed on the
  canonical repo root, so two spellings of one checkout, or two processes,
  never land into it at once.
- **`baton share` and the launcher.** `share add sam` before `share on` no
  longer makes the guest the owner. A non-loopback board no longer falls open
  to everyone the moment share.json reads as off (`share off` stops the
  listener first, and the bind is re-checked per request). Share off no longer
  promotes a guest's live SSE stream; a stale tab repeating one rotated token
  no longer locks the machine out; `share on|off` no longer kill every running
  agent; `share rm` refuses to take the last owner; the SSE health frame is
  filtered for guests; a redacted session names its branch. The pidfile is
  confirmed by a probe, so `status` cannot report a dead board as running and
  `down` cannot kill whatever reused the PID. Card removal with `?branch=delete`
  no longer escalates to `git branch -D` without `?force=1`, a status check
  that fails no longer reads as clean, and `sessions rm` refuses mid-land.
- **The limit path.** codex's rollout is found for a session started in the
  local evening (the day directory is local, the filter compared UTC). agy's
  wall is seen behind non-ASCII log lines (a byte count was used as a string
  index) and an old wall is not re-fired by a second agy leg. After a hand-off
  the previous agent's usage bars are cleared, the near-limit warning fires
  again, the chain shown as "next" is recomputed, `all_out` clears after the
  wait, an agy leg adds to the turn count, and a board Hand off with the other
  agents walled restarts the current agent instead of waiting. The resume
  prompt names the absolute RESUME file.
- Smaller: an agent-created `.env.example` is no longer dropped from a land;
  a card whose trunk does not exist is refused at `card add` naming the repo's
  default branch (it used to burn every land attempt); a rebase git refuses for
  a non-conflict reason bounces `rebase-failed` with git's words, and a
  conflicting retry is no longer reported as `trunk-moved`; `sk-` no longer
  matches ordinary hyphenated words (a task saying "risk-free" was refused as a
  secret); `OPENAI_BASE_URL` is stripped from agent legs; with share off and a
  token, the rate limit is per address, not one shared bucket.

## 0.3.1 (2026-09-11)

A security and correctness pass over 0.3.0, after an adversarial review. No new
features; 44 fixes, all covered by the test suite (281 tests).

- **`baton share` security.** A guest could read the owner's pipeline through
  `/api/trunk` (now on the guest deny-list) and through the SSE stream (the
  card/removed broadcasts now carry the per-viewer filter, and every push
  re-checks the viewer against the live roster). `share add|rotate|rm` now take
  effect on a live board instead of after a restart: the server re-reads
  `share.json` per request, so a removed or rotated link stops at once and a new
  one works at once. `baton share add` before `baton share on` can no longer
  make a guest the board's owner. A non-loopback bind also listens on 127.0.0.1
  so the owner keeps a tokenless URL while a remote peer still needs a token.
  Cross-origin state-changing requests are refused. New `test/share-security.test.mjs`
  sends a missing, wrong, other-human, rotated and removed token to every route
  including SSE.
- **No lost work.** Land refuses a worktree with a rebase/merge already in
  progress (it used to commit the half-state and then abort it, deleting the
  human's uncommitted files). Remove and `baton sessions rm` no longer drop a
  session record while its worktree still holds unlanded commits. `git branch -d`
  before `-D`. A Land never commits a `.env`. A git failure during a Land no
  longer crashes the board process.
- **No lost writes.** `session.json` and the usage files are written under a
  cross-process lock with a reducer form, so concurrent hooks, taps and pollers
  stop losing files, turns and limit walls to a last-writer-wins race.
- **The limit path.** The handoff chooser skips agents that are not installed
  (a missing next agent used to kill the session exit 127), the all-out wait
  counts down to the true soonest reset including the current agent, a weekly
  wall is no longer recorded as a 5-hour one, and agy reset durations with more
  than one unit (`71h19m42s`) are summed, not truncated. `live-capture` now
  redacts the home and repo paths, not only secret shapes. The env sanitizer
  also strips the Google/Gemini keys the agy leg kept.
- A hung test command no longer leaves a card in `landing` forever and wedging
  the repo's merge queue. A crash during `git worktree add` no longer orphans a
  worktree with no card. Two sessions in one checkout get their own
  `RESUME-<id>.md`.

## 0.3.0 (2026-09-11)

Closing the gaps against the two tweets: a limit path proved live, waiting
instead of quitting, collisions stopped instead of flagged, and more than one
human on the board.

- `baton sessions simulate-limit <id>`: a `StopFailure` `rate_limit` payload in
  the shape Claude Code sends (marked simulated) goes through Baton's hook, so
  the whole path runs for real (limit status, bundle, agent stopped, the next
  agent started in the same terminal). Verified live: a haiku session handed
  off to codex, which read `.baton/RESUME.md` on its first turn. The simulated
  wall clears after two minutes and is never kept as evidence. agy: the
  RESOURCE_EXHAUSTED line is appended to the session's own log. codex is
  refused (use `handoff`).
- The first real claude `StopFailure` is saved with secrets scrubbed under
  `fixtures/live/<agent>/` in a dev clone (outside a clone it goes to
  `~/.baton/live/`, a path nothing has written yet), and the docs row for it
  flips from docs-only to observed-live (`scripts/live-limits.mjs`). The same
  capture is wired for codex `usage_limit_exceeded` and agy
  `RESOURCE_EXHAUSTED`; no real payload for either has been kept yet, and
  their rows are still docs-only.
- `BATON_CLAUDE_ARGS`, `BATON_CODEX_ARGS`, `BATON_AGY_ARGS`: extra arguments
  for a leg Baton starts after a hand-off (keep a chain on cheap models).
- codex's card no longer shows the injected AGENTS.md block as the task.
- When every option is out the terminal no longer exits 3: it prints the reset
  times, counts down to the first one, and starts that agent from the bundle
  when it arrives (`src/wait.mjs`). The card shows `waiting for <agent> at
  <time>`. End on the card quits with exit 3; Ctrl-C is wired to the same exit
  (the End path is the one under test). Verified live: with codex walled for
  80 s and agy for 200 s, a simulated limit on a haiku session waited and then
  started codex from `.baton/RESUME.md`.
- A second live session in a checkout that already has one gets its own git
  worktree, `<repo>/.baton-worktrees/<session-id>` on branch
  `baton/<session-id>`, cut from the branch the checkout has out; the terminal
  prints one line saying where. `--no-worktree` shares the checkout (the flag
  never reaches the agent).
- **Land** on the card of a session with its own worktree sends its branch
  through the merge queue: commit what the agent left, rebase onto the base,
  run the tests, fast-forward only, or bounce with the reason
  (`rebase-conflict` with the files, `tests-red` with the output tail,
  `dirty-trunk` when the checkout has local changes the landing would
  overwrite). The landed-on-trunk list says who landed each commit
  (`~/.baton/landings.jsonl`). Remove takes the worktree and branch along only
  when the worktree is clean and the branch is already on its base. Verified
  live: three haiku sessions in a throwaway repo, the second and third in
  worktrees both appending to README.md; Land on one ran the tests and
  fast-forwarded main, Land on the other bounced with `rebase-conflict` on
  README.md.
- `baton share`: more than one human on the board, off by default. `baton share
  on` binds the Tailscale address (or `--bind lan`, or one you name) and gives
  every human a name and their own token, kept as a sha256 hash and printed
  once (`baton share rotate <name>` issues a new one). A terminal belongs to
  the human who started it (`BATON_PERSON`). Another human's card is
  read-only: no prompt, no file names, no paths, no limit message, no bundle,
  no events, no logs — the agent, the branch, the usage bars and the reset
  time still show — and one **Request handoff** button that the owner
  approves or dismisses on their own card; the pipeline side stays the
  owner's. The security pass: a token on every `/api` route including the
  event stream (which is computed per viewer), 403 for a guest on anything
  that is not theirs, a lockout after repeated wrong tokens from one address
  and a per-human request ceiling (defaults 20 failures and 600 requests a
  minute, `src/ratelimit.mjs`; the tests drive both at lower thresholds), and
  tests that send a bad and a missing token to every route. Verified live
  over Tailscale with two terminals on one machine, one wes's and one sam's:
  sam's board redacted wes's card, and sam's **Request handoff** reached
  wes's board (the approve-then-hand-off step is covered by tests).
- The merge queue runs its tests through an async spawn instead of a blocking
  one, so a Land no longer parks the board's event loop.
- Fixed: a board that asks for a token answered `ensureBoard`'s health probe
  with 401, and Baton read that as "no board" and started a second one.
- `/api/health` asks each adapter where its binary is instead of running the
  bare name, so the board no longer says `codex: false` while the runner starts
  codex fine.
- When the claude usage endpoint 404s, answers with something that is not JSON,
  or changes shape, the card says `usage unknown (<why>) · the limit still
  hands off` instead of showing empty bars; the wall still arrives through the
  `StopFailure` hook. `BATON_CLAUDE_USAGE_URL` (or `fetchClaudeUsage({ url })`)
  accepts an http test double.
- Fixed: the first dirty file on a card (and in the bundle notes) lost its
  first letter (`EADME.md`) because the porcelain status was trimmed;
  `.dashclaw-local/` no longer counts as a file being touched, and it joins
  `.baton/`, `.baton-worktrees/` and `.context-handoffs/` in
  `.git/info/exclude` so a landing never commits it.
- `BATON_NO_BOARD=1` runs a session without the board; a stub-agent end-to-end
  test (`test/attach-e2e.test.mjs`) now runs `baton claude` through the hook,
  the hand-off, the wait and the restart in CI.

## 0.2.0 (2026-09-11)

The way in is now `baton claude`, `baton codex` or `baton agy`: the normal
interactive agent in your terminal, with Baton alongside it. The v0.1 form,
pipelines, leases and merge queue stay as extras.

- `baton <agent> [args…]` starts the real interactive CLI with your settings,
  hooks and skills; extra args pass straight through. API-key variables are
  stripped; Baton writes its own per-session settings file
  (`~/.baton/sessions/<id>/claude-settings.json`) and passes it with
  `--settings`, instead of editing `~/.claude`, `~/.codex` or agy's home.
- The board opens once and is reused; every session in every terminal is a
  card: agent, account, repo@branch, task, turns, files being touched, 5h/7d
  usage, warning/limit/handoff state. Two live sessions editing the same file
  in one repo are flagged on both cards. A "landed on trunk" list per repo.
  Buttons: Hand off now, End, Remove.
- Usage tracking per agent and account. claude: Claude Code's usage endpoint
  with the stored login (a status-line JSON route is written as a fallback;
  on the build machine, Claude Code 2.1.268 was not seen running a custom
  status line — see docs/adapters.md) plus the `StopFailure` `rate_limit`
  hook. codex: the session rollout file
  (`token_count.rate_limits`, `usage_limit_exceeded`). agy: its log
  (`RESOURCE_EXHAUSTED`, "it resets in"); no percentage is exposed.
- A context-handoff-bundle per session, refreshed every two minutes and at
  every warning/limit/handoff (`save --update <slug>`).
- Hand-off on limit or on request: bundle, stop the agent, restore the
  terminal, start the next option in the same terminal from `.baton/RESUME.md`.
  Order: other logins of the same agent, then the next agents (claude → codex
  → agy). When every option is out: each reset time, soonest first, then exit
  3. (0.3.0 waits for the first reset instead.)
- Optional second logins: `baton accounts add <claude|codex> <name>` (config-dir
  junctions for the shared harness, one login line to paste). Both vendors'
  terms are in the README and are printed by `baton accounts terms`.
- `baton uninstall` removes only `~/.baton` (it prints what it will remove and
  asks for confirmation).
- gemini removed everywhere (Google retired Gemini CLI in favour of agy).
- 0 runtime dependencies still. New modules: src/attach.mjs, src/sessions.mjs,
  src/usage.mjs, src/accounts.mjs, src/bundle.mjs, src/hook.mjs, src/taps/*.

## 0.1.0 (2026-09-10)

First public release (source on GitHub; not on npm yet).

- Ported the detached runner, the append-only ledger and the git snapshot tool
  from a private ucsandman repository (team tooling) under the same MIT license,
  with Telegram delivery, chat identifiers and machine paths removed (see
  NOTICE, docs/REUSE.md, docs/DEVIATIONS.md).
- Adapters for claude, codex, gemini and agy, each spawned as argv with a
  sanitized child environment (subscription logins only, no YOLO flags); grok
  written from `--help` but unregistered until a live probe passes.
- Limit detector built from 25 recorded signals (docs/cli-contracts.md keeps
  the observed-live vs docs-only tag per row); DONE-marker completion contract.
- Handoffs through context-handoff-bundle (repo-local bundles, `load` resume
  prompt); pipeline presets factory / build / build-land; scheduler with path
  leases; land station as a merge queue (rebase → test → ff-only, bounce with
  the failure in the bundle); `pr` land mode stub.
- Board (kanban from the pipeline, every judgment a button, detail drawer) and
  floor view (running cards, leases, trunk lane) over a ledger-backed server
  with SSE and a BATON_BIND / BATON_TOKEN seam.
- Launcher: `npm start` = `baton up` (preflight, health check, prefixed
  redacted logs, Ctrl-C teardown), `up --dry`, `down`, `status`, `open`.
- Optional syncs, off by default: OpenClaw Workboard (argv) and DashClaw action
  recording (verified live once).
- Demo (fake limit on the board, five screenshots) and one real run: claude
  hit `--max-turns 2`, codex finished from the bundle, tests green in 2 m 50 s.
- Polish pass: a missing CLI ends the card `failed` (was stuck `running`);
  runs re-attach after `baton down` instead of relaunching; bounce and
  blocked chips name their reason; repo path must be a git root outside
  BATON_HOME; SSE re-reads only the changed card; reduced-motion and contrast
  checks; docs/VOCABULARY.md.
