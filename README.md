# baton

Local-first kanban board and meta-harness for coding-agent CLIs. A human drops a
task card and assigns a fallback chain (Claude Code → Codex → Gemini CLI → agy).
Baton runs the first agent headless in its own git worktree, streams progress to
the card, and when that agent hits a usage limit, stalls, or exits without
finishing, writes a context-handoff-bundle and hands the same worktree to the
next agent in the chain. Every judgment call is a button on the board.

**Status: building.** The reuse audit is in `docs/REUSE.md`; every shape change
from the ported sources is one row in `docs/DEVIATIONS.md`. Run steps land with
the launcher.

## Hard constraints

- Logged-in subscription CLIs only, never per-token API. Every spawn deletes
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
  `OPENAI_API_KEY` from the child environment. Stderr saying "another auth
  source is set" counts as a failed launch, never a limit.
- Agents keep their own permission and sandbox modes. No skip-permissions or
  YOLO flags, ever, by default or otherwise.
- Human surface first: the board is the product, the CLI is secondary.
- One-command launcher: `npm start` boots, health-checks, opens the board,
  streams prefixed logs, tears down on Ctrl+C. Argv subprocesses only.
- No shell spawns anywhere; secrets redacted from every log.
