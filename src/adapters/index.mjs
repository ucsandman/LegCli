// Adapter registry. Adapters are loaded lazily so a typo fails with a named
// error before anything is spawned. Every real CLI here was probed live
// through the runner in phase 3 (fixtures/live/<name>/, docs/cli-contracts.md).
// grok.mjs exists but is NOT registered: the build machine had no grok login
// (the probe printed a device-code prompt and exited "Cancelled"). Register it
// after `grok` is logged in and scripts/probe.mjs --adapter grok passes.
const REGISTRY = {
  fake: { path: './fake.mjs' },
  'fake-claude': { path: './fake.mjs', fake: ['fake-claude', 'pipe'] },
  'fake-codex': { path: './fake.mjs', fake: ['fake-codex', 'ignore'] },
  'fake-agy': { path: './fake.mjs', fake: ['fake-agy', 'ignore'] },
  'fake-nostdin': { path: './fake.mjs', fake: ['fake-nostdin', 'ignore'] },
  claude: { path: './claude.mjs' },
  codex: { path: './codex.mjs' },
  agy: { path: './agy.mjs' },
}

export function names() { return Object.keys(REGISTRY) }

export function isFake(name) { return Boolean(REGISTRY[name]?.fake) || name === 'fake' }

export async function get(name) {
  const entry = REGISTRY[name]
  if (!entry) throw new Error(`unknown adapter: ${name}`)
  const mod = await import(entry.path)
  return entry.fake ? mod.makeFake(...entry.fake) : mod.default
}
