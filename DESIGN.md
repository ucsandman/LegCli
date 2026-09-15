# Design

Visual system for the Baton marketing site (`site/`). PRODUCT.md carries the who and why; this file carries how it looks. Chosen on 2026-09-11 from a four-concept tournament (light restrained, drenched dark, committed cobalt, product-led dark); the committed-cobalt concept won and borrowed the DOM-recreated board from the light concept and the full-bleed live terminal from the product-led one.

## Overview

Three brand-voice words: exact, unhurried, mechanical. Physical reference: the printed operator's manual for a piece of test equipment, cobalt covers, white plates, every figure labeled. Scene: a developer at a desk, mid-afternoon, one terminal tab showing a usage-limit message, reading in irritation and looking for the install command. Aesthetic lane: cobalt-drenched hardware manual with the product recreated in DOM. The modal page in this category is near-black with a purple glow, gradient text and three icon cards; this page is a saturated blue plate with a live terminal and no cards.

Color strategy: **Committed.** Cobalt carries the hero, the live handoff, the changeover and the footer (roughly half the surface); the rest sits on a blue-tinted off-white. Warmth comes only from the claude terracotta inside product visuals.

## Colors (OKLCH)

| token | value | use |
|---|---|---|
| `--blue` | `oklch(0.47 0.19 258)` | drenched sections, primary button on light |
| `--blue-deep` | `oklch(0.24 0.06 255)` | terminal and panel surfaces on blue |
| `--blue-rule` | `oklch(0.62 0.16 258)` | rules and markers on blue |
| `--on-blue` | `oklch(1 0 0)` | text on blue |
| `--on-blue-muted` | `oklch(0.90 0.05 258)` | secondary text on blue (a tint of the hue, never gray) |
| `--bg` | `oklch(0.975 0.004 258)` | light sections |
| `--surface` | `oklch(1 0 0)` | tables, before/after plate |
| `--ink` | `oklch(0.21 0.03 258)` | body text on light (>= 12:1) |
| `--muted` | `oklch(0.46 0.03 258)` | secondary text on light (>= 6:1) |
| `--line` | `oklch(0.87 0.012 258)` | hairlines on light |
| `--claude` | `oklch(0.780 0.115 46)` | agent identity, terracotta |
| `--codex` | `oklch(0.820 0.100 178)` | agent identity, aqua |
| `--agy` | `oklch(0.760 0.120 300)` | agent identity, violet |
| `--warn` | `oklch(0.82 0.16 85)` | 85 percent amber, marker tabs and the bell |
| `--bad` | `oklch(0.68 0.20 25)` | limit and bounce, on cobalt |
| `--ok` | `oklch(0.75 0.17 150)` | landed, tests green |
| `--warn-fill` | `oklch(0.72 0.15 75)` | rail segment 60 to 85, inside a track only |
| `--warn-text` | `oklch(0.840 0.130 78)` | warning mark, numeral, tier word, the 85 post |
| `--bad-fill` | `oklch(0.56 0.17 20)` | rail segment past 85, and the walled fill |
| `--danger-text` | `oklch(0.740 0.140 20)` | error mark, numeral, tier word and sentence |

The three identity values are the shipped `--id-claude`, `--id-codex` and
`--id-agy` from `src/board/board.css`, so an agent name recreated on this page
is the colour of that agent name in the product. No identity hue sits within 25
degrees of a state hue, which is why codex is aqua at 178 and not green at 165:
green is what a landed commit is. Agent color is never the only carrier; the
agent name is always printed beside it.

State colour splits in two, the same split `board.css` makes: the darker `-fill`
pair paints rail segments inside a track, the lighter `-text` pair paints marks,
numerals and sentences, which have to clear 4.5:1 on the raised panel.

## Typography

- Display and body: **Atkinson Hyperlegible Next** (Google Fonts, weights 300 to 800). One family, hierarchy by weight and size. Chosen as a physical object: the Braille Institute's typeface, drawn so no glyph can be mistaken for another, which is the page's promise about its claims.
- Code and terminal: **Azeret Mono** (Google Fonts, 400 and 600). Used only where a real command, path or transcript is shown.
- Scale, ratio 1.25 from 17px body: 17 / 21 / 27 / 34 / 42 / 53 / 66, plus one sub-body step at 15px for figcaptions, list items, the footer and control labels. Nothing outside a product recreation is set below 15px; inside one the sizes are the product's own. Hero `clamp(2.4rem, 4.6vw, 4rem)` in the 7/5 fold and `clamp(2.4rem, 6.4vw, 4.6rem)` stacked, weight 800, letter-spacing -0.025em, `text-wrap: balance`. Section headings `clamp(1.9rem, 3.6vw, 3.3rem)`, weight 700. Lead paragraph `clamp(1.1875rem, 1.6vw, 1.3125rem)`, reaching 21px by 1320. Body 17px, line-height 1.55, max 66ch. On blue, line-height +0.05.
- No uppercase runs. Section headings are sentences.

## Components

- **Plate**: a panel with a 1px rule in `--line` (light) or `--blue-rule` (blue), radius 3px, no shadow. Tables, the before/after, the RESUME.md excerpt.
- **Terminal**: `--blue-deep` surface, a 2px top rule in the owning agent's color, title strip in Azeret Mono 13px, body 15px, line-height 1.7. Every `[baton]` line is set in white weight 600; agent output in `--on-blue-muted`.
- **Instrument head**: collapsed to one line by default, because that is how the board opens: one `.u` run per login carrying that login's worst reading, and a `show windows` control on the right. Opened, one row per login in the four-column register, two window rails each.
- **Window rail**: a 2.6ch window label, a graduated track (two tick layers so the 10 percent graduations read at every fill level, 0 included), a hard-stop fill whose gradient is computed from the value so red is confined past 85, the 85 post painted at all times, and a right-aligned tabular numeral in an 88px cell. In the head it is the product's four-column form, 2.6ch / 104px / 88px / reset, with the reset time on the same line; under 1000px the reset drops to its own line. A window with no reading paints no fill and no post and prints `no reading` in the numeral cell.
- **Session panel**: a full-width band in the who / what / where / when-or-act register, never a card. A status word beside a 7px mark, one ranked sentence, a named `also:` disclosure, the files as comma-separated text, an elapsed clock, and the fixed row Land / Hand off now / Details / End; a button that does not apply is omitted, never moved. A terminal that is merely running or has stopped takes the quiet one-line form: files, worktree line, disclosure and account chips are suppressed, R1/R3/R4 run along the line, and the controls lift out of the grid and return over the row on hover or focus. A terminal that needs you rises one step and opens to the whole register.
- **Marker**: the signature element. A hairline rule with short tabs sitting on it, each tab a 2px by 14px tick plus a mono label and a sentence (`85%  where the fill crosses the post...`). Used to bracket the live terminal and, with the tick hung under the rule instead of over it, to lay out the changeover beats and the pricing columns. Nowhere else.
- **Command row**: mono command, a Copy button (verb label, turns to `copied` for 1.4 s), sharp 2px radius.
- **Buttons**: 2px radius, 44px min height, weight 600, visible 2px focus ring in `--warn` on blue and `--blue` on light.

Radius stance: sharp. 2px on controls, 3px on plates, never 8px.

## Layout

- Max wrapper width 1120px **including** the side gutters `clamp(20px, 4vw, 56px)`, so the content column runs about 1018px at 1280. One column at 400px.
- One idea per fold; fold padding `clamp(72px, 11vw, 160px)` top and bottom. Sections alternate blue and light: hero (blue), live handoff (blue), one word (light), the board (light), two sessions (light), the changeover (blue), what is touched (light), pricing (blue), install and footer (blue). Pricing is cobalt because four consecutive light folds put six thousand vertical pixels between the reader and the brand colour, and because a blue band cannot carry two white plates without restating them as ruled columns, which is what the fold needed anyway.
- Asymmetric two-column folds for text beside a product visual: 5/7 with the heading or the short copy in the narrow column. The hero is 7/5, copy then instrument. The one inversion allowed is two prose columns of unequal length, where the longer one takes the wider column. The live terminal and the board run full width.
- No cards as layout, and nothing on the page is card-shaped any more: the product deleted its own cards, so the recreations are full-width panels and ruled rows, and the pricing fold is two ruled columns rather than two plates.

## Motion

- One choreographed sequence: the live handoff terminal types at reading speed when it enters the viewport (IntersectionObserver), 5h bar fills to 85 then 100, the strip turns amber then red, Baton's lines print, codex's first turn appears. A Replay button restarts it. Under `prefers-reduced-motion: reduce` the full transcript renders static with the final state and Replay is hidden. The transcript is real text in the DOM at all times; JS only reveals lines, so the section is never blank without it.
- Easing `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-expo), 180 to 320 ms for hover and copy feedback. No scroll-reveal fades, no parallax, no hover scale on images.
