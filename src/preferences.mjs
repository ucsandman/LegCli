// Machine-wide defaults for interactive Leg terminals. A new terminal takes
// a copy of these preferences when it starts; later edits do not silently
// change terminals that are already running.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'

export const HANDOFF_AGENTS = ['claude', 'codex', 'agy']
export const ALL_HANDOFF_AGENTS = ['claude', 'codex', 'agy', 'grok']

export function validHandoffOrder(value) {
  if (!Array.isArray(value)) return false
  const set = new Set(value)
  if (set.size !== value.length) return false
  if (value.length === 3 && ['claude', 'codex', 'agy'].every((a) => set.has(a))) return true
  if (value.length === 4 && ['claude', 'codex', 'agy', 'grok'].every((a) => set.has(a))) return true
  return false
}

export function normalizeHandoffOrder(value) {
  return validHandoffOrder(value) ? [...value] : [...HANDOFF_AGENTS]
}

export function requireHandoffOrder(value) {
  if (!validHandoffOrder(value)) throw new TypeError('handoff_order must contain claude, codex, and agy exactly once')
  return [...value]
}

export function preferencesFile() { return join(home(), 'preferences.json') }

export function resolveAutoApprove({ env = process.env, preferences = null, cliFlag = null } = {}) {
  if (cliFlag !== null && cliFlag !== undefined) return Boolean(cliFlag)
  const envVal = env.LEG_AUTO_APPROVE ?? env.BATON_AUTO_APPROVE
  if (envVal !== undefined) return envVal !== '0' && envVal !== 'false' && envVal !== 'off'
  if ((env.LEG_NO_AUTO_APPROVE ?? env.BATON_NO_AUTO_APPROVE) === '1') return false
  const prefs = preferences ?? readPreferences()
  if (typeof prefs?.auto_approve === 'boolean') return prefs.auto_approve
  return true
}

export function readPreferences() {
  const file = preferencesFile()
  if (!existsSync(file)) return { handoff_order: [...HANDOFF_AGENTS], auto_approve: true }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return {
      handoff_order: normalizeHandoffOrder(value?.handoff_order),
      auto_approve: value?.auto_approve !== false,
    }
  } catch {
    return { handoff_order: [...HANDOFF_AGENTS], auto_approve: true }
  }
}

export function writePreferences(patch) {
  const order = patch?.handoff_order !== undefined ? requireHandoffOrder(patch?.handoff_order) : undefined
  mkdirSync(home(), { recursive: true })
  return withFileLock(preferencesFile() + '.lock', () => {
    const current = readPreferences()
    const next = { ...current }
    if (order !== undefined) next.handoff_order = order
    if (patch?.auto_approve !== undefined) next.auto_approve = Boolean(patch.auto_approve)
    writeJsonAtomic(preferencesFile(), next)
    return next
  })
}
