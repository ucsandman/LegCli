// Shared adapter helpers. An adapter exports:
//   name, stdin ('pipe' | 'ignore'), modes {default, allowed}, forbiddenFlags,
//   resolve() → {bin, viaNode, entry}, argv(opts) → {bin, args},
//   env(base) → sanitized copy, parseResult(text) → {session_id, last_message, stop_reason, raw} | null
// argv() throws `forbidden flag: …` before anything is spawned when the chain
// entry names a mode outside `modes.allowed` or smuggles a forbidden flag.
import { existsSync } from 'node:fs'

export function assertAllowed(adapter, opts = {}) {
  const mode = opts.mode ?? adapter.modes.default
  if (!adapter.modes.allowed.includes(mode)) {
    throw new Error(`forbidden flag: ${adapter.name} mode "${mode}" is not allowed (allowed: ${adapter.modes.allowed.join(', ')})`)
  }
  for (const flag of opts.extraArgs ?? []) {
    if (adapter.forbiddenFlags.some((f) => flag === f || flag.startsWith(`${f}=`))) {
      throw new Error(`forbidden flag: ${flag}`)
    }
  }
  return mode
}

// First existing candidate path, else the bare command name (PATH lookup).
export function firstExisting(candidates, fallback) {
  for (const c of candidates) if (c && existsSync(c)) return c
  return fallback
}

// Go-style duration for CLIs that want "90m" rather than milliseconds.
export function goDuration(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return s % 60 === 0 ? `${s / 60}m` : `${s}s`
}
