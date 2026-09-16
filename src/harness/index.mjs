// harness — the portable-harness subsystem. Leg carries a session's task
// context between agents (src/bundle.mjs); this carries the agent's WORKING
// ENVIRONMENT: the global working agreement, identity, hooks, skills,
// subagents, slash commands, MCP servers and permissions, as far as the
// destination client can represent them, and says what it could not carry.
//
// The engine is the Agnostic AI port engine (MIT), vendored byte for byte
// under vendor/agnostic-ai and driven only through its library entry
// (engine/harness/index.cjs). Leg owns everything around it: consent
// (preferences.harness.enabled), policy (warn | sync | strict), the client
// registry (registry.mjs), where state lives ($LEG_HOME/harness), the
// fingerprint that keeps a hand-off fast (fingerprint.mjs), the evidence
// trail (history.jsonl) and the decision a hand-off makes (prepare below).
//
// What the engine promises and Leg keeps: the source client is never written;
// every generated file carries the ownership claim BRAND.mark; a file the user
// hand-edited is backed up and skipped, never overwritten, unless --force;
// managed regions leave everything outside them byte for byte; a credential
// never enters the bundle (it becomes ${NAME} and the user is told); every
// dropped item carries a reason. Account credentials are not a harness concern
// at all: which login runs is the account layer's decision (src/accounts.mjs).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import engine from './vendor/agnostic-ai/engine/harness/index.cjs'
import { BRAND, CLIENT_IDS, NO_ADAPTER, SOURCE_IDS, VENDOR, clientFor, detectSources, harnessHome, registry } from './registry.mjs'
import { sourceFingerprint, sourcePresent } from './fingerprint.mjs'
import { home } from '../store.mjs'
import { withFileLock, writeJsonAtomic } from '../fsx.mjs'
import { readPreferences, writePreferences, HARNESS_POLICIES } from '../preferences.mjs'
import { SECRET_PATTERNS } from '../redact.mjs'

export { BRAND, CLIENT_IDS, SOURCE_IDS, NO_ADAPTER, clientFor, detectSources, harnessHome, registry } from './registry.mjs'
export const COMPONENTS = engine.COMPONENTS
export const POLICIES = ['off', ...HARNESS_POLICIES]
// What a hand-off records about the destination's harness. One word each,
// so the board and the CLI print the same vocabulary.
export const STATES = ['off', 'same-client', 'source', 'synced', 'partial', 'stale', 'attention', 'unsupported', 'blocked', 'error']

// ---- engine configuration (once per process) ----
let configured = false
function guardsPatterns() {
  try {
    const g = JSON.parse(readFileSync(join(VENDOR, 'core', 'safety', 'guards.json'), 'utf8'))
    return g?.guards?.secretScan?.sensitivePatterns ?? []
  } catch { return [] }
}
export function configureEngine() {
  if (configured) return engine
  engine.configure({
    brand: { ...BRAND },
    // the engine's own shapes plus Leg's (src/redact.mjs): one list, fail closed
    secretPatterns: [...guardsPatterns(), ...SECRET_PATTERNS.map(([, re]) => re)],
    shimPath: join(VENDOR, 'engine', 'hooks', 'shim.cjs'),
    // no rules live inside the package: an @import may only resolve inside the user's home
    importRoots: [],
  })
  configured = true
  return engine
}

// ---- where state lives ----
export function harnessDir() { return join(home(), 'harness') }
export const bundleDir = () => join(harnessDir(), 'bundle')
export const captureFile = () => join(harnessDir(), 'capture.json')
export const historyFile = () => join(harnessDir(), 'history.jsonl')
export const policyFile = () => join(harnessDir(), 'policy.json')

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

// ---- the port policy (what is deliberately not carried) ----
// Leg ships a neutral default: nothing excluded, nothing dropped, and the
// Codex model ladder that maps the four Claude tiers onto Codex models. A user
// customises it in $LEG_HOME/harness/policy.json, which is deep-merged over
// this (docs/harness.md, "The port policy").
export const DEFAULT_POLICY = Object.freeze({
  targets: 'installed',
  rules: { dropSectionsForTargets: [] },
  hooks: { exclude: [], extra: {} },
  skills: { exclude: {}, codexDisable: [] },
  mcp: { exclude: {} },
  agents: { modelLadder: { codex: { fable: ['gpt-6-astra', 'high'], opus: ['gpt-5.6-sol', 'high'], sonnet: ['gpt-5.6-terra', 'medium'], haiku: ['gpt-5.6-luna', 'low'] } } },
})
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v
  return out
}
export function readPolicy() {
  const user = readJson(policyFile(), null)
  const merged = merge(structuredClone(DEFAULT_POLICY), user ?? {})
  merged.baseDir = harnessDir()
  return merged
}

// ---- configuration (consent + mode + source) ----
export function harnessConfig() { return readPreferences().harness }
export function effectivePolicy(cfg = harnessConfig()) { return cfg.enabled ? cfg.policy : 'off' }

// ---- evidence ----
export function appendHistory(entry) {
  mkdirSync(harnessDir(), { recursive: true })
  appendFileSync(historyFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}
export function readHistory(limit = 50) {
  if (!existsSync(historyFile())) return []
  return readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).slice(-limit)
}

// ---- capture ----
function sourceTarget(source, opts) {
  const t = registry(opts).find((x) => x.id === source)
  if (!t) throw new Error(`"${source}" is not a client Leg can capture a harness from (${SOURCE_IDS.join(', ')})`)
  return t
}

export function resolveSource({ env = process.env, cfg = harnessConfig() } = {}) {
  if (cfg.source) return cfg.source
  const found = detectSources({ env })
  return found.length ? found[0].id : null
}

// Read the source client into the neutral bundle under $LEG_HOME/harness/bundle.
// Cheap when nothing changed: the source surfaces are fingerprinted first and a
// matching capture.json means the bundle on disk is current.
export function captureHarness({ source = null, force = false, env = process.env } = {}) {
  configureEngine()
  const src = source ?? resolveSource({ env })
  if (!src) throw new Error('no source client found: none of ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md exists (leg harness source <claude|codex>)')
  const homeDir = harnessHome(env)
  const reg = registry({ env, home: homeDir })
  const target = sourceTarget(src, { env, home: homeDir })
  if (!sourcePresent(src, target)) throw new Error(`source client ${src} has no rules file under ${target.home}`)
  const fp = sourceFingerprint(src, target, homeDir)
  const t0 = Date.now()
  mkdirSync(harnessDir(), { recursive: true })
  return withFileLock(join(harnessDir(), '.lock'), () => {
    const cache = readJson(captureFile())
    if (!force && cache && cache.source === src && cache.surfaces_hash === fp.hash && existsSync(join(bundleDir(), 'manifest.json'))) {
      // a bundle that no longer loads, or no longer matches the fingerprint it
      // was recorded with, is repaired by capturing again, never trusted
      let bundle = null
      try { bundle = engine.bundle.load(bundleDir()) } catch { bundle = null }
      if (bundle && bundle.manifest.fingerprint === cache.fingerprint) return { bundle, warnings: cache.warnings ?? [], cached: true, source: src, elapsed_ms: Date.now() - t0 }
    }
    const { bundle, warnings } = engine.capture({ from: src, home: homeDir, outDir: bundleDir(), registry: reg, port: readPolicy() })
    const record = { source: src, fingerprint: bundle.manifest.fingerprint, surfaces_hash: fp.hash, surfaces: fp.surfaces, captured_at: bundle.manifest.capturedAt, components: bundle.manifest.components, warnings }
    mkdirSync(harnessDir(), { recursive: true })
    writeJsonAtomic(captureFile(), record)
    appendHistory({ op: 'capture', source: src, fingerprint: record.fingerprint, components: record.components, warnings, elapsed_ms: Date.now() - t0 })
    return { bundle, warnings, cached: false, source: src, elapsed_ms: Date.now() - t0 }
  }, LOCK)
}

// One writer at a time across every Leg process: a hand-off in one terminal,
// a `leg harness sync` in another. Thirty seconds covers a cold apply; a
// caller that cannot get the lock fails its own step rather than tearing the
// ownership record two processes would otherwise both rewrite.
const LOCK = { retries: 600, waitMs: 50, staleMs: 60000, mustHold: true }

export function loadBundle() {
  configureEngine()
  try { return engine.bundle.load(bundleDir()) } catch (err) { return { corrupt: err.message } }
}

// What the bundle holds, by name, for `leg harness inspect` and the board.
export function inspectHarness() {
  const cap = readJson(captureFile())
  const b = loadBundle()
  if (!b) return { captured: false, source: cap?.source ?? null }
  if (b.corrupt) return { captured: true, corrupt: b.corrupt, source: cap?.source ?? null }
  return {
    captured: true,
    source: b.manifest.source,
    captured_at: b.manifest.capturedAt,
    fingerprint: b.manifest.fingerprint,
    components: b.manifest.components,
    rules_bytes: b.rules.length,
    identity: Boolean(b.identity),
    hooks: Object.fromEntries(Object.entries(b.hooks.events).map(([ev, groups]) => [ev, groups.reduce((n, g) => n + g.hooks.length, 0)])),
    skills: b.skills.skills.map((s) => s.name),
    agents: b.agents.map((a) => ({ name: a.name, model: a.meta.model, readonly: String(a.meta.readonly) === 'true' })),
    commands: b.commands.map((c) => c.name),
    mcp: Object.entries(b.mcp.servers).map(([name, s]) => ({ name, transport: s.transport, env_refs: [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})].filter((v) => /^\$\{[A-Za-z0-9_]+\}$/.test(String(v))).length })),
    permissions: b.permissions,
    warnings: cap?.warnings ?? [],
  }
}

// ---- normalising an engine report into Leg's vocabulary ----
const ROW_STATE = { synced: 'synced', written: 'synced', stale: 'stale', skipped: 'attention', unsupported: 'unsupported', error: 'error', source: 'source' }
const COMPONENT_STATE = { synced: 'synced', written: 'synced', stale: 'stale', skipped: 'attention', unsupported: 'unsupported', error: 'error' }
const COUNTED = { skills: 'skills', agents: 'agents', commands: 'commands', mcp: 'mcp', hooks: 'hooks', permissions: 'permissions' }

function excludedBy(policy, component, item) {
  const name = String(item).replace(/^(skill|mcp|agent|command)\s+/, '')
  if (component === 'skills' && policy.skills?.exclude?.[name]) return true
  if (component === 'mcp' && policy.mcp?.exclude?.[name]) return true
  if (component === 'hooks' && (policy.hooks?.exclude ?? []).some((e) => { try { return new RegExp(e.match).test(item) } catch { return String(item).includes(e.match) } })) return true
  if (component === 'rules' && /^rules section/.test(item)) return true
  return false
}

export function normalizeRow(row, bundle, policy = readPolicy()) {
  const counts = bundle?.manifest?.components ?? {}
  const components = {}
  const dropped = []
  const attention = []
  let files = 0
  for (const c of COMPONENTS) {
    const r = row.components?.[c]
    if (!r) { components[c] = { state: row.status === 'source' ? 'source' : 'unsupported', note: null }; continue }
    const state = COMPONENT_STATE[r.status] ?? 'error'
    const drops = (r.dropped ?? []).map((d) => ({ component: c, item: d.item, reason: d.reason, excluded: excludedBy(policy, c, d.item) }))
    dropped.push(...drops)
    // a deny or ask the destination cannot express leaves it with a WIDER
    // policy than the source: that is not a drop to note, it is a gap to fix
    for (const d of drops) if (c === 'permissions' && /^(deny|ask):/.test(d.item) && !d.excluded) attention.push({ component: c, file: null, reason: `${d.item} cannot be expressed here (${d.reason}); the destination is less restricted than the source` })
    for (const f of r.files ?? []) {
      if (f.action === 'written' || f.action === 'linked' || f.action === 'pruned' || f.action === 'removed') files++
      if (f.action === 'skipped-hand-edited') attention.push({ component: c, file: f.path, reason: 'hand-edited since Leg last wrote it; left alone (backup taken). Run `leg harness sync --force` to replace it, or edit the source client instead.' })
    }
    if (r.status === 'error') attention.push({ component: c, file: null, reason: r.error ?? r.note ?? 'error' })
    const total = COUNTED[c] ? (counts[c] ?? 0) : null
    const notCarried = drops.filter((d) => !d.excluded).length
    const carried = total === null ? null : Math.max(0, total - drops.length)
    components[c] = { state, note: r.note ?? null, total, carried, dropped: drops.length, excluded: drops.length - notCarried, error: r.error ?? null }
  }
  let state = ROW_STATE[row.status] ?? 'error'
  if (state === 'synced' && dropped.some((d) => !d.excluded)) state = 'partial'
  if (attention.length && state !== 'error') state = 'attention'
  return { state, installed: row.installed, adapter: row.adapter, components, dropped, attention, files_written: files, backups: [], note: row.note ?? null, error: row.error ?? null }
}

function sortedTargets(report, bundle, policy) {
  const out = {}
  for (const id of CLIENT_IDS) if (report.targets[id]) out[id] = { id, name: report.targets[id].name, ...normalizeRow(report.targets[id], bundle, policy) }
  return out
}

// ---- compare / apply ----
export function compareHarness({ to = null, env = process.env, bundle = null } = {}) {
  configureEngine()
  const b = bundle ?? loadBundle()
  if (!b || b.corrupt) return { captured: Boolean(b), corrupt: b?.corrupt ?? null, targets: {} }
  const homeDir = harnessHome(env)
  const policy = readPolicy()
  mkdirSync(harnessDir(), { recursive: true })
  const report = withFileLock(join(harnessDir(), '.lock'), () => engine.status({ bundle: b, home: homeDir, registry: registry({ env, home: homeDir }), port: policy, storageDir: harnessDir(), to: to ? [].concat(to) : undefined, quiet: true, log: () => {} }).report, LOCK)
  return { captured: true, source: b.manifest.source, fingerprint: b.manifest.fingerprint, captured_at: b.manifest.capturedAt, targets: sortedTargets(report, b, policy), stale: report.stale }
}

export function applyHarness({ to = null, force = false, dryRun = false, env = process.env, bundle = null, sessionId = null } = {}) {
  configureEngine()
  const b = bundle ?? loadBundle()
  if (!b) throw new Error('no harness captured yet: leg harness capture')
  if (b.corrupt) throw new Error(`the captured harness is unreadable (${b.corrupt}); run leg harness capture --force`)
  const homeDir = harnessHome(env)
  const policy = readPolicy()
  const t0 = Date.now()
  const backupsDir = join(harnessDir(), 'backups')
  const before = backupNames(backupsDir)
  mkdirSync(harnessDir(), { recursive: true })
  const report = withFileLock(join(harnessDir(), '.lock'), () => engine.apply({
    bundle: b, home: homeDir, registry: registry({ env, home: homeDir }), port: policy, storageDir: harnessDir(),
    to: to ? [].concat(to) : undefined, force, dryRun, check: dryRun, quiet: true, log: () => {},
  }), LOCK)
  const targets = sortedTargets(report, b, policy)
  // The writer names every backup it takes (<target>-<file>-<stamp>.bak) but
  // adapters keep only the action, so the count comes from the directory.
  const created = [...backupNames(backupsDir)].filter((n) => !before.has(n))
  for (const [id, t] of Object.entries(targets)) t.backups = created.filter((n) => n.startsWith(`${id}-`)).map((n) => join(backupsDir, n))
  const out = { source: b.manifest.source, fingerprint: b.manifest.fingerprint, captured_at: b.manifest.capturedAt, mode: report.mode, targets, applied_at: report.appliedAt, elapsed_ms: Date.now() - t0 }
  if (!dryRun) {
    for (const [id, t] of Object.entries(targets)) {
      const files = []
      for (const r of Object.values(report.targets[id].components ?? {})) for (const f of r.files ?? []) if (f.action && f.action !== 'unchanged' && f.action !== 'inspected') files.push({ path: engine.common.tildePath(f.path, homeDir), action: f.action })
      appendHistory({ op: 'apply', source: out.source, target: id, fingerprint: out.fingerprint, captured_at: out.captured_at, state: t.state, session_id: sessionId, force, components: Object.fromEntries(Object.entries(t.components).map(([c, v]) => [c, v.state])), dropped: t.dropped.slice(0, 50), attention: t.attention, warnings: [], files, written: t.files_written, backups: t.backups, elapsed_ms: out.elapsed_ms })
    }
  }
  return out
}

function backupNames(dir) {
  try { return new Set(readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isFile() } catch { return false } })) } catch { return new Set() }
}

// ---- status ----
export function getHarnessStatus({ env = process.env, fresh = false } = {}) {
  const cfg = harnessConfig()
  const cap = readJson(captureFile())
  const source = cfg.source ?? cap?.source ?? resolveSource({ env, cfg })
  const out = {
    enabled: cfg.enabled, policy: effectivePolicy(cfg), configured_policy: cfg.policy, source,
    sources_detected: detectSources({ env }).map((s) => s.id),
    captured: Boolean(cap), captured_at: cap?.captured_at ?? null, fingerprint: cap?.fingerprint ?? null, components: cap?.components ?? null,
    source_changed: null, targets: {}, unsupported: {}, warnings: cap?.warnings ?? [],
  }
  for (const [agent, reason] of Object.entries(NO_ADAPTER)) out.unsupported[agent] = reason
  if (!source) return out
  try {
    const homeDir = harnessHome(env)
    const target = registry({ env, home: homeDir }).find((t) => t.id === source)
    if (target && sourcePresent(source, target)) out.source_changed = cap ? sourceFingerprint(source, target, homeDir).hash !== cap.surfaces_hash : null
  } catch { /* the status page must render whatever the source looks like */ }
  if (fresh && out.enabled) {
    try { const c = captureHarness({ source, env }); out.captured = true; out.captured_at = c.bundle.manifest.capturedAt; out.fingerprint = c.bundle.manifest.fingerprint; out.components = c.bundle.manifest.components; out.source_changed = false; out.warnings = c.warnings } catch (err) { out.capture_error = err.message }
  }
  if (out.captured) {
    const cmp = compareHarness({ env })
    out.targets = cmp.targets
    out.corrupt = cmp.corrupt ?? null
  }
  return out
}

export function explainHarnessDrops({ to = null, env = process.env } = {}) {
  const cmp = compareHarness({ to, env })
  const out = []
  for (const t of Object.values(cmp.targets)) for (const d of t.dropped) out.push({ target: t.id, ...d })
  return { source: cmp.source ?? null, dropped: out, unsupported: NO_ADAPTER }
}

// ---- enable / disable ----
export function setHarnessConfig(patch) { return writePreferences({ harness: patch }).harness }

// ---- the hand-off decision ----
// Called before every leg Leg launches. Deterministic, never interactive,
// never throws: the answer is a record the session keeps and the board shows.
//   proceed  whether the launch goes ahead (only strict mode says no)
//   state    one of STATES
export function prepareHarnessForHandoff({ from = null, to, sessionId = null, env = process.env, cfg = harnessConfig(), log = null } = {}) {
  const t0 = Date.now()
  const policy = effectivePolicy(cfg)
  const base = { policy, from: from ?? null, to, target: clientFor(to), proceed: true, elapsed_ms: 0, at: new Date().toISOString() }
  const finish = (rest) => {
    const out = { ...base, ...rest, elapsed_ms: Date.now() - t0 }
    if (out.state !== 'off') appendHistory({ op: 'prepare', session_id: sessionId, from: out.from, to: out.to, target: out.target, policy, state: out.state, proceed: out.proceed, fingerprint: out.fingerprint ?? null, reason: out.reason ?? null, elapsed_ms: out.elapsed_ms })
    if (log) log(out)
    return out
  }
  if (policy === 'off') return finish({ state: 'off', summary: 'portable harness is off' })
  const target = clientFor(to)
  const fromClient = clientFor(from)
  if (!target) return finish({ state: 'unsupported', reason: `${to} runs under no client Leg can carry a harness to`, summary: `${to}: no client to carry a harness to` })
  if (fromClient && fromClient === target) return finish({ state: 'same-client', summary: `${target} to ${target}: same client, same harness` })
  try {
    const source = resolveSource({ env, cfg })
    if (!source) return finish({ state: 'error', reason: 'no source client configured or detected', proceed: policy !== 'strict', summary: 'no source harness to carry' })
    if (target === source) return finish({ state: 'source', source, summary: `${target} is the source of the harness; nothing to carry` })
    if (NO_ADAPTER[target] || !CLIENT_IDS.includes(target)) {
      return finish({ state: 'unsupported', source, reason: NO_ADAPTER[target] ?? `no harness adapter for ${target}`, proceed: policy !== 'strict', summary: `${target}: ${NO_ADAPTER[target] ?? 'no harness adapter'}` })
    }
    const cap = captureHarness({ source, env })
    const check = compareHarness({ to: target, env, bundle: cap.bundle })
    let row = check.targets[target]
    if (!row) return finish({ state: 'error', source, reason: `no status for ${target}`, proceed: policy !== 'strict', summary: `${target}: no status` })
    if (!row.installed) return finish({ state: 'unsupported', source, reason: `${target} is not installed under ${harnessHome(env)}`, proceed: policy !== 'strict', summary: `${target} is not installed` })
    let synced_at = null
    let mode = 'check'
    if (policy !== 'warn' && (row.state === 'stale' || row.state === 'attention')) {
      const applied = applyHarness({ to: target, env, bundle: cap.bundle, sessionId })
      row = applied.targets[target]
      synced_at = applied.applied_at
      mode = 'sync'
    }
    const blocked = policy === 'strict' && !(row.state === 'synced' || row.state === 'partial')
    const state = blocked ? 'blocked' : row.state
    const summary = describe({ state, target, row, policy, mode, cached: cap.cached })
    return finish({
      state, source, fingerprint: cap.bundle.manifest.fingerprint, captured_at: cap.bundle.manifest.capturedAt, capture_cached: cap.cached,
      synced_at, mode, proceed: !blocked, reason: blocked ? `strict policy: ${target} is ${row.state}` : null,
      components: row.components, dropped: row.dropped.slice(0, 50), attention: row.attention, warnings: cap.warnings,
      files_written: row.files_written, backups: row.backups.length, summary,
    })
  } catch (err) {
    return finish({ state: 'error', reason: String(err.message).slice(0, 300), proceed: policy !== 'strict', summary: `harness error: ${String(err.message).slice(0, 120)}` })
  }
}

function describe({ state, target, row, policy, mode, cached }) {
  const carried = COMPONENTS.filter((c) => row.components[c]?.state === 'synced').length
  const supported = COMPONENTS.filter((c) => row.components[c]?.state !== 'unsupported').length
  const parts = [`${target} harness ${state}`]
  parts.push(`${carried}/${supported} components${row.dropped.length ? `, ${row.dropped.length} dropped` : ''}`)
  if (mode === 'sync') parts.push(`${row.files_written} file(s) written`)
  else if (state === 'stale') parts.push(policy === 'warn' ? 'warn policy: not synced' : 'not synced')
  if (row.attention.length) parts.push(`${row.attention.length} need(s) attention`)
  if (cached) parts.push('capture reused')
  return parts.join(' · ')
}

// The one-line summary a session's timeline and the terminal print.
export function harnessLine(outcome) {
  if (!outcome || outcome.state === 'off') return null
  if (outcome.state === 'same-client') return null
  return outcome.summary ?? `${outcome.target}: ${outcome.state}`
}

// A status a session card can show beside the agent, or null when there is nothing to say.
export function harnessBadge(outcome) {
  if (!outcome || ['off', 'same-client'].includes(outcome.state)) return null
  return { state: outcome.state, target: outcome.target, source: outcome.source ?? null, synced_at: outcome.synced_at ?? null, captured_at: outcome.captured_at ?? null }
}
