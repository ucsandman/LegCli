// Adapter registry. Adapters are loaded lazily so a typo fails with a named
// error before anything is spawned. Phase 3 registers claude, codex, gemini, agy.
const REGISTRY = {
  fake: './fake.mjs',
}

export function names() { return Object.keys(REGISTRY) }

export async function get(name) {
  const path = REGISTRY[name]
  if (!path) throw new Error(`unknown adapter: ${name}`)
  return (await import(path)).default
}
