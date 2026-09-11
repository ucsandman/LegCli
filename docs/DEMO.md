# Demo: a usage limit hands the card to the next agent

What you watch: a card starts on `fake-claude`, hits a (recorded) Claude usage
limit, Baton writes a context-handoff-bundle, and `fake-codex` resumes in the
same worktree and finishes. The fake adapters replay real CLI shapes without
spending any subscription usage; the real run is in [real-run.md](real-run.md).

Screenshots from the run on 2026-09-11 (02:36 UTC), of the live board at
1280×800: `docs/screenshots/demo-1-claude-running.png`
(leg 1 running), `demo-2-limit-hit.png` (limit detected, handoff written, card
waiting for approval with the ↷ glyph on the claude leg), `demo-3-handoff-bundle.png`
(detail drawer: timeline with `limit_detected` and `handoff_written`, bundle
path), `demo-4-codex-running.png` (leg 2 running), `demo-5-done.png` (Done).
The recorded ledger is `fixtures/demo/events.jsonl`.

## Replay it (the recorded card ran in 49 s once it was queued)

1. A throwaway repo and home:

   ```
   mkdir %TEMP%\toy-demo && cd %TEMP%\toy-demo && git init -b main && echo # toy > README.md && git add -A && git commit -q -m init
   set BATON_HOME=%TEMP%\baton-demo-home
   set FAKE_DELAY_MS=15000
   ```

2. Start Baton (it serves the board on http://127.0.0.1:4747; `BATON_NO_OPEN=1`
   skips the browser):

   ```
   cd C:\Projects\baton && npm start
   ```

3. Click **New card**. Repo path: the toy repo. Task: `Add a file greeting.txt
   containing 'hello from baton'`. Chain: row 1 `fake-claude` with fake mode
   `limit`; **Add chain row**: `fake-codex`, fake mode `success`, tick
   **approve** so the handoff pauses for you. Leave **Queue immediately** on.
   **Create**.

4. Watch the card in the Build column: `leg_started` → after ~15 s
   `limit_detected` (signal `claude-session-limit`) → `handoff_written` → chip
   **needs approval**. Click the title to see the timeline and the bundle path.

5. Click **Approve**. `fake-codex` runs ~15 s and the card lands in Done.

6. Ctrl-C stops everything (`baton down` from another terminal does the same).

The same demo headless, with the target file named:

```
node bin/baton.mjs card add --repo %TEMP%\toy-demo --task "Add greeting.txt" --chain fake-claude,fake-codex --fake-mode "fake-claude=limit,fake-codex=success" --fake-target fake-codex=greeting.txt --title "Greeting file"
node bin/baton.mjs card run <card-id>
node bin/baton.mjs card events <card-id>
```

The fake agent writes `FAKE_TARGET` (default `hello-fake.txt`); it does not read
the task, which is why the headless replay passes `--fake-target`.
