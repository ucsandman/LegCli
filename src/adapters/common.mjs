// Shared adapter helpers. An adapter exports:
//   name, stdin ('pipe' | 'ignore'), modes {default, allowed}, forbiddenFlags,
//   resolve() → {bin, viaNode, entry}, argv(opts) → {bin, args},
//   env(base) → sanitized copy, parseResult(text) → {session_id, last_message, stop_reason, raw} | null
// argv() throws `forbidden flag: …` before anything is spawned when the chain
// entry names a mode outside `modes.allowed` or smuggles a forbidden flag.
import { existsSync, statSync, accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'

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

// The absolute path a shell-less spawn(name) would run, or null; nothing is
// spawned. Windows follows libuv's search: the cwd first, then each PATH entry
// with its quotes stripped, trying the name as given only when it has an
// extension, then name.com, then name.exe. A .cmd or .ps1 shim is never a
// match: Leg spawns without a shell, and neither runs without one. POSIX takes
// the first regular file in a PATH entry that has the execute bit.
export function onPath(name, { env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
  if (platform !== 'win32') {
    for (const dir of String(env.PATH ?? '').split(':')) {
      const p = resolve(cwd, dir || '.', name)
      try { if (isFile(p)) { accessSync(p, constants.X_OK); return p } } catch {}
    }
    return null
  }
  // Windows matches the variable's name without case: it is often `Path`
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  const dot = name.indexOf('.')
  const names = [...(dot !== -1 && dot < name.length - 1 ? [name] : []), `${name}.com`, `${name}.exe`]
  for (const entry of [cwd, ...String(path).split(';')]) {
    const dir = entry.replace(/^["']|["']$/g, '')
    if (!dir) continue
    for (const n of names) { const p = resolve(cwd, dir, n); if (isFile(p)) return p }
  }
  return null
}

// Go-style duration for CLIs that want "90m" rather than milliseconds.
export function goDuration(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return s % 60 === 0 ? `${s / 60}m` : `${s}s`
}
