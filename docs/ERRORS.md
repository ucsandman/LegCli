# Errors

What broke, why, and what fixed it. One entry per failure, newest first. A first
occurrence has to be written down or a repeat is never countable.

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
there — the same latent bug, hidden by a coincidence of layout. Homebrew,
nvm and asdf would all have failed the same way on a real machine.

The fix derives the prefix from the running binary instead of guessing:
POSIX installs put node at `<prefix>/bin/node` and global packages at
`<prefix>/lib/node_modules`, so `dirname(process.execPath)/../lib/node_modules`
finds it wherever node actually lives. `execPath` is now an injectable option
so the layout can be tested without one.

The lesson is about the class, not the path: a hardcoded absolute path is a
guess about someone else's machine, and a test matrix that omits a platform
does not tell you the code works there — it tells you nothing about it. This
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
ephemeral ports and exercises a rate-limit lockout, and a Baton board was live
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

## 2026-09-15: Baton silently reversed a user's refusal to trust a folder

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
  on the card every shared link renders. Baton ships under the Baton License
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
- **Fix.** `scratchpad/seed-wes.mjs` seeds a board with the real shape — 4 live,
  3 lost, 2 ended, long temp paths, an image tag in a prompt — served on an
  isolated port with a throwaway `BATON_HOME`. Run against it, the *pre-change*
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
  and not a failure — it is no information, and it stays that way for as long as
  a sibling keeps failing. Read the per-job conclusions, not the run's, and treat
  a leg that has not completed since a feature landed as unmeasured. Locally,
  `npm test` does not run `npm run lint` here: both are needed before a push.

## 2026-09-15: the site did not deploy, and the repo said it had

- **Symptom.** `main` was fast-forwarded with the board and site redesign, every
  check was green, and `baton-agents.vercel.app` still served the old blue page.
  GitHub showed `Vercel — Canceled by Ignored Build Step` with a green tick,
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
  a deploy, load the page and confirm the change is on it — the deploy
  platform's own tick is not evidence that anything shipped.

## 2026-09-15: the new OG card was live and every share still showed the old one

- **Symptom.** The site had deployed the dark OG card, and a link shared in a
  messaging app still previewed the blue one — with a tag line naming MIT, which
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
- **Root cause.** `.r1` `.r2` `.r3` `.r4` — the card row's whole layout — had no
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
  mechanical — every class the code emits must resolve to a rule — and it should
  exist before the redesign starts, not after the screenshots expose it.

## Removing the trial turned the test suite red in three unrelated files (2026-09-15)

- **Symptom.** After deleting the 14-day trial from `src/license.mjs`,
  `share.test.mjs`, `cards.test.mjs` and `launcher.test.mjs` failed with
  licensing errors, none of which mention licensing in their test names.
- **Root cause.** The trial opened every gate for free, so ~470 tests had been
  passing the licence check without ever declaring they needed to. Removing it
  made the suite's dependence on it visible all at once.
- **Fix.** `testEnv()` writes a Team key into each throwaway home, signed by a
  pair generated per run, with `BATON_PUBLIC_KEY_B64` pointing the spawned CLI
  at its public half. `BATON_UNLICENSED=1` opts a test back into the refusal.
- **A second bug inside the fix.** The first version imported `src/license.mjs`
  from `test/helpers.mjs` to reuse `signLicense`. That pulls in `store.mjs`,
  which reads `BATON_HOME` once at import time, and `helpers.mjs` is imported by
  every test file *before* it sets `BATON_HOME` — so the ledger was pinned to
  whatever home happened to be set, which on a developer machine is the real
  `~/.baton`. Caught because `server.test.mjs` started failing on a card it had
  just written. The key format is now reproduced in `helpers.mjs` instead.
  Checked `~/.baton` afterwards: no test cards, no `license.json`, nothing
  written.
- **The lesson that generalises.** A permissive default in test setup is load
  bearing and invisible; you find out how much only when you remove it. And a
  module that reads the environment at import time cannot be imported from a
  helper that runs before the environment is set, no matter how small the thing
  you wanted from it.
