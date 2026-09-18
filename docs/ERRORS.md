# Errors

What broke, why, and what fixed it. One entry per failure, newest first. A first
occurrence has to be written down or a repeat is never countable.

## 2026-09-18: 0.14.0 pushed, CI green everywhere, and npm still served 0.13.1

**Fixed by putting the `repository` block back into the lockfile root
(`packages[""]`) and pushing again.** `scripts/npm-publish-gate.mjs` requires
`package-lock.json`'s root `repository.url` to equal the trusted-publisher
binding, and npm 10.9 (the local install) does not write that block; npm 11
does, which is where the 0.13.1 lockfile got it. `npm version 0.14.0` on npm
10 rewrote the lockfile without it, the test matrix and the site deploy passed,
and only the `publish-npm` job failed, on the gate, before publishing anything.
The lesson: a lockfile touched by a different npm major is a release change,
and "CI green" after a push means the run, not the publish; `npm view
@ucsandman/legcli version` is the check.

## 2026-09-18: `vercel --prod --yes` from `site/` failed the deploy and created a stray Vercel project

**Fixed by deploying from the repo root with a root `.vercelignore` and
`--archive=tgz`; the recipe is in DECISIONS.md under "the site deploys itself
from git".** The `--yes` also auto-created an empty Vercel project named `leg`
that still needs `vercel project rm leg` (2026-09-18 later: `vercel project ls` no longer lists a `leg` project, so it is gone). The lesson: on a project with a Root
Directory set, the CLI must run from the repo root, and `--yes` is a consent to
create projects, not only to skip a confirmation.

## 2026-09-18: the terminal's opening `next:` line named the same agent twice and no model

**Fixed in `src/attach.mjs`: the line maps the chain through `rungLabel`, so it
reads `next: claude/opus → claude/sonnet → codex → agy`.**

The ladder made destinations rungs of (agent, account, model), and every other
surface (the ledger's `handoff` event, the board's chain rail, `leg ladder`)
moved to `rungLabel`. The one line the human reads first, printed at session
start, kept its pre-ladder formatter of `agent[/account]`, so a claude/fable
terminal announced `next: claude → claude → codex → agy`. Found while writing
the marketing site's transcript from the source lines rather than from memory:
a transcript that mirrors the code cannot show a line the code prints wrongly.
The lesson is the same one as the site rule: a sample transcript is written
from the `say()` calls, and a `say()` that reads wrong there is a bug here.

## 2026-09-17: a new field on the session view leaked the owner's reset times to a guest, through the guest's own terminal

**Fixed in `src/server.mjs` (`sessionsView` decides `guest` before the map and
blanks `handoff_targets[].resets_at` for one). Caught by
`test/share-security.test.mjs`, which was already asserting it.**

The hand-off picker needed each destination's availability, so `handoff_targets`
went onto every session in `sessionsView` carrying `resets_at`. The obvious
mental model was "a guest gets `redactSession`, which lists its fields
explicitly, so a new field is invisible to them". That is only true of someone
else's terminal. `mine(s)` is true for a guest's **own** terminal, and that path
spreads the whole object. So a guest's own card carried the exact reset
timestamp of every account on the machine, including the owner's, which is
precisely the usage data the share design keeps off a guest's board.

The lesson is about where redaction lives, not about this field. There are two
paths out of `sessionsView`: `redactSession` (allow-list, safe by default) and
the `mine(s)` spread (deny-list, unsafe by default). **Any field added to a
session object is visible to whoever owns that session, and a guest owns one.**
A field that carries machine-level data has to be blanked where it is built, not
left to a redactor that never sees it.

What made this cheap: the security suite already asserted the whole guest
response text contains no reset time, so the leak failed a test in the same run
that introduced it. The test was written against the property ("a guest board
carries no reset time"), not against the fields that existed when it was
written, which is why it still caught a field invented months later.

Two smaller ones from the same change, both worth the line:

- Registering `grok` broke three tests that asserted `unknown adapter "grok"`.
  A test that encodes "not supported yet" as an assertion becomes a tripwire on
  the day support lands. Assert the refusal with a name nothing will ever
  provide (`no-such-agent`), so the test outlives the gap it was describing.
- `names()` started reading `$LEG_HOME/adapters` from disk, and `/api/health`
  calls it once for the list and once per adapter. That put a readdir, a read
  and a JSON parse per spec on the same event loop the terminals lane is pushed
  from, and `/api/health` went over its 1 s budget in
  `test/board-responsiveness.test.mjs`. Cached against the directory's entry
  list with a one-second floor. The board's hot path is `/api/health` plus the
  sessions view; anything new they call has to be counted, not assumed cheap.
  (This is the same event-loop failure as the entry below, from the other end.)
- `test/board-responsiveness.test.mjs` failed the ship twice at 1055 ms and
  1140 ms against a hard `< 1000 ms`, and passed three times out of three when
  run alone. An absolute millisecond budget on a four-way-concurrent runner
  measures the machine, not the code. It now takes an idle baseline in the same
  process and asserts the busy request is not 20x it, with a 3 s ceiling for the
  symptom the test is named for. **It was only trusted after being made to
  fail**: putting the original shape back (no floor, no fingerprint, a 1.2 s
  blocking view on every watcher event) made it report 4,810 ms and fail both
  assertions, which is the "four to fourteen seconds" the entry below describes.
  A perf test that has never been watched failing is a number, not a guard.

## 2026-09-17: one running terminal saturated the board's event loop, and four separate symptoms came out of it

**Fixed in `src/server.mjs` (watcher filter, stat fingerprint, push floor, cached
`canLand`), `src/attach.mjs` (a taken port is a board; always open it) and
`src/board/{board,sessions}.js` (one render per push, hold an open confirm row).
Regression tests: `test/board-responsiveness.test.mjs`.**

Reported as four bugs: `leg claude` took a long time to start, the board never
opened by itself, the board was slow to load and to react, and Remove under
Terminals did nothing. All four were one cause. The board server had burned
17,080 seconds of CPU — it answered `/api/health` in 7 to 14 seconds and a
40 KB stylesheet in 14. A live agent rewrites its session record every six
seconds or so and takes a control lock about once a second; the recursive
watcher over the sessions directory answered every one of those — including
`.control.lock`, `.session.lock` and the `session.json.*.tmp` files atomic
writes leave behind — with a full rebuild of the terminals view, which costs
about two seconds (1.1 s of it `canLand` shelling out to git across twenty
worktrees). 105 filesystem events in 30 seconds against a 300 ms debounce and a
2,000 ms rebuild: the queue could never drain.

What that one stall produced:

- **Slow start.** `ensureBoard`'s health probe times out at 2 s, so a merely
  busy board read as no board. `leg` spawned a second server, which died of
  `EADDRINUSE` (the evidence was already in `~/.baton/board.log`), then polled
  the dead child every 200 ms for the full 15 s.
- **The board never opened.** `openBoard(url)` sat only on the branch that
  successfully started a server. With one already running, or on the 15 s
  give-up path, nothing was ever opened.
- **Slow to react.** `board.js` dispatched `leg:sessions` and `baton:sessions`
  per push, parsing the quarter-megabyte payload twice, with the second
  dispatch outside the `state.es === es` staleness guard (missing braces on a
  one-line `if`). `sessions.js` was registered on `leg:sessions` twice and on
  the alias once. One push rebuilt the whole grid three times.
- **Slow to react, part two.** `renderSessions` starts with
  `grid.textContent = ''`, so with three rebuilds per push every button was
  destroyed and recreated several times a second.

**Remove was a second, independent bug, and fixing the first did not fix it.**
Reported again as "it's still not removing them" after all of the above
shipped. `confirmRow` does `pendingConfirm = null; onYes(yes)`, and the call
site passed `(btn) => act(s.session_id, pendingConfirm.action, btn)` — a
closure over the module variable, not over its value. Every Yes on the
Terminals panel threw `TypeError: Cannot read properties of null (reading
'action')` before reaching `act()`, so Remove, Remove record, End and Land had
never worked from the confirm row; the exception went to the console and
nowhere the reader would see it. Fixed by snapshotting
`const pending = pendingConfirm` before building the row. Caught by driving the
real page: the click produced zero network requests, which pointed at the
handler rather than at anything server-side. The instrument that found it was
five lines — wrap `window.fetch`, listen for `window.onerror`, click, read
both.

Three lessons. First, a name filter is not enough to classify a filesystem event:
taking a lock inside a directory changes that directory's own mtime, and the
event arrives naming only the directory. The watcher now treats an event as a
hint and compares a stat fingerprint of the files the view is really built from
— sub-millisecond, against a 2 s rebuild. Second, the CPU counter on a
long-lived process names a stall in one command, before any code is read.

Third, and the one that cost a round trip: several symptoms reported together
are not thereby one bug. Three of these four were, and finding that cause made
the fourth *look* explained — the render churn is a real way to drop a click,
so "Remove doesn't work" fit the story. It was a different bug in a different
file, and it was still there after the fix shipped. A symptom is only closed
once it has been driven and watched, not once a plausible cause for it has been
found and fixed. Clicking Remove in the real page would have taken two minutes
and would have shown zero network requests and a `TypeError` in the console.

Verified by running the new tests against `da453b7`: 7 of 8 fail there, 8 of 8
pass after, and the busy-board test takes 21 s before versus 4 s after. On the
live board, same 66 sessions: `/api/health` 14.19 s → 2.4 ms, `/board.css`
14.24 s → 1.5 ms, `/api/sessions` 15.64 s → 109 ms, view rebuild 2,049 ms →
115 ms, renders per push 3 → 1.

Also found while verifying: `npm run lint` reported "ESLint: No issues found"
with `node_modules/.bin` empty and eslint not installed — a wrapper was printing
it. Run `npm install` first and check that ESLint really ran; a lint result from
a tool that is not on disk is not a lint result.

## 2026-09-16: a hand-edited `package.json` version left `package-lock.json` behind, and the publish gate refused 0.9.0

**Fixed by bumping the lockfile root version; the gate is `scripts/npm-publish-gate.mjs`.**

The version went from 0.8.1 to 0.9.0 by editing `package.json` directly, so
the lockfile's two root `version` fields still said 0.8.1 and CI's
`publish-npm` job stopped at "package.json and package-lock.json root metadata
do not match". The run before it had failed the same way, which is why npm
still served 0.8.0. Tests, lint and the docs job were green; only the publish
was refused, which is the gate doing its job. Lesson: bump with `npm version`
(it writes the lockfile and runs the alias sync) and run the gate locally
before pushing a release; a green test matrix says nothing about the publish.

## 2026-09-16: the vendored engine's secret scan covered two fields; the review found the other five

**Fixed upstream (Agnostic AI 7e35b51) and re-vendored; regression in `test/harness-engine.test.mjs`.**

`docs/harness.md` promised "a bundle that still carries a credential is refused
at save time". The engine's `validate()` scanned `mcp.<n>.env` and
`mcp.<n>.headers` only; the rules text, identity, hook command lines, MCP
arguments, URLs and agent bodies were copied verbatim, and the four canary
tests planted tokens exactly where the scan already looked. The read-only
security review planted one everywhere else and got one problem back. Root
cause: a scan written for two map keys, and a test fixture shaped to it. Fix:
whole-bundle scanning with redaction of free text and drops of unsafe
handlers or servers, plus `PLANTED` tokens in every place the scan must reach.
Lesson: a canary proves the place it sits in, nothing else; a fixture written
by the same hands as the scan finds nothing the scan missed.

## 2026-09-16: `CLAUDE_CONFIG_DIR` outside the OS home was captured from `~/.claude` instead

**Fixed upstream in `sources/claude.cjs` (`pick()`), regression in `test/harness-engine.test.mjs`.**

The engine kept a registry path only when it sat inside the OS home and fell
back to `~/.claude` otherwise, while Leg's registry, detection and fingerprint
honoured the override. A per-account config dir under a `LEG_HOME` on another
drive would have ported the dormant profile and never noticed edits to the
active one. Fix: the registry path is trusted as given. Lesson: three code
paths agreeing on a directory is a property to test, not to assume.

## 2026-09-16: `leg harness sync` wrote before `leg harness enable`; the board could widen the policy

**Fixed in `src/harness/cli.mjs` and `src/server.mjs`, regressions in `test/harness-cli.test.mjs` and `test/harness-policy.test.mjs`.**

The consent gate lived in `enable` only, so `sync` on an install that never
enabled the feature wrote managed files while `status` said off; the settings
route accepted any policy value, so a board POST could take `warn` to
`strict`. Both were one-line fixes the review caught. Lesson: a consent rule
has to be checked at every writer, not at the one verb that grants it.

## 2026-09-16: the backup count was always zero

**Fixed in `src/harness/index.mjs`.**

The engine's writer returns the backup path, but every adapter keeps only the
action, so counting `f.backup` counted nothing. The count now comes from the
backups directory before and after an apply. Lesson: a number that never moves
in a demo is a number nobody is computing.

## 2026-09-16: alias `import(join(windowsPath))` is a `c:` URL scheme

**Fixed in `packages/leg-agents/bin/leg.mjs`.**

The first `leg-agents` wrapper did `await import(join(pkgRoot, 'bin', 'leg.mjs'))`.
On Windows that string is `C:\…\bin\leg.mjs`, which Node's ESM loader treats as a
URL with protocol `c:` and throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. `npm install`
of the tarball succeeded; `leg --version` died before printing `0.8.0`.

The fix is `await import(pathToFileURL(join(pkgRoot, 'bin', 'leg.mjs')).href)`.
`require.resolve` returning a path is not a valid ESM specifier on Windows.

## 2026-09-15: macOS `/var` symlink broke two e2e tests

**Fixed in `test/helpers.mjs`.**

`initRepo` and `makeHome` returned the path from `mkdtempSync(join(tmpdir(),
...))` verbatim. On macOS, `tmpdir()` returns `/var/folders/…` but `/var` is a
symlink to `/private/var`. Leg stores paths through `canonPath` (which calls
`realpathSync`), so `s.cwd` was `/private/var/…` while the test's `repo` was
`/var/…`. Two `attach-e2e` assertions failed: `assert.equal(codex.cwd, repo)`
and the `.find(s => s.cwd === repo)` that guards the "End from board" test.

The fix wraps both helpers in `realpathSync` so the returned path matches what
baton stores. This is a test-infrastructure bug, not a production-code bug:
`canonPath` was already doing the right thing.

The lesson: any path created from `os.tmpdir()` that will be compared against a
path stored by production code must be resolved first, because macOS `tmpdir()`
returns the unresolved symlink form.

## 2026-09-15: Land could not run the tests on macOS

**Fixed in `src/adapters/resolve.mjs`.**

The first CI run with `macos-latest` in the matrix failed where Linux and
Windows passed: `cannot resolve npm's JS entry` from `resolveCommand`
(`src/commands.mjs:22`), taking down `runTests` and with it `landNow` and the
merge queue. On a Mac, Land could never have run a repo whose test command
starts with `npm` or `npx`.

`resolveNpmCliEntry` looked in three places: `%APPDATA%\npm\node_modules`,
`/usr/local/lib/node_modules` and `/usr/lib/node_modules`. All three are
guesses at where someone else put node. The GitHub macOS runner keeps it in
`~/hostedtoolcache`, so none of them existed and the lookup returned null.
Linux passed only because `/usr/local/lib/node_modules` happens to exist
there, the same latent bug, hidden by a coincidence of layout. Homebrew,
nvm and asdf would all have failed the same way on a real machine.

The fix derives the prefix from the running binary instead of guessing:
POSIX installs put node at `<prefix>/bin/node` and global packages at
`<prefix>/lib/node_modules`, so `dirname(process.execPath)/../lib/node_modules`
finds it wherever node actually lives. `execPath` is now an injectable option
so the layout can be tested without one.

The lesson is about the class, not the path: a hardcoded absolute path is a
guess about someone else's machine, and a test matrix that omits a platform
does not tell you the code works there, it tells you nothing about it. This
was latent for as long as the matrix was two platforms wide.

Covered by `npm-entry-from-execpath` in `test/lessons.test.mjs`, checked in
both directions: it fails with the fix reverted and passes with it.

## 2026-09-15: share-security failed once in the full suite and has not repeated

**Not fixed. Recorded so a second occurrence is countable.**

One full-suite run reported `test\share-security.test.mjs` failing at `:1:1`
after 1496 ms, with no individual test named. The file passed 19 of 19 in
isolation in 6.5 s, and passed inside two later full runs of the whole suite.
No root cause found.

What the evidence rules out: parallel contention, because `npm test` runs
`--test-concurrency=1`. What it points at: the file failed at the top level
rather than in a named test, and far faster than its healthy 6.5 s, so it died
during setup, not in an assertion. The file binds several loopback boards on
ephemeral ports and exercises a rate-limit lockout, and a Leg board was live
on 4747 for 161 minutes when the failing run started.

The cost of the bad reading was real even though the test was fine: the suite
totalled 454 tests that run instead of 472, because a file that dies at the top
level never registers its subtests, and 454 was briefly written into
`fixtures/verified.json` and onto two public pages as the published test count.
A total from a run with a failure in it is not the suite's size.

If it happens again: capture the file's stderr before anything else
(`node --test --test-reporter=spec` writes it; the default reporter swallowed
it), and check whether a board was listening on 4747 at the time.

## 2026-09-15: a 3-second rebuild made the board impossible to scroll

- **Symptom.** Reported by the operator as "I'm not able to scroll down or up or
  really interact with the new UI layout, and it keeps reverting to where I was
  before scrolling." Intermittent-looking, which is what made it hard to believe.
- **Root cause.** `src/board/sessions.js`, in `putFocus()`. Every region on the
  board is wiped and rebuilt on a timer, so focus is captured before the wipe and
  restored after it, or a tabbed control is lost every three seconds. The restore
  called `target.focus()`. `focus()` scrolls its element into view unless it is
  passed `{ preventScroll: true }`, so the moment the reader clicked any button,
  every poll dragged the viewport back to that button, forever.
- **Why it looked random.** With nothing focused, `takeFocus()` returns null and
  the page behaves. The bug only appears after the reader interacts, which is
  exactly when they stop suspecting the page and start suspecting themselves.
- **Fix.** `target.focus({ preventScroll: true })` on the rebuild path only. A
  focus move the reader asked for (Cancel in a confirm row, the close control of
  the detail region) still scrolls, because there it is the right behaviour.
- **Measured before and after.** Before: scroll to 1200, click Details, and the
  next seven samples read 106, 106, 106… After: four scenarios held for 20
  seconds each across both the 3s poll and the 15s re-sort, 0px drift on all
  four. `test/board-drawer.test.mjs` now pins both halves of the rule.
- **The lesson that generalises.** Screenshots and a green suite cannot see "the
  page fights you three seconds later". A live surface needs a hold test: put the
  viewport somewhere, wait through every timer the page owns, and assert it did
  not move. The same applies to focus, scroll position, an open disclosure and a
  text selection.

## 2026-09-15: Leg silently reversed a user's refusal to trust a folder

- **Symptom.** None visible. That is the point: it wrote to a file the user owns
  and printed a line that read like a first-time record.
- **Root cause.** `src/trust.mjs` treated "not `true`" as "not asked yet". A
  `hasTrustDialogAccepted: false` in `~/.claude.json`, which is what clicking
  "No, exit" records, was flipped to `true` on every run in that repo. The agy
  writer had the same shape: any value other than `TRUST_FOLDER`, including a
  deliberate `DO_NOT_TRUST`, fell through to a write. The codex writer was the
  only one of the three that got it right, because it happened to test for
  presence rather than for truth.
- **Fix.** Only an absent key is an unanswered question. An answer already on
  file is the user's, including "no", and is left alone with a stated reason.
  The imports question is separate: `WarningShown: true` with `Approved: false`
  is a recorded refusal and is not re-approved.
- **The lesson that generalises.** When code writes a file a human owns, absent
  and negative are different states and must be distinguished in the code, not
  in a comment. `!== true` is not "unset".

## 2026-09-15: the trust record was written under a key Claude Code never reads

- **Symptom.** Would have been: the flag is on file, the prompt still appears,
  and nothing says why. Caught before shipping by diffing against a copy of a
  real `~/.claude.json` rather than a synthetic one.
- **Root cause.** The project key was written in Windows-native form,
  `C:\Projects\foo`. Claude Code stores it as `C:/Projects/foo`: 100 of the 104
  entries in a real config are forward-slash with an upper-case drive letter and
  no trailing separator, and the four that are not are older duplicates of
  projects that also appear in the new form. The wrong spelling creates a second
  entry that is simply ignored.
- **Fix.** `claudeProjectKey()` normalises to that form. An older spelling
  already present is updated in place, never created, so a stale entry is
  corrected without littering the config.
- **The lesson that generalises.** When writing into someone else's data file,
  derive the key format from that file's own contents on a real machine. A
  synthetic fixture agrees with whatever the code does and proves nothing.

## 2026-09-15: a walled usage bar was drawn full, then drawn red, before it was drawn at all

- **Symptom.** The account at its limit showed a full calm-blue bar beside the
  words `no reading`: the most urgent row on the page looked like the safest.
- **Root cause.** `board.css` draws a walled account's fill at 100%, but the
  colour stops were computed from the percentage, which is 0 when there is no
  reading, and `fillStops(0)` puts every stop at 100% so the whole bar paints
  calm.
- **The wrong first fix, and why.** Computing the stops from 100 when walled made
  the bar danger-red. That is the same fabricated number, louder. An independent
  review caught it. The right answer is that a window with no reading paints no
  fill at all, and the wall is carried by the words beside it.
- **The lesson that generalises.** When a display and its own label disagree,
  fix the display's right to exist, not its colour.

## 2026-09-15: the OG card advertised a commercial product as MIT

- **Symptom.** `site/og.html` printed `Claude Code · Codex · agy · local · MIT`
  on the card every shared link renders. Leg ships under the Leg License
  Agreement, all rights reserved; the only MIT in the repo is in `NOTICE`, about
  a borrowed component explicitly re-licensed.
- **Fix.** The tag line names the price instead. The first correction was longer
  than the string it replaced and pushed `.cmd` into wrapping, so `.cmd` is now
  `flex: none; white-space: nowrap` and the footer measures 0px past its gutter
  with a 15px gap, checked with `getBoundingClientRect` rather than by eye.
- **The lesson that generalises.** A generated image is code with no test. Any
  copy change inside one needs the render measured afterwards, and legal or
  pricing strings in marketing assets need checking against `LICENSE` and
  `package.json`, which are the only sources that are actually true.

## 2026-09-15: a redesign measured on a board of healthy terminals

- **Symptom.** Compact row styling was reported as producing 40px terminal rows.
  Wes's actual screen showed 400px rows and he rejected the result.
- **Root cause.** The styling was scoped to `.panel.is-running` and measured
  against a board of live, healthy terminals. A real board after a day's work is
  mostly `lost` and `ended` terminals with long absolute temp paths, and none of
  them matched the selector, so the measurement was taken on the minority of rows
  the change actually touched.
- **Fix.** `scratchpad/seed-wes.mjs` seeds a board with the real shape, 4 live,
  3 lost, 2 ended, long temp paths, an image tag in a prompt, served on an
  isolated port with a throwaway `LEG_HOME`. Run against it, the *pre-change*
  board reproduced the defect exactly: 3,302px page and 180-277px rows at 1280,
  6,530px and 307-585px at 400. That is the check being observed failing before
  it was trusted.
- **The lesson that generalises.** A UI measurement is only worth what its
  fixture is worth. Before trusting a number about a redesign, seed the state the
  operator actually has and confirm the instrument reproduces the complaint.
  Never 4747 for that board: that port is the live one with real sessions on it.

## 2026-09-15: a CSS rewrite silently broke the page that shares the stylesheet

- **Symptom.** `/floor` rendered unstyled account rows and threw
  `ReferenceError: narrowQuery is not defined` after the board redesign.
- **Root cause.** `floor.html` and `floor.js` share `board.css` and carry a
  ported copy of the board's head block. Rewriting `board.css` removed the
  classes that copy emits (`.acct`, `.rail`, `.track`, `.fill`, `.num`, `.tier`),
  and removing helpers from `sessions.js` left the copy in `floor.js` referencing
  names that no longer existed on its own page.
- **Fix.** The head block is now extracted from `sessions.js` mechanically rather
  than transcribed, so the "character for character" claim in its comment stays
  true; `floor.html` moved onto the new shell; the floor's table styles were
  added to the new system.
- **The lesson that generalises.** Before rewriting a shared stylesheet, list
  every page that links it and open each one. A grep for the class names would
  also have caught this; rendering the page is what actually did.

## 2026-09-15: two pre-existing CI failures, one hiding behind the other

- **Symptom.** Three trust tests failed on the ubuntu job; the windows job showed
  `cancelled`. Fixing ubuntu revealed three *different* failures on windows, in
  resume, that had been there for two commits.
- **Root cause.** A failing matrix leg cancels its siblings, so windows had not
  run to completion since `1f61414` introduced `test/resume.test.mjs`. Every run
  after that reported `win=cancelled`, which reads like "not the problem" and is
  actually "not measured". Both underlying bugs were the same shape: a function
  describing a path asked the *host* to resolve it. On ubuntu, `resolve()` on
  `C:\cfg` prepended the runner's cwd; on windows, `realPath()` expanded the 8.3
  short name in `tmpdir()`, so `C:\Users\RUNNER~1\...` came back as
  `C:\Users\runneradmin\...` and no longer matched the path the caller passed in.
- **Fix.** `src/trust.mjs` treats a drive-letter path as already absolute and
  recognises the older Windows spelling by its spelling rather than by asking the
  host to resolve it. `src/resume.mjs` walks with `resolve()` instead of
  `realPath()` and returns the root in the caller's own spelling; two spellings
  of one checkout are reconciled by `canonPath()` where they are compared.
- **The lesson that generalises.** `cancelled` on a CI matrix leg is not a pass
  and not a failure, it is no information, and it stays that way for as long as
  a sibling keeps failing. Read the per-job conclusions, not the run's, and treat
  a leg that has not completed since a feature landed as unmeasured. Locally,
  `npm test` does not run `npm run lint` here: both are needed before a push.

## 2026-09-15: the site did not deploy, and the repo said it had

- **Symptom.** `main` was fast-forwarded with the board and site redesign, every
  check was green, and `legcli.com` still served the old blue page.
  GitHub showed `Vercel, Canceled by Ignored Build Step` with a green tick,
  which reads like a pass.
- **Root cause.** `site/vercel.json` carried
  `ignoreCommand: git diff --quiet HEAD^ HEAD .`, and with Root Directory `site`
  that asks one question: did the SINGLE most recent commit touch `site/`? The
  push was five commits; `site/` changed in the first of them and the tip was a
  test fix, so the answer was no and the build was skipped. A push is not a
  commit, and `HEAD^ HEAD` cannot see past the tip.
- **Fix.** `ignoreCommand` removed, so every push to `main` deploys. Vercel's
  built-in "Skip deployments when there are no changes to the root directory"
  is the safe form of the same idea because it compares against the last
  deployment, not against `HEAD^`.
- **The lesson that generalises.** A skipped step reports as a green tick.
  "Canceled by Ignored Build Step" and a cancelled CI matrix leg are the same
  trap in different clothes: an absence of failure that is not a success. After
  a deploy, load the page and confirm the change is on it, the deploy
  platform's own tick is not evidence that anything shipped.

## 2026-09-15: the new OG card was live and every share still showed the old one

- **Symptom.** The site had deployed the dark OG card, and a link shared in a
  messaging app still previewed the blue one, with a tag line naming MIT, which
  had been corrected days earlier.
- **Root cause.** Nothing was wrong with the deploy: fetching
  `/og.png` returned the new image. Link-preview caches (Telegram, Slack,
  iMessage, X) key on the image URL and most never re-fetch a URL they already
  hold. `og.png` never changed, so every client that had ever crawled the page
  kept its first copy indefinitely.
- **Fix.** `og:image` and `twitter:image` carry `?v=`, bumped in the same commit
  that changes `og.png`. Already-cached previews need the platform's own
  refresh (Telegram: send the URL to `@WebpageBot`).
- **The lesson that generalises.** "Deployed" and "what people see" are
  different questions for anything a third party caches by URL. An asset that
  will ever be revised needs a version in its URL from the first ship, not after
  someone notices the old one is still going out.

## The card row was never ported, and nothing noticed for four days (2026-09-15)

- **Symptom.** Retaking `docs/screenshots/` showed the Background tasks rows
  rendering as unstyled markup: the card title unreadable, chips welded to the
  text beside them, the four-column layout stacked into blocks. The rest of the
  board had been redesigned on 2026-09-15 and looked right.
- **Root cause.** `.r1` `.r2` `.r3` `.r4`, the card row's whole layout, had no
  rule in `board.css`. `.row-title` had a rule, but it set only `font-size` and
  `color`, never resetting the native button, so the browser's own
  `rgb(240,240,240)` fill sat under the board's near-white text. Two separate
  misses in the same region, neither of which fails a test, a lint, or a build.
- **Fix.** Both rules written against `.term-row`, the terminal row they are
  supposed to mirror. `test/board-a11y.test.mjs` now fails if any class that
  reaches the DOM from `board.js`, `sessions.js`, `floor.js`, `index.html` or
  `floor.html` has no rule in `board.css`, with a named exception list for the
  ones queried as selectors only. Verified by deleting the `.r1` rules and
  watching the test name `.r1`.
- **The lesson that generalises.** A redesign that lands region by region has no
  natural signal for the region nobody opened. CSS has no undefined-variable
  error: an unstyled class renders, it just renders wrong, and it renders wrong
  only where someone looks. The check that would have caught it is cheap and
  mechanical, every class the code emits must resolve to a rule, and it should
  exist before the redesign starts, not after the screenshots expose it.

## Removing the trial turned the test suite red in three unrelated files (2026-09-15)

- **Symptom.** After deleting the 14-day trial from `src/license.mjs`,
  `share.test.mjs`, `cards.test.mjs` and `launcher.test.mjs` failed with
  licensing errors, none of which mention licensing in their test names.
- **Root cause.** The trial opened every gate for free, so ~470 tests had been
  passing the licence check without ever declaring they needed to. Removing it
  made the suite's dependence on it visible all at once.
- **Fix.** `testEnv()` writes a Team key into each throwaway home, signed by a
  pair generated per run, with `LEG_PUBLIC_KEY_B64` pointing the spawned CLI
  at its public half. `LEG_UNLICENSED=1` opts a test back into the refusal.
- **A second bug inside the fix.** The first version imported `src/license.mjs`
  from `test/helpers.mjs` to reuse `signLicense`. That pulls in `store.mjs`,
  which reads `LEG_HOME` once at import time, and `helpers.mjs` is imported by
  every test file *before* it sets `LEG_HOME`, so the ledger was pinned to
  whatever home happened to be set, which on a developer machine is the real
  `~/.leg`. Caught because `server.test.mjs` started failing on a card it had
  just written. The key format is now reproduced in `helpers.mjs` instead.
  Checked `~/.leg` afterwards: no test cards, no `license.json`, nothing
  written.
- **The lesson that generalises.** A permissive default in test setup is load
  bearing and invisible; you find out how much only when you remove it. And a
  module that reads the environment at import time cannot be imported from a
  helper that runs before the environment is set, no matter how small the thing
  you wanted from it.

## A 3,000-line feature landed with red CI on Windows and no docs page (2026-09-16)

- **Symptom.** Commit `c7f24a0` (the history index, committed by the agy
  session that took over after a Claude usage limit) went green on Ubuntu and
  macOS and red on Windows in two `history.test.mjs` cases, and the `docs` job
  failed with "site/ is out of date". `/docs/history` did not exist and every
  link to `history.md` pointed at the npm package page.
- **Root cause, tests.** GitHub's Windows runner hands out an 8.3 short TEMP
  path (`RUNNER~1`) while git reports the long form (`runneradmin`). The two
  assertions compared a `mkdtemp` path with a path that had been through git.
  The repo already had the seam for this (`canonPath` in `src/fsx.mjs`,
  used the same way in `handoff-order.test.mjs`); the new tests did not use it.
  It cannot be seen on a developer machine with 8.3 names disabled.
- **Root cause, docs.** `scripts/build-docs-site.mjs` builds from a hard-coded
  `PAGES` list. A new `docs/*.md` that is not in it gets no page, and
  `rewriteHref` sends its links to the npm URL by design. Nobody ran
  `npm run docs` before pushing, so the docs job was the first to notice.
- **Fix.** `ebda794`: both sides of the four path assertions through
  `canonPath`; reproduced locally by pointing `TEMP` at a case-altered path
  (seen failing, then 16/16); `history` registered in `PAGES`; site rebuilt.
- **The lesson that generalises.** A test that compares two filesystem paths
  on Windows compares two spellings of the same folder unless both go through
  `canonPath`. And a new `docs/*.md` is two edits, the file and the `PAGES`
  entry, then `npm run docs`; the docs job exists because the second and third
  get forgotten.

## The review that was in flight when the limit hit never ran; the feature shipped with 38 defects (2026-09-17)

- **Symptom.** `c7f24a0` (history discovery) was committed and pushed by the
  agent that took over after a Claude usage limit. The nine-lens adversarial
  review the Claude session had launched died with that session. Re-run the
  next day it confirmed 38 findings, 3 high: the board's Conversations cell
  could never page past 150 rows (the total was counted after the cursor
  slice), an unreachable UNC cwd blocked a refresh for seconds per record,
  and an Antigravity retitle was invisible to every incremental refresh
  (the directory's mtime was the cache key; an in-place rewrite never moves
  it).
- **Root cause.** The hand-off bundle carried "what was established" and
  "next moves" but not "what was in flight": a background workflow is not a
  file, so the next agent saw a clean-looking task and shipped it. Nothing
  in the ship path asks whether the change was reviewed.
- **Fix.** `582dfe5`: 20 findings closed, each with a test that fails on the
  previous source (proved on a detached worktree of HEAD before the fix).
- **Left open, by choice.** Coverage-only findings (live markers, the
  write-scope guard, the flag surfaces, extra accounts), a low-severity
  dedup edge (a conversation split over two Claude transcript files when Leg
  recorded only the older path), the `sessions ls` row format, and the
  pretty-printed index file.
- **The lesson that generalises.** A review is part of the change, not a
  step after it: launch it before the feature is committable and record it
  in the hand-off as in flight, or the next agent ships without it. And a
  cache keyed on a directory's mtime sees files added and removed, never a
  file rewritten in place.

## The first morning on 0.12.0: a 0.10.0 process served the 0.12.0 page, and three terminals rate-limited the usage endpoint (2026-09-18)

- **What happened.** Wes installed 0.12.0 and opened the board: no Fable
  bucket anywhere, an empty agent select under "Run in the background", and a
  timeline full of `claude usage unavailable: usage endpoint 429`. The board
  process on 4747 had been started the day before from the repo checkout and
  was still 0.10.0 in memory; it served the 0.12.0 page files straight from
  disk, so the page drew controls the process had no data for (`handoff_ladder`
  and `buckets` were simply absent from its payloads). The 429s were a second,
  real defect: every claude terminal polled the usage endpoint once a minute
  on its own, three terminals plus Claude Code's own polling, and each flip
  from success to failure logged the whole JSON body into that terminal's
  timeline.
- **Fix.** The board and the floor carry the version their files shipped with
  and print `This board process runs leg 0.10.0 and the page files are
  0.13.0. Restart it to match: leg down && leg up` when `/api/health`
  disagrees (`test/files-version.test.mjs` pins the constant to
  `package.json`). Usage polling moved into the board, one poller per login
  with backoff, one line on failure and one on recovery
  (`src/usage-poll.mjs`, `test/usage-poller.test.mjs`).
- **The lesson that generalises.** "Installed" is not "running". A release that
  changes a long-lived process is verified by restarting that process and
  reading its `/api/health` version, not by reading the page. And a reported
  symptom that pattern-matches a known cause still gets driven to its own
  evidence: two of the five symptoms this morning were the stale process, the
  third was a polling design defect that the stale process was hiding.

## The 0.12.0 redesign review confirmed 51 findings before the fix pass, 23 of them high (2026-09-18)

- **What happened.** The eight-step redesign (per-model buckets, the ladder,
  the capacity strip, cards reborn) was reviewed before commit by six finders
  and three refuters per finding: 174 agents, 51 findings confirmed, 23 high.
  The highs were all in code that had passed its own tests: `binding()`
  short-circuited on the first active bucket instead of the one that stops
  the requested model, `summarize()` parsed the ledger once per card per
  refresh, the take-over route handed out a command for a card with no
  checkout, `cardWorkRoot()` fell back to the main checkout, and the guest
  payload leaked buckets, walls and hand-off reasons through the new fields.
- **Fix.** Three parallel fix passes, one owner per file group, every finding
  closed with a regression test in the same change; the suite went from 783
  to 830 tests. The lockfile's root `repository` field, lost when Playwright
  was installed, was restored so `scripts/npm-publish-gate.mjs` passes.
- **The lesson that generalises.** A feature's own tests prove the feature's
  own model of itself. The defects a review finds sit where two new pieces
  meet (a new field and an old redaction list, a new route and an old helper),
  and the review has to run on the uncommitted tree, before the commit exists
  to be pushed by someone else. A `npm i` that regenerates the lockfile is a
  release change and gets the publish gate run in the same turn.

## A seeded board's End-as-card button wrote into a real repo (2026-09-17)

- **What happened.** Driving the new "End, and keep going as a card" verb in
  a browser against `scripts/seed-wes-board.mjs`'s board, the click on the
  recruiting-tool row hit `POST /api/sessions/:id/end-as-card`, which did
  exactly its job: it wrote a hand-off bundle under
  `C:\Projects\recruiting-tool\.context-handoffs\` and cut a worktree and a
  `leg/card-...` branch there. The seed's rows named real repositories on this
  machine because long real paths were what the layout had to be measured
  against. Nothing ran in the worktree (the server was stopped within a
  minute); the worktree was deregistered and the branch deleted, and the
  directory and bundle were left for a hand delete.
- **Fix.** The seed's repo paths now live under `C:\Projects-seed\...`, which
  does not exist, so every git-backed action on a seeded row answers 409
  instead of touching a checkout. The row still prints the same length.
- **The lesson that generalises.** A seeded board is safe to look at and not
  safe to click: any row that names a path that exists is a live control on
  that path. Seed paths must be realistic in shape and impossible in fact.
