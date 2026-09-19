# Roadmap v2: the software factory

**0.12.0 (2026-09-17) added the model dimension and made cards a first-class
surface.** A hand-off destination is now a rung of (agent, login, model), not
just an agent, so a Fable wall moves the terminal to opus on the same
subscription before it moves to another CLI, and for claude that move keeps
the conversation (`claude --resume <id> --model <alias>`). The **Hand off now
to** picker lists those rungs with their models, whether each keeps the
conversation, and why a greyed one buys nothing; the same list is a ladder
editor in Settings, in a terminal's expansion and behind `leg ladder`. Live
cards left the drawer and became rows in a **Background** panel directly under
Terminals, with a one-line entry and the thirteen-field dialog demoted to
**More settings**; `End, and keep going as a card` and `Take over` are the two
doors between a terminal and a card. The board top became a capacity strip
over a **Capacity and models** drawer, a row says `waiting on you` with the
question when Claude Code's `Notification` hook fires, and a burn-rate figure
prints only with its sample count. That closes the model dimension, the
picker's second half, and the cards item below.

**0.11.0 (2026-09-17) opened the chain and finished the share story.** grok is
a registered card adapter; any other CLI becomes one from a JSON spec
(`leg adapter add`, no code); **Hand off now** can name its destination
instead of taking the next in the order; `leg share` grew TLS from a
certificate pair you supply, an `operator` role between owner and guest, and
an audit trail of who did what across every terminal and every card. That
closes items 1 and 4 below, and the "hand off now to \<adapter>" picker.

**0.3.0 (2026-09-11) shipped item 1 and the first half of continuous landing.**
A second live session in one checkout gets its own worktree and branch, and
**Land** on its card sends that branch through the merge queue (rebase, tests,
fast-forward, or a bounce with the reason), with the landed-on-trunk list
naming the terminal that landed each commit. `leg share` puts more than one
human on the board, off by default: a token and a name per human, per-human
actor ids on every event, another human's terminal read-only with everything it
said or touched left out, a **Request handoff** the owner approves, and rate
limits on the API. Still open from item 1: TLS (there is none, so the board
belongs on Tailscale or a trusted LAN), token scopes finer than owner and
guest, and an audit view.

**0.2.0 (2026-09-11) shipped the terminal-first entry**: `leg claude|codex|agy`
runs the real interactive agent with a board, usage tracking and a hand-off
alongside it. Against the list below, it delivers the hand-off-on-demand half
of the "hand off now to \<adapter>" item (a button on every terminal card,
which takes the next option in the chain; the picker is still open), and it
puts the machine's terminals on one board, which is the surface item 1's
multi-human work was built on.

v1 ships one wedge: a card runs a fallback chain of coding-agent CLIs, and when
a leg hits its usage limit the next agent resumes from a handoff bundle in the
same worktree. Where it is headed (Wes, 2026-09-10, after @mikehostetler's
"massive multiplayer software factory"): many cards, many agents and several
humans working one repo at once; stations handing work to each other
continuously; trunk moving in small landed pieces all day; every human judgment
a button on a shared floor. Not live co-editing of the same files: that is a
conflict machine with agents. The v1 shapes already point there: stations not
fixed columns, a scheduler with path leases, a merge queue, a ledger where every
event names its actor, a board that reads only the ledger, and an auth/bind seam.

## Next

1. ~~**Multi-human network access**~~ — done. 0.3.0 shipped `leg share`; 0.11.0
   shipped the three that were left: TLS (`leg share on --tls-cert/--tls-key`,
   or `LEG_TLS_CERT`/`LEG_TLS_KEY`, from a pair you supply — Leg issues none),
   the `operator` role between owner and guest, and the audit trail
   (`/api/audit`, Settings → Audit trail).
2. **Review station with human reviewers**: a `human` station kind that shows
   the diff, the bundle and the test tail, with Approve / Request changes /
   Reassign as buttons; reviewer identity from the token.
3. **`pr` land mode live**: `gh pr create` argv is built and stub-tested today;
   run it for real behind an explicit per-card opt-in and a remote allowlist.
4. ~~**More adapters**~~ — done. grok is registered (2026-09-17: flags read
   from `grok --help` on 1.0.34, envelope read from the shipped binary, probe
   reached the account and returned a real 402 wall that classified `limit`;
   the success path is still unprobed for want of balance). Anything else,
   muse included, is a custom adapter: a JSON spec in
   `$LEG_HOME/adapters/<name>.json`, `leg adapter add`, no code
   ([adapters.md](adapters.md#custom-adapters)).
5. **OpenClaw Workboard mirror** once the bundled plugin is allowed
   (`plugins.allow`): the verb table in `src/sync/workboard.mjs` is the only
   thing to check against `openclaw workboard --help`.

6. **Probe `codex resume <id> -m <model>`.** The `resume` subcommand and the
   `-m` flag are each verified from `codex --help`; composing them is not, so
   a codex rung ships primed from the bundle and only the claude rungs claim
   to keep the conversation. One real run on a live codex session settles it.
   The same probe shape applies to naming the terminal tab: whether codex, agy
   and grok leave an OSC 2 title alone once the child starts drawing is
   assumed, not known, which is why the tab title is the browser's and not the
   terminal's. 0.15.0 made the claude half of this real across logins too (a
   second login shares the conversation store, so a login switch keeps the
   conversation): the codex probe now also covers a second `CODEX_HOME` with
   its `sessions` store shared the same way.
7. **`stalled` and `repeating` on the row.** Two derived states from data the
   record already holds: no turn, file write or commit for N minutes while not
   waiting on a human; the same test red across two legs of one card. Printed
   only, never acted on; a `looping` state waits for a false-positive study on
   real transcripts. Design in `docs/review-2026-09-18.md`.
8. **The digest on the board.** `leg digest` and `/api/digest` shipped in
   0.15.0; the panel above Terminals on the first load of the day is the
   human surface it still lacks. Same review doc.

Also on the list: per-station prompt templates editable from the board, lease
suggestions from the diff of the previous leg, and a floor view that shows
lease contention over time. (The "hand off now to \<adapter>" picker landed in
0.11.0: Details → **Hand off now to**, or `leg sessions handoff <id> --to`.
0.12.0 put models on its rows.)

## Ruled out, with the reason

- **Phone or push notifications.** They need a relay, which means a server
  that is not this machine holding a token that can reach you. Leg is
  local-first, so the notice surfaces are the ones the machine already owns:
  the browser tab badge (always on, no permission), a browser toast on the
  board (off by default, gated on a secure context), and a terminal toast
  through Claude Code's `Notification` hook (on by default).
- **Percentages for agy.** Antigravity CLI publishes no usage figure at all,
  so there is nothing to read. agy's token says `no figure`, and its terminals
  are shown by elapsed time instead. A number here could only be invented.
- **Dollars for subscription sessions.** No transcript Leg reads carries a
  cost field. codex's `credits.balance` can be printed as a measured fact with
  the word `credits`, and is never summed with an estimate.
- **Per-terminal attribution of a shared login.** Nothing publishes which
  terminal spent which part of a window. The board says it once, at the
  Terminals head (`4 share the claude login`), rather than guessing per row.
