// Adapter registry. Adapters are loaded lazily so a typo fails with a named
// error before anything is spawned. Every real CLI here was probed live
// through the runner in phase 3 (fixtures/live/<name>/, docs/cli-contracts.md).
// grok.mjs exists but is NOT registered: the build machine had no grok login
// (the probe printed a device-code prompt and exited "Cancelled"). Register it
// after `grok` is logged in and scripts/probe.mjs --adapter grok passes.
const REGISTRY = {
  fake: './fake.mjs',
  claude: './claude.mjs',
  codex: './codex.mjs',
  gemini: './gemini.mjs',
  agy: './agy.mjs',
}

export function names() { return Object.keys(REGISTRY) }

export async function get(name) {
  const path = REGISTRY[name]
  if (!path) throw new Error(`unknown adapter: ${name}`)
  return (await import(path)).default
}
