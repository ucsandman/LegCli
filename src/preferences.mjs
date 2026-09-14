// Machine-wide defaults for interactive Baton terminals. A new terminal takes
// a copy of these preferences when it starts; later edits do not silently
// change terminals that are already running.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'

export const HANDOFF_AGENTS = ['claude', 'codex', 'agy']

export function validHandoffOrder(value) {
  return Array.isArray(value) && value.length === HANDOFF_AGENTS.length &&
    new Set(value).size === HANDOFF_AGENTS.length &&
    value.every((agent) => HANDOFF_AGENTS.includes(agent))
}

export function normalizeHandoffOrder(value) {
  return validHandoffOrder(value) ? [...value] : [...HANDOFF_AGENTS]
}

export function requireHandoffOrder(value) {
  if (!validHandoffOrder(value)) throw new TypeError('handoff_order must contain claude, codex, and agy exactly once')
  return [...value]
}

export function preferencesFile() { return join(home(), 'preferences.json') }

export function readPreferences() {
  const file = preferencesFile()
  if (!existsSync(file)) return { handoff_order: [...HANDOFF_AGENTS] }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return { handoff_order: normalizeHandoffOrder(value?.handoff_order) }
  } catch {
    return { handoff_order: [...HANDOFF_AGENTS] }
  }
}

export function writePreferences(patch) {
  const order = requireHandoffOrder(patch?.handoff_order)
  mkdirSync(home(), { recursive: true })
  return withFileLock(preferencesFile() + '.lock', () => {
    const next = { ...readPreferences(), handoff_order: order }
    writeJsonAtomic(preferencesFile(), next)
    return next
  })
}
