# Resume after a crash or power loss

Written 2026-09-10 at the start of supergoal phase 10 (demo + real E2E).

- Phase pointer: `.supergoal/STATE.md` (`Current phase`). Phase specs: `.supergoal/phases/phase-N.md`.
- Phase 10 does two runs: a fake-adapter demo through `baton up` on a scratch
  `toy-demo` repo (screenshots to `docs/screenshots/demo-*.png`, events to
  `fixtures/demo/events.jsonl`, replay steps in `docs/DEMO.md`) and one real
  run on `toy-real` with chain claude (max 2 turns) → codex (fixtures to
  `fixtures/real-run/`, write-up in `docs/real-run.md`).
- Scratch homes and toy repos live under the session scratchpad
  (`%LOCALAPPDATA%\Temp\claude\C--Projects\<session>\scratchpad\`); card ids are
  appended below once created.
- To resume anything: `node bin/baton.mjs up` (board), `node bin/baton.mjs card ls`,
  `node bin/baton.mjs card show <id>`, `node bin/baton.mjs card run <id>` (a run
  that died mid-leg reads as `orphaned` → `failed`; `card rerun <id>` starts it
  over in the same worktree).
- Hard stops still apply: no remote, no push, no deploy, no launch post.

## Card ids

- demo: card-20260911-0236-add-a-file-greeting-txt-contai (scratch home demo-home)
- real: card-20260911-0232-real-calc (scratch home real-home) — done, 2m50s
