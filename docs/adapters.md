# Adapters

Two things per agent: what Leg reads from an interactive session
(`leg claude|codex|agy|grok`), and the headless argv the v0.1 pipeline spawns.
Every fact here was written against `src/taps/*.mjs`, `src/attach.mjs` and
`src/adapters/*.mjs`; the evidence trail, including which lines an artifact
backs, is [cli-contracts.md](cli-contracts.md).

An agent is never run through a shell. Interactive sessions are
`spawn(bin, argv, { stdio: 'inherit' })` (`src/attach.mjs` `spawnSpec`);
headless legs are `spawn(spec.bin, spec.args, …)` (`src/runner.mjs`). Both
strip the API-key and base-URL variables and the Claude Code nested-session
markers from the child environment (`src/env.mjs` `sanitizeEnv`).

## What Leg reads from each agent

Nothing is screen-scraped. Each tap was read from the CLI's own source or
documentation, then checked on a real machine on 2026-09-11 (Claude Code
2.1.268, codex-cli 0.153.4, agy 1.2.0). Lines that a live run or a fixture
backs say observed-live; lines read only from a CLI's source or
documentation say docs-only.

### claude

- **How Leg attaches**: one extra settings file per session, passed as
  `claude <your args> --settings <~/.leg/sessions/<id>/claude-settings.json>`
  (`src/taps/claude.mjs` `settingsFor`). Hooks from `--settings` merge with
  yours rather than replacing them. Observed live: a Leg session ran with
  every user hook still firing.
- **Hooks wired**: `SessionStart`, `UserPromptSubmit`,
  `PostToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`), `Stop`,
  `StopFailure`, `SessionEnd`, each running
  `node src/hook.mjs claude-hook --session <id>`. Observed live.
- **`autoContinueAtUsageLimit` is set to `false`** in that settings file,
  because Leg owns what happens at the limit.
- **Usage percentages**: `GET https://api.anthropic.com/api/oauth/usage`
  (`LEG_CLAUDE_USAGE_URL` overrides), with the `accessToken` Claude Code
  stored in `<CLAUDE_CONFIG_DIR>/.credentials.json` under `claudeAiOauth`, and
  the header `anthropic-beta: oauth-2025-04-20`. The response carries
  `five_hour` and `seven_day`, each `{ utilization, resets_at }`. Polled every
  60 s (`LEG_USAGE_POLL_MS`). Observed live: real percentages come back
  and land in `<LEG_HOME>/usage/claude--default.json` with
  `source: claude usage endpoint`; a 7-day window at 93 % raised the amber
  warning on 2026-09-11.
- **The wall**: the `StopFailure` hook fires with `error: rate_limit`
  ([docs](https://code.claude.com/docs/en/hooks#stopfailure)). Status:
  **observed-live 2026-09-11** <!-- live:claude/rate_limit -->. A real
  `StopFailure` arrived on 2026-09-11 at 07:46:37Z, a 429 `rate_limit_error`
  from the API, and is kept, secrets scrubbed, as
  `fixtures/live/claude/limit-rate_limit.json` (`src/live-capture.mjs`); a
  payload `leg sessions simulate-limit <id>` produces is marked and never
  kept (`src/live-capture.mjs` `isSimulated`). The path is also covered by
  the hook contract test and can be driven end to end with
  `leg sessions simulate-limit <id>`, which sends the same payload through
  `src/hook.mjs`.
- **Why not the status line.** Leg writes a `statusLine` entry into the same
  settings file that would record `rate_limits.five_hour.used_percentage` and
  `resets_at`, and runs your own `statusLine` command first, its rows above
  Leg's one (since 0.15.1; before that your command was read and never run,
  so a build that honours the key showed Leg's row instead of yours). Claude
  Code 2.1.268 and 2.1.278 did not run it when it was tried on this machine
  (2026-09-11, 2026-09-19): an `echo` command
  passed through `--settings` and again through a project
  `.claude/settings.local.json` left the built-in status line in place, while
  hooks from the same `--settings` file fired. No artifact of that check was
  kept; the note lives in the `src/taps/claude-usage.mjs` header. The endpoint
  poll is therefore the live source; the status-line route becomes a fallback
  the moment a build honours it.
- **Token handling**: the stored token is read by the polling process only,
  sent only to `api.anthropic.com`, and written nowhere. The ledger scrubs
  bearer tokens from every line regardless (`src/redact.mjs`).

### codex

- **How Leg attaches**: nothing is injected. `leg codex` runs `codex` with
  your arguments, then finds and tails that session's rollout file. A hook
  would have to be trusted by codex on first use, which is why this tap
  reads instead.
- **Which file**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  (`CODEX_HOME` when an extra account is in use), picked by
  `session_meta.payload.cwd` equal to the session's directory and a birth
  time or mtime at or after the spawn, with five seconds of slack
  (`src/taps/codex.mjs` `findRollout`). Observed live: the tap found the
  right rollout for a real hand-off. On Windows the file's mtime lags its
  contents, across six rollouts from 2026-09-11 the mtime was 7 s to 9 min
  behind the last line's timestamp, so `findRollout` matches on cwd and
  accepts a birth time or mtime at or after the spawn rather than relying on
  the two agreeing.
- **Usage percentages**: the read-only app-server `account/rateLimits/read`
  response. Leg identifies the returned windows by duration rather than by
  field name: 300 minutes is 5h and 10080 minutes is 7d. The board and active
  attach poll it every 60 seconds; neither sends a model turn nor assumes a
  quota. Only an explicit available response clears a prior wall.
- **The wall**: `event_msg.task_complete.error` with
  `codex_error_info: "usage_limit_exceeded"` and the message "You've hit your
  usage limit … try again at \<date>". The wording comes from
  `codex-rs/protocol/src/error.rs` (`UsageLimitReachedError`); the event shape
  was read from local rollouts. The error itself:
  **observed-live 2026-09-15** <!-- live:codex/usage_limit_exceeded -->, a
  real `task_complete.error` with `codex_error_info: usage_limit_exceeded`
  walled a codex leg at 07:56:24Z and handed the session to agy. No payload
  was kept: the capture call in `src/attach.mjs` was added while that
  session's runner was already running, so
  `fixtures/live/codex/limit-usage_limit_exceeded.json` is still the slot
  for the next one.
- **Transcript**: user prompts from `response_item.message` with `role: user`
  and `content[].type: input_text`; assistant text from `output_text` and from
  `task_complete.last_agent_message`. Observed live.
- **Edited files**: parsed from `apply_patch` payloads, the
  `*** Add File:` / `*** Update File:` / `*** Delete File:` lines. Observed
  live.

### agy

- **How Leg attaches**: `agy <your args> --log-file
  <~/.leg/sessions/<id>/agy.log>`. agy 1.2.0 is a closed Go binary with no
  hook surface.
- **Usage percentages**: none. agy exposes no percentage anywhere on disk; its
  own status line fetches a quota summary from the backend and writes it
  nowhere. When agy is not walled the board shows a "no % from agy" chip
  instead of empty bars (`src/board/sessions.js`); when it is walled the
  chip shows the wall and its reset.
- **The wall**: `RESOURCE_EXHAUSTED`, "it resets in %s" and "out of quota" in
  the log. Those strings are present in `agy.exe`, and `scanLog()` also reads a
  relative reset out of "resets in \<n>\<s|m|h|d>". Status:
  **observed-live 2026-09-16** <!-- live:agy/agy-resource-exhausted --> —
  `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in
  71h19m42s.` appeared in a session's `agy.log` at 08:02:42Z and walled the
  agent. No payload was kept: the capture call in `src/attach.mjs` was added
  while that session's runner was already running, so
  `fixtures/live/agy/limit-agy-resource-exhausted.json` is still the slot
  for the next one.
- **Prompts and conversation id**: `~/.gemini/antigravity-cli/history.jsonl`,
  one `{ display, timestamp, workspace, conversationId }` per prompt. Observed
  live.
- **One account only**: agy 1.2.0 has no config-directory override, so
  `leg accounts add agy …` is refused.

### grok

- **How Leg attaches**: `grok <your args>` with `--debug-file <~/.leg/sessions/<id>/grok.log>` passed by Leg (`src/attach.mjs` `spawnSpec`).
- **Usage percentages**: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` and `GET https://cli-chat-proxy.grok.com/v1/user?include=subscription` (`LEG_GROK_BILLING_URL` and `LEG_GROK_USER_URL` override), reading the OAuth token stored in `~/.grok/auth.json`. The billing endpoint reports `creditUsagePercent` and `currentPeriod` (with weekly resets). Polled every 60 s (`LEG_USAGE_POLL_MS`). If the token expires or returns 401, usage is marked unknown without crashing, and re-reads `auth.json` on the next poll.
- **The wall**: rate limit signals cited directly from `xai-org/grok-build`:
  - `SamplingError::Api { status: StatusCode::TOO_MANY_REQUESTS }` (`crates/codegen/xai-grok-sampling-types/src/error.rs:304`)
  - `RATE_LIMITED_ERROR_CODE = -32003` and user messages `RATE_LIMITED_USER_MESSAGE_OAUTH` ("You've hit the rate limit for your plan. Try again later.") and `RATE_LIMITED_USER_MESSAGE_API_KEY` ("You've hit the rate limit for your API key. Try again later.") (`crates/codegen/xai-grok-shell/src/sampling/error.rs:15, 18-21`)
  - Headline "Rate limited (429)" and "You've hit the rate limit for your plan" (`crates/codegen/xai-grok-pager/src/app/error_display.rs:263-267`)
  - `StopFailureKind::RateLimit` ("rate_limit") (`crates/codegen/xai-grok-hooks/src/event.rs:306-315`)
  - Free usage exhausted: `FREE_USAGE_USER_MESSAGE` and `FREE_USAGE_EXHAUSTED_ERROR_CODE` ("subscription:free-usage-exhausted") (`crates/codegen/xai-grok-shell/src/sampling/error.rs:30, 33`)
  `src/taps/grok.mjs` scans `grok.log` for these exact signals and extracts reset durations when available.
- **Prompts and session id**: `~/.grok/sessions/<url-encoded-cwd>/prompt_history.jsonl`, recorded per prompt with timestamp, `session_id`, and `prompt`.
- **Accounts**: Supports `GROK_HOME` override. `leg accounts add grok <name>` creates junctioned directories copying `config.toml`.

### Resume prompt per agent

After a hand-off the next agent starts in the same terminal with the pointer
prompt as its first positional argument: `claude "<prompt>"`,
`codex "<prompt>"`, `agy -i "<prompt>"`, `grok "<prompt>"` (`src/attach.mjs` `spawnSpec`).

## Headless adapters (the v0.1 pipeline)

These are what a pipeline card's chain spawns. Unchanged since 0.2.0.

### claude (headless)

- **Binary**: `LEG_CLAUDE_BIN`, else `~/.local/bin/claude.exe` (Windows)
  or `~/.local/bin/claude`, else `claude` on PATH.
- **Argv**: `claude -p --output-format json --permission-mode <mode>`, plus
  `--max-turns <n>`, `--resume <session-id>`, `--model <name>`,
  `--allowedTools <a,b>` when set.
- **Stdin**: `pipe`: the prompt is written to stdin, not argv.
- **Modes**: default `acceptEdits`; allowed `acceptEdits`, `auto`, `plan`,
  `manual`, `dontAsk`.
- **Forbidden flags**: `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`,
  `--permission-mode=bypassPermissions`, `bypassPermissions`.
- **Gotchas**: prints nothing on stdout until the session ends (poll
  `run.json`, never a stdout timeout). Stderr saying "another auth source is
  set" is an `auth_failed` leg, not a limit: it means an
  `ANTHROPIC_API_KEY` or similar is shadowing the subscription login.

### codex (headless)

- **Binary**: `LEG_CODEX_BIN`, else the `@openai/codex` npm package's
  native platform exe (resolved under `%APPDATA%\npm\node_modules\@openai\codex\...`
  on Windows), else `node <bin/codex.js>` via `resolveNpmCliEntry`, else
  `codex` on PATH.
- **Argv**: `codex exec --json -s <mode> -C <cwd> -c
  sandbox_workspace_write.network_access=<true|false>`, plus `-m <model>`,
  `-o <runDir>/last.md`, `resume <session-id>` and the prompt as the last
  positional argument.
- **Stdin**: `ignore`, deliberately. `codex exec` reads stdin whenever it
  is not a TTY and hangs on an open pipe ("Reading additional input from
  stdin..."); a plan-time probe with a pipe hung until it was killed at
  170 s; the same task with stdin closed finished normally (the kept probe
  run took 28 s).
- **Modes**: default `workspace-write`; allowed `read-only`,
  `workspace-write`.
- **Forbidden flags**: `danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `--full-auto`, `--approve-for-me`.
- **Gotchas**: network access is off unless the chain entry sets
  `network: true`. If you run `codex exec` by hand outside Leg, always
  pass the prompt as an argument, never on a pipe.

### agy (headless)

- **Binary**: `LEG_AGY_BIN`, else `%LOCALAPPDATA%\agy\bin\agy.exe`, else
  `agy` on PATH.
- **Argv**: `agy -p "<working-directory preamble>\n\n<prompt>"
  --output-format json --mode <mode> --add-dir <cwd> --print-timeout
  <duration>`, plus `--model <model>`, `--conversation <session-id>`. The
  duration is the card's kill timer converted to Go syntax, for example `90m`.
- **Stdin**: `ignore`.
- **Modes**: default `accept-edits`; allowed `accept-edits`, `plan`.
- **Forbidden flags**: `--dangerously-skip-permissions`.
- **Gotchas**: agy does not act in the process cwd by default: with no
  `--add-dir` it writes into its own scratch workspace
  (`~/.gemini/antigravity-cli/scratch/`, observed live). Leg always passes
  `--add-dir <worktree>` and prefixes the prompt with "Working directory:
  `<worktree>`" so the agent writes where the card expects. `--print-timeout`
  defaults to 5 minutes in the CLI itself; Leg always sets it explicitly
  from the leg's kill timer so the supervisor, not agy, decides what a
  runaway is.

### fake (and fake-claude / fake-codex / fake-agy / fake-nostdin)

- **Binary**: always `node bin/fake-agent.mjs` (`process.execPath` +
  the script path); nothing to install.
- **Argv**: `fake-agent.mjs [--mode <m>] [--max-turns <n>] [--resume <id>]`.
- **Stdin**: `pipe` for `fake`, `ignore` for the `fake-*` named variants
  (`fake-nostdin` is the same agent with stdin ignored), useful for
  exercising both stdin conventions without a real CLI.
- **Modes**: default `acceptEdits`; allowed `acceptEdits`, `plan`,
  `workspace-write`, `read-only`, `accept-edits`, `auto_edit` (a superset
  covering every real adapter's vocabulary, so a chain can mix fakes and
  real adapters without a mode conflict).
- **Forbidden flags**: `--dangerously-skip-permissions`, `--yolo`.
- **What it does**: driven entirely by the `FAKE_MODE` environment
  variable, set per chain entry with `--fake-mode <adapter>=<mode>` (see
  [getting-started.md](getting-started.md#try-a-pipeline-with-no-real-agent)
  for the full list of modes). `fake-claude` / `fake-codex` / `fake-agy` set
  `emulates` to that CLI's name, so the limit classifier applies that CLI's own
  fixtures to it and a demo chain reads like a real fallback.

### grok (headless)

- **Binary**: `LEG_GROK_BIN`, else `~/.grok/bin/grok.exe`, else `grok` on
  PATH.
- **Argv**: `grok --prompt-file <run>/prompt.txt --output-format json
  --permission-mode <mode> --cwd <worktree>`, plus `--max-turns <n>`,
  `-m <model>`, `-r <session-id>`. Every flag was read from `grok --help` on
  grok 1.0.34 (`3736acbc8658`) on 2026-09-17. The prompt travels by file
  rather than on argv because a hand-off prompt carries the whole bundle
  summary and Windows caps one command line at about 32k; with no prompt file
  the adapter falls back to `-p "<prompt>"`. `--cwd` is passed explicitly
  rather than relying on the spawn's working directory: grok can run against a
  shared leader process (`~/.grok/leader.sock`), and a leg must edit its own
  worktree, not whatever directory the leader started in.
- **Stdin**: `ignore`.
- **Modes**: default `acceptEdits`; allowed `default`, `acceptEdits`,
  `auto`, `dontAsk`, `plan`.
- **Forbidden flags**: `--always-approve`, `bypassPermissions`,
  `--permission-mode=bypassPermissions`.
- **Result**: grok's headless writer emits the Claude Code result envelope.
  The field names (`"type":"result"`, `subtype`, `is_error`, `session_id`,
  `result`, `num_turns`, `stop_reason`, `total_cost`) were read out of the
  shipped `grok.exe` on 2026-09-17. An error is the other envelope,
  `{"type":"error","message":…}`, observed live the same day.
- **Status**: registered on 2026-09-17. The probe reached the account and came
  back with a real wall — `API error (status 402 Payment Required): Grok Build
  usage balance exhausted`, exit 1, classified `limit` and handed off — so the
  spawn, the argv, the auth and the wall path are all verified live
  (`fixtures/live/grok/`). The **success** path of a grok leg is still
  unprobed: that needs balance on the account. Until it is, a grok leg whose
  envelope does not parse falls back to the `.leg/DONE` marker and the diff,
  which is what every adapter does when `parseResult` returns null. Re-run
  `node scripts/probe.mjs --adapter grok --repo <toy-repo>` with balance to
  close it.

## Custom adapters

Any other coding-agent CLI becomes a card adapter through a JSON spec in
`$LEG_HOME/adapters/<name>.json`, with no code in this package. This is the
open end of the chain: claude, codex, agy and grok ship with taps and a probe,
and anything else joins as "argv in, JSON out".

A custom adapter runs **cards**: headless, in a worktree, handing off like any
other leg. It is not an interactive `leg <agent>` terminal, because that needs
a usage tap and a wall signal, which only the four built-ins expose.

```
leg adapter template --name muse > muse.json   # a starter spec
leg adapter add muse.json                      # validate and install it
leg adapter check muse                         # the exact command a leg would run
leg card add --repo <path> --task "<t>" --chain muse,claude --queue
leg adapter list | show muse | rm muse
```

The spec:

```json
{
  "name": "muse",
  "bin": "muse",
  "stdin": "ignore",
  "args": ["run", "--json",
           ["--dir", "{{cwd}}"],
           ["--model", "{{model}}"],
           "--prompt-file", "{{promptFile}}"],
  "modes": { "default": "auto", "allowed": ["auto", "readonly"] },
  "forbiddenFlags": ["--unsafe"],
  "result": { "format": "json", "sessionId": "session_id",
              "message": "result", "stopReason": "stop_reason" }
}
```

- **`bin`** is argv[0]. It is spawned directly, never through a shell, so it
  cannot contain `< > | & ;`. `LEG_<NAME>_BIN` overrides it. A `.mjs`, `.cjs`
  or `.js` path runs under this Node.
- **`args`** is a list of strings and groups. Placeholders: `{{prompt}}`,
  `{{promptFile}}`, `{{cwd}}`, `{{mode}}`, `{{model}}`, `{{resume}}`,
  `{{maxTurns}}`, `{{runDir}}`. A bare string is always kept; a **group** (a
  nested array) is dropped whole when a placeholder inside it has no value, so
  `["--model", "{{model}}"]` disappears rather than passing a bare `--model`.
  Something has to carry the prompt: `{{prompt}}`, `{{promptFile}}`, or
  `"stdin": "pipe"`.
- **`modes`** is validated before anything spawns, the same way a built-in's
  is: a chain entry naming a mode outside `allowed` throws `forbidden flag`.
- **`forbiddenFlags`** is yours to add to. The flags that turn a supervised
  agent into an unsupervised one are refused whatever the spec says, in `args`,
  in `modes` and at argv time (`NEVER_ALLOWED`, `src/adapters/custom.mjs`).
- **`result.format`** is `json` (the first parseable object in stdout),
  `jsonl` (the last line carrying the message field) or `text` (no parsing).
  `sessionId`, `message` and `stopReason` are dotted paths, so
  `"sessionId": "thread.id"` reads `{"thread":{"id":…}}`. With `text`, or when
  nothing parses, the leg is judged by its `.leg/DONE` marker and its diff,
  which is what happens for any adapter whose `parseResult` returns null.

A broken spec is reported, never thrown: `leg adapter list` names the file and
the reason, and the board, the scheduler and `leg card add` carry on without
it. A spec may not take a built-in's name. The directory is re-read whenever
the list is asked for, keyed on its entries, so a spec added while the board is
up appears in the New card form without a restart.

## How to add a built-in adapter

An adapter is a plain object (see `src/adapters/common.mjs` for the shared
helpers, `src/adapters/fake.mjs` for the simplest full example):

```js
{
  name: 'mycli',
  stdin: 'pipe' | 'ignore',
  modes: { default: 'acceptEdits', allowed: ['acceptEdits', 'plan'] },
  forbiddenFlags: ['--any-bypass-flag'],
  emulates: null,             // optional: another registered adapter's name
  resolve() { return { bin, viaNode, entry } },
  argv(opts) { return { bin, args } },   // opts: mode, maxTurns, resume, cwd, prompt, model, ...
  env(base) { return sanitizeEnv(base) },   // from src/env.mjs, always
  parseResult(text) { return { session_id, last_message, stop_reason, raw } | null },
}
```

1. Write `src/adapters/<name>.mjs` exporting that shape as `default`.
   `argv()` must call `assertAllowed(adapter, opts)` (from
   `src/adapters/common.mjs`) first, so a forbidden mode or flag throws
   before anything spawns.
2. Add an entry to `REGISTRY` in `src/adapters/index.mjs`:
   `<name>: { path: './<name>.mjs' }`.
3. Add its limit/auth/launch signal fixtures under `fixtures/limits/` (see
   the existing ones for the JSON shape `src/limits.mjs` expects: `id`,
   `adapter`, `source`, `produced_by`, `where`, `text`, `classification`).
4. Run the probe script against a real login before trusting it:

   ```
   node scripts/probe.mjs --adapter <name> --repo <existing-git-repo> [--mode <m>] [--timeout-s 300]
   ```

   It runs one real tiny task (write a file, write `.leg/DONE`) through
   the same runner a card uses, and prints `probe <name>: exit=<code>
   file=<yes|no> done=<yes|no> auth_source=<yes|no> seconds=<n>`. Keep the
   evidence it produces under `fixtures/live/<name>/` and cite it in
   [cli-contracts.md](cli-contracts.md), the way every existing adapter's
   section does.

An interactive tap is a separate, larger job: a new agent needs a
`src/taps/<name>.mjs` that answers three questions (what are the usage
percentages, what does the wall look like, what are the prompts and edited
files) and a branch in `src/attach.mjs` `spawnSpec`.

## See also

- [cli-contracts.md](cli-contracts.md): the full evidence trail, exit
  codes, the interactive tap sources, and every limit-signal fixture, tagged
  observed-live or docs-only.
- [configuration.md](configuration.md): the `LEG_<ADAPTER>_BIN`
  overrides and the accounts layout.
- [concepts.md](concepts.md): sessions, usage windows, the interactive
  hand-off, and how a headless leg's outcome is classified.
