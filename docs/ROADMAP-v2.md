# Roadmap v2: the software factory

**Unreleased (2026-09-17) opened the chain and finished the share story.** grok is
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

1. ~~**Multi-human network access**~~ — done. 0.3.0 shipped `leg share`; the
   unreleased work of 2026-09-17 shipped the three that were left: TLS (`leg share on --tls-cert/--tls-key`,
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

Also on the list: per-station prompt templates editable from the board, lease
suggestions from the diff of the previous leg, and a floor view that shows
lease contention over time. (The "hand off now to \<adapter>" picker landed
2026-09-17, unreleased: Details → **Hand off now to**, or `leg sessions handoff <id> --to`.)
