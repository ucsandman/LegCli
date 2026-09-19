# FAQ

Real questions, short answers, sourced from the code and the other docs in
this directory.

**Why subscription CLIs only, never a per-token API?**
Leg spawns each CLI's own logged-in session (`claude`, `codex`, `agy`).
Every child process has `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_API_BASE`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_EFFORT`, and `CLAUDE_PLUGIN_DATA` stripped out
(`src/env.mjs`), then gets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for a
detached Claude print session. A stray API key in your shell cannot silently
take over billing or shadow the subscription login. If stderr ever says
"another auth source is set", that leg is classified `auth_failed`, a failed
launch, and does not count as a usage limit.

**Why does Leg poll an endpoint for claude's usage instead of reading the
status line?**
Because Claude Code 2.1.268 and 2.1.278 did not run a custom status line from a settings
file Leg controls when this was tried on 2026-09-11 and 2026-09-19 (recorded in
[DEVIATIONS.md](DEVIATIONS.md)); hooks from the same `--settings` file did
fire. So the numbers come from
`GET api.anthropic.com/api/oauth/usage` with the login Claude Code already
stored, which is the same data `/usage` shows. Leg still writes the
`statusLine` entry, so the endpoint poll becomes a fallback the moment a build
honours it, and your own status-line command runs first, its rows above
Leg's one, either way (since 0.15.1). See
[adapters.md](adapters.md#claude) and `src/taps/claude-usage.mjs`.

**Why does codex get no hook when claude does?**
Because injecting one would put a prompt in your way. codex asks you to review
new hooks before it runs them, so a hook per Leg session would mean a
review prompt per Leg session. It is not needed: an interactive codex writes
the whole thread to a rollout file under `~/.codex/sessions/YYYY/MM/DD/`, and
flushes it per event. Leg finds the rollout whose `session_meta` cwd is the
session's directory and tails it for the rate limits, the prompts and the
edited files.

**Why does agy show no percentage?**
Because agy exposes none. agy 1.2.0 is a closed Go binary; its own status line
fetches a quota summary from the backend and writes it nowhere on disk. The
board shows "no % from agy" rather than an empty bar. The wall itself is still
caught: Leg passes `--log-file` per session and watches for
`RESOURCE_EXHAUSTED`, "it resets in …" and "out of quota". Those strings are
present in `agy.exe`. A real `RESOURCE_EXHAUSTED` wall was caught live on
2026-09-11 and handed the session off; the fixture in `fixtures/limits/agy/`
is still tagged docs-only in [cli-contracts.md](cli-contracts.md#agy-tap)
because the payload itself was never captured to `fixtures/live/agy/`.

**Am I allowed to add a second account?**
That is your call, and the terms are quoted in full in the README under
"Second accounts, and what the terms say" (`leg accounts terms` prints the
same summary). The short version: owning two paid subscriptions is not named
as prohibited by Anthropic or OpenAI, but rotating to a second account of the
same vendor because the first is rate-limited sits close to OpenAI's
"circumvent any rate limits" wording and Anthropic's "circumvent product
guardrails". Leg's default fallback ladder switches vendors (claude, codex,
agy) only after it has already tried claude's own weaker models (fable, opus,
sonnet), which is plainly fine. Same-vendor rotation only happens after you
run `leg accounts add`; switching models on one login, claude/fable to
claude/opus, is not a second account at all and none of this applies to it.

**Can I switch models mid-session, or does a hand-off always mean a different CLI?**
Yes. `handoff_ladder` in `preferences.json` names an agent, account and model
per rung (`src/preferences.mjs`), and a fresh install tries claude/fable, then
claude/opus, then claude/sonnet before it ever leaves the claude login, then
the other agents. A downshift to a weaker claude model with a known session id
runs `claude --resume <id> --model <alias>` and keeps the conversation; every
other rung takes the bundle as today. `may_spend` (default `false`) keeps an
automatic hand-off off any rung whose live cost is `credits` or `metered`; a
hand-off you press yourself can still take it. `climb_back` decides whether
Leg returns to the top rung at the next hand-off (`next-handoff`, the default)
or waits for you to press **Back to fable** (`never`). Edit the ladder with
`leg ladder` or in Settings; see
[configuration.md](configuration.md#the-hand-off-ladder).

**What does `leg uninstall` remove?**
`~/.leg` and nothing else: sessions, usage files, the extra account
directories with their junctions, the v0.1 cards and runs, and the board
pidfile. It removes the junctions as links, never following them into your
real `~/.claude` or `~/.codex`. It does not touch any file of yours, any repo,
or the agent CLIs themselves. Run `leg uninstall` with no flag to print what
would go, `--yes` to do it; then `npm rm -g legcli` if you want the
package gone too.

**Can I run `leg claude` inside a Claude Code shell?**
Yes. A parent Claude Code session exports `CLAUDECODE` and `CLAUDE_CODE_*`
markers that make a nested Claude refuse to start; `sanitizeEnv`
(`src/env.mjs`) strips them along with the API-key variables, so the child
starts normally. It becomes its own session with its own row on the board,
unrelated to the parent's.

**Why are `--dangerously-skip-permissions` and similar flags never
available?**
Each adapter's `argv()` calls `assertAllowed()`
(`src/adapters/common.mjs`), which checks the requested mode against that
adapter's `allowed` list and rejects any flag on its `forbiddenFlags` list,
before anything spawns. Requesting `bypassPermissions`, `--yolo`,
`--full-auto`, `danger-full-access`, or similar throws immediately; nothing
ever runs with permission checks off.

**What actually happens when a pipeline leg hits a usage limit?**
(For an interactive session, see [concepts.md](concepts.md#handoff-interactive).)
`src/limits.mjs` classifies the leg's exit code, output and diff evidence as
`limit`. Leg writes a handoff bundle in the same worktree (task, done so
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

For terminals: a second `leg <agent>` in a checkout that already has a live
session gets its own worktree and branch, so the two never write over each
other's files. Whoever presses Land first fast-forwards trunk; the second one
rebases onto it, or bounces with the conflicting files named on the card.
`--no-worktree` shares the checkout when that is what you want.

**Can someone else watch my board?**
Only if you run `leg share on`, which is off by default. It binds your
Tailscale or LAN address and prints one link per human (`leg share add
<name>`), each with its own token. A guest sees the terminals lane read-only
and nothing a terminal has said, read or written: no prompt, no file names, no
paths, no bundle, no events, no logs, and none of the pipeline side. The
limit line keeps only the reason and the reset time, never the raw limit
text. The one thing they can do on your terminal is ask for a hand-off, which
you approve or dismiss on the row. `leg share off` ends it and every link
stops working. TLS is served from a certificate pair you supply (`leg share on
--tls-cert <file> --tls-key <file>`); Leg issues none, so without one keep it on
Tailscale or a network you trust.

**What if the CLI I want isn't installed?**
`node bin/leg.mjs up --dry` prints a preflight table with `ok`/`missing`
per adapter. A missing adapter only matters if a card's chain names it: that
leg fails to launch (`launch_failed`), which does not advance the chain,
install and log in, then press Rerun. A chain only needs the adapters it
names; leave a missing one out.

**How do I resume after a reboot or a crash?**
Every run's `run.json` under `$LEG_HOME/cards/<id>/runs/<n>/` is the
source of truth, not process memory. `leg down` kills active agents but
each run's supervisor still writes its final verdict; the next `leg up`
(or the scheduler) finds any unsettled run with no live driver and
re-attaches to apply that verdict, logging a `re-attached to run N` event.
Nothing manual to do beyond starting Leg again.

**Does Leg push to GitHub, or open pull requests?**
No. The default `land_mode: ff` only rebases and fast-forwards the local
trunk branch inside the repo you gave it; there is no remote write anywhere
in `src/worktree.mjs` or `src/mergequeue.mjs`. `land_mode: pr` builds a real
`gh pr create` argv but is stub-only: it refuses to run unless
`LEG_GH_BIN` points at a real `gh` (or a test stub), and even then it
never pushes or creates a remote for you, that is out of scope for this
build.

**Is there a hosted version of Leg?**
No. Leg is local-first: the board binds `127.0.0.1` by default, every
card's state lives in files under `LEG_HOME`, and there is no service to
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
codebase Leg's runner/ledger were ported from.

**Does the next agent get my rules, hooks, skills and MCP servers, or just the task?**
Just the task, unless you turn on the [portable harness](harness.md)
(`leg harness enable`). Then a hand-off also renders the source client's
global working agreement, identity, hooks, skills, subagents, slash commands,
MCP servers and permissions into the destination's own files, as far as that
client can represent them, and the terminal's details say what was dropped and
why (Codex has no SSE transport; agy has no `SessionStart` hook; a skill that
already exists as a real directory is left alone). Credentials never move: an
MCP key becomes `${NAME}` and you export it for each client. Off by default,
and `leg harness disable` turns it off without removing anything.

**Will the portable harness overwrite a file I edited?**
No. Every file it writes carries `GENERATED by Leg harness` in its first lines,
and inside a file you also own it writes a marked `leg harness` region. A
file whose content changed since Leg wrote it is backed up once under
`~/.leg/harness/backups` and skipped; the sync reports `attention` with the
path, and `leg harness sync --force` is the only way it gets replaced. The
source client is never written at all.

**What happens if I close the terminal instead of Ctrl-C?**
The board server and any running agents keep running as detached processes.
Run `node bin/leg.mjs down` (or `npm run stop`) from another terminal to
stop them cleanly, or just start `leg up` again later: it re-attaches to
any run left in progress rather than launching a duplicate.

**Can I run a card without the board?**
Yes: `node bin/leg.mjs card run <card-id>` drives one card through the
orchestrator directly and exits when it reaches a waiting or terminal
state, printing the final status. `node bin/leg.mjs card show <id>` and
`card events <id>` work without the server running too, since they read the
same on-disk ledger the board reads.

**What does `LEG_NO_SCHEDULER=1` do, and why would I set it?**
It boots the board server without its embedded scheduler, so no queued card
starts automatically, useful when you want to drive every card by hand
with `card run` (for example, inside a test) while still watching it on the
board.

**Is there a limit to how long a chain can be, or how many legs a card can
take?**
No fixed limit; the chain array can be as long as you like. A card fails
only when a leg's outcome needs to hand off and the chain has no next entry
left, or (separately) after `LEG_MAX_LAND_ATTEMPTS` test/land bounces.

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

**Where do I find the exact word Leg uses for a given status, event, or
button?**
[VOCABULARY.md](VOCABULARY.md): one table per category (statuses, outcomes,
station kinds, event types, actor types, human actions, bounce reasons),
pulled straight from the source identifiers.
