# History: every conversation on this machine

`leg history` lists the coding-agent conversations on this machine in one
place: the sessions Leg started itself, and the ones Claude Code, Codex, Grok,
Antigravity and GitHub Copilot CLI keep in their own stores, whether or not
Leg was involved. `leg worktrees` does the same for checkouts. The board's
fourth ledger cell, **Conversations**, is the same index with a search box.

Nothing moves. Claude keeps Claude's history where it always was, Codex
keeps Codex's, and so on. Leg reads those stores, writes one index file of
its own, and points back.

## What you get

```
leg history                          newest first, every agent, 50 rows
leg history --provider codex,grok    one or more agents
leg history --repo leg               a repository by name, or by path
leg history --search "drainer"       title, repo, branch, folder or id
leg history --managed | --external   only what Leg started, or only what it found
leg history --live                   only conversations with a process still on them
leg history --all --json             everything, as JSON
leg history show <id>                one conversation: where, when, its last messages, whether it can continue
leg history continue <id>            start leg <agent> on it, in its folder, supervised like any other session
leg history refresh [--full]         re-stat every store now; --full drops the index and re-reads everything
leg history providers                the support matrix below, from the code that implements it
leg worktrees [--repo <path>] [--json] [--no-dirty]
```

An id is `<provider>:<the agent's own id>`, for example
`claude:0fc54b51-6cfa-40cf-9823-a5a36d1ca3f3`. A unique prefix of the agent's
id, four characters or more, is enough: `leg history show 0fc5`. A Leg session
id (`s-2026…`) works too.

A row says which agent, whether the conversation is **leg** (Leg started it,
its session id follows) or **external** (found in the agent's store), whether
it is **live** (a process is still on it, where the agent leaves a marker),
the repository and branch, when it was last active, and its title.

## Support matrix

Verified against the stores on a real machine on 2026-09-16 (Claude Code
2.1.273, codex-cli 0.154.0, Grok CLI with `chat_format_version` 1,
Antigravity 1.2.0, Copilot CLI 1.0.80). Each provider's file header in
`src/history/providers/` names the exact files and fields it reads.

| provider | list | title | branch | live marker | transcript | continue | store read |
|---|---|---|---|---|---|---|---|
| Claude Code | yes | custom title, else the AI title, else the first prompt | yes | `sessions/<pid>.json`, pid checked | yes | `claude --resume <id>` | `~/.claude/projects/*/<id>.jsonl`, `history.jsonl`, `sessions/` |
| Codex | yes | `session_index.jsonl`, else the first prompt | yes (the `git` block) | no | yes | `codex resume <id>` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `session_index.jsonl`, `history.jsonl` |
| Grok | yes | `generated_title`, else the summary, else the first prompt | yes | `active_sessions.json` | yes | `grok --resume <id>` | `~/.grok/sessions/<cwd>/<id>/summary.json`, `chat_history.jsonl`, `prompt_history.jsonl` |
| Antigravity | yes | `annotations/<id>.pbtxt`, else the first prompt | no | no | **no** (SQLite) | `agy --conversation <id>` | `~/.gemini/antigravity-cli/history.jsonl`, `annotations/`, `presence/` |
| Copilot CLI | yes | the session name | yes | no | yes | **no** | `~/.copilot/session-state/<id>/workspace.yaml`, `events.jsonl` |

Extra logins made with `leg accounts add` are scanned too (their `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` or `GROK_HOME` directory); a row from one carries the account
name.

**Continue** is offered only where the installed CLI's own help documents
resume-by-id, quoted in the provider file. Antigravity keeps its transcripts
in SQLite, which Leg does not open, so it lists and continues but cannot show
messages. Copilot is discoverable without being an agent Leg supervises, so it
lists and shows messages but cannot be continued through Leg; that split (a
provider Leg can *find* versus an agent Leg can *run*) is deliberate, and the
registry in `src/history/index.mjs` is separate from `src/adapters/`.

Looked at and left unsupported, each for one reason: Cursor (its chat lives
in `state.vscdb`, SQLite), opencode (`opencode.db`, SQLite), Pi (documented
under `~/.pi/agent/sessions/`, not present on the verification machine, the
cwd encoding undocumented), Hermes, aider and Windsurf (no session store).

## How discovery works

- **One index file.** `$LEG_HOME/history/index.json` holds, per provider, per
  transcript, the file's size and mtime and a small record: ids, cwd, repo,
  branch, times, a scrubbed title cut to 200 characters. No message body is
  ever cached. A refresh stats every file and re-reads only the ones whose
  size or mtime changed; deleted files drop out.
- **Bounded reads.** Metadata comes from the first 256 KB and the last 256 KB
  of a transcript, never the whole file (a busy machine has gigabytes of
  them). Messages are read only when a conversation is opened, from the last
  4 MB, and every string is passed through the same redaction as the rest of
  the board plus the values of the well-known key variables the process holds.
- **Repository resolution without git.** A cwd is walked up to its `.git`; a
  `.git` *file* names a linked worktree and its main repository, so a
  conversation that ran in a worktree groups under the repository it belongs
  to. When the folder is gone, what the agent itself recorded (Claude's
  `worktree-state`, Grok's `git_root_dir`) is used instead.
- **Dedup.** A Leg session records the agent's own id (`agent_session_id`)
  and transcript path; a discovered record with the same id or path is the
  same conversation and is shown once, marked managed, with the Leg session id
  and status. A Leg session whose agent id Leg never learned still lists,
  under `leg:<session id>`. `leg history continue` seeds the new session with
  the id up front, so the continued conversation dedups from its first turn.
- **Hidden by default.** Subagent threads (Codex `source.subagent`, Grok
  `session_kind: subagent`, Claude sidechains and the `<id>/subagents/`
  directory) and sessions Claude Code itself hides (`history-suppression`)
  are left out unless `--subagents` (the API's `hidden=1`) asks for them.
- **A provider failing is contained.** Each provider scans inside its own
  try; a throw keeps that provider's last good entries, records the error on
  its stats line, and the others still index.
- **The listing refreshes itself** when the index is older than a minute;
  `leg history refresh` forces it.

## Worktrees

`leg worktrees` merges three sources into one list: what `git worktree list`
says for every repository Leg knows (from its sessions, its cards and the
discovered conversations), the worktrees Leg's sessions and cards recorded
(even when git no longer lists them), and the worktrees discovered
conversations ran in. Each row carries the repository, branch, whether the
directory exists, how many files are uncommitted (git status, on up to 40
checkouts per call; `null` past that or when `--no-dirty`), who owns it (the
checkout itself, a Leg session, a Leg card, or nobody Leg knows), which
conversations point at it and when the last one was active, **orphaned**
(a `.leg-worktrees/` directory no session or card records), **stale**
(exists, no live owner, nothing touched it in 14 days) and **missing** (git
or a record names it, the directory is gone).

It is a view. Removing a worktree is still `leg sessions rm`, `leg card rm`
or the board's Remove, which keep their guards.

## Privacy

- The whole `/api/history` and `/api/worktrees` group is the owner's. On a
  shared board a guest gets 403 from every route in it, the same gate as the
  pipeline routes; nothing history knows is pushed over SSE.
- The API takes an id, never a path. The transcript a record names is read
  only when it sits inside a provider home, an extra account's directory or
  Leg's own `sessions/`; an index edited by hand to point elsewhere reads
  nothing.
- Discovery writes only `$LEG_HOME/history/index.json`, its lock and its
  temporary sibling, and refuses to write when `LEG_HOME` sits inside a
  provider's store. No SQLite file is ever opened. Junctions and symlinks
  under a store are not followed.
- `leg history continue` validates the id against the provider's own shape
  (a UUID) before it becomes an argument, and the folder before it becomes
  the working directory: it must exist, be a directory, and not sit under
  `LEG_HOME`. The continued session shares its checkout (no worktree is cut):
  the conversation's files are where it left them.

## Adding a provider

One file in `src/history/providers/`, registered in `src/history/index.mjs`:

- `name`, `label`, `transcript` (`'supported' | 'unsupported'`), `ID_RE`
- `root(homes)`: the store's directory (from the CLI's own environment variable
  when it has one; `homes` overrides it in tests)
- `scan({ home, prev })`: `{ entries, aux, scanned, parsed }` where `entries`
  maps a stable key (the transcript path) to `{ mtime, size, record }`, reusing
  `prev.entries[key]` when the file is unchanged; `record` carries
  `native_id, cwd, branch, title, started_at, updated_at, transcript_path,
  size_bytes, turns, live, native`
- `messages(record, limit)`: the last messages from a bounded tail, or `null`
- `resume(record)`: `{ supported, agent, args }` or `{ supported: false, reason }`,
  with the CLI's help text quoted beside it
- optionally `liveIds(home)`

`test/history-fixture.mjs` shows the shapes each existing provider expects;
a new provider gets a builder there and a row in the matrix above.
