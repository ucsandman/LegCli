# Docs index

## Start here

- [getting-started.md](getting-started.md): install, run `leg claude`, what you get while it runs, where files live, and the v0.1 pipeline flow as an extra.
- [concepts.md](concepts.md): sessions, accounts, usage windows and the interactive handoff, then cards, stations, chains, outcomes, leases, the land station and the card status state diagram.
- [board-guide.md](board-guide.md): the instrument head (a row per login, two window rails each, the 85 percent post), the Terminals panels, overlap flags, Landed on main, Background tasks, Settings, and the floor view.
- [configuration.md](configuration.md): every environment variable, the accounts layout, `.env`, network exposure, card-level options.
- [harness.md](harness.md): the portable harness, off by default: what moves between agents and what does not, the first run, policies, ownership and backups, secrets, the evidence trail, and how Leg relates to the Agnostic AI engine it embeds.
- [adapters.md](adapters.md): what Leg reads from each CLI in an interactive session, each adapter's headless argv, modes, forbidden flags, gotchas, and how to add a new one.
- [faq.md](faq.md): short answers to real questions (the status line, codex's missing hook, agy's missing percentage, second accounts, uninstall, limits, secrets, Windows support).

## Reference

- [VOCABULARY.md](VOCABULARY.md): the exact identifiers Leg uses for session statuses and session events, and for card statuses, outcomes, event types, actor types, human actions and bounce reasons.
- [cli-contracts.md](cli-contracts.md): what Leg knows about each coding-agent CLI, the interactive taps and their sources, and the limit-signal table, every fact tagged observed-live or docs-only.
- [DEMO.md](DEMO.md): a fake-adapter walkthrough of a usage-limit handoff, with screenshots.
- [real-run.md](real-run.md): one real pipeline run, claude handing off to codex with no fakes involved.
- [ROADMAP-v2](ROADMAP-v2.md): where the factory-floor shape is headed after v1.

## The code behind the docs

| area | modules |
|------|---------|
| interactive sessions | `src/attach.mjs` (the `leg <agent>` runner), `src/sessions.mjs` (the session store), `src/usage.mjs` (usage windows and the chooser), `src/accounts.mjs` (extra logins), `src/bundle.mjs` (the per-session bundle), `src/hook.mjs` (what Claude Code's hooks run) |
| portable harness | `src/harness/index.mjs` (capture, compare, apply, status, the hand-off decision), `src/harness/registry.mjs` (which clients, where their files are), `src/harness/fingerprint.mjs`, `src/harness/cli.mjs` (`leg harness`), `src/harness/vendor/agnostic-ai/` (the engine, verbatim; `scripts/sync-harness-engine.mjs` is the only writer) |
| taps | `src/taps/claude.mjs`, `src/taps/claude-usage.mjs`, `src/taps/codex.mjs`, `src/taps/agy.mjs` |
| board | `src/server.mjs`, `src/board/sessions.js` (Terminals lane), `src/board/board.js` and `src/board/floor.js` (pipelines) |
| pipelines | `src/orchestrator.mjs`, `src/scheduler.mjs`, `src/chain.mjs`, `src/pipeline.mjs`, `src/runner.mjs`, `src/ledger.mjs`, `src/leases.mjs`, `src/mergequeue.mjs`, `src/adapters/*.mjs` |

## History

- [REUSE.md](REUSE.md): what Leg ports from the private team tooling it started from, and what it drops.
- [ERRORS.md](ERRORS.md): what broke, the root cause and the fix, so a repeat is countable.
- [DEVIATIONS.md](DEVIATIONS.md): every place Leg's shape differs from that ported source or from the plan, one row per change.

## Also see

- [../README.md](../README.md): the top-level overview.
- [../CHANGELOG.md](../CHANGELOG.md): what changed in each release.
- [../CONTRIBUTING.md](../CONTRIBUTING.md): dev setup, tests, lint, the privacy hook, PR checklist.
- [../SECURITY.md](../SECURITY.md): how to report a vulnerability.
