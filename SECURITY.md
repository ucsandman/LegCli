# Security policy

## Supported versions

| version | supported |
|---------|-----------|
| 0.1.x | yes |

Baton is pre-1.0 and local-only software. Only the latest `0.1.x` release
gets security fixes.

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability. Use GitHub's
private vulnerability reporting on this repository instead: go to the
repository's **Security** tab, then **Report a vulnerability**. This opens
a private draft advisory that only the maintainer can see until it is
resolved.

Include what you found, how to reproduce it, and what you think the impact
is. You will get an acknowledgment and, where reasonable, updates as the
fix moves forward.

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
