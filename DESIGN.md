# Design

One visual system for both surfaces: the board (`src/board/`) and the marketing site (`site/`). PRODUCT.md carries the who and why; this file carries how it looks. Chosen on 2026-09-15 after six rejected rounds, from three mocks built against the design skills; mock B, "dark product surface", won and took two grafts from its siblings.

**What was replaced, and why it must not come back.** Until this rewrite the brief here was "exact, unhurried, mechanical, the printed operator's manual for a piece of test equipment": a saturated cobalt ground, hairline rules as the only structure, a sharp radius stance of 2px on controls and 3px on plates, a monospace face for prose, and no elevation. Six board designs were built against it and all six were rejected. The brief cannot produce a consumer-product finish, which is what was asked for from the first message. If a future pass finds itself reaching for hairlines, sharp corners and a flat plane, it is rebuilding the rejected look.

## Overview

Three brand-voice words: quiet, lit, decided. Physical reference: a dark instrument panel where the thing that matters is the one lit surface, and everything else recedes. Scene: a developer with four terminals open, glancing at a second monitor to find out whether they can keep going. Aesthetic lane: dark product surface, the product recreated in DOM on the site in the product's own colours.

Colour strategy: **one accent, spent once.** The ground is a neutral near-black. Emphasis is elevation and size, never hue. A single blue marks the action to take and appears nowhere else: on the board that is Land when it can run, and Start once a task is typed. Identity colours are a dot beside a printed name and a gauge fill; the name itself is text, in the strip, in a row's register and in the ladder editor alike. Severity paints inside a gauge track; it is never the colour of a word except where a word is itself the failure (a row waiting on you, a login at its wall).

**The mark.** A tile with the L cut as hip, knee and foot: the letter and the leg are one shape. Inline SVG (`viewBox 0 0 24 24`, `rx 6`, stroke 3.2, round caps) in `currentColor` on the board and the floor, `#F3F4F7` on `#0E1012` as the favicon and on the site. It replaced the 🦿 emoji on 2026-09-19, which rendered as whichever system emoji font the machine had. Runner-up, kept in `.design/board-v5/marks.html`: the three-node route.

Five rules that decide most questions:

1. The largest thing on a page is a sentence, not a number.
2. Size encodes importance. The login carrying the work gets the wide lit panel; a login with one fact gets a half panel; a login with no figure draws no instrument at all.
3. History sits on the ground, unpanelled, as a count that opens. It cannot compete with what is live.
4. A fact true of every row is a property of the region and is said once, there.
5. Print nothing rather than a wrong number. An empty track reads as a measurement of zero.

## Colors

Hex is the shipped value, with the OKLCH it was designed in beside it. `src/board/board.css` and `site/style.css` carry the same numbers; a marketing page that recreates the product in a different palette is a picture of a different product.

| token | hex | OKLCH | use |
|---|---|---|---|
| `--e0` | `#0E1012` | `0.170 0.006 258` | page ground, unlit |
| `--e1` | `#171A1D` | `0.215 0.007 258` | recessed well: drawers, tracks, inputs, command rows |
| `--e2` | `#212427` | `0.258 0.008 258` | the raised panel |
| `--e3` | `#2C2F34` | `0.305 0.009 258` | quiet control |
| `--e4` | `#363A40` | `0.345 0.010 258` | control hover |
| `--line` | `#35383D` | `0.335 0.008 258` | separator between siblings inside one panel |
| `--edge` | `#2A2D31` | `0.285 0.008 258` | panel boundary |
| `--control-edge` | `#686D75` | `0.540 0.010 258` | quiet control boundary, 3.00:1 on the panel |
| `--text` | `#F3F4F7` | `0.960 0.004 258` | primary, 14.18:1 on the panel |
| `--text-2` | `#B9BEC6` | `0.800 0.010 258` | secondary, 8.35:1 |
| `--text-3` | `#9399A1` | `0.680 0.012 258` | meta, 5.43:1 |
| `--accent` | `#5C91FF` | `0.680 0.185 264` | the action to take. Nowhere else |
| `--on-accent` | `#070D1A` | `0.150 0.030 264` | 6.43:1 on the accent |
| `--id-claude` | `#FCA169` | `0.790 0.130 52` | identity, warm |
| `--id-codex` | `#69DBBA` | `0.815 0.115 172` | identity, cool green |
| `--id-agy` | `#CC97F3` | `0.760 0.140 310` | identity, violet, 46 degrees clear of the accent |
| `--warn` | `#E0A33C` | `0.760 0.140 75` | gauge segment 60 to 85 |
| `--danger` | `#E64343` | `0.620 0.200 25` | gauge segment past 85, and the walled fill |
| `--danger-text` | `#FF8A8A` | `0.760 0.150 22` | the same state when a word must carry it, at AA |

Agent colour is never the only carrier; the agent name is always printed beside its dot. A fill colour and a text colour are different tokens on purpose: `--danger` is 3.9:1 as text and fails AA, which is why `--danger-text` exists.

## Elevation

One light source, above. A raised object carries a 1px inset highlight on its top edge, a contact shadow and an ambient shadow:

```
--lift:    inset 0 1px 0 rgba(255,255,255,.05), 0 1px 2px rgba(0,0,0,.45), 0 18px 44px -14px rgba(0,0,0,.70)
--lift-hi: inset 0 1px 0 rgba(255,255,255,.10), 0 1px 2px rgba(0,0,0,.45), 0 22px 52px -14px rgba(0,0,0,.75)
--sink:    inset 0 1px 3px rgba(0,0,0,.50)
```

`--lift-hi` is the panel that matters catching more light. At most one per screen. `--sink` is for anything recessed into a panel: a drawer, a gauge track, a command row.

## Typography

- One family, **Atkinson Hyperlegible Next**, self-hosted as a subset in `src/board/fonts/` and `site/fonts/`. The Braille Institute's typeface, drawn so no glyph can be mistaken for another, which is the promise a board read at a glance has to keep. Two weights: 400 and 700.
- **Azeret Mono** is demoted to true data tokens only: session ids, diffs, log output, a literal command. Never prose. Monospace prose was one of the tells of the rejected look.
- Board scale, 14 to 52px: `--t--1` 14 (row scaffolding: files, capacity phrase, dirty and quiet counts), `--t-0` 15 (labels, meta, controls, the row register), `--t-1` 17 (prompts, panel heads, body), `--t-2` 21 (section heads), `--t-3` 34 (gauge numeral), `--t-4` 52 (the verdict). The old board ran 13 to 21, which is why it read as a spreadsheet; the 13px floor went to 14 on 2026-09-19 because 26 elements per screen under 14px on a 1440 monitor read as a spreadsheet again.
- Site scale keeps its marketing display sizes: hero `clamp(2.6rem, 6.4vw, 5.5rem)` weight 700, section headings `clamp(1.9rem, 3.6vw, 3.3rem)`, body 17px, max 66ch.
- `font-variant-numeric: tabular-nums` throughout, so a ticking figure does not reflow.
- No uppercase runs, no tracked-out labels. Headings are sentences.
- **Floor: no text below 14px on mobile.** On the board this is held by redefining `--t--1` to the body size inside the narrow breakpoint, so it is a property of the token and not something every rule has to remember. On the site the 560px block raises every sub-14px run, once.

## Components

- **Panel**: `--e2`, 1px `--edge`, radius 16px, padding 32, `--lift`. The unit of the design. `panel--lit` for the one that matters.
- **Gauge**: a 16px track in `--track` with `--sink`, a fill in the login's identity colour running to 85 percent and in `--danger` past it, a 2px notch cut through the bar at 85, and the numeral at 34px right-aligned. `gauge--minor` is the same instrument at 8px with a 21px numeral, for a login's second window. A window with no reading draws no track.
- **Capacity strip**: one token per login as a small aligned table, dot, name, 120x6 track, figure, in an auto-fill grid of 300px columns. The name is `--text-2`; the dot and the fill carry the identity. Under 760px the track goes and the figure right-aligns.
- **Terminal row**: one row inside the terminals panel, separated from its siblings by `--line`. Reading order across it: what it is doing, what it is working on, how long, what you can do about it. Register at 15px with a dot beside the rung, prompt at 17px clamped to two lines (the expansion holds the rest), the mono clock and id over a single row of quiet buttons in a side column, so every row's controls sit in the same place. Land is drawn only when it can run, and then it is the one primary. A row whose state changed since the last render is lit for 1.4 s (`is-changed`), the one motion the rows own. Rows carry a 1.5 percent white hover.
- **Background entry**: the one-line field under the terminals panel, joined to it as its footer when the panel has rows, a well of its own otherwise. Its choices (repo, ladder, pipeline) are quiet chips inside the sentence; More settings is the one text link.
- **First run**: with no terminal, the terminals region is one lit panel: the three commands in `--e0` wells, each with a Copy, and one line on what appears with the first turn. It is the first screen a new reader sees and the screenshot the docs open with (`docs/screenshots/board-empty.png`).
- **Ledger cell**: a count, a line of meta (at most three lines) and one verb (View, Browse, New card), on the ground with no panel, the verbs on one baseline across the four cells. Settings is a fifth row in the same grammar. A disclosure carries a CSS chevron that turns when it is open; no typed `>`.
- **Drawer**: `--e1`, radius 12px, `--sink`. Anything a disclosure opens.
- **Buttons**: radius 10px, min-height 36px, weight 700. Filled `--accent` for the primary, `--e3` with a `--control-edge` border for secondary. Land is the primary only when it can run: a disabled control never wears the accent, and in a terminal row it is not drawn at all. End and Remove are quiet at rest and turn `--danger-text` on hover; the confirm row is where the decision is made. The masthead's page link (Floor, Board) is a secondary button, not an underlined word.
- **Verdict link**: when the verdict names a terminal, the h1 is a button in its own clothes (`.verdict-link`) that scrolls to that row and focuses its prompt; the accent appears on hover only.
- **Command row** (site): mono command in a `--e1` well with `--sink`, radius 12px, a Copy button that says `copied` for 1.4 s.
- **Board recreation** (site): the board's own anatomy in DOM — the verdict sentence, login panels, terminal rows, the ledger — in the board's own colours. When the board's anatomy changes, these change in the same pass.

Radius stance: **soft.** 16px on containers, 12px on wells, 10px on controls, 999px on dots and tracks. Never 0, never 2px.

Focus: a 2px solid `--focus` (`#EDF2FA`) outline at 2px offset, one treatment for every control on both surfaces. It appears nowhere else in the design.

## Layout

- Max content width 1120px, side gutters `clamp(20px, 4vw, 56px)`, one column under 760px (board) / 860px (site).
- Board: 32 to 64px between sections. Verdict, logins, terminals, ledger, settings, in that order, top to bottom by how often you need them.
- Site: one idea per fold, fold padding `clamp(72px, 11vw, 160px)`. Emphasis between folds is elevation, not hue: the band that used to be a slab of blue is a raised surface on the same ground.
- Asymmetric two-column folds (5/7 or 7/5) for text beside a product visual; the live terminal and the board recreation run full width.
- Cards are not a layout device. The only row-shaped things are terminal rows, because those are rows in the product.

## Motion

- Board: two animations. The breathing dot on a running terminal, 2400ms, and a 1400ms settle on a row whose state just changed (a blue wash at 14 percent fading to nothing). Nothing else moves on its own. The elapsed clock and the connection word prove liveness with real data.
- Site: one choreographed sequence, the live handoff terminal typing at reading speed when it enters the viewport. A Replay button restarts it.
- Easing `cubic-bezier(.2,0,0,1)` on the board, `cubic-bezier(0.16, 1, 0.3, 1)` on the site; 150 to 320ms for hover and press feedback. No scroll-reveal fades, no parallax, no hover scale.
- `prefers-reduced-motion: reduce` disables the running dot, the settle, every transition and the press translate; the site renders the full transcript static and hides Replay.

## Verifying a change to either surface

The measurement that matters is taken against a board shaped like a real one: mostly `lost` and `ended` terminals with long absolute paths, not a clean board of healthy ones. Scoping a style to `.panel.is-running` and measuring on healthy terminals reported 40px rows while the real screen showed 400px, and that single mistake cost more than any other in the six rejected rounds.

Check, at 1280 and 400: full-page height, per-row height, horizontal overflow, the computed font-size floor, console errors, text contrast against what is actually painted behind it, and a scroll-hold probe — park the viewport, wait through every timer the page owns, assert it did not move.
