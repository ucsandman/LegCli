# The portable harness

Off by default. When you turn it on, a hand-off carries two things instead of
one: the task (the context handoff bundle Leg has always written) and the
agent's **working environment**: the global working agreement, identity,
hooks, skills, subagents, slash commands, MCP servers and permissions of the
client you actually use, rendered into the native configuration of the client
the hand-off lands on. The promise is not byte-for-byte equivalence. It is:

> Preserve as much of the source agent's operating environment as the
> destination client can faithfully support, and say exactly what could not be
> carried over.

```
leg harness enable        # detect clients, capture, show the plan, apply after you say yes
leg harness status        # what is on, the source, when it was captured, each client's state
leg harness sync          # re-capture and write whatever is out of date
leg harness check         # the same, writing nothing; exit 1 when something is stale
leg harness explain       # every item a client could not receive, and why
leg harness disable       # stop; nothing already written is removed
```

## What moves, and what does not

| component | carried as | what a destination may drop |
|---|---|---|
| rules | the source's global rules file with its `@imports` inlined, written as the destination's global rules file (`AGENTS.md`, `GEMINI.md`, or `leg-rules.md` imported from `CLAUDE.md`) | nothing; the whole agreement travels |
| identity | `SOUL.md` or the identity section, inlined or written to the client's own file | nothing |
| hooks | the same hook scripts, pointed at (never copied), in the destination's dialect; non-Codex clients run them through a shim that translates the payload | an event the client does not have (`MessageDisplay`, agy's missing `SessionStart`), a matcher whose tools have no counterpart |
| skills | a directory link per skill into the client's skills directory, so an edit at the source is live everywhere | a name that already exists as a real directory there, a skill the client reads natively from a shared directory |
| agents | one subagent file per agent in the client's format (`.md` or `.toml`), with the model tier mapped through the client's ladder | a client with no subagent surface (Gemini CLI) |
| commands | one prompt file per slash command (`prompts/`, `commands/`, `.toml` for Gemini) | a name that already exists and Leg did not write |
| MCP servers | each server in the client's own MCP file or config table, with every credential replaced by an environment reference | a transport the client lacks (Codex has no SSE), a server the user already configured there |
| permissions | `settings.json` allow/deny/ask for Claude Code; Codex prefix rules for `Bash(...)` patterns | anything but a `Bash(...)` pattern on Codex; clients with no machine-readable permission surface |

What never moves:

- **Credentials.** OAuth tokens, `.credentials.json`, `auth.json`, API keys in an
  MCP `env` or `headers` block, and a token anywhere else the capture reads.
  An `env` or `headers` value that looks like a credential becomes `${NAME}`
  in the bundle and Leg tells you which variable to export for each client.
  A token inside free text (the rules, the identity, an agent or command
  body) is replaced by `[REDACTED]`; a hook whose command line carries one,
  and an MCP server whose argument or URL carries one (a password in a
  connection string, a secret query value, a token in the path), are not
  carried at all, each with a warning naming it. The scan is fail-closed:
  every field of the bundle is validated at save time and a bundle that
  still carries a credential is refused. Tests plant tokens in every one of
  those places, and in the places a capture must not read, and assert they
  appear in no bundle file and no destination file.
- **Which login runs.** Accounts are Leg's account layer
  (`leg accounts`, `src/accounts.mjs`); the harness describes behaviour and
  capabilities, never who is signed in. A same-agent hand-off to a second
  login carries no harness at all: the second login shares the first one's
  home through the junctions the account layer made.
- **Project-local instructions.** A repository's `CLAUDE.md`, `AGENTS.md` or
  `GEMINI.md` is read natively by each client from the checkout. The harness
  carries the *global* working agreement only.
- **The source client itself.** The client the harness is captured from is
  never written to.

## Precedence

When a destination starts after a hand-off, four layers of instruction are in
play. From most to least specific:

1. **The resume prompt and bundle** (`.leg/RESUME-<session>.md`): the task,
   the last messages, the diff, why the previous agent stopped. Always
   present, harness or not.
2. **The repository's own instruction files**: `CLAUDE.md`, `AGENTS.md`,
   `GEMINI.md` in the checkout. Never touched by Leg; each client reads them
   itself.
3. **The ported global working agreement**: the destination's global rules
   file, written by the harness. This is where the source's `~/.claude/CLAUDE.md`
   (with its imports) lands.
4. The client's own defaults.

Leg does not merge layers 2 and 3. A repository file that repeats a global rule
repeats it; a repository file that contradicts one wins, because that is how
every client already resolves project-level instructions over global ones.
`test/harness-policy.test.mjs` runs a sync from inside a checkout that has its
own `CLAUDE.md` and `AGENTS.md` and asserts both are byte-identical afterwards:
a sync writes under the client homes only.

## Turning it on: the first run

`leg harness enable` is the one explicit consent. It:

1. Detects which sources exist on this machine (`~/.claude/CLAUDE.md`,
   `~/.codex/AGENTS.md`) and picks the first, or the one you name with
   `--source`. It never guesses destructively: with two sources it says which
   it chose and how to choose the other.
2. Captures the source into the neutral bundle under `~/.leg/harness/bundle/`,
   scans it for credentials, and prints every warning.
3. Runs a check against every installed client and prints the table: per
   client, per component, `✓ synced`, `✗ stale`, `- unsupported`, and the
   count carried (`skills 2/3`), then every item that will not be carried with
   its reason.
4. Asks before writing. In a terminal it prompts; without one (a script, CI)
   it prints the plan, writes nothing, and exits 3 unless you passed `--yes`.
5. Applies, records ownership of every file and region it wrote, and saves the
   consent: `preferences.json` gains `"harness": { "enabled": true, "policy":
   "sync", "source": "claude" }`.

After that, unattended hand-offs use the saved policy and never prompt.
`leg harness sync` writes only on an install that gave this consent; before
`enable` it exits 3 and points at it, while `check`, `diff` and `explain`
report without writing. The board can turn the feature off or narrow the
policy, never turn it on or widen it: that stays a terminal command.

## Policies

`leg harness policy <warn|sync|strict>`, or `--policy` on `enable`. The
default when you enable is `sync`; an install that never enabled the feature
is `off` and behaves exactly as before.

| policy | at a hand-off, before the next agent starts |
|---|---|
| `off` | nothing is captured, checked, written or recorded |
| `warn` | the source is re-captured if it changed, the destination is checked, the result is recorded on the session and printed; nothing is written to any client |
| `sync` | as `warn`, and a stale destination is synced: managed files and regions are written, backups taken, hand-edited files skipped and reported. The hand-off proceeds whatever the outcome. |
| `strict` | as `sync`, and a destination that ends `attention`, `error` or `unsupported` is refused: Leg records `harness_blocked`, prints why, tries the next option in your hand-off order, and if none is left stops the terminal with exit 5 rather than launching an agent without its environment. Strict applies to hand-offs only; the agent you start yourself is never refused. |

There is no interactive prompt on this path under any policy. A limit usually
lands when nobody is at the keyboard, and a prompt would wedge the terminal
until morning.

## States

One word per destination, the same word on the CLI, the session timeline, the
terminal card and the drawer:

| state | meaning |
|---|---|
| `synced` | everything the destination supports is current and nothing was dropped |
| `partial` | current, but some items could not be carried (each has a reason under **Dropped**) |
| `stale` | the destination is behind the source; `warn` policy, or a `check` |
| `attention` | a managed file was hand-edited since Leg wrote it (backed up, left alone), a component errored (a malformed config file, for instance), or a `deny` or `ask` permission the destination cannot express was dropped, leaving it less restricted than the source; needs you |
| `unsupported` | the destination has no harness adapter (Grok) or is not installed |
| `blocked` | the strict policy refused this destination |
| `source` | the destination is the source client; nothing to carry |
| `same-client` | a hand-off to another login of the same client; the harness is shared already |
| `error` | the preparation itself failed; the reason is recorded |

## Ownership, backups, hand edits

Every file the harness writes carries `GENERATED by Leg harness` in its first
lines. Inside a file you also own (`config.toml`, `settings.json`,
`.claude.json`, agy's `hooks.json`) it writes a marked region:

```
# >>> leg harness hooks start (generated, do not edit)
...
# <<< leg harness hooks end
```

or, for JSON, exactly the groups or keys it inserted last time, recorded in
`~/.leg/harness/harness-state.json`. Everything outside is preserved byte for
byte; a re-run only ever removes what the harness itself added; a skill link is
never made over a real directory; a file Leg did not create is never
overwritten. Before any overwrite the previous content goes to
`~/.leg/harness/backups/<client>-<file>-<timestamp>.bak`. A generated file
that is pruned because its source went away (a subagent or command deleted at
the source, a permissions file that became empty) is backed up the same way
before it is removed.

A file you edit by hand after Leg wrote it (the ownership line removed, or
the content changed) is detected by hash, backed up once, and **skipped**. The
sync reports `attention` with the path and the remedy: edit the source client
instead, or `leg harness sync --force` to replace it (the backup stays).

## Performance

A hand-off must stay fast. Before capturing, Leg fingerprints the source's
surfaces from file metadata alone (the rules file and its imports,
`settings.json`, the MCP file, the agents, commands and skills directories):
a few dozen `stat` calls. An unchanged fingerprint reuses the bundle on disk.
The destination is then checked by reading its managed files, and written
only when something differs. `test/harness-perf.test.mjs` holds a warm
hand-off decision (unchanged source, synced destination) under 400 ms median
and a cached capture under 40 ms; on the development machine they measure
about 19 ms and 7 ms.

## Failure model

| failure | what happens |
|---|---|
| no source configured or detected | `error`; hand-off proceeds under `warn`/`sync`, refused under `strict`; `leg harness source` names one |
| destination not installed | `unsupported`; the chooser never picks a missing CLI anyway |
| destination config is not valid JSON/TOML | that component is `error`, nothing is written to that file, the hand-off proceeds under `warn`/`sync` |
| a managed file was hand-edited | `attention`; backed up, skipped, named |
| a skill name is a real directory at the destination | dropped with a reason; the directory is untouched |
| an MCP value references a variable the destination does not expand | the component note names the variable to export |
| a hook event or matcher the destination lacks | dropped with a reason |
| a `deny` or `ask` permission the destination cannot express | `attention`: the destination would be less restricted than the source; strict refuses it, sync proceeds and names it |
| a credential in the rules, an agent, a command, a hook command line, an MCP argument or URL | free text is redacted to `[REDACTED]`; the hook or server is not carried; each with a warning |
| a subagent, command or skill with an unsafe name | not carried, with a warning; the rest of the bundle still travels |
| a skill path with a shell metacharacter on Windows when the junction fallback is needed | the link is refused and reported; nothing is passed to a shell |
| two Leg processes hand off at once | one takes `~/.leg/harness/.lock` (up to 30 s); the other fails its own step rather than tearing the ownership record |
| a model tier the destination cannot map | passed through as a raw id and noted |
| the captured bundle is corrupt on disk | re-captured from the source, never trusted |
| an interrupted previous apply | the next sync re-derives everything from ownership records; a region is rebuilt, never appended twice |
| the engine itself throws | `error` on the session; the session is never corrupted; the hand-off proceeds under `warn`/`sync` |

Nothing here rolls back a user file: every overwrite is preceded by a backup,
and a refusal leaves the file as it was.

## Observability

Every operation leaves evidence:

- `~/.leg/harness/history.jsonl`: one line per capture, apply and hand-off
  decision, with the source, target, bundle fingerprint, timestamps,
  per-component states, dropped items, attention items, the files touched and
  the backups made. `leg harness history` prints it.
- The session record (`session.json` → `harness`) carries the outcome for the
  leg now running: source, fingerprint, capture and sync times, components,
  dropped, attention, whether the hand-off proceeded.
- Session events `harness` and `harness_blocked`; card ledger events of the
  same names on the background-task path.
- The board: a chip on the terminal row (`harness synced`, `harness partial`,
  `harness attention`, `harness refused`) and a **Harness** section in the
  drawer with the source, capture and sync times, the component table,
  **Needs you**, **Dropped**, and the last eight trail entries.

No secret is ever logged: the bundle holds references, the trail holds paths
and states.

## Files

```
~/.leg/harness/
  bundle/               the neutral bundle: manifest.json, rules.md, identity.md,
                        hooks.json, mcp.json, skills.json, permissions.json, agents/, commands/
  capture.json          source, fingerprint, the surfaces hash the capture was taken at
  harness-state.json    ownership: every file and region written, per client
  harness-report.json   the last apply or check, per client, per component
  backups/              every file before Leg overwrote it
  history.jsonl         the evidence trail
  policy.json           optional: what is deliberately not carried (below)
```

`leg uninstall --yes` removes `~/.leg` and with it all of the above. It does
not remove what the harness wrote into other clients: run `leg harness
disable`, then delete the files carrying `GENERATED by Leg harness` and the
`leg harness` regions if you want them gone.

## The port policy

`~/.leg/harness/policy.json`, optional, merged over the defaults:

```jsonc
{
  "rules":  { "dropSectionsForTargets": ["Delegation and Model Routing"] },
  "hooks":  { "exclude": [{ "match": "capability-graph-guard", "reason": "polices Claude Code's model ladder" }] },
  "skills": { "exclude": { "review-browser": "the destination has no browser tool" } },
  "mcp":    { "exclude": { "xapi": "one OAuth grant per client; copy nothing" } },
  "agents": { "modelLadder": { "codex": { "opus": ["gpt-5.6-sol", "high"] } } }
}
```

An excluded item shows in `explain` and on the board as **excluded by policy**
with your reason, and does not make a destination `partial`. The defaults
exclude nothing; the shipped Codex model ladder maps the four Claude tiers
(`fable`, `opus`, `sonnet`, `haiku`) onto Codex models and can be overridden.

## Which clients

| client | source | destination | notes |
|---|---|---|---|
| Claude Code | yes | yes | the bundle's own dialect; hooks and matchers need no translation |
| Codex CLI | yes | yes | hooks pre-trusted with Codex's own trust hash (self-tested against a value Codex wrote); SSE servers dropped |
| Antigravity CLI (`agy`) | no | yes | hooks under one owned key in `hooks.json`; shares `GEMINI.md` with Gemini CLI; no permission surface |
| Gemini CLI | no | yes | kept coherent with agy; no subagent surface |
| Grok CLI | no | no | no adapter yet; reported `unsupported`, never guessed |

Paths honour `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CONFIG_DIR`, the
same variables the trust and account layers honour.

## Leg and Agnostic AI

The capture → neutral bundle → apply engine is the
[Agnostic AI](https://github.com/ucsandman/Agnostic-AI) port engine (MIT).
Leg embeds it as a library, byte for byte, under
`src/harness/vendor/agnostic-ai/`, and owns everything around it: consent,
policy, the client registry, where state lives, the fingerprint, the evidence
trail and the hand-off decision (`src/harness/*.mjs`).

Drift between the two is refused, not managed:

- `src/harness/vendor/agnostic-ai/UPSTREAM.json` records the upstream commit
  and the sha256 of every vendored file. `npm test` runs
  `scripts/sync-harness-engine.mjs --check`, which fails on any local edit
  under `vendor/`.
- A fix to the engine lands upstream first, then
  `node scripts/sync-harness-engine.mjs <path-to-agnostic-ai>` copies it in
  and re-records the hashes. `--diff <path>` lists what a sync would change.
- Upstream exposes the library through `engine/harness/index.cjs` with
  everything a host may own as an option (`configure({ brand, secretPatterns,
  shimPath, importRoots })`, an injected registry and policy), and its own
  regression suite proves that boundary. Node's ESM loader imports that
  CommonJS entry directly, so there is no build step and no dependency.

Attribution is in `NOTICE`; the vendored copy keeps its MIT licence text and
is not relicensed.

## Limits

- Grok has no adapter.
- Cursor, Windsurf and the other clients upstream supports are not in Leg's
  registry, because Leg does not launch them.
- The Claude Code target imports the ported rules from `~/.claude/CLAUDE.md`
  with one `@` line; a source that is itself Codex therefore lands as
  `~/.claude/leg-rules.md`, not inline.
- A repository-level harness (project skills, project MCP) is not carried;
  only the global one is.
- Persistent configuration is the only mechanism: none of the four clients
  offers a per-session overlay for rules, hooks, skills and MCP together, so
  the managed-region and ownership discipline above is what keeps writes safe.
