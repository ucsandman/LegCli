# Permission defaults repair

```yaml
contract_version: 1
subject: "Leg launch permissions and client trust"
generated: "2026-10-01"
must_haves:
  - id: MH-01
    requirement: "Missing, malformed or non-boolean auto_approve resolves off. Explicit saved booleans survive reads and unrelated saves. Reads do not write."
    shape: [stateful, io]
    edge_category: empty
    disposition: specify
    tier: test
    non_inferable: false
    check: "node --test test/auto-approve.test.mjs"
  - id: MH-02
    requirement: "CLI overrides environment, which overrides preferences. Conflicting CLI switches resolve off. Environment opt-out wins a conflict. LEG overrides corresponding BATON aliases. Only normalized 1/true/on enable environment opt-in; empty or unknown values resolve off."
    shape: [text, collection]
    edge_category: ordering
    disposition: specify
    tier: test
    non_inferable: false
    check: "node --test test/auto-approve.test.mjs test/permission-launch.test.mjs"
  - id: MH-03
    requirement: "Direct, resume, history, card takeover and handoff launches add no bypass by default. Explicit opt-in persists across that terminal's handoffs. Native permission arguments are preserved. Headless adapters retain restricted modes and reject bypass flags."
    shape: [collection, stateful, io]
    edge_category: boundaries
    disposition: specify
    tier: test
    non_inferable: false
    check: "node --test test/auto-approve.test.mjs test/permission-launch.test.mjs test/attach-e2e.test.mjs test/history.test.mjs test/adapters.test.mjs"
  - id: MH-04
    requirement: "Client trust writes require LEG_TRUST=auto or its legacy alias. Missing, empty or unknown policy means never. Trust is independent of auto-approve."
    shape: [text, stateful, io]
    edge_category: idempotency
    disposition: specify
    tier: test
    non_inferable: false
    check: "node --test test/trust.test.mjs test/permission-launch.test.mjs"
  - id: MH-05
    requirement: "Public copy states opt-in bypass, opt-in trust writes including external Claude imports, separate harness writes, precedence and opt-outs. Generated docs match sources."
    shape: [text]
    edge_category: none
    disposition: specify
    tier: judgment
    non_inferable: false
prohibitions:
  - id: PR-01
    must_not: "Turn missing preferences, unrelated saves, typos, or default launches into consent to bypass approval or write trust."
    tier: test
    repo_check: "node --test test/auto-approve.test.mjs test/trust.test.mjs test/permission-launch.test.mjs"
  - id: PR-02
    must_not: "Run real agents or modify live client security configs in verification; use temporary homes and stubs."
    tier: judgment
    reason: "Execution constraint checked by reviewing fixtures and commands."
open_questions: []
```

Edges: boundaries covers zero/one/conflicting switches and all clients; adjacency
is inapplicable (no intervals); empty covers missing/invalid data; encoding covers
trimmed case-insensitive environment values; ordering specifies precedence and
native argv preservation; precision is inapplicable (no arithmetic); idempotency
covers reads and trust opt-outs; concurrency retains preference locks and terminal
permission snapshots. Existing saved true cannot be distinguished from an older
release's persisted default, so preserve it and document explicit opt-outs.
Native bypass arguments deliberately supplied by a user remain intact even when
Leg's injection is disabled. The independent requirement read-back confirmed the
intent: preserve client behavior by default, with separate explicit opt-ins.
