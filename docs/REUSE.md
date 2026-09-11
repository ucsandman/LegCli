# REUSE — what Baton ports from the private team tooling, and what it drops

Source: a private ucsandman repository (team tooling for a two-agent protocol
with a detached Claude Code launcher, a JSONL task ledger, a git snapshot tool,
and a governed capability runner). Read in full on 2026-09-10 before any Baton
code was designed. Every ported shape change is one row in `DEVIATIONS.md`.
NOTICE carries the attribution. No path, id, or chat identifier from the source
appears anywhere in this tree; `scripts/privacy-check.mjs` enforces that.

Legend: **Ported** = kept, with its new home. **Dropped** = removed, with the
reason. **Why** = the judgment.

## lead-handoff.mjs

**Ported** (→ `src/runner.mjs`, subcommands `launch | supervise | sweep`):
- `launch`: detached supervisor spawn (`detached: true, windowsHide: true`,
  `child.unref()`), the `handoff_already_running` refusal (exit 11) when the
  recorded supervisor pid is alive, archiving a stale record to `*.prev.json`
  and relaunching when it is dead, one-line JSON on stdout.
- `supervise`: spawn the agent with stdout/stderr redirected to files, write
  the run record on every transition, notify timer (30 min) and kill timer
  (90 min) with the kill-verify retry (30 s) and the UNKILLABLE path (exit 12),
  session-id capture from the result file, ledger writes through the ledger CLI
  via `ledgerSafe` (a ledger failure never crashes the supervisor), stderr tail
  scrubbed of secrets before it is logged (`SECRET_RES`, `scrub`, `errTail`).
- `killTree`: `taskkill /PID <pid> /T /F` on Windows, process-group SIGKILL
  elsewhere; the `HANDOFF_SKIP_KILL` test seam becomes `BATON_SKIP_KILL`.
- `sweep`: orphan detection (record says running, supervisor pid dead →
  `orphaned` + ledger error + ORPHANED line naming the child pid).
- `pidAlive`, `parseArgs`, `need`, `die`, exit codes 0 / 2 / 3 / 11 / 12 / 13.
- `resolveOpenclawEntry` → `src/adapters/resolve.mjs` `resolveNpmCliEntry(pkg, bin)`:
  resolves an npm package's real JS entry so the runner can `spawn(node, [entry])`
  without a shell (the `.cmd` shim needs one). Codex, Gemini and the optional
  OpenClaw sync need exactly this.
- Child environment sanitization before spawn (the "drill launched from inside
  a Claude Code session leaks a session key" lesson) → one exported
  `sanitizeEnv(env)` that every adapter calls; the deleted-key set grows (see
  DEVIATIONS).
- The timer seam (`HANDOFF_TIMERS_MS` → `BATON_TIMERS_MS`, same
  `notify,kill,kill-verify` shape and defaults).

**Dropped:**
- `telegramTarget`, `sendTelegram`, `.env.handoff`, every `notify(...)` message
  string, and the sweep's delivery canary — Telegram delivery and chat ids
  (privacy rule). The notify timer becomes a ledger `status` event only.
- `LEAD_ALLOWED_TOOLS` — a hard-coded allowlist naming the team bin scripts and
  two MCPs. Baton passes only the permission mode the chain entry names and
  never disallows the Agent tool.
- `findReportEvent` — decided "completed" by scanning the lead's ledger for a
  `done` event. Baton uses one CLI-agnostic completion contract (`.baton/DONE`
  in the worktree), phase 5.
- `--model` / `--effort` / `--safe-mode` argv and the `origin` lookup — model
  and effort move into the chain entry; there is no origin surface.
- `WORKDIR = ROOT/../..` (the lead ran in the private repo's root) — Baton runs
  every leg in the card's worktree.

**Why:** the supervise/kill/sweep logic is paid-for behaviour with tests that
caught real incidents (split-brain relaunch, unkillable lead, orphaned
supervisor after reboot). Everything dropped is either transport (Telegram),
identity (allowlist, private paths), or a completion rule that only worked for
one CLI.

## lead-handoff.test.mjs

**Ported** (→ `test/runner.test.mjs`, stub agents → `src/adapters/fake.mjs` +
`bin/fake-agent.mjs` selected by `FAKE_MODE`):
- launch writes the run record + prompt file and prints ok JSON
- launch refuses unknown card (exit 3) and missing prompt file (exit 2)
- launch exits 11 when the supervisor pid is alive
- launch archives a stale record (dead pid) and relaunches
- supervise: fast finish stores the session id, exit code, never fires timers
- supervise: agent exits without finishing → `failed`-shaped record, exit 13,
  ledger error with a **scrubbed** stderr tail (the `sk-…` assertion stays)
- supervise: runaway agent → notify event then killed, exit 12
- supervise: unkillable agent → retry, UNKILLABLE ledger error, exit 12
- supervise: child environment is sanitized (extended to all seven keys plus
  the `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` assertion)
- sweep: dead supervisor → orphaned + ORPHANED line + ledger error
- sweep: healthy running record left alone
- sweep: no records → quiet OK line, exit 0

**Dropped** (named here so the count is auditable):
- "supervise: lead logs done -> completed, session id stored, HANDOFF_DONE sent"
  (the completed half is replaced by phase 5's DONE-marker test; the Telegram
  half is gone)
- "supervise: claude-code origin -> no telegram send at all"
- "supervise: no TEAM_TELEGRAM_TO configured -> send skipped, still completes"
- "sweep: no handoffs at all -> ... dry-run-only canary" (canary half)
- "sweep: broken delivery path -> DELIVERY-CHECK FAILED line"
- "sweep: no TEAM_TELEGRAM_TO -> DELIVERY-CHECK FAILED line"

**Why:** the stub-agent approach (a per-test `.mjs` that plays the CLI) is the
right seam for a runner that must never touch a real CLI under test; it becomes
Baton's fake adapter, which phase 4 extends with limit / stall / auth-failure
modes.

## team-ledger.mjs

**Ported** (→ `src/ledger.mjs`, subcommands `create | append | update | sync`):
- The rule that this file is the ONLY writer of ledger files; per-writer
  append-only JSONL; `ACTIVE.md` regenerated on every create/update with
  corrupt records skipped and warned, never bricking the list.
- `assertNoSecrets` with `SECRET_PATTERNS` (refuses to log, exit 2).
- `parseArgs` / `need(args, key, allowed)` validation with the exact
  `invalid --type "gossip" (allowed: …)` error shape.
- The DashClaw sync: `loadDashclawConfig` (process variables win, then a
  dotenv file), `dashclawRequest` on native `http`/`https` with a 5 s timeout
  and the 409-on-create-is-success rule, `bufferUnsynced` → `unsynced.jsonl`,
  `flushUnsynced` via `sync [--card]` exiting 1 while anything remains.
- Exit codes 2 (bad args / secret / corrupt record) and 3 (not found).

**Dropped:**
- `AGENTS = ['claude', 'openclaw']`, `RECIPIENTS`, and the `from`/`to` pair —
  replaced by a validated `actor` object plus `card_id`, `station`, `leg`
  (amendment 2 §4).
- `ORIGINS`, `lead`, `stop_condition`, `max_exchanges`,
  `openclaw_session_key` — two-agent protocol fields with no Baton meaning.
- The `team-` id prefix and `tasks/` directory (→ `card-`, `cards/`).
- The DashClaw endpoint paths `/api/team-tasks…` — phase 9 wires the real
  target through config; the transport code stays.

**Why:** an append-only, secret-refusing, per-writer ledger with a buffered
best-effort sync is exactly the multiplayer-ready event store amendment 2 asks
for. Only the vocabulary changes.

## team-ledger.test.mjs

**Ported** (→ `test/ledger.test.mjs`, renamed to card/actor vocabulary):
- create writes `card.json`, the `card_created` event, and `ACTIVE.md`
- append adds one line to the writer's own file only
- update patches status and session id and regenerates `ACTIVE.md`
- append with an invalid type exits 2 and names the bad value
- append to a missing card exits 3
- create rejects a slug that will not produce a valid id
- create syncs to DashClaw with `x-api-key` (fake server on 127.0.0.1)
- sync failure buffers to `unsynced.jsonl` and still exits 0
- `sync` flushes the buffer
- append refuses secret-looking values with exit 2 and writes nothing
- update dies cleanly (exit 2) on a corrupt record
- unknown subcommand exits 2
- a corrupt record is skipped with a warning and does not brick `ACTIVE.md`

**Added in the port:** append without a valid `--actor` exits 2;
`readEvents(cardId)` merges writer files sorted by `ts`.

**Dropped:** none. Assertions on `from`/`to`/`origin`/`lead` become assertions
on `actor`/`card_id`/`station`/`leg`.

**Why:** all thirteen encode behaviour Baton keeps.

## git-snapshot.mjs

**Ported** (→ `src/git-snapshot.mjs`, byte-identical apart from the two removals):
read-only snapshot JSON (`branch`, `head`, `head_subject`, `dirty` counts and
files with `--max-files` truncation, `submodules_dirty`, `recommendation`) and
`--diff-since <ref>` (commits, changed files, insertions, deletions). Phase 5
uses `--diff-since` to classify a leg that exited 0 with no DONE marker and no
diff as `no_progress`; phase 7 uses the snapshot before landing.

**Dropped:** the hard-coded private-path constant and its `dirty-check`
recommendation branch. Recommendation is `branch` when clean, `worktree` when
dirty.

**Why:** the tool already does what the land station and the no-progress
check need, and it never mutates the repo.

## git-snapshot.test.mjs

**Ported** (→ `test/git-snapshot.test.mjs`): clean repo → `branch`; dirty
repo → `worktree` with exact counts; `--diff-since` across two commits; non-repo
dir exits 2; 25 untracked files truncate at 20.

**Dropped:** "private-path override … yields recommendation dirty-check" — it
asserts on a machine path that must not exist in this tree.

**Why:** five of six tests are portable as-is.

## invoke-capability.mjs

**Ported** (as patterns, not code → `src/sync/dashclaw.mjs` in phase 9):
- The argv-builder shape: a registry entry owns an `argv(input)` function that
  returns a plain array, and `--dry-run` prints the exact command without
  touching anything. Baton's `pr` land mode (`gh pr create` argv, stub-tested
  only) and the DashClaw action recorder use this shape.
- Fail-closed: no config → do nothing and say so; a 4xx/5xx or a timeout never
  turns into "executed". Baton's optional syncs are off by default and a sync
  failure never changes a card's state.

**Dropped:** the capability registry (`post-to-x`, `send-email`), the
approval-polling loop, agent identities, `REPO_ROOT`-relative wrapper paths,
and the global `fetch` client (LESSONS 07-12: Node 24 on Windows can crash at
exit after global fetch; the ledger already uses native `http`/`https`).

**Why:** exactly the verdict the plan expected: nothing to port but the two
shapes. Baton records actions; it does not gate external capabilities.

## LESSONS.md

Each applicable line becomes a named test in `test/lessons.test.mjs` (phase 4).
Lines that only concern X/OAuth, the OpenClaw gateway, Vercel, or the weekly
drill do not apply and are omitted.

| lesson | Baton test name |
|--------|-----------------|
| 07-09 MSYS mangles leading-slash args | `lessons: every git spawn carries MSYS_NO_PATHCONV=1 and never a shell` |
| 07-10 `claude -p --output-format json` prints nothing until the end | `lessons: stall detector reads out/err file mtime, never waits on stdout` |
| 07-10 acceptEdits silently denies tools outside `--allowedTools` | `lessons: claude argv carries no --allowedTools and never disallows Agent` |
| 07-11 `bash` under some PATHs is the WSL shim and drops variables | `lessons: no adapter spawn sets shell:true; argv[0] is node or a native exe` |
| 07-11 every ledger write from your OWN identity only | `lessons: an event always lands in its own actor's events file` |
| 07-11 a detached session cannot answer permission prompts | `lessons: CONTRACT.md tells the agent no interactive prompt will be answered` |
| 07-12 Node 24 + global fetch crashes at exit | `lessons: src/ has no global fetch call` |
| 07-13 codex exec may start read-only despite the flag | `lessons: codex argv carries -s workspace-write and -C <worktree>; phase 3 records the effective sandbox` |
| 07-13 `node --test <dir>` fails on Node 24/Windows | `lessons: package.json test script is bare node --test` |
| 07-13 `[hidden]` loses to an author `display:` rule | `lessons: board CSS ships [hidden]{display:none!important}` |
| 08-10 enumerate the interface from source before building | `lessons: cli-contracts.md carries a producing command for every CLI section` |
| 08-10 relative doc paths silently no-op | `lessons: README links resolve to files in the tree` |
| 08-11 two checkouts, wrong path built against | `lessons: card repo is resolved to its git toplevel before a worktree is created` |

Thirteen tests. Phase 4 may add more if the port surfaces another line.

## PROTOCOL.md

**Ported** (as rules in `docs/cli-contracts.md`, the adapters, and the land
station):
- Codex sandbox ladder: `read-only` for review, `workspace-write` only when
  edits are the deliverable, `danger-full-access` and
  `--dangerously-bypass-approvals-and-sandbox` never (a chain entry naming one
  refuses to launch). Blast radius: `-C <narrowest dir>` = the card's worktree.
  Network off by default: `-c sandbox_workspace_write.network_access=false`.
- Git workflow: snapshot before a leg, snapshot `--diff-since` after; the
  `worktree` recommendation is Baton's only mode (one worktree per card,
  branch `baton/<card-id>`); the diff, never prose, is what review and landing
  trust.
- Failure rules that carry over: exit 11 means a supervisor is already running,
  never relaunch over it; a failed launch is retried once then the chain moves
  on; slow, dead, or runaway legs are the supervisor's job (30 m notify, 90 m
  kill); no secrets in any ledger field.
- Model routing: a `claude -p` call that omits `--model` inherits the
  interactive default. Baton lets the chain entry name the model and passes it
  when present; the default is documented per CLI in `cli-contracts.md` rather
  than hard-coded.

**Dropped:** the two-agent classifier, lead/specialist roles, envelopes, the
exchange cap, Telegram transport, DashClaw tiers and approvals (Baton's
approvals are buttons on the board; DashClaw is an optional recorder), the
`openclaw agent` transport.

**Why:** the containment rules for Codex and the snapshot-then-diff workflow
were written after real incidents and transfer unchanged. The protocol's
coordination layer is what Baton replaces with a board.

## context-handoff-bundle (the handoff format)

**Reused as-is** (argv subprocess, never re-implemented): `save --title --slug
--notes <file> --tag --repo-local [--update]`, `load [query] [--json]`,
`validate <dir>`, `list`, `show`. The `--notes` file is the input Baton
writes; its parser reads `## Scope`, `## Projects mentioned`, `## Findings`,
`## Opportunities`, `## Open questions`, `## Evidence anchors` (bullets under
each). Baton's mapping: Scope = the task and the leg that stopped; Findings =
what was done (from `.baton/PROGRESS.md` and the diff); Open questions = why
the leg stopped and what is unverified (a failing test lands here on a
bounce); Evidence anchors = the changed files, so drift checks flag them.
Bundles are saved `--repo-local` inside the worktree so the next agent finds
them in its cwd. Storage: `.context-handoffs/index.json` in the worktree.
`checkpoint` / `rescue` (hook-driven passive checkpoints) are not used.

**Machine state (verified live 2026-09-10):** the CLI on PATH was 0.1.0 from
the Store Python; PyPI and the source checkout are 0.4.0 (`--notes`,
`--repo-local`, `--update`, drift). Phase 5 installed 0.4.0 from PyPI, then
the local checkout in editable mode because 0.4.0 has no `--version` flag:
the checkout gained `--version` and `tests/test_version.py` (76 upstream
tests green, not pushed). `src/handoff.mjs` reads the version through
`importlib.metadata` when the flag is absent, so a plain `pip install -U
context-handoff-bundle` still works. Live-verified in phase 5: `save
--repo-local --notes`, `validate`, `load`, `list --repo-only`, `show`.

## project-launch-button-policy

Adopted whole as phase 8's spec: `npm start` = `baton up`; boots, health-checks,
opens the board, prefixed unified logs, Ctrl+C teardown, `--dry` and `down`
modes, argv subprocesses only, secret redaction on stdout, refuses dangerous
misconfiguration (a YOLO flag in a chain entry, a bind address off loopback
without a token).
