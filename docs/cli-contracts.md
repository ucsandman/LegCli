# CLI contracts

What Leg knows about each coding-agent CLI, where every fact came from, and
which facts were observed live on the build machine versus read from `--help`
or docs. Two contracts per CLI: the headless argv a pipeline leg spawns
(§ per CLI below), and the interactive tap `leg <agent>` reads
(§ [Interactive taps](#interactive-taps)). Evidence:
`fixtures/help/<cli>.txt` (raw `--help`), `fixtures/live/<cli>/` (one real tiny
task per CLI, run through `src/runner.mjs launch` on 2026-09-11 UTC, the
evening of 2026-09-10 locally; paths under the local home directory are
replaced with `~`), and the interactive checks run on 2026-09-11.

Every fact line ends with `(source: …)`. `observed-live` means the build machine
did it; `docs-only` means the CLI's own `--help` or documentation says so and
Leg has not seen it happen.

Probe task (identical for every CLI, `scripts/probe.mjs`): "Create a file named
hello-<name>.txt in the current directory containing exactly the word hi.
Then create the directory .leg if it is missing and write the file
.leg/DONE containing the single line: done. Do nothing else. Do not ask
questions."

| CLI | version | probe result | adapter |
|-----|---------|--------------|---------|
| claude | 2.1.268 | exit 0, file yes, DONE yes, 20 s | `src/adapters/claude.mjs` |
| codex | codex-cli 0.153.4 | exit 0, file yes, DONE yes, 28 s | `src/adapters/codex.mjs` |
| agy | 1.2.0 | attempt 1 exit 0 but wrote to its scratch workspace; attempt 2 (`--add-dir`) exit 0, file yes, DONE yes, 41 s | `src/adapters/agy.mjs` |
| grok | 1.0.34 | exit 1, no file, no DONE: the account answered `402 Payment Required: Grok Build usage balance exhausted`, classified `limit` (re-probed 2026-09-17; the 2026-09-11 run on 0.2.51 was not logged in) | `src/adapters/grok.mjs` |

The auth-source check: the build shell carried `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` (injected by the shell profile). Every adapter's `env()` deletes
them (`src/env.mjs`). No fixture contains "another auth source"
(`grep -ril "another auth source" fixtures/live` is empty), claude's and agy's
stderr are 0 bytes, and codex's is the one stdin notice. observed-live.

## claude

- Version 2.1.268 (source: `claude --version`, fixtures/help/claude.version.txt).
- Binary: `~/.local/bin/claude.exe` (native exe, 211 MB); Leg resolves it
  there first, else `claude` on PATH; `LEG_CLAUDE_BIN` overrides (source: `ls
  ~/.local/bin/claude.exe`; src/adapters/claude.mjs `resolve()`).
- Headless argv (exact, from fixtures/live/claude/cmd.txt):
  `claude.exe -p --output-format json --permission-mode acceptEdits`
  with the prompt on **stdin** (stdin: `pipe`). Optional: `--max-turns N`,
  `--resume <session-id>`, `--model <alias|name>`, `--allowedTools a,b`
  (source: `claude --help` lines for each flag; observed-live for the base argv).
- Output: ONE JSON object on stdout, printed only when the session ends
  (test/lessons.test.mjs `json-only-at-end`; observed-live: 20 s of silence
  then the object). Top-level
  keys observed: `type:"result"`, `subtype:"success"`, `is_error`,
  `stop_reason:"end_turn"`, `terminal_reason:"completed"`, `api_error_status`,
  `session_id`, `num_turns`, `result` (final text), `permission_denials` (array),
  `usage{input_tokens,output_tokens,cache_read_input_tokens,…}`, `modelUsage`,
  `total_cost_usd`, `duration_ms` (source: fixtures/live/claude/out.log).
  Leg reads `session_id`, `result`, `stop_reason`, `subtype`, `is_error`,
  `terminal_reason`, `api_error_status`, `permission_denials.length`.
- Model: with no `--model`, the account's default model answered
  (`modelUsage` names claude-fable-5-1 and claude-haiku-4-5). A chain entry
  should name `model` to control spend; Leg passes it through as `--model`
  (source: fixtures/live/claude/out.log `modelUsage`; `claude --help --model`).
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | completed, JSON printed | observed-live, fixtures/live/claude/run.json |
  | non-zero | launch or fatal error; JSON may be absent | docs-only (`claude --help` does not enumerate codes; phase 4 records the fixture cases) |

- Permission modes (`--permission-mode` choices in 2.1.268): `acceptEdits`,
  `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (source: `claude
  --help`). Leg: default `acceptEdits`; allowed `acceptEdits`, `auto`, `plan`,
  `manual`, `dontAsk`; forbidden `bypassPermissions`,
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`.
  `acceptEdits` allowed the file write headless (observed-live). The Agent tool
  is never disallowed (test/lessons.test.mjs `agent-tool-never-disallowed`).
  `--permission-prompts none` exists
  ("anything that would prompt is denied automatically") and is not passed;
  headless `-p` has no host to answer prompts anyway (source: `claude --help`).
- Resume: `--resume <session-id>` (docs-only until phase 5 exercises it);
  `--fork-session` creates a new id on resume (source: `claude --help`).
- Child-process rules: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT`,
  `CLAUDE_PLUGIN_DATA` deleted; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` set
  (source: src/env.mjs; the "another auth source" check above, observed-live).
- Limit signals: see § Limit signals (phase 4).

## codex

- Version codex-cli 0.153.4 (source: `codex --version`).
- Binary: npm package `@openai/codex` whose `bin/codex.js` only spawns the
  platform package's native exe. Leg spawns that exe directly:
  `~/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
  (one process to kill); falls back to `node <bin/codex.js>` via
  `resolveNpmCliEntry`, then `codex` on PATH; `LEG_CODEX_BIN` overrides
  (source: `bin/codex.js` read 2026-09-10; fixtures/live/codex/cmd.txt).
- Headless argv (exact, from cmd.txt):
  `codex.exe exec --json -s workspace-write -C <worktree> -c sandbox_workspace_write.network_access=false -o <run>/last.md "<prompt>"`.
  Prompt is the last positional argument; **stdin is `ignore`**: `codex exec`
  reads stdin whenever it is not a TTY and hangs on an open pipe ("Reading
  additional input from stdin..."; plan-time probe hung 170 s with a pipe,
  finished in 20 s with stdin closed; observed-live). `-o` writes the final
  agent message to a file (observed-live: fixtures/live/codex/last.md).
- Output: JSONL events on stdout (source: fixtures/live/codex/out.log):
  `thread.started{thread_id}`, `turn.started`, `item.started/item.completed{item{type:
  agent_message|command_execution|error, text|command|message}}`,
  `turn.completed{usage{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`.
  An `item.type:"error"` is a non-fatal notice (observed: "Skill descriptions
  were shortened…"). Leg reads `thread_id` as the session id, the last
  `agent_message` text, `turn.completed` as the stop reason, and the error
  messages.
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | turn completed | observed-live, fixtures/live/codex/run.json |
  | (none) | hangs with an open stdin pipe until it is killed | observed at plan time; no artifact kept, the behaviour is pinned by test/lessons.test.mjs `codex-stdin-ignored` |
  | non-zero | launch/auth/fatal | docs-only |

- Sandbox modes (`-s`): `read-only`, `workspace-write`, `danger-full-access`
  (source: `codex exec --help`). Leg: default `workspace-write`; allowed
  `read-only`, `workspace-write`; forbidden `danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
  `--approve-for-me` (routes approvals through automatic review), `--full-auto`
  (not present in 0.153.4 `exec --help`; kept on the forbidden list). Blast
  radius is `-C <worktree>`; network off unless the chain entry sets
  `network: true` (PROTOCOL sandbox ladder). `workspace-write` allowed the
  write headless (observed-live).
- Resume: `codex exec resume [SESSION_ID] [PROMPT]` with `--last` for the newest
  (source: `codex exec resume --help`). Leg's adapter emits
  `exec … resume <thread_id> <prompt>`; docs-only until phase 5 exercises it.
- Limit signals: see § Limit signals (phase 4).

## agy

- Version 1.2.0 (source: `agy --version`).
- Binary: `~/AppData/Local/agy/bin/agy.exe` (native); `LEG_AGY_BIN` overrides
  (source: `where agy`; src/adapters/agy.mjs).
- Headless argv (exact, from cmd.txt):
  `agy.exe -p "<working-directory preamble + prompt>" --output-format json --mode accept-edits --add-dir <worktree> --print-timeout 90m`;
  stdin `ignore`.
  - **agy does not work in the process cwd.** Attempt 1 (no `--add-dir`) exited
    0 and wrote `hello-agy.txt` under `~/.gemini/antigravity-cli/scratch/`
    (observed-live, fixtures/live/agy/attempt-1-scratch-workspace.out.log).
    Attempt 2 adds `--add-dir <worktree>` and prefixes the prompt with
    "Working directory: <worktree>"; it wrote both files in the repo
    (observed-live).
  - `--print-timeout` defaults to 5m0s; Leg sets it from the kill timer in Go
    duration syntax so the supervisor decides what a runaway is (source: `agy --help`).
- Output: one JSON object: `conversation_id`, `status:"SUCCESS"`, `response`,
  `duration_seconds`, `num_turns`, `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`
  (observed-live, fixtures/live/agy/out.log). Leg reads `conversation_id` as
  the session id, `response`, `status`.
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | `status: SUCCESS` | observed-live (both attempts; attempt 1 was a success in the wrong directory) |
  | non-zero | fatal/auth | docs-only |

- Modes (`--mode`): `accept-edits`, `plan` (source: `agy --help`). Leg: default
  `accept-edits`; forbidden `--dangerously-skip-permissions`. `accept-edits`
  allowed the write headless (observed-live).
- Resume: `--conversation <id>` (by id) or `--continue` (most recent) (source:
  `agy --help`; docs-only until phase 5).
- Limit signals: see § Limit signals (phase 4).

## grok

- Version grok 1.0.34 (3736acbc8658) [stable] (source: `grok --version`,
  2026-09-17). The 2026-09-11 sweep saw 0.2.51 on a machine with no login; every
  line below was re-read on 1.0.34.
- Binary: `~/.grok/bin/grok.exe` (native; also an npm shim on PATH);
  `LEG_GROK_BIN` overrides (source: `where grok`).
- Headless argv (from cmd.txt): `grok.exe --prompt-file <run>/prompt.txt
  --output-format json --permission-mode acceptEdits --cwd <worktree>`; stdin
  `ignore`. The file form is used whenever the runner has written a prompt file,
  because a hand-off prompt carries the whole bundle summary and Windows caps a
  command line near 32k; with none, the adapter falls back to `-p "<prompt>"`
  (source: `grok --help`, `-p, --single <PROMPT>` and `--prompt-file <PATH>`).
  `--cwd <CWD>` is passed explicitly rather than trusting the spawn's working
  directory, because grok can run against a shared leader process
  (`~/.grok/leader.sock`) and a leg must edit its own worktree.
- Output: the Claude Code result envelope. `"type":"result"`, `subtype`,
  `is_error`, `session_id`, `result`, `num_turns`, `stop_reason`, `total_cost`,
  read out of the shipped `grok.exe` on 2026-09-17 alongside the streaming
  types (`assistant`, `system`, `text`, `usage`, `end`, `error`). An error is
  the other envelope, `{"type":"error","message":…}` (observed-live,
  `fixtures/live/grok/out.log`).
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 1 | printed `{"type":"error","message":"Internal error: … API error (status 402 Payment Required): Grok Build usage balance exhausted"}` and did no work: the account had no balance left | observed-live 2026-09-17, fixtures/live/grok/out.log |
  | 0 | printed JSON with `stopReason:"Cancelled"` and did no work: the CLI was not logged in, printed a device-code prompt on stderr and gave up after ~58 s | observed-live 2026-09-11 on 0.2.51 |

  The 402 is a wall, not a failure: `fixtures/limits/grok/grok-balance-exhausted.json`
  classifies it `limit`, so the card hands off instead of stopping. None of the
  rate-limit strings the tap watched for appear in a 402, which is why an
  exhausted grok terminal used to sit there; `src/taps/grok.mjs` reads it too now.
- Permission modes: `default`, `acceptEdits`, `auto`, `dontAsk`, `plan`, and a
  bypass mode Leg never passes (source: `grok --help`). Leg: default
  `acceptEdits`; forbidden the bypass mode and `--always-approve`.
- Login: `grok login` (source: `grok --help` Commands).
- **Verdict: registered, wall path verified, success path not.** The probe
  reached the account through the real runner, so the binary resolution, the
  argv, the auth and the limit classification are all observed-live. A leg that
  completes its task has not been seen, because that needs balance on the
  account; until it is, a grok leg whose envelope does not parse is judged by
  its `.leg/DONE` marker and its diff, as every adapter is. Re-run
  `node scripts/probe.mjs --adapter grok --repo <toy>` with balance to close it.

## `leg harness` (the portable harness)

What the command reads and writes per client, each fact from the engine's
adapter source (`src/harness/vendor/agnostic-ai/engine/harness/{sources,targets}/*.cjs`,
byte for byte the Agnostic AI engine) and verified by
`test/harness-*.test.mjs` against fixture homes on 2026-09-16.

| client | read as a source | written as a destination | shim |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` (+ `@imports` inside the home), `SOUL.md`, the hooks and permissions of its settings file, the `mcpServers` of `~/.claude.json` and `~/.claude/.mcp.json` (the oauth block is never read), `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md` | `~/.claude/leg-rules.md` + one `@` line appended to `CLAUDE.md`; owned hook groups and permission entries in its settings file; owned servers in `~/.claude.json`; `agents/`, `commands/`, skill links | none: the bundle is Claude's dialect |
| Codex CLI | `~/.codex/AGENTS.md`, `config.toml` (`hooks.*`, `mcp_servers.*`), `agents/*.toml`, `prompts/*.md`, `skills/`, `rules/*.rules` (per-invocation absolute-path approvals skipped; `auth.json` never read) | `AGENTS.md` (whole file, owned), `config.toml` regions `hooks` (with `[hooks.state]` trust hashes, self-tested), `skills` (duplicate disables), `mcp`; `agents/*.toml`; `prompts/*.md`; skill links; `rules/leg-harness.rules` prefix rules | none |
| Antigravity CLI | not a source | `~/.gemini/GEMINI.md` (owned), the `leg-harness` key in `~/.gemini/config/hooks.json`, `mcp_config.json` servers, `config/agents`, `config/commands`, `config/skills` links | the engine's hook shim, chained with `++` |
| Gemini CLI | not a source | `GEMINI.md`, owned hook groups in its settings file, `commands/*.toml`, `mcpServers`, skill links | shim |
| Grok CLI | no | no (reported `unsupported`) | |

Exit codes: `0` fine; `1` stale or attention (`check`, `sync`) or a doctor
failure; `2` usage; `3` not captured, no source, or consent declined
(`enable` without `--yes` and without a terminal). `--json` on `status`,
`inspect`, `sync`, `check`, `explain`, `history`, `doctor` prints the same
record the board reads.

## Interactive taps

What `leg claude|codex|agy|grok` reads while the real interactive CLI runs. Same
tagging rule: `observed-live 2026-09-11` means the build machine did it;
`docs-only` means the CLI's own source or documentation says so and Leg has
not seen it happen. Machine: Claude Code 2.1.268, codex-cli 0.153.4, agy 1.2.0.

Shared: the agent is spawned with stdio inherited and the user's arguments
passed through (`src/attach.mjs` `spawnSpec`); the child environment is
`sanitizeEnv(process.env, { interactive: true })` plus the account's config-dir
variable and `LEG_SESSION` (source: src/attach.mjs, src/env.mjs).

### claude tap

- Attach: `claude <args> --settings <LEG_HOME>/sessions/<id>/claude-settings.json`
  (source: src/attach.mjs `spawnSpec`; src/taps/claude.mjs `writeSettings`).
  Hooks in a `--settings` file merge with the user's rather than replacing
  them; `statusLine` is the one key that replaces, so Leg runs the user's own
  command first (source: code.claude.com/docs/en/settings;
  src/taps/claude.mjs `userStatusLine`). observed-live 2026-09-11: a Leg
  session ran with every user hook still firing.
- Hooks written (source: src/taps/claude.mjs `settingsFor`): `SessionStart`,
  `UserPromptSubmit`, `PostToolUse` with matcher `Edit|Write|MultiEdit|NotebookEdit`,
  `Stop`, `StopFailure`, `SessionEnd`, each
  `node <src>/hook.mjs claude-hook --session <id>` with a 20 s timeout.
  observed-live 2026-09-11 (hook.log in the session directory).
- `autoContinueAtUsageLimit: false` in the same file, because Leg owns the
  hand-off (source: src/taps/claude.mjs `settingsFor`).
- Usage: `GET https://api.anthropic.com/api/oauth/usage`
  (`LEG_CLAUDE_USAGE_URL` overrides) with `Authorization: Bearer <accessToken>`
  from `<CLAUDE_CONFIG_DIR>/.credentials.json` key `claudeAiOauth`, and header
  `anthropic-beta: oauth-2025-04-20`; response fields `five_hour` and
  `seven_day`, each `{ utilization, resets_at }`; polled every
  `LEG_USAGE_POLL_MS` ms, default 60000 (source: src/taps/claude-usage.mjs).
  observed-live 2026-09-11: real windows came back and were written to
  `<LEG_HOME>/usage/claude--default.json`; a seven_day window at 93 %
  raised the amber warning.
- The wall: `StopFailure` hook with `error: rate_limit` (source:
  https://code.claude.com/docs/en/hooks#stopfailure).
  **observed-live 2026-09-11** <!-- live:claude/rate_limit -->: a real
  `StopFailure` with `error: rate_limit` (a 429 `rate_limit_error`) arrived
  at 07:46:37Z and is kept, scrubbed, as
  `fixtures/live/claude/limit-rate_limit.json` (src/live-capture.mjs). The
  path can also be run live with `leg sessions simulate-limit` (the same
  payload through `src/hook.mjs`, marked `leg_simulated`, never kept as
  evidence).
- Status line, not usable on 2.1.268: a custom `statusLine` command passed
  through `--settings`, and again through a project
  `.claude/settings.local.json`, was not run at all when it was tried; an
  `echo` command at both levels left the built-in status line in place while
  hooks from the same `--settings` file fired (no artifact kept; note in the
  src/taps/claude-usage.mjs header, 2026-09-11). Leg still writes the
  `statusLine` entry, which records the
  same `rate_limits.five_hour` / `seven_day` fields
  (https://code.claude.com/docs/en/statusline), so the endpoint poll becomes a
  fallback if a later build honours it.

### codex tap

- Attach: nothing injected. `codex <args>` runs as it always does, and Leg
  finds the session's rollout file afterwards (source: src/attach.mjs
  `spawnSpec`). Reason: injecting a hook makes codex show its hooks-review
  prompt on every Leg session.
- Which file: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, matched on
  `session_meta.payload.cwd` equal to the session's cwd with a birth time or
  mtime at or after the spawn time, five seconds of slack (source:
  src/taps/codex.mjs `findRollout`). observed-live 2026-09-11: the right
  rollout was found for a real hand-off. The file's mtime is not a content
  clock on Windows, six rollouts from that day had mtimes 7 s to 9 min
  behind their last line, so nothing depends on the two matching.
- Usage: read-only app-server `account/rateLimits/read`, polled every 60
  seconds by the board and active attach. Leg maps windows by duration,
  including 300 minutes to 5h and 10080 minutes to 7d, rather than assuming
  `primary` or `secondary` names. It sends no model turn and does not hardcode
  a quota; only explicit backend availability clears a previous wall (sources:
  `src/taps/codex.mjs`, `src/attach.mjs`, `src/server.mjs`, `src/usage.mjs`).
- The wall: `event_msg.task_complete.error` with
  `codex_error_info: "usage_limit_exceeded"` and message "You've hit your usage
  limit … try again at \<date>" (source:
  github.com/openai/codex `codex-rs/protocol/src/error.rs`
  `UsageLimitReachedError`). The event shape was read from local rollouts;
  the error itself is **observed-live 2026-09-15** <!-- live:codex/usage_limit_exceeded -->.
  A `task_complete.error` with `codex_error_info: usage_limit_exceeded` walled
  a codex leg once, but no scrubbed payload was kept, so
  `fixtures/live/codex/limit-usage_limit_exceeded.json` is still the slot for
  the first one.
- Transcript: `response_item.message` with `role: user` and
  `content[].type: input_text` for prompts; `output_text` and
  `task_complete.last_agent_message` for assistant text (source:
  src/taps/codex.mjs; observed-live 2026-09-11).
- Edited files: the `*** Add File:` / `*** Update File:` / `*** Delete File:`
  lines of an `apply_patch` payload (source: src/taps/codex.mjs; observed-live
  2026-09-11).

### agy tap

- Attach: `agy <args> --log-file <LEG_HOME>/sessions/<id>/agy.log` (source:
  src/attach.mjs `spawnSpec`). agy 1.2.0 is a closed Go binary with no hook
  surface.
- Usage: none. No percentage is written to any file agy owns; its own status
  line fetches a quota summary from the backend and stores nothing (source:
  src/taps/agy.mjs header).
- The wall: `RESOURCE_EXHAUSTED`, "it resets in %s", "out of quota", and
  "quota exhausted/exceeded" in the log, plus a relative reset parsed out of
  "resets in \<n>\<s|m|h|d>" (source: strings present in `agy.exe`;
  src/taps/agy.mjs `scanLog`).
  **observed-live 2026-09-16** <!-- live:agy/agy-resource-exhausted -->:
  `RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in
  71h19m42s.` appeared in a session's `agy.log` at 08:02:42Z, `scanLog` read
  the relative reset, and the agent was walled. No payload was kept, the
  capture call in `src/attach.mjs` was added while that session's runner was
  already running, so `fixtures/live/agy/limit-agy-resource-exhausted.json`
  is still the slot for the next one.
- Prompts and conversation id: `~/.gemini/antigravity-cli/history.jsonl`, one
  `{ display, timestamp, workspace, conversationId }` per prompt (source:
  src/taps/agy.mjs `historyFile`; shape observed on disk, last written
  2026-09-09, the 2026-09-11 agy leg produced no history entry).
- One account only: agy 1.2.0 has no config-directory override, so
  `LAYOUT.agy.env` is `null` and `accounts add agy` is refused (source:
  src/accounts.mjs).

### grok tap

- Attach: `grok <args> --debug-file <LEG_HOME>/sessions/<id>/grok.log` (source:
  src/attach.mjs `spawnSpec`).
- Usage: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` and
  `GET https://cli-chat-proxy.grok.com/v1/user?include=subscription` with
  `Authorization: Bearer <token>` read from `~/.grok/auth.json` (per-scope
  key map or direct object). The billing endpoint reports `creditUsagePercent`
  and `currentPeriod` (with weekly reset timestamp `end`). Polled every 60 s
  (`LEG_USAGE_POLL_MS`). Token expiry and HTTP 401 are handled gracefully
  without throwing, marking usage unknown until re-authenticated.
  (source: src/taps/grok.mjs; probe against xAI proxy).
- The wall: exact rate-limit signals cited from `xai-org/grok-build` (Rust):
  - `SamplingError::Api { status: StatusCode::TOO_MANY_REQUESTS }`
    (`crates/codegen/xai-grok-sampling-types/src/error.rs:304`)
  - `RATE_LIMITED_ERROR_CODE = -32003` and messages
    `RATE_LIMITED_USER_MESSAGE_OAUTH` ("You've hit the rate limit for your plan. Try again later.")
    and `RATE_LIMITED_USER_MESSAGE_API_KEY` ("You've hit the rate limit for your API key. Try again later.")
    (`crates/codegen/xai-grok-shell/src/sampling/error.rs:15, 18-21`)
  - Headline "Rate limited (429)" and "You've hit the rate limit for your plan"
    (`crates/codegen/xai-grok-pager/src/app/error_display.rs:263-267`)
  - `StopFailureKind::RateLimit` ("rate_limit")
    (`crates/codegen/xai-grok-hooks/src/event.rs:306-315`)
  - Free usage exhausted: `FREE_USAGE_USER_MESSAGE` and `FREE_USAGE_EXHAUSTED_ERROR_CODE`
    ("subscription:free-usage-exhausted")
    (`crates/codegen/xai-grok-shell/src/sampling/error.rs:30, 33`)
  `src/taps/grok.mjs` scans `grok.log` for these patterns and parses reset duration.
- Prompts and session id: `~/.grok/sessions/<url-encoded-cwd>/prompt_history.jsonl`,
  one `{ timestamp, session_id, prompt }` per entry (source: src/taps/grok.mjs `promptsSince`).
- Accounts: `GROK_HOME` override supported; `leg accounts add grok <name>` creates
  junctioned directories with copied `config.toml` (source: src/accounts.mjs).

### Usage store and the chooser

- `<LEG_HOME>/usage/<agent>--<account>.json`:
  `{ five_hour: {pct, resets_at}, seven_day: {…}, limited_until,
  limited_reason, source, updated_at, buckets, walls, history, extra_usage,
  facts }` (source: src/usage.mjs). The last five are the per-model half of the
  record: measured buckets, walls attributed from wording, a 24-sample ring per
  bucket, the credits block and agent-measured strings. See
  [concepts.md](concepts.md).
- Warning threshold `WARN_PCT`, default 85, from `LEG_WARN_PCT`; the warning
  is an amber card, an event, and one terminal bell (source: src/usage.mjs,
  src/attach.mjs).
- `markLimited()` takes the reset the CLI reported; failing that the soonest
  known window reset; failing that now + 5 h (source: src/usage.mjs
  `DEFAULT_LIMIT_S`).
- `candidates()` yields the other accounts of the same agent first, then the
  remaining agents in the order claude, codex, agy, wrapping, so every option
  is tried once. `chooseNext()` skips any option still walled and returns the
  walled ones sorted by reset (source: src/usage.mjs).

### Session store

`<LEG_HOME>/sessions/<id>/` holds `session.json`, `events.jsonl`,
`hook.log`, and, per agent, `claude-settings.json` or `agy.log`;
`control.json` appears only once the board has asked for a hand-off or an
end (source: src/sessions.mjs header, src/attach.mjs). Statuses and event
types are listed
in [VOCABULARY.md](VOCABULARY.md). Board routes: `GET /api/sessions`,
`GET /api/sessions/:id`, `POST /api/sessions/:id/handoff`,
`POST /api/sessions/:id/end`, `DELETE /api/sessions/:id`, with the list pushed
as the SSE `sessions` event (source: src/server.mjs, src/board/sessions.js).

### History index

`<LEG_HOME>/history/index.json` is the one file `leg history` writes: per
provider, per transcript, size, mtime and a small scrubbed record (source:
src/history/index.mjs). What each provider reads from its CLI's own store,
with the observed file and field names, is the header of each
`src/history/providers/<name>.mjs`; the support matrix and the resume
commands quoted from each CLI's `--help` (observed-live 2026-09-16: `claude
--resume <id>`, `codex resume <id>`, `grok --resume <id>`, `agy --conversation
<id>`; copilot has none Leg has verified) are in [history.md](history.md).
Board routes, owner only: `GET /api/history`, `GET /api/history/:id`,
`GET /api/history/providers`, `POST /api/history/refresh`,
`GET /api/worktrees` (source: src/server.mjs, src/board/history.js).

## Limit signals

Recorded in `fixtures/limits/<group>/<id>.json` and classified by
`src/limits.mjs` (`classify()`); the runner writes the outcome into
`run.json.outcome` with the matched `signal`. Every `limit` row below is
still **docs-only**: its text comes from the CLI's own documentation or
source, cited in "produced by". Real limits from all three agents were seen
on 2026-09-11, but only the claude payload was kept as evidence
(`fixtures/live/claude/limit-rate_limit.json`); the codex and agy ones went
to the session ledger, not to `fixtures/limits/`. The observed-live rows are
the non-limit cases the probes actually hit and the detector must never
mistake for a limit.

Outcome precedence (`src/limits.mjs`): spawn error → `launch_failed`; stderr
"another auth source is set" or an `auth` fixture → `auth_failed` (wins over
any limit text, even with exit 0); killed from the board → `killed`; kill timer
→ `stalled`; exit 0 + `.leg/DONE` → `completed`; adapter-specific then
generic `limit` fixture → `limit`; `launch` fixture → `launch_failed`; exit 0 +
changes, no DONE → `incomplete`; exit 0, nothing changed → `no_progress`;
non-zero exit → `failed`. Every outcome except `completed`, `auth_failed` and
`killed` asks the chain to hand off.

<!-- limits-table:start -->
Generated by `node scripts/limits-table.mjs` from 24 fixtures (6 observed-live, 18 docs-only). Classification `limit` hands the card to the next agent as a usage limit; `auth` is a failed launch (never a limit); `launch` is a failed launch that the next agent may still try; `budget` is a turn or spend cap set by Leg itself; `info` must never classify as a limit.

| id | adapter | class | where | source | text (excerpt) | produced by |
|----|---------|-------|-------|--------|----------------|-------------|
| agy-resource-exhausted | agy | limit | any | **docs-only** | resource-exhausted | `agy changelog` ("Fixed personal accounts hitting a resource-exhausted error at startup"); agy --help documents no limit wording; falls back to the generic matchers |
| claude-budget-limit | claude | budget | any | **docs-only** | Budget limit reached | https://code.claude.com/docs/en/cli-reference (--max-budget-usd) |
| claude-fable-limit | claude | limit | any | **observed-live** | You've reached your Fable limit. Run /usage-credits to continue or switch models with /mod | fixtures/live/claude/limit-rate_limit.json: StopFailure error rate_limit, last_assistant_message on the real run, 2026-09-11 (a per-model wall: the account's session and weekly windows were open) |
| claude-max-turns | claude | budget | stdout | **observed-live** | {"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"tool_use","ter | fixtures/real-run/leg1/out.log: `claude -p --max-turns 2` on the real run, 2026-09-10 (docs: https://code.claude.com/docs/en/cli-reference --max-turns "Exits with an error when the limit is reached") |
| claude-model-limit | claude | limit | any | **docs-only** | You’ve hit your Opus limit | https://code.claude.com/docs/en/costs ("You’ve hit your Opus limit" / "You’ve hit your Sonnet limit") |
| claude-session-limit | claude | limit | any | **docs-only** | You’ve hit your session limit | https://code.claude.com/docs/en/costs (section: When a developer asks about a limit) |
| claude-weekly-limit | claude | limit | any | **docs-only** | You’ve hit your weekly limit | https://code.claude.com/docs/en/costs (section: When a developer asks about a limit) |
| codex-quota-exceeded | codex | limit | any | **docs-only** | quota exceeded | github.com/openai/codex codex-rs/response-debug-context/src/lib.rs (ApiError::QuotaExceeded => "quota exceeded") |
| codex-rate-limit-exceeded | codex | limit | any | **docs-only** | rate limit exceeded:  | github.com/openai/codex codex-rs/codex-api/src/error.rs (#[error("rate limit exceeded: {message}")]) |
| codex-skills-notice | codex | info | stdout | **observed-live** | Skill descriptions were shortened to fit the skills context budget. Codex can still see ev | fixtures/live/codex/out.log (item.completed, item.type=error) from scripts/probe.mjs --adapter codex, 2026-09-10 |
| codex-usage-limit-reached | codex | limit | any | **docs-only** | Usage limit reached. You've reached your usage limit. Increase your limits to continue | github.com/openai/codex codex-rs/tui/src/chatwidget/turn_runtime.rs (WorkspaceOwnerUsageLimitReached) |
| codex-usage-limit | codex | limit | any | **docs-only** | You’ve hit your usage limit for {limit_name}. Switch to another model now, | github.com/openai/codex codex-rs/protocol/src/error.rs (gh search code "usage limit" --repo openai/codex, 2026-09-10) |
| generic-429 | * | limit | any | **docs-only** | 429 Too Many Requests | generic HTTP matcher (429 Too Many Requests); lowest priority |
| generic-overloaded | * | limit | any | **docs-only** | overloaded_error | generic matcher (Anthropic API 529 overloaded_error); lowest priority |
| generic-quota | * | limit | any | **docs-only** | quota | generic matcher; lowest priority |
| generic-rate-limit | * | limit | any | **docs-only** | rate limit | generic matcher; lowest priority |
| generic-resource-exhausted | * | limit | any | **docs-only** | RESOURCE_EXHAUSTED | generic matcher (gRPC RESOURCE_EXHAUSTED); lowest priority |
| generic-usage-limit | * | limit | any | **docs-only** | usage limit | generic matcher; lowest priority |
| grok-balance-exhausted | grok | limit | any | **observed-live** | API error (status 402 Payment Required): Grok Build usage balance exhausted | grok 1.0.34 -p --output-format json on an account with no balance left, 2026-09-17: stdout {"type":"error","message":"Internal error: {   \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",   \"http_status\": 402 }"}, exit 1 |
| grok-not-logged-in | grok | auth | stderr | **observed-live** | To sign in, open this URL in your browser:    https://accounts.x.ai/oauth2/device?user_cod | fixtures/live/grok/err.log from scripts/probe.mjs --adapter grok, 2026-09-10 (stdout JSON stopReason: Cancelled, exit 0) |
| grok-rate-limit | grok | limit | any | **docs-only** | You've hit the rate limit for your plan. Try again later. | crates/codegen/xai-grok-shell/src/sampling/error.rs:18 (RATE_LIMITED_USER_MESSAGE_OAUTH: "You've hit the rate limit for your plan. Try again later.") |
| auth-source-set | * | auth | stderr | **docs-only** | another auth source is set | project brief (Wes, 2026-09-10): stderr saying "another auth source is set" counts as a failed launch; wording not yet observed live |
| compile-error | * | info | stderr | **docs-only** | SyntaxError: Unexpected token )     at compileSourceTextModule (node:internal/modules/esm/ | synthetic negative fixture (a crashed agent is not a limit) |
| empty-stdout-exit-0 | * | info | stdout | **observed-live** |  | fixtures/live/grok (exit 0, no work): silence is not a limit |
<!-- limits-table:end -->

## Runner facts that apply to every CLI (observed-live in phase 2/3 tests)

- The supervisor is detached (`detached: true, windowsHide: true`) and survives
  the launcher; `run.json` moves `launching → running → exited|killed|failed`.
- Kill is `taskkill /PID <pid> /T /F` on Windows with one verify-retry
  (`LEG_TIMERS_MS=notify,kill,verify`, default 30 min / 90 min / 30 s).
- No adapter ever sets `shell: true`; every spawn is `spawn(bin, argv)` with a
  native exe or `node <entry.js>` (test/lessons.test.mjs `no-shell-spawn`).
- A chain entry naming a forbidden mode or flag makes `argv()` throw
  `forbidden flag: …`; the supervisor records the refusal and exits 13 without
  spawning (test/adapters.test.mjs, test/runner.test.mjs).
