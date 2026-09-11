# CLI contracts

What Baton knows about each coding-agent CLI, where every fact came from, and
which facts were observed live on the build machine versus read from `--help`
or docs. Evidence: `fixtures/help/<cli>.txt` (raw `--help`), `fixtures/live/<cli>/`
(one real tiny task per CLI, run through `src/runner.mjs launch` on 2026-09-10;
paths under the local home directory are replaced with `~`).

Every fact line ends with `(source: …)`. `observed-live` means the build machine
did it; `docs-only` means the CLI's own `--help` or documentation says so and
Baton has not seen it happen.

Probe task (identical for every CLI, `scripts/probe.mjs`): "Create a file named
hello-<name>.txt containing exactly the word hi, then write .baton/DONE
containing the line: done. Do nothing else."

| CLI | version | probe result | adapter |
|-----|---------|--------------|---------|
| claude | 2.1.268 | exit 0, file yes, DONE yes, 20 s | `src/adapters/claude.mjs` |
| codex | codex-cli 0.153.4 | exit 0, file yes, DONE yes, 28 s | `src/adapters/codex.mjs` |
| gemini | 0.55.1 | attempt 1 exit 55 (untrusted folder); attempt 2 exit 1 (account tier ineligible) | `src/adapters/gemini.mjs` (registered; not verified live on this machine) |
| agy | 1.2.0 | attempt 1 exit 0 but wrote to its scratch workspace; attempt 2 (`--add-dir`) exit 0, file yes, DONE yes, 42 s | `src/adapters/agy.mjs` |
| grok | 0.2.51 | exit 0, `stopReason: Cancelled`, no file: not logged in (device-code prompt) | `src/adapters/grok.mjs` exists, NOT registered |

The auth-source check: the build shell carried `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` (injected by the shell profile). Every adapter's `env()` deletes
them (`src/env.mjs`). No fixture contains "another auth source"
(`grep -ril "another auth source" fixtures/live` is empty), claude's and agy's
stderr are 0 bytes, and codex's is the one stdin notice. observed-live.

## claude

- Version 2.1.268 (source: `claude --version`, fixtures/help/claude.version.txt).
- Binary: `~/.local/bin/claude.exe` (native exe, 211 MB); Baton resolves it
  there first, else `claude` on PATH; `BATON_CLAUDE_BIN` overrides (source: `ls
  ~/.local/bin/claude.exe`; src/adapters/claude.mjs `resolve()`).
- Headless argv (exact, from fixtures/live/claude/cmd.txt):
  `claude.exe -p --output-format json --permission-mode acceptEdits`
  with the prompt on **stdin** (stdin: `pipe`). Optional: `--max-turns N`,
  `--resume <session-id>`, `--model <alias|name>`, `--allowedTools a,b`
  (source: `claude --help` lines for each flag; observed-live for the base argv).
- Output: ONE JSON object on stdout, printed only when the session ends
  (LESSONS 07-10; observed-live: 20 s of silence then the object). Top-level
  keys observed: `type:"result"`, `subtype:"success"`, `is_error`,
  `stop_reason:"end_turn"`, `terminal_reason:"completed"`, `api_error_status`,
  `session_id`, `num_turns`, `result` (final text), `permission_denials` (array),
  `usage{input_tokens,output_tokens,cache_read_input_tokens,…}`, `modelUsage`,
  `total_cost_usd`, `duration_ms` (source: fixtures/live/claude/out.log).
  Baton reads `session_id`, `result`, `stop_reason`, `subtype`, `is_error`,
  `terminal_reason`, `api_error_status`, `permission_denials.length`.
- Model: with no `--model`, the account's default model answered
  (`modelUsage` names claude-fable-5-1 and claude-haiku-4-5). A chain entry
  should name `model` to control spend; Baton passes it through as `--model`
  (source: fixtures/live/claude/out.log `modelUsage`; `claude --help --model`).
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | completed, JSON printed | observed-live, fixtures/live/claude/run.json |
  | non-zero | launch or fatal error; JSON may be absent | docs-only (`claude --help` does not enumerate codes; phase 4 records the fixture cases) |

- Permission modes (`--permission-mode` choices in 2.1.268): `acceptEdits`,
  `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (source: `claude
  --help`). Baton: default `acceptEdits`; allowed `acceptEdits`, `auto`, `plan`,
  `manual`, `dontAsk`; forbidden `bypassPermissions`,
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`.
  `acceptEdits` allowed the file write headless (observed-live). The Agent tool
  is never disallowed (LESSONS 07-10). `--permission-prompts none` exists
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
  platform package's native exe. Baton spawns that exe directly:
  `~/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
  (one process to kill); falls back to `node <bin/codex.js>` via
  `resolveNpmCliEntry`, then `codex` on PATH; `BATON_CODEX_BIN` overrides
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
  were shortened…"). Baton reads `thread_id` as the session id, the last
  `agent_message` text, `turn.completed` as the stop reason, and the error
  messages.
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | turn completed | observed-live, fixtures/live/codex/run.json |
  | (none) | hangs forever with an open stdin pipe | observed-live at plan time (killed after 170 s) |
  | non-zero | launch/auth/fatal | docs-only |

- Sandbox modes (`-s`): `read-only`, `workspace-write`, `danger-full-access`
  (source: `codex exec --help`). Baton: default `workspace-write`; allowed
  `read-only`, `workspace-write`; forbidden `danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
  `--approve-for-me` (routes approvals through automatic review), `--full-auto`
  (not present in 0.153.4 `exec --help`; kept on the forbidden list). Blast
  radius is `-C <worktree>`; network off unless the chain entry sets
  `network: true` (PROTOCOL sandbox ladder). `workspace-write` allowed the
  write headless (observed-live).
- Resume: `codex exec resume [SESSION_ID] [PROMPT]` with `--last` for the newest
  (source: `codex exec resume --help`). Baton's adapter emits
  `exec … resume <thread_id> <prompt>`; docs-only until phase 5 exercises it.
- Limit signals: see § Limit signals (phase 4).

## gemini

- Version 0.55.1 (source: `gemini --version`).
- Binary: npm package `@google/gemini-cli`, `bundle/gemini.js`, run as
  `node <entry>` via `resolveNpmCliEntry`; `BATON_GEMINI_BIN` overrides
  (source: package.json `bin`; fixtures/live/gemini/cmd.txt).
- Headless argv (exact): `node gemini.js -p "<prompt>" -o json --approval-mode auto_edit --skip-trust`;
  stdin `ignore` (gemini appends stdin to the prompt if any: source `gemini --help -p`).
  `--skip-trust` "Trust the current workspace for this session" (source:
  `gemini --help`). Without it, headless gemini in an untrusted folder prints
  "Approval mode overridden to \"default\" because the current folder is not
  trusted" and exits **55** (observed-live, fixtures/live/gemini/attempt-1-untrusted.err.log).
  Workspace trust is not a permission bypass; the approval mode still gates tools.
- Output format: `-o json` (choices text|json|stream-json; source: `gemini --help`).
  Shape not observed live on this machine; the adapter parses the first JSON
  object on stdout and reads `session_id`, `response`, `error`, `stats` (docs-only).
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 55 | untrusted folder in headless mode | observed-live |
  | 1 | `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products` | observed-live, fixtures/live/gemini/err.log |
  | 0 | success | docs-only |

- Approval modes: `default`, `auto_edit`, `yolo`, `plan` (source: `gemini --help
  --approval-mode`). Baton: default `auto_edit`; allowed `default`, `auto_edit`,
  `plan`; forbidden `yolo`, `-y/--yolo`. Which mode allows the write is
  unverified here (the account cannot run).
- Resume: `-r/--resume latest|<index>`, `--session-id <uuid>` to start with a
  chosen id, `--list-sessions` (source: `gemini --help`; docs-only).
- Verdict: the CLI contract is complete from `--help`; the logged-in account on
  the build machine is on a retired tier, so gemini cannot run here. Its
  successor `agy` (Antigravity) is verified below. The adapter stays
  registered for machines with an eligible login; a chain that includes gemini
  on this machine gets an `auth_failed` leg and moves on.
- Limit signals: see § Limit signals (phase 4).

## agy

- Version 1.2.0 (source: `agy --version`).
- Binary: `~/AppData/Local/agy/bin/agy.exe` (native); `BATON_AGY_BIN` overrides
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
  - `--print-timeout` defaults to 5m0s; Baton sets it from the kill timer in Go
    duration syntax so the supervisor decides what a runaway is (source: `agy --help`).
- Output: one JSON object: `conversation_id`, `status:"SUCCESS"`, `response`,
  `duration_seconds`, `num_turns`, `usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`
  (observed-live, fixtures/live/agy/out.log). Baton reads `conversation_id` as
  the session id, `response`, `status`.
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | `status: SUCCESS` | observed-live (both attempts; attempt 1 was a success in the wrong directory) |
  | non-zero | fatal/auth | docs-only |

- Modes (`--mode`): `accept-edits`, `plan` (source: `agy --help`). Baton: default
  `accept-edits`; forbidden `--dangerously-skip-permissions`. `accept-edits`
  allowed the write headless (observed-live).
- Resume: `--conversation <id>` (by id) or `--continue` (most recent) (source:
  `agy --help`; docs-only until phase 5).
- Limit signals: see § Limit signals (phase 4).

## grok

- Version grok 0.2.51 (f4f85a649) [stable] (source: `grok --version`).
- Binary: `~/.grok/bin/grok.exe` (native; also an npm shim on PATH);
  `BATON_GROK_BIN` overrides (source: `where grok`).
- Headless argv (from cmd.txt): `grok.exe -p "<prompt>" --output-format json --permission-mode acceptEdits`; stdin `ignore`.
  `--prompt-file <path>` also exists (source: `grok --help`).
- Output: one JSON object `{text, stopReason, sessionId, requestId, thought}`
  (observed-live, fixtures/live/grok/out.log).
- Exit codes:

  | exit | meaning | source |
  |------|---------|--------|
  | 0 | printed JSON with `stopReason:"Cancelled"` and did no work: the CLI was not logged in, printed a device-code prompt on stderr (`https://accounts.x.ai/oauth2/device?user_code=…`, "Waiting for authorization...") and gave up after ~58 s | observed-live, fixtures/live/grok/err.log |

  A zero exit with no DONE marker and no diff is exactly the `no_progress` class
  the completion contract exists for.
- Permission modes: `default`, `acceptEdits`, `auto`, `dontAsk`,
  `bypassPermissions`, `plan` (source: `grok --help`). Baton: default
  `acceptEdits`; forbidden `bypassPermissions`, `--always-approve`.
- Login: `grok login` (source: `grok --help` Commands).
- **Verdict: not verified, no adapter registered.** `src/adapters/grok.mjs` is
  built from `--help` and unit-tested for shape and forbidden flags, but stays
  out of `src/adapters/index.mjs` until `grok login` has been completed on the
  machine and `node scripts/probe.mjs --adapter grok --repo <toy>` passes.

## Limit signals

Recorded in `fixtures/limits/<group>/<id>.json` and classified by
`src/limits.mjs` (`classify()`); the runner writes the outcome into
`run.json.outcome` with the matched `signal`. A real usage limit could not be
forced live on the build machine, so every `limit` row is **docs-only**: its
text comes from the CLI's own documentation or source, cited in "produced by".
The observed-live rows are the non-limit cases the probes actually hit and the
detector must never mistake for a limit.

Outcome precedence (`src/limits.mjs`): spawn error → `launch_failed`; stderr
"another auth source is set" or an `auth` fixture → `auth_failed` (wins over
any limit text, even with exit 0); killed from the board → `killed`; kill timer
→ `stalled`; exit 0 + `.baton/DONE` → `completed`; adapter-specific then
generic `limit` fixture → `limit`; `launch` fixture → `launch_failed`; exit 0 +
changes, no DONE → `incomplete`; exit 0, nothing changed → `no_progress`;
non-zero exit → `failed`. Every outcome except `completed`, `auth_failed` and
`killed` asks the chain to hand off.

<!-- limits-table:start -->
Generated by `node scripts/limits-table.mjs` from 25 fixtures (6 observed-live, 19 docs-only). Classification `limit` hands the card to the next agent as a usage limit; `auth` is a failed launch (never a limit); `launch` is a failed launch that the next agent may still try; `budget` is a turn or spend cap set by Baton itself; `info` must never classify as a limit.

| id | adapter | class | where | source | text (excerpt) | produced by |
|----|---------|-------|-------|--------|----------------|-------------|
| agy-resource-exhausted | agy | limit | any | **docs-only** | resource-exhausted | `agy changelog` ("Fixed personal accounts hitting a resource-exhausted error at startup"); agy --help documents no limit wording; falls back to the generic matchers |
| claude-budget-limit | claude | budget | any | **docs-only** | Budget limit reached | https://code.claude.com/docs/en/cli-reference (--max-budget-usd) |
| claude-max-turns | claude | budget | stdout | **observed-live** | {"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"tool_use","ter | fixtures/real-run/leg1/out.log: `claude -p --max-turns 2` on the real run, 2026-09-10 (docs: https://code.claude.com/docs/en/cli-reference --max-turns "Exits with an error when the limit is reached") |
| claude-model-limit | claude | limit | any | **docs-only** | You’ve hit your Opus limit | https://code.claude.com/docs/en/costs ("You’ve hit your Opus limit" / "You’ve hit your Sonnet limit") |
| claude-session-limit | claude | limit | any | **docs-only** | You’ve hit your session limit | https://code.claude.com/docs/en/costs (section: When a developer asks about a limit) |
| claude-weekly-limit | claude | limit | any | **docs-only** | You’ve hit your weekly limit | https://code.claude.com/docs/en/costs (section: When a developer asks about a limit) |
| codex-quota-exceeded | codex | limit | any | **docs-only** | quota exceeded | github.com/openai/codex codex-rs/response-debug-context/src/lib.rs (ApiError::QuotaExceeded => "quota exceeded") |
| codex-rate-limit-exceeded | codex | limit | any | **docs-only** | rate limit exceeded:  | github.com/openai/codex codex-rs/codex-api/src/error.rs (#[error("rate limit exceeded: {message}")]) |
| codex-skills-notice | codex | info | stdout | **observed-live** | Skill descriptions were shortened to fit the skills context budget. Codex can still see ev | fixtures/live/codex/out.log (item.completed, item.type=error) from scripts/probe.mjs --adapter codex, 2026-09-10 |
| codex-usage-limit-reached | codex | limit | any | **docs-only** | Usage limit reached. You've reached your usage limit. Increase your limits to continue | github.com/openai/codex codex-rs/tui/src/chatwidget/turn_runtime.rs (WorkspaceOwnerUsageLimitReached) |
| codex-usage-limit | codex | limit | any | **docs-only** | You’ve hit your usage limit for {limit_name}. Switch to another model now, | github.com/openai/codex codex-rs/protocol/src/error.rs (gh search code "usage limit" --repo openai/codex, 2026-09-10) |
| gemini-ineligible-tier | gemini | auth | stderr | **observed-live** | Error authenticating: IneligibleTierError: This client is no longer supported for Gemini C | fixtures/live/gemini/err.log from scripts/probe.mjs --adapter gemini, 2026-09-10 |
| gemini-quota-exceeded | gemini | limit | any | **docs-only** | You exceeded your current quota | github.com/google-gemini/gemini-cli packages/core/src/utils/googleErrors.test.ts |
| gemini-resource-exhausted | gemini | limit | any | **docs-only** | got status: 429 Too Many Requests. {"error":{"code":429,"message":"Rate limit exceeded","s | github.com/google-gemini/gemini-cli packages/cli/src/nonInteractiveCliAgentSession.ts (status RESOURCE_EXHAUSTED => severity error on stderr) + packages/core/src/utils/errorParsing.test.ts |
| gemini-untrusted-folder | gemini | launch | stderr | **observed-live** | Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, s | fixtures/live/gemini/attempt-1-untrusted.err.log (exit 55) from scripts/probe.mjs --adapter gemini, 2026-09-10 |
| generic-429 | * | limit | any | **docs-only** | 429 Too Many Requests | generic HTTP matcher (429 Too Many Requests); lowest priority |
| generic-overloaded | * | limit | any | **docs-only** | overloaded_error | generic matcher (Anthropic API 529 overloaded_error); lowest priority |
| generic-quota | * | limit | any | **docs-only** | quota | generic matcher; lowest priority |
| generic-rate-limit | * | limit | any | **docs-only** | rate limit | generic matcher; lowest priority |
| generic-resource-exhausted | * | limit | any | **docs-only** | RESOURCE_EXHAUSTED | generic matcher (gRPC RESOURCE_EXHAUSTED); lowest priority |
| generic-usage-limit | * | limit | any | **docs-only** | usage limit | generic matcher; lowest priority |
| grok-not-logged-in | grok | auth | stderr | **observed-live** | To sign in, open this URL in your browser:    https://accounts.x.ai/oauth2/device?user_cod | fixtures/live/grok/err.log from scripts/probe.mjs --adapter grok, 2026-09-10 (stdout JSON stopReason: Cancelled, exit 0) |
| auth-source-set | * | auth | stderr | **docs-only** | another auth source is set | project brief (Wes, 2026-09-10): stderr saying "another auth source is set" counts as a failed launch; wording not yet observed live |
| compile-error | * | info | stderr | **docs-only** | SyntaxError: Unexpected token )     at compileSourceTextModule (node:internal/modules/esm/ | synthetic negative fixture (a crashed agent is not a limit) |
| empty-stdout-exit-0 | * | info | stdout | **observed-live** |  | fixtures/live/gemini/out.log (0 bytes) and fixtures/live/grok (exit 0, no work): silence is not a limit |
<!-- limits-table:end -->

## Runner facts that apply to every CLI (observed-live in phase 2/3 tests)

- The supervisor is detached (`detached: true, windowsHide: true`) and survives
  the launcher; `run.json` moves `launching → running → exited|killed|failed`.
- Kill is `taskkill /PID <pid> /T /F` on Windows with one verify-retry
  (`BATON_TIMERS_MS=notify,kill,verify`, default 30 min / 90 min / 30 s).
- No adapter ever sets `shell: true`; every spawn is `spawn(bin, argv)` with a
  native exe or `node <entry.js>` (LESSONS 07-11).
- A chain entry naming a forbidden mode or flag makes `argv()` throw
  `forbidden flag: …`; the supervisor records the refusal and exits 13 without
  spawning (test/adapters.test.mjs, test/runner.test.mjs).
