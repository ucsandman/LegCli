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

// Portable harness (src/harness/): off for every existing install. `enabled`
// is the explicit consent `leg harness enable` records; `policy` is what an
// unattended hand-off may do (warn: report only; sync: write managed state
// when it is safe; strict: refuse a destination that cannot be made safe);
// `source` is the client whose harness is the one being carried.
export const HARNESS_POLICIES = ['warn', 'sync', 'strict']
export const HARNESS_SOURCES = ['claude', 'codex']
export const HARNESS_DEFAULTS = Object.freeze({ enabled: false, policy: 'warn', source: null })

export function normalizeHarness(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    enabled: v.enabled === true,
    policy: HARNESS_POLICIES.includes(v.policy) ? v.policy : HARNESS_DEFAULTS.policy,
    source: HARNESS_SOURCES.includes(v.source) ? v.source : null,
  }
}

export function requireHarness(patch, current = HARNESS_DEFAULTS) {
  const next = { ...normalizeHarness(current) }
  if (patch?.enabled !== undefined) next.enabled = Boolean(patch.enabled)
  if (patch?.policy !== undefined) {
    if (!HARNESS_POLICIES.includes(patch.policy)) throw new TypeError(`harness policy must be one of ${HARNESS_POLICIES.join(', ')}`)
    next.policy = patch.policy
  }
  if (patch?.source !== undefined) {
    if (patch.source !== null && !HARNESS_SOURCES.includes(patch.source)) throw new TypeError(`harness source must be one of ${HARNESS_SOURCES.join(', ')}`)
    next.source = patch.source
  }
  return next
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

// Where a terminal that is waiting on a human says so. `notify_terminal` is on
// by default: the OSC 9 toast reaches the window the human is already in, with
// no browser and no permission prompt (docs/redesign-2026-09-17.md E, the
// notifications table). `notify_board` is off by default because the browser's
// own Notification permission has to be granted first, and a toggle that asks
// for a permission nobody wanted is worse than no toggle.
const defaults = () => ({ handoff_order: [...HANDOFF_AGENTS], auto_approve: true, notify_terminal: true, notify_board: false, harness: { ...HARNESS_DEFAULTS } })

export function readPreferences() {
  const file = preferencesFile()
  if (!existsSync(file)) return defaults()
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return {
      handoff_order: normalizeHandoffOrder(value?.handoff_order),
      auto_approve: value?.auto_approve !== false,
      notify_terminal: value?.notify_terminal !== false,
      notify_board: value?.notify_board === true,
      harness: normalizeHarness(value?.harness),
    }
  } catch {
    return defaults()
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
    if (patch?.notify_terminal !== undefined) next.notify_terminal = Boolean(patch.notify_terminal)
    if (patch?.notify_board !== undefined) next.notify_board = Boolean(patch.notify_board)
    if (patch?.harness !== undefined) next.harness = requireHarness(patch.harness, current.harness)
    writeJsonAtomic(preferencesFile(), next)
    return next
  })
}
