# Adapters

Reference for each coding-agent CLI Baton drives, and how to add a new one.
Every fact below is verified against `src/adapters/*.mjs`; the full evidence
trail (raw `--help` output, live probe fixtures, exit codes actually seen)
is [cli-contracts.md](cli-contracts.md).

An adapter never runs through a shell: it is spawned as `argv` directly
(`src/runner.mjs` `spawn(spec.bin, spec.args, ...)`). Every adapter's `env()`
strips the four API-key/base-URL variables and the Claude-Code nested-session
markers (`src/env.mjs`), so a subscription login is always what runs, never
a leaked token.

## claude

- **Binary**: `BATON_CLAUDE_BIN`, else `~/.local/bin/claude.exe` (Windows)
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
  `ANTHROPIC_API_KEY`/similar is shadowing the subscription login.

## codex

- **Binary**: `BATON_CODEX_BIN`, else the `@openai/codex` npm package's
  native platform exe (resolved under `%APPDATA%\npm\node_modules\@openai\codex\...`
  on Windows), else `node <bin/codex.js>` via `resolveNpmCliEntry`, else
  `codex` on PATH.
- **Argv**: `codex exec --json -s <mode> -C <cwd> -c
  sandbox_workspace_write.network_access=<true|false>`, plus `-m <model>`,
  `-o <runDir>/last.md`, `resume <session-id>` and the prompt as the last
  positional argument.
- **Stdin**: `ignore`, deliberately. `codex exec` reads stdin whenever it
  is not a TTY and hangs on an open pipe ("Reading additional input from
  stdin..."); a plan-time probe with a pipe hung 170s, the same task with
  stdin closed finished in 20s.
- **Modes**: default `workspace-write`; allowed `read-only`,
  `workspace-write`.
- **Forbidden flags**: `danger-full-access`,
  `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `--full-auto`, `--approve-for-me`.
- **Gotchas**: network access is off unless the chain entry sets
  `network: true`. If you run `codex exec` by hand outside Baton, always
  pass the prompt as an argument, never on a pipe.

## gemini (legacy)

Google is retiring Gemini CLI in favour of Antigravity's `agy` (next
section). The adapter stays registered for accounts that still work, but the
live probe on 2026-09-10 got `IneligibleTierError` with a message pointing at
Antigravity. Prefer `agy` in new chains.

- **Binary**: `BATON_GEMINI_BIN` (a `.mjs`/`.cjs`/`.js` path runs via
  `node <entry>`, anything else runs directly), else the
  `@google/gemini-cli` npm package's entry via `resolveNpmCliEntry`, else
  `gemini` on PATH.
- **Argv**: `gemini -p "<prompt>" -o json --approval-mode <mode>
  --skip-trust`, plus `-m <model>`, `-r <session-id>`.
- **Stdin**: `ignore`: gemini appends any stdin to the prompt, so an open
  pipe would corrupt it.
- **Modes**: default `auto_edit`; allowed `default`, `auto_edit`, `plan`.
- **Forbidden flags**: `--yolo`, `-y`, `yolo`, `--approval-mode=yolo`.
- **Gotchas**: `--skip-trust` is required headlessly. Without it, gemini in
  an untrusted folder overrides the approval mode to `default` and exits
  **55**; the worktree is Baton's own checkout, so this is not a permission
  bypass, the approval mode still gates every tool. An `IneligibleTierError`
  on stderr means the logged-in account's tier was retired (the CLI's own
  message points at Antigravity/`agy`).

## agy

- **Binary**: `BATON_AGY_BIN`, else `%LOCALAPPDATA%\agy\bin\agy.exe`, else
  `agy` on PATH.
- **Argv**: `agy -p "<working-directory preamble>\n\n<prompt>"
  --output-format json --mode <mode> --add-dir <cwd> --print-timeout
  <duration>`, plus `--model <model>`, `--conversation <session-id>`. The
  duration is the card's kill timer converted to Go syntax (e.g. `90m`).
- **Stdin**: `ignore`.
- **Modes**: default `accept-edits`; allowed `accept-edits`, `plan`.
- **Forbidden flags**: `--dangerously-skip-permissions`.
- **Gotchas**: agy does not act in the process cwd by default: with no
  `--add-dir` it writes into its own scratch workspace
  (`~/.gemini/antigravity-cli/scratch/`, observed live). Baton always passes
  `--add-dir <worktree>` and prefixes the prompt with "Working directory:
  `<worktree>`" so the agent writes where the card expects. `--print-timeout`
  defaults to 5 minutes in the CLI itself; Baton always sets it explicitly
  from the leg's kill timer so the supervisor, not agy, decides what a
  runaway is.

## fake (and fake-claude / fake-codex / fake-gemini / fake-agy / fake-nostdin)

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
  [getting-started.md](getting-started.md#7-try-it-with-no-real-agent) for
  the full list of modes). `fake-claude` / `fake-codex` / `fake-gemini` /
  `fake-agy` set `emulates` to that CLI's name, so the limit classifier
  applies that CLI's own fixtures to it, so a demo chain reads like a real
  fallback.

## grok (built, not registered)

- **Binary**: `BATON_GROK_BIN`, else `~/.grok/bin/grok.exe`, else `grok` on
  PATH.
- **Argv**: `grok -p "<prompt>" --output-format json --permission-mode
  <mode>`, plus `-m <model>`, `-r <session-id>`.
- **Stdin**: `ignore`.
- **Modes**: default `acceptEdits`; allowed `default`, `acceptEdits`,
  `auto`, `dontAsk`, `plan`.
- **Forbidden flags**: `--always-approve`, `bypassPermissions`,
  `--permission-mode=bypassPermissions`.
- **Status**: `src/adapters/grok.mjs` exists and is unit-tested, but is
  **not** in `src/adapters/index.mjs`'s registry. The build machine had no
  `grok` login: the probe printed a device-code prompt and exited
  `Cancelled`. Register it (add an entry to `REGISTRY` in
  `src/adapters/index.mjs`) once `grok login` has been completed and
  `node scripts/probe.mjs --adapter grok --repo <toy-repo>` passes.

## How to add an adapter

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

   It runs one real tiny task (write a file, write `.baton/DONE`) through
   the same runner a card uses, and prints `probe <name>: exit=<code>
   file=<yes|no> done=<yes|no> auth_source=<yes|no> seconds=<n>`. Keep the
   evidence it produces under `fixtures/live/<name>/` and cite it in
   [cli-contracts.md](cli-contracts.md), the way every existing adapter's
   section does.

## See also

- [cli-contracts.md](cli-contracts.md): the full evidence trail, exit
  codes, and every limit-signal fixture, tagged observed-live or docs-only.
- [configuration.md](configuration.md): the `BATON_<ADAPTER>_BIN`
  overrides.
- [concepts.md](concepts.md): how a leg's outcome is classified from an
  adapter's exit code, output, and the DONE marker.
