# Decisions

Durable product and design decisions that the code does not explain on its own. One entry per decision, newest first.

## 2026-09-11: the marketing site is a cobalt-drenched static page in `site/`

- **What.** One static HTML page (`site/index.html`, `style.css`, `site.js`), self-hosted fonts, deployed to Vercel from the `site/` directory with `vercel.json` headers. No framework, no build step. PRODUCT.md and DESIGN.md at the repo root carry the brief and the tokens so later edits inherit them.
- **How it was chosen.** A four-concept tournament (light restrained, drenched racing green, committed cobalt, product-led dark terminal) judged against a written rubric. Committed cobalt won and borrowed the DOM-recreated board from the light concept and the typed full-bleed terminal from the product-led one. The scores and disqualifications are recorded in the session notes; the design tokens are in DESIGN.md.
- **Why cobalt and not the board's own dark palette.** The operator board and the sibling site declick.dev are both near-black; a third near-black surface from the same author would read as one family and as the generic dark AI-tool page. The site's warmth comes only from the agent colors inside product visuals.
- **What the page promises.** Every number, path, version and date on it is copied from the README as verified on 2026-09-11. The terminal transcript is a labeled sample session whose `[baton]` lines are the strings `src/attach.mjs` prints and whose pointer prompt is the one `src/bundle.mjs` sends. The two-session cards are from the live run the README documents.
- **Analytics and search.** Vercel Web Analytics is the only script besides `site.js`; nothing on the page depends on it. Search Console and Bing registration state is recorded below this entry when done.
