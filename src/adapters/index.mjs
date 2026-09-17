// Adapter registry. Adapters are loaded lazily so a typo fails with a named
// error before anything is spawned. Every real CLI here was probed live
// through the runner in phase 3 (fixtures/live/<name>/, docs/cli-contracts.md).
// grok joined on 2026-09-17: its flags were read from `grok --help` on 1.0.34
// and its headless envelope out of the shipped binary, and the probe reached
// the account (a 402 "usage balance exhausted", classified `limit`). The
// success path of a grok leg is still unprobed — that needs balance on the
// account — so a grok card falls back to the DONE marker and the diff, which
// is what every adapter does when parseResult comes back null.
//
// Anything else is a custom adapter: a JSON spec in $LEG_HOME/adapters/*.json
// (src/adapters/custom.mjs, `leg adapter add`). Built-in names always win, and
// the spec directory is re-read on every call so a spec added while the board
// is up shows in the New card form without a restart.
import { listSpecs } from './custom.mjs'

const REGISTRY = {
  fake: { path: './fake.mjs' },
  'fake-claude': { path: './fake.mjs', fake: ['fake-claude', 'pipe'] },
  'fake-codex': { path: './fake.mjs', fake: ['fake-codex', 'ignore'] },
  'fake-agy': { path: './fake.mjs', fake: ['fake-agy', 'ignore'] },
  'fake-nostdin': { path: './fake.mjs', fake: ['fake-nostdin', 'ignore'] },
  claude: { path: './claude.mjs' },
  codex: { path: './codex.mjs' },
  agy: { path: './agy.mjs' },
  grok: { path: './grok.mjs' },
}

export const BUILTIN_NAMES = Object.keys(REGISTRY)

// Every spec on disk, including the broken ones (each carries its `error`).
export function customSpecs() { return listSpecs({ reserved: BUILTIN_NAMES }) }

// Only the specs that loaded. A broken file is not an adapter; `leg adapter
// list` is where its error is shown, so a typo is visible instead of silent.
export function customNames() { return customSpecs().filter((s) => s.adapter).map((s) => s.name) }

export function names() { return [...BUILTIN_NAMES, ...customNames()] }

export function isFake(name) { return Boolean(REGISTRY[name]?.fake) || name === 'fake' }

export function isCustom(name) { return !REGISTRY[name] && customNames().includes(name) }

export async function get(name) {
  const entry = REGISTRY[name]
  if (entry) {
    const mod = await import(entry.path)
    return entry.fake ? mod.makeFake(...entry.fake) : mod.default
  }
  const hit = customSpecs().find((s) => s.name === name)
  if (hit?.adapter) return hit.adapter
  if (hit?.error) throw new Error(`adapter ${name} is on disk but its spec does not load: ${hit.error}`)
  throw new Error(`unknown adapter: ${name}`)
}
