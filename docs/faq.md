# FAQ

Real questions, short answers, sourced from the code and the other docs in
this directory.

**Why subscription CLIs only, never a per-token API?**
Baton spawns each CLI's own logged-in session (`claude`, `codex`, `gemini`,
`agy`). Every child process has `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` and `OPENAI_API_KEY` stripped out (`src/env.mjs`), so a
stray API key in your shell cannot silently take over billing or shadow the
subscription login. If stderr ever says "another auth source is set", that
leg is classified `auth_failed`, a failed launch, and does not count as a
usage limit.

**Why are `--dangerously-skip-permissions` and similar flags never
available?**
Each adapter's `argv()` calls `assertAllowed()`
(`src/adapters/common.mjs`), which checks the requested mode against that
adapter's `allowed` list and rejects any flag on its `forbiddenFlags` list,
before anything spawns. Requesting `bypassPermissions`, `--yolo`,
`--full-auto`, `danger-full-access`, or similar throws immediately; nothing
ever runs with permission checks off.

**What actually happens when a leg hits a usage limit?**
`src/limits.mjs` classifies the leg's exit code, output and diff evidence as
`limit`. Baton writes a handoff bundle in the same worktree (task, done so
far, the diff, open findings) via `context-handoff-bundle`, then starts the
next adapter in that station's chain from the bundle's resume text. If the
chain has no next adapter, the card fails. See
[concepts.md](concepts.md#outcomes-and-the-classifier).

**Can two agents edit the same files at the same time?**
Not inside one card: a station runs one chain leg at a time. Across cards,
the scheduler only starts a queued card when its declared leases (path
globs) do not overlap any running card's leases (`src/leases.mjs`); the
default lease is `**` (the whole repo), so two cards with no leases set
always serialize. The overlap check is a deliberate approximation biased
toward false positives: an unnecessary serialization costs minutes, a
wrongly parallel card can corrupt a merge.

**What if the CLI I want isn't installed?**
`node bin/baton.mjs up --dry` prints a preflight table with `ok`/`missing`
per adapter. A missing adapter only matters if a card's chain names it: that
leg fails to launch (`launch_failed`), which does not advance the chain,
install and log in, then press Rerun. A chain only needs the adapters it
names; leave a missing one out.

**How do I resume after a reboot or a crash?**
Every run's `run.json` under `$BATON_HOME/cards/<id>/runs/<n>/` is the
source of truth, not process memory. `baton down` kills active agents but
each run's supervisor still writes its final verdict; the next `baton up`
(or the scheduler) finds any unsettled run with no live driver and
re-attaches to apply that verdict, logging a `re-attached to run N` event.
Nothing manual to do beyond starting Baton again.

**Does Baton push to GitHub, or open pull requests?**
No. The default `land_mode: ff` only rebases and fast-forwards the local
trunk branch inside the repo you gave it; there is no remote write anywhere
in `src/worktree.mjs` or `src/mergequeue.mjs`. `land_mode: pr` builds a real
`gh pr create` argv but is stub-only: it refuses to run unless
`BATON_GH_BIN` points at a real `gh` (or a test stub), and even then it
never pushes or creates a remote for you, that is out of scope for this
build.

**Is there a hosted version of Baton?**
No. Baton is local-first: the board binds `127.0.0.1` by default, every
card's state lives in files under `BATON_HOME`, and there is no service to
sign into. See [configuration.md](configuration.md#network-exposure) for
what changes if you deliberately bind it to a shared address.

**How are secrets handled?**
`src/redact.mjs` holds one pattern list (API keys, bearer tokens, GitHub and
AWS tokens, `key=value` secrets); `scrub()` rewrites matches to
`[REDACTED]` in every log line the launcher prints and in handoff bundle
text, and the ledger's own writer refuses to record an event whose summary
or body matches a secret pattern at all. Every adapter's `env()` strips the
API-key/base-URL variables from the child process. `npm test` and the
pre-commit hook both run `scripts/privacy-check.mjs`, which additionally
scans the whole tree for a short list of strings specific to the private
codebase Baton's runner/ledger were ported from.

**What happens if I close the terminal instead of Ctrl-C?**
The board server and any running agents keep running as detached processes.
Run `node bin/baton.mjs down` (or `npm run stop`) from another terminal to
stop them cleanly, or just start `baton up` again later: it re-attaches to
any run left in progress rather than launching a duplicate.

**Can I run a card without the board?**
Yes: `node bin/baton.mjs card run <card-id>` drives one card through the
orchestrator directly and exits when it reaches a waiting or terminal
state, printing the final status. `node bin/baton.mjs card show <id>` and
`card events <id>` work without the server running too, since they read the
same on-disk ledger the board reads.

**What does `BATON_NO_SCHEDULER=1` do, and why would I set it?**
It boots the board server without its embedded scheduler, so no queued card
starts automatically, useful when you want to drive every card by hand
with `card run` (for example, inside a test) while still watching it on the
board.

**Is there a limit to how long a chain can be, or how many legs a card can
take?**
No fixed limit; the chain array can be as long as you like. A card fails
only when a leg's outcome needs to hand off and the chain has no next entry
left, or (separately) after `BATON_MAX_LAND_ATTEMPTS` test/land bounces.

**Windows vs macOS/Linux: what's actually verified?**
Built and tested on Windows (every worktree, git and taskkill path in the
source has Windows-specific handling: `MSYS_NO_PATHCONV=1`, `taskkill /T
/F`, native `.exe` resolution). CI (`.github/workflows/ci.yml`) runs the
full test suite on both `ubuntu-latest` and `windows-latest` on every push
and pull request.

**How do I report a bug?**
Open a GitHub issue using the bug report template
(`.github/ISSUE_TEMPLATE/bug_report.md`). For a security vulnerability, do
not open a public issue, see [SECURITY.md](../SECURITY.md) instead.

**Where do I find the exact word Baton uses for a given status, event, or
button?**
[VOCABULARY.md](VOCABULARY.md): one table per category (statuses, outcomes,
station kinds, event types, actor types, human actions, bounce reasons),
pulled straight from the source identifiers.
