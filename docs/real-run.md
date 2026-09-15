# Real run: claude → codex, no fakes

One task, two real logged-in CLIs, the real handoff path. Run on 2026-09-10 on
a scratch repo (`toy-real`: README, package.json with `"test": "node --test"`,
one commit). Evidence: `fixtures/real-run/` (run records, logs, bundle `show`,
events; home paths scrubbed to `~`).

## Command

```
node bin/leg.mjs card add --repo <toy-real> --chain claude,codex --max-turns claude=2 --mode codex=workspace-write --pipeline build --title "calc module (real run)" --task "Create src/calc.mjs exporting add, sub, mul and div (div throws on division by zero). Create test/calc.test.mjs using node:test covering all four functions including the divide-by-zero case. Run node --test and fix until green. Then write .leg/DONE."
node bin/leg.mjs card run card-20260911-0232-real-calc
```

`--max-turns claude=2` is the handoff trigger: the task needs more than two
turns, so the first leg ends before the DONE marker.

## Timeline (UTC, from `fixtures/real-run/events.jsonl`)

| time | event | detail |
|------|-------|--------|
| 02:32:50 | card_created | actor human:local, chain claude > codex |
| 02:32:51 | leg_started | adapter `claude`, run 1, `mode=default`, `--max-turns 2` |
| 02:33:23 | leg_exited | **outcome `failed`**, exit 1, signal `claude-max-turns` (32 s) |
| 02:33:24 | handoff_written | bundle `20260911-023324-baton-card-20260911-0232-real-calc-build-leg0`, quality **strong (0.65)** |
| 02:33:25 | leg_started | adapter `codex`, run 2, `-s workspace-write` |
| 02:35:39 | leg_exited | **outcome `completed`**, exit 0 (2 m 14 s) |
| 02:35:40 | station_done, done | |

Wall time: 2 m 50 s. `grep -c fake fixtures/real-run/events.jsonl` = 0.

## Leg 1 (claude)

The result JSON on stdout (`fixtures/real-run/leg1/out.log`) is the signal that
was docs-only until this run and is now observed-live:

```
{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"tool_use","terminal_reason":"max_turns","num_turns":3, …}
```

Exit code 1, empty stderr, no `.leg/DONE`; the diff evidence saw one changed
path (`.dashclaw-local/`, written by the machine's Claude Code hooks, not the
task). Classification: `budget` signal `claude-max-turns` + non-zero exit →
`failed`, handoff. (A budget cap is Leg's own setting, not a usage limit; it
still hands off.)

## The bundle

`fixtures/real-run/bundle-show.txt`: Findings carry "Done so far", "Diff since
leg start", the touched path; Open questions carry the outcome and exit code.
Leg 2 picked the handoff up: its first message is "Proceeding from the last
agent state" and its second tool call reads `.leg/CONTRACT.md` and the
handoff file (`fixtures/real-run/leg2/out.excerpt.log`, items 1-3).

## Leg 2 (codex)

`fixtures/real-run/leg2/out.excerpt.log` (JSONL): codex read the resume,
wrote `src/calc.mjs` and `test/calc.test.mjs`, ran the tests itself (its
sandbox allowed `node --test` here; LESSONS 07-13 recorded a policy block on a
different machine setup), wrote `.leg/PROGRESS.md` and `.leg/DONE`, and
printed a summary. Verified inside leg 2
(`fixtures/real-run/leg2/out.excerpt.log`, item 20), which ran the repo's
`npm test` -> `node --test` in the worktree:

```
tests 5  pass 5  fail 0
```

The worktree holds `src/calc.mjs`, `test/calc.test.mjs` and
`.leg/{CONTRACT.md, DONE, PROGRESS.md, handoff-build-leg0.md}`.

## What this proves

- The subscription logins were used: neither leg's stderr carries an
  "another auth source" warning (`leg1/err.log` is empty, `leg2/err.log` is
  one stdin notice), and `sanitizeEnv` strips ANTHROPIC_API_KEY and
  OPENAI_API_KEY before any adapter starts (test/redact.test.mjs).
- The handoff is CLI-agnostic: the bundle written after a Claude leg was
  consumed by a Codex leg through the same `load` + contract prompt.
- The DONE-marker contract classified both legs without parsing prose.
