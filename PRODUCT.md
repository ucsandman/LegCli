# Product

## Register

brand

## Users

Developers who run Claude Code, Codex or agy (Gemini CLI) as their daily coding agent, for hours at a stretch, on a subscription login. They hit the 5-hour or 7-day usage limit mid-task, lose the thread, retype the context into the next tool, or sit and wait. They read the install command before the headline, distrust anything called an "AI agent platform", and can tell a screenshot from a mockup. Secondary reader: a lead who runs two or three agents in one repo and has watched two of them edit the same file.

The site is read at a desk, in a terminal-adjacent browser tab, usually right after a limit hit. The mood is irritation looking for a plain fix, not curiosity looking for a vision.

## Product Purpose

Leg is a local CLI wrapper: `leg claude|codex|agy` instead of the bare command. The same interactive agent runs, with a board beside it, usage tracking per agent and account, a context handoff bundle kept current, and an automatic handoff in the same terminal when the limit hits. The destination is a rung of (agent, login, model), so a Fable wall moves the terminal to another model on the subscription already paid for, keeping the conversation, before it moves to another CLI. A second session in one repo gets its own worktree and a Land button that rebases, tests and fast-forwards. Local-first, zero runtime dependencies, leaves the user's settings files alone; the one thing it writes outside its own directory is the folder-trust answer each agent CLI would otherwise stop and ask for, so a handoff at 3am does not stall on a prompt (`LEG_TRUST=never` turns that off). Commercial license, source readable in the package; a 14-day free trial from the first session, then a Personal license at $79 once or Team at $12 per seat per month, and a 30-day money-back guarantee as the risk reversal after buying.

The site exists to get a developer from "I just hit the wall again" to `npm install -g @ucsandman/legcli` in under a minute, and to let them verify every claim against the docs before they do. The source repository is private, so the site's own docs are the only thing a stranger can check the claims against: they carry the same text as the README and `docs/`, and the source itself is readable in the installed package. Success is a copied install command and a visit to the docs, in that order.

Leg does not use Claude Code's own `/model` command or its `--fallback-model` flag to move a terminal off a wall. The interactive child runs with its stdio inherited (`src/attach.mjs`), so Leg has no pipe to type `/model <name>` into the running session even if it wanted to. That command also saves the name as the human's own default model going forward, and a tool that rewrites your default at 2am is a tool you stop trusting. `--fallback-model` looks like the same idea from the other side, but Claude Code's own model-config documentation says authentication, billing, rate-limit, request-size and transport errors never trigger it, so the flag answers a transient 529 overload rather than a usage wall. A usage wall is the one case it was never built to reach, and it is the exact gap Leg's hand-off ladder fills instead, in a new process it starts and controls itself.

## Brand Personality

Exact, unhurried, mechanical. Voice of a well-written hardware manual: every sentence names a file, a command, a time or a number the reader can check. It states what is touched and what is never touched. It never sells; it describes, and the description is the pitch. No exclamation marks, no superlatives, no "AI" as an adjective. The emotional goal is relief with evidence: the reader should feel the wall stopped mattering, and see why.

## Anti-references

- The generic AI-agent-platform landing page: dark near-black body, purple or cyan glow, gradient text, three icon cards, "supercharge your workflow", a logo row of companies that have not heard of it.
- declick.dev, a sibling product by the same author: dark `#0f1115`, Archivo + Spline Sans Mono, amber accent. Leg must not read as the same family.
- Editorial-typographic restraint (display serif italic, small mono labels, ruled columns). Leg is a tool, not a magazine.
- Cream/paper "warm minimalism". The warmth in this brand comes from the claude terracotta inside product visuals, never from the page background.
- Any page whose hero is a stock illustration of robots, hands, or a baton.

## Design Principles

1. **The product is the imagery.** Every visual is the real terminal or the real board, recreated in DOM or shown as a true screenshot. No abstract shapes standing in for the product.
2. **One idea per fold.** The page is a long scroll with deliberate pacing; each fold carries one sentence a stranger could repeat.
3. **Motion tells the handoff.** The single story worth animating is: the wall, the bundle, the next agent continuing in the same terminal. Everything else is still.
4. **Every claim is checkable.** Numbers, versions, file paths and dates appear exactly as in the README, and the README is one click away.
5. **Say what is never touched.** Trust is built by naming the files Leg does not edit and the keys it strips, as prominently as what it does.

## Accessibility & Inclusion

WCAG 2.2 AA. Body text >= 4.5:1, large text >= 3:1, visible focus rings on every control. Every animation has a `prefers-reduced-motion` alternative and no content is gated behind a reveal. Terminal recreations carry the full transcript as real text (screen-reader readable), never as an image. Color is never the only carrier of agent identity; the agent name is always printed beside its color. Touch targets >= 44px; no text below 14px on mobile; no horizontal scroll at 400px.
