# Decisions

Durable product and design decisions that the code does not explain on its own. One entry per decision, newest first.

## 2026-09-14: npm publication follows a successful push to `main`

- **What.** Baton publishes from the existing `.github/workflows/ci.yml`; there is no separate release workflow or manual publish step. The publisher waits for the complete Ubuntu and Windows test matrix, then publishes only when the exact package version is absent from npm.
- **Authentication.** The job uses npm trusted publishing and GitHub OIDC with `contents: read` and `id-token: write`. It has no `NPM_TOKEN`. The one-time npm trusted-publisher binding for `ucsandman/baton` and `ci.yml` was created on 2026-09-14; the first `0.4.2` workflow publication remains the end-to-end proof.
- **Private source.** The repository stays private. npm accepts trusted publishing from a private repository but cannot generate public provenance for it, so the publish command explicitly uses `--provenance=false`.
- **Failure behavior.** A validated registry 200 response skips an existing version. An exact-version 404 permits publication only when the candidate is a stable three-part version newer than npm's stable `latest`; this prevents an older queued run from moving the tag backward. Network failures, invalid JSON, unexpected statuses, prereleases, stale versions, and package/lock/repository metadata drift stop the job. Publish concurrency is serialized without cancelling an in-progress release.
- **Retro.** Git, site deployment, and npm publication are separate release results and must be verified separately. A green skip proves idempotency only; `0.4.2` must actually publish once to prove unattended trusted publishing end to end.

## 2026-09-11: the marketing site is a cobalt-drenched static page in `site/`

- **What.** One static HTML page (`site/index.html`, `style.css`, `site.js`), self-hosted fonts, deployed to Vercel from the `site/` directory with `vercel.json` headers. No framework, no build step. PRODUCT.md and DESIGN.md at the repo root carry the brief and the tokens so later edits inherit them.
- **How it was chosen.** A four-concept tournament (light restrained, drenched racing green, committed cobalt, product-led dark terminal) judged against a written rubric. Committed cobalt won and borrowed the DOM-recreated board from the light concept and the typed full-bleed terminal from the product-led one. The scores and disqualifications are recorded in the session notes; the design tokens are in DESIGN.md.
- **Why cobalt and not the board's own dark palette.** The operator board and the sibling site declick.dev are both near-black; a third near-black surface from the same author would read as one family and as the generic dark AI-tool page. The site's warmth comes only from the agent colors inside product visuals.
- **What the page promises.** Every number, path, version and date on it is copied from the README as verified on 2026-09-11. The terminal transcript is a labeled sample session whose `[baton]` lines are the strings `src/attach.mjs` prints and whose pointer prompt is the one `src/bundle.mjs` sends. The two-session cards are from the live run the README documents.
- **Analytics and search.** Vercel Web Analytics is the only script besides `site.js`; nothing on the page depends on it. Search Console and Bing registration state is recorded below this entry when done.

### Registration state, 2026-09-11

- Google Search Console: URL-prefix property `https://baton-agents.vercel.app/`, verified by the `google-site-verification` meta tag in `site/index.html` (removing the tag revokes it); `sitemap.xml` submitted; home URL inspected and indexing requested.
- Bing Webmaster Tools: site added manually and verified by the `msvalidate.01` meta tag (account-wide code); `sitemap.xml` submitted.
- Vercel Web Analytics: enabled on project `baton-agents` (plan-included tier); the tag is `<script defer src="/_vercel/insights/script.js">` and it is the only script besides `site.js`.
- Not done: a custom domain (none owned for Baton); the GitHub repository is still private, so the site's GitHub, README, FAQ and changelog links 404 for strangers until it is made public.

## 2026-09-11: Baton is a commercial product; the site stays on the free Vercel address

- **License.** Wes: "if we're trying to sell this thing it shouldn't be open source and MIT." The repo stays private and the package ships under the Baton License Agreement (LICENSE): commercial, source readable in the package for inspection and own-use modification, no redistribution, no working around the license check. The FSL option from the pricing research was dropped for the same reason. Versions 0.2.0 and 0.3.0 remain available under MIT.
- **Pricing.** Personal $79 once with 12 months of releases (Sublime shape); Team $12 per seat per month (adds `baton share`); 14-day trial started on first use, no card. Keys are Ed25519 tokens signed with a private key that lives only in the seller's `.env` and the site's Vercel env; the public key is in `src/license.mjs`. A Personal key is a window over `RELEASE_DATE`, so every release bumps that constant.
- **Checkout.** Stripe payment links (live) with automatic tax, `site/api/key` and `site/api/webhook` on Vercel functions, Resend from `baton@practicalsystems.io`. `scripts/stripe-setup.mjs` is idempotent per site origin; a test-mode purchase was run end to end on 2026-09-11 (checkout, thanks page, key activated in the CLI, webhook 200 twice).
- **Domain.** A `batonagents.com` purchase ($11.25) was started and cancelled at Wes's "just deploy it to a free vercel site"; nothing was bought. The site is https://baton-agents.vercel.app.
- **Not a lawyer.** The license text was drafted in-session; a review before the first sale outside the US is Wes's call.

## 2026-09-14: the handoff order is a priority list, and a killed agent's terminal is restored in full

- **Order.** The saved order (Settings for new terminals, **Change order** per running terminal) is applied as an absolute priority list: drop the agent already running, keep the rest in the saved order. It used to rotate, anchored on the current agent and wrapping, so `codex > claude > agy` handed a Claude terminal to agy first. Wes: "I want agy to always be the last option." A rotation cannot express that; a priority list can, and every option is still tried exactly once. Same-agent alternate accounts still come before any agent switch, because continuing with the same agent on another login loses the least.
- **Terminal restore.** Baton kills the agent on End, Hand off now and the usage limit, so nothing the agent set is ever unset by the agent itself. Baton now undoes all of it (mouse reporting, bracketed paste, focus events, application keys, autowrap, the scrolling region) instead of only leaving the alternate screen. DECSTBM homes the cursor, so the margin reset sits between DECSC and DECRC, and the erase clears only what is below the cursor.
