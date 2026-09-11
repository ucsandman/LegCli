// Pipeline = ordered stations a card moves through. Board columns derive from
// it (phase 6). Validation happens at card creation so a forbidden mode or a
// misplaced land station never reaches a worktree.
import { readFileSync } from 'node:fs'
import { PRESETS, PRESET_NAMES } from './presets.mjs'
import { get as getAdapter, names as adapterNames } from './adapters/index.mjs'

export const KINDS = ['agent', 'human', 'test', 'land']
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/

// chain entry: { adapter, mode?, maxTurns?, approve?, network?, fakeMode?, model? }
export function normalizeChainEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.adapter !== 'string') throw new Error('chain entry needs an adapter name')
  const out = { adapter: e.adapter }
  if (e.mode !== undefined && e.mode !== null) out.mode = String(e.mode)
  const mt = e.maxTurns ?? e.max_turns
  if (mt !== undefined && mt !== null) {
    out.maxTurns = Number(mt)
    if (!Number.isInteger(out.maxTurns) || out.maxTurns < 1) throw new Error(`chain entry ${e.adapter}: maxTurns must be a positive integer`)
  }
  if (e.approve) out.approve = true
  if (e.network) out.network = true
  if (e.fakeMode !== undefined) out.fakeMode = String(e.fakeMode)
  if (e.model !== undefined && e.model !== null) out.model = String(e.model)
  return out
}

// "claude,codex" | [{adapter}] → normalized entries
export function parseChain(raw) {
  if (Array.isArray(raw)) return raw.map(normalizeChainEntry)
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('[')) return JSON.parse(s).map(normalizeChainEntry)
    return s.split(',').map((x) => x.trim()).filter(Boolean).map((adapter) => ({ adapter }))
  }
  throw new Error('chain must be a comma list or a JSON array')
}

// preset name | path to a JSON file | array → stations with the default chain applied
export function buildPipeline({ preset, file, stations, chain }) {
  let base
  if (Array.isArray(stations)) base = stations
  else if (file) base = JSON.parse(readFileSync(file, 'utf8'))
  else base = PRESETS[preset ?? 'build']
  if (!base) throw new Error(`unknown pipeline preset "${preset}" (known: ${PRESET_NAMES.join(', ')})`)
  if (!Array.isArray(base)) throw new Error('pipeline must be an array of stations')
  return base.map((s) => {
    const st = { name: s.name, kind: s.kind }
    if (s.prompt) st.prompt = s.prompt
    if (s.kind === 'agent') st.chain = (s.chain ?? chain ?? []).map(normalizeChainEntry)
    if (s.command) st.command = s.command
    return st
  })
}

// Registered adapters with their allowed modes, for validation.
export async function loadAdapterModes(names = adapterNames()) {
  const out = {}
  for (const n of names) {
    const a = await getAdapter(n)
    out[n] = { allowed: a.modes.allowed, default: a.modes.default }
  }
  return out
}

// Throws a named error on: empty pipeline, duplicate names, unknown kinds,
// agent station without a chain, unregistered adapter, forbidden mode, land
// station not last or more than one.
export function validatePipeline(pipeline, adapterModes) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) throw new Error('pipeline is empty')
  const seen = new Set()
  pipeline.forEach((s, i) => {
    if (!s || typeof s.name !== 'string' || !NAME_RE.test(s.name)) throw new Error(`station ${i}: invalid name "${s?.name}"`)
    if (seen.has(s.name)) throw new Error(`duplicate station name "${s.name}"`)
    seen.add(s.name)
    if (!KINDS.includes(s.kind)) throw new Error(`station "${s.name}": unknown kind "${s.kind}" (allowed: ${KINDS.join(', ')})`)
    if (s.kind === 'agent') {
      if (!Array.isArray(s.chain) || s.chain.length === 0) throw new Error(`station "${s.name}": agent station needs a non-empty chain`)
      for (const e of s.chain) {
        const modes = adapterModes[e.adapter]
        if (!modes) throw new Error(`station "${s.name}": unknown adapter "${e.adapter}" (registered: ${Object.keys(adapterModes).join(', ')})`)
        if (e.mode !== undefined && !modes.allowed.includes(e.mode)) {
          throw new Error(`forbidden mode "${e.mode}" for ${e.adapter} (allowed: ${modes.allowed.join(', ')})`)
        }
      }
    }
    if (s.kind === 'land' && i !== pipeline.length - 1) throw new Error(`station "${s.name}": a land station must be last`)
  })
  if (pipeline.filter((s) => s.kind === 'land').length > 1) throw new Error('at most one land station')
  return pipeline
}

export function stationIndex(pipeline, name) {
  return pipeline.findIndex((s) => s.name === name)
}

export function columns(pipeline) {
  return ['backlog', ...pipeline.map((s) => s.name), 'done']
}
