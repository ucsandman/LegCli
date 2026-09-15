# Security policy

## Supported versions

| version | supported |
|---------|-----------|
| 0.6.x | yes |
| < 0.6 | no |

Baton is pre-1.0 and local-only software. Only the latest minor release gets
security fixes; upgrade with `npm install -g baton-agents@latest`.

## Reporting a vulnerability

Email **baton@practicalsystems.io** with `SECURITY` in the subject. The
source repository is private, so there is no public issue tracker and no
GitHub advisory form to use; mail is the whole reporting path.

Include what you found, how to reproduce it, and what you think the impact
is. You will get an acknowledgment inside two working days and, where
reasonable, updates as the fix moves forward. Please give a fix a reasonable
window before publishing details.

## Scope

Baton is local-first by design:

- The board server binds `127.0.0.1` by default. It does not listen on any
  other address unless you explicitly set `BATON_BIND`, and it refuses to
  start on a non-loopback address without `BATON_TOKEN` also set (exit code
  `3`; see [docs/configuration.md](docs/configuration.md#network-exposure)).
- The token seam (`BATON_TOKEN`, `Authorization: Bearer <token>`, or
  `?token=` for the event stream) is a bearer secret, not a full
  authentication system: there is no TLS, no per-user identity, and no
  session expiry yet. A vulnerability report about the lack of those is
  useful and tracked ([docs/ROADMAP-v2.md](docs/ROADMAP-v2.md)); a report
  that assumes they already exist is not a bug.
- Every adapter spawns its CLI as `argv`, never a shell, and strips
  API-key/base-URL environment variables from the child process
  (`src/env.mjs`). A way to make an adapter pass a permission-bypass flag,
  or to make Baton fall back to a shell spawn anywhere, is in scope.
- Secret redaction (`src/redact.mjs`) covers logs, launcher output, and
  handoff bundle text. A secret shape it misses, or a path where a secret
  reaches disk or stdout unredacted, is in scope.

Out of scope: anything requiring physical or already-elevated access to the
machine Baton runs on, and vulnerabilities in the coding-agent CLIs
themselves (report those to their own maintainers) or in
`context-handoff-bundle` (report to that project).
