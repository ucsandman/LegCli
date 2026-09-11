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
| `--claude` | `oklch(0.70 0.15 40)` | agent identity, terracotta |
| `--codex` | `oklch(0.70 0.15 165)` | agent identity, green |
| `--agy` | `oklch(0.70 0.18 300)` | agent identity, violet |
| `--warn` | `oklch(0.82 0.16 85)` | 85 percent amber |
| `--bad` | `oklch(0.68 0.20 25)` | limit, bounce, overlap flag |
| `--ok` | `oklch(0.75 0.17 150)` | landed, tests green |

Agent color is never the only carrier; the agent name is always printed beside it.

## Typography

- Display and body: **Atkinson Hyperlegible Next** (Google Fonts, weights 300 to 800). One family, hierarchy by weight and size. Chosen as a physical object: the Braille Institute's typeface, drawn so no glyph can be mistaken for another, which is the page's promise about its claims.
- Code and terminal: **Azeret Mono** (Google Fonts, 400 and 600). Used only where a real command, path or transcript is shown.
- Scale, ratio 1.25 from 17px body: 17 / 21 / 27 / 34 / 42 / 53 / 66. Hero `clamp(2.6rem, 6.4vw, 5.5rem)`, weight 800, letter-spacing -0.025em, `text-wrap: balance`. Section headings `clamp(1.9rem, 3.6vw, 3.3rem)`, weight 700. Lead paragraph 21px. Body 17px, line-height 1.55, max 66ch. On blue, line-height +0.05.
- No uppercase runs. Section headings are sentences.

## Components

- **Plate**: a panel with a 1px rule in `--line` (light) or `--blue-rule` (blue), radius 3px, no shadow. Tables, the before/after, the RESUME.md excerpt.
- **Terminal**: `--blue-deep` surface, a 2px top rule in the owning agent's color, title strip in Azeret Mono 13px, body 15px, line-height 1.7. Every `[baton]` line is set in white weight 600; agent output in `--on-blue-muted`.
- **Board card**: the real card's anatomy in DOM: agent pill, status pill, prompt, repo@branch, chips for files, the 5h and 7d bars, the landed or bounced line, buttons Land / Hand off now / End.
- **Marker**: the signature element. A hairline rule across the section with short tabs sitting on it, each tab a mono label plus a sentence (`85%  the card turns amber, the terminal bell rings once`). Used to bracket the live terminal and to lay out the changeover. Nowhere else.
- **Command row**: mono command, a Copy button (verb label, turns to `copied` for 1.4 s), sharp 2px radius.
- **Buttons**: 2px radius, 44px min height, weight 600, visible 2px focus ring in `--warn` on blue and `--blue` on light.

Radius stance: sharp. 2px on controls, 3px on plates, never 8px.

## Layout

- Max content width 1120px, side gutters `clamp(20px, 4vw, 56px)`, one column at 400px.
- One idea per fold; fold padding `clamp(72px, 11vw, 160px)` top and bottom. Sections alternate blue and light: hero (blue), live handoff (blue), one word (light), the board (light), two sessions (light), the changeover (blue), what is touched (light), install and footer (blue).
- Asymmetric two-column folds (5/7 or 7/5) for text beside a product visual; the live terminal and the board run full width.
- No cards as layout; the only card-shaped things are the recreated board cards, because those are cards in the product.

## Motion

- One choreographed sequence: the live handoff terminal types at reading speed when it enters the viewport (IntersectionObserver), 5h bar fills to 85 then 100, the strip turns amber then red, Baton's lines print, codex's first turn appears. A Replay button restarts it. Under `prefers-reduced-motion: reduce` the full transcript renders static with the final state and Replay is hidden. The transcript is real text in the DOM at all times; JS only reveals lines, so the section is never blank without it.
- Easing `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-expo), 180 to 320 ms for hover and copy feedback. No scroll-reveal fades, no parallax, no hover scale on images.
