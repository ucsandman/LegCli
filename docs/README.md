# Docs index

## Start here

- [getting-started.md](getting-started.md): install, run the preflight, create your first card from the board and the CLI, where files live, how to stop it.
- [concepts.md](concepts.md): cards, stations, chains, outcomes, handoffs, leases, the land station, the card status state diagram.
- [board-guide.md](board-guide.md): every element of the board and the floor view, what a card looks like in each state.
- [configuration.md](configuration.md): every environment variable, `.env`, network exposure, card-level options.
- [adapters.md](adapters.md): each coding-agent CLI's exact argv, modes, forbidden flags, gotchas, and how to add a new adapter.
- [faq.md](faq.md): short answers to real questions (limits, secrets, resuming after a crash, Windows support, reporting a bug).

## Reference

- [VOCABULARY.md](VOCABULARY.md): the exact identifiers Baton uses for statuses, outcomes, event types, actor types, human actions, and bounce reasons.
- [cli-contracts.md](cli-contracts.md): what Baton knows about each coding-agent CLI, with every fact tagged observed-live or docs-only.
- [DEMO.md](DEMO.md): a fake-adapter walkthrough of a usage-limit handoff, with screenshots.
- [real-run.md](real-run.md): one real run, claude handing off to codex with no fakes involved.
- [ROADMAP-v2](ROADMAP-v2.md): where the factory-floor shape is headed after v1.

## History

- [REUSE.md](REUSE.md): what Baton ports from the private team tooling it started from, and what it drops.
- [DEVIATIONS.md](DEVIATIONS.md): every place Baton's shape differs from that ported source, one row per change.

## Also see

- [../README.md](../README.md): the top-level overview.
- [../CONTRIBUTING.md](../CONTRIBUTING.md): dev setup, tests, lint, the privacy hook, PR checklist.
- [../SECURITY.md](../SECURITY.md): how to report a vulnerability.
