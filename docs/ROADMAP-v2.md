# Roadmap v2: the software factory

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

1. **Multi-human network access**, gated on a security review: token scopes per
   human, per-human actor ids on every event, an audit view, rate limits on the
   API, and a decision on TLS termination before `BATON_BIND` leaves loopback.
2. **Review station with human reviewers**: a `human` station kind that shows
   the diff, the bundle and the test tail, with Approve / Request changes /
   Reassign as buttons; reviewer identity from the token.
3. **`pr` land mode live**: `gh pr create` argv is built and stub-tested today;
   run it for real behind an explicit per-card opt-in and a remote allowlist.
4. **More adapters**: grok (adapter written, unregistered until `grok login` and
   a passing probe on the machine) and muse only if a real CLI is verified; a
   generic "argv + JSON result" adapter for anything else.
5. **OpenClaw Workboard mirror** once the bundled plugin is allowed
   (`plugins.allow`): the verb table in `src/sync/workboard.mjs` is the only
   thing to check against `openclaw workboard --help`.

Also on the list: per-station prompt templates editable from the board, a
"hand off now to <adapter>" picker, lease suggestions from the diff of the
previous leg, and a floor view that shows lease contention over time.
