# Contributing

## Dev setup

```
npm install
pip install -U context-handoff-bundle
git config core.hooksPath .githooks
```

The last command turns on the pre-commit privacy hook (see
[Rules](#rules) below); it's a one-time local git config, not a package
install.

Node 22 or newer, git, and Python 3 with pip are the only external
requirements. You do not need any coding-agent CLI installed to develop or
test Baton: the `fake` adapter (`bin/fake-agent.mjs`) stands in for a real
one everywhere the test suite needs an agent.

## Running the checks

```
npm test
npm run lint
npm run privacy
```

- `npm test` runs `node --test` over everything in `test/`, then
  `scripts/privacy-check.mjs` (so a leaked private-source string fails the
  test run, not just the commit hook).
- `npm run lint` runs `eslint .` (config: `eslint.config.js`; it ignores
  `docs/**`, `fixtures/**`, `.baton/**` and `.baton-worktrees/**`).
- `npm run privacy` runs the same check `npm test` runs, standalone.

Prove a clean clone actually works before opening a PR that touches
install, build, or test wiring:

```
bash scripts/clean-clone-check.sh <scratch-dir>
```

It clones the repo into `<scratch-dir>`, runs `npm ci`, `npm test`,
`npm run lint`, and `node bin/baton.mjs up --dry`, and prints
`CLEAN-CLONE PASS tests=<n>` or `CLEAN-CLONE FAIL step=<step>`.

## How tests are laid out

- `test/helpers.mjs`: shared setup, a throwaway `BATON_HOME`
  (`makeHome()`), a throwaway git repo with one commit (`initRepo()`), and
  wrappers to run the `baton` CLI as a child process (`baton()`,
  `batonFail()`, `batonSpawn()`). Most test files import from here instead
  of duplicating setup.
- One test file roughly per source module (`chain.test.mjs` for
  `src/chain.mjs`, `leases.test.mjs` for `src/leases.mjs`, and so on).
- `e2e-fake.test.mjs` and `e2e-land.test.mjs`: full card runs through the
  real orchestrator and scheduler, using the `fake` adapter chain so no
  real CLI or subscription login is needed. This is the pattern to follow
  for any new end-to-end test: drive it with `fake`/`fake-claude`/
  `fake-codex` and `FAKE_MODE`, never a real adapter.
- `adapters.test.mjs`: shape and forbidden-flag tests for every adapter
  (including `grok`, which is built but not registered).
- `board-a11y.test.mjs`: accessibility assertions against the board's
  rendered output (focus handling, `aria-label`s, reduced-motion CSS).
- `lessons.test.mjs`: regression tests for specific incidents recorded
  while building Baton (see the file's own comments for what each one
  guards against).

## Rules

- **Zero runtime dependencies.** `package.json` has none; only
  `devDependencies` (eslint and its config packages). Do not add a runtime
  dependency without raising it as its own decision first.
- **Argv spawns only, never a shell.** Every child process call in `src/`
  passes an argv array (`spawn`/`spawnSync`/`execFileSync`), never a
  command string interpreted by `cmd.exe` or `/bin/sh`. This is what makes
  the forbidden-flag checks and the prompt-on-stdin/argv distinction
  actually safe.
- **No YOLO flags, ever.** Do not add a way, default or opt-in, to pass a
  permission-bypass flag to any adapter. If a new adapter needs a
  `forbiddenFlags` entry for its own bypass flag, add it; do not add a way
  around it.
- **Secrets never go in fixtures.** Any fixture that looks like it needs a
  real key, token, or path uses an obviously fake value
  (`fixtures/limits/*.json` and `fixtures/live/*/` are the pattern to
  follow). `scripts/privacy-check.mjs` and the redaction patterns in
  `src/redact.mjs` are the backstop, not the first line of defense.
- **A shape change gets a `DEVIATIONS.md` row.** If you change how a
  ported piece (`src/runner.mjs`, `src/ledger.mjs`, `src/git-snapshot.mjs`,
  see [docs/REUSE.md](docs/REUSE.md)) behaves compared to its original
  shape, or change an already-documented Baton shape in a way future
  readers would want explained, append one row to
  [docs/DEVIATIONS.md](docs/DEVIATIONS.md) (append-only, newest at the
  bottom): date, file, the old shape, the new shape, why.
- **The pre-commit privacy hook stays on.** `git config core.hooksPath
  .githooks` (above) wires `.githooks/pre-commit`, which runs
  `node scripts/privacy-check.mjs --staged` and blocks the commit on any
  hit. Do not commit with `--no-verify` to skip it.
- **The test suite never starts a real agent.** Every test drives `fake`,
  `fake-claude`, `fake-codex`, `fake-agy` or `fake-nostdin` with `FAKE_MODE`,
  and every tap test reads a recorded fixture. A test that needs a real
  subscription login is a test that cannot run in CI or on a contributor's
  machine.
- **A real agent session started by hand to test tooling runs on the cheapest
  model.** `baton claude --model haiku` (or `--model sonnet`); for another
  agent, whatever its own cheapest-model flag is.
  Verifying that a hook fires or that a tap reads the right file costs one
  turn; there is no reason for that turn to come out of an expensive model's
  usage window.

## Commit message style

Every commit in this repo's history starts with `baton: ` followed by a
short, lowercase, present-tense-ish summary (`git log --oneline`):

```
e1ddc42 baton: station kind modules (audit fix 1)
9e9ad04 baton: polish and harden
c7459d3 baton: land station, merge queue, pr mode stub, 3-card landing e2e
dbceacd baton: scheduler with path leases + concurrency test
```

Follow that shape: `baton: <what changed>`, no period, no issue number
required.

## PR checklist

- [ ] `npm test` passes (includes the privacy check).
- [ ] `npm run lint` passes.
- [ ] `npm run privacy` passes (redundant with `npm test`, but check it
      directly if you touched fixtures or docs).
- [ ] A `DEVIATIONS.md` row added if this PR changes a ported or
      already-documented shape (see [Rules](#rules)).
- [ ] No secrets, tokens, or real machine paths in any file this PR adds or
      touches.
