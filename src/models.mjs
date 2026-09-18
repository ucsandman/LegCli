// models: the model catalog each CLI already publishes, read from where that
// CLI keeps it rather than from a list Leg maintains by hand.
//
// Why not a table in this file: three of the four catalogs move under Leg's
// feet. codex rewrites ~/.codex/models_cache.json whenever it refreshes from
// the service, agy and grok print theirs from their own accounts, and a name
// hard-coded here would be a wrong answer the week after it was written. Only
// claude's list is static, and it is static because those four words are
// aliases Claude Code itself resolves (src/buckets.mjs MODEL_ALIASES), not
// service-side model ids.
//
// Sources, each verified on this machine on 2026-09-18:
//   claude  MODEL_ALIASES.claude, labelled; no default (Claude Code picks one)
//   codex   <CODEX_HOME>/models_cache.json models[] where visibility == "list",
//           default from `model = "..."` at the top of <CODEX_HOME>/config.toml
//   agy     `agy models`, tab-separated `id<TAB>label` after a "Fetching" line
//   grok    `grok models`, "Default model: X" then "  * id (default)" / "  - id"
//
// agy and grok cost a process each, so their answers are cached under
// <LEG_HOME>/models/<agent>.json for an hour and a request is never made to
// wait on one: a stale or missing cache is served as-is and the refresh runs
// behind the answer.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'
import { writeJsonAtomic } from './fsx.mjs'
import { MODEL_ALIASES } from './buckets.mjs'
import { LAYOUT } from './accounts.mjs'
import agyAdapter from './adapters/agy.mjs'
import grokAdapter from './adapters/grok.mjs'

export const MODEL_AGENTS = ['claude', 'codex', 'agy', 'grok']

// A model id is pushed onto an agent's argv (`-m <id>`), so the shape is the
// boundary: letters, digits and the four separators the four catalogs actually
// use. Anything else (a space, a quote, a leading dash, a path separator) is
// a flag or a path in disguise and is dropped by the parser rather than
// corrected, because a corrected id is a model nobody published.
//
// Lower case only, and that is a constraint on the catalogs rather than a
// preference: `normalizeRung` in src/preferences.mjs lower-cases a rung's model
// before it validates it, so an id with a capital in it would be offered in a
// select here and then handed to the CLI in a spelling the CLI never published.
// All 23 ids the four catalogs publish on this machine today are lower case
// (codex slugs, agy ids, grok bullets, claude's aliases), so nothing is lost;
// if one ever is not, it is missing from the select, which is visible, rather
// than silently mangled on a command line, which is not.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/

export function validModelId(id) {
  return MODEL_ID_RE.test(String(id ?? ''))
}

const CACHE_MS = 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 20_000

// ---- parsers: pure, one fixture each under fixtures/models/ ----------------

// "fable" -> "Claude Fable". The alias is what the CLI takes; the label is
// what a human reads in a select.
function claudeLabel(alias) {
  return `Claude ${alias.charAt(0).toUpperCase()}${alias.slice(1)}`
}

// claude's list never leaves this process: the aliases are Claude Code's own.
// No default: `claude` with no `--model` picks for itself, and naming one here
// would be Leg inventing a choice the human did not make.
export function claudeModels() {
  return MODEL_ALIASES.claude.filter(validModelId).map((id) => ({ id, label: claudeLabel(id), default: false }))
}

// models_cache.json plus config.toml. `visibility` is codex's own word for
// which models it offers a human: "hide" covers gpt-reserve and the internal
// codex-auto-review, neither of which is a model to start a leg on.
export function parseCodexModels(cacheText, configText = '') {
  let parsed = null
  try { parsed = JSON.parse(String(cacheText ?? '')) } catch { return [] }
  const rows = Array.isArray(parsed?.models) ? parsed.models : []
  const preferred = parseCodexDefault(configText)
  const out = []
  for (const m of rows) {
    if (m?.visibility !== 'list') continue
    const id = String(m?.slug ?? '')
    if (!validModelId(id)) continue
    out.push({ id, label: String(m?.display_name || id), default: id === preferred })
  }
  return out
}

// `model = "gpt-6-astra"` at the top level of config.toml. A `model` key inside
// a `[profiles.x]` table is that profile's, not the one a bare `codex` uses, so
// the scan stops at the first table header.
//
// A trailing `# ...` is ordinary TOML and common in that file, so it is allowed
// after the closing quote: anchoring at end of line made `model = "gpt-5-codex"
// # the fast one` read as no default at all, and the board then offered a
// generic "provider default" for a codex that has one.
export function parseCodexDefault(configText) {
  for (const raw of String(configText ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#') || !line) continue
    if (line.startsWith('[')) break
    const m = /^model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line)
    if (m && validModelId(m[1])) return m[1]
  }
  return null
}

// `agy models` prints a progress line first and then one `id<TAB>label` per
// model. A line with no tab is progress, not a model.
export function parseAgyModels(stdout) {
  const out = []
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const tab = raw.indexOf('\t')
    if (tab <= 0) continue
    const id = raw.slice(0, tab).trim()
    if (!validModelId(id)) continue
    out.push({ id, label: raw.slice(tab + 1).trim() || id, default: false })
  }
  return out
}

// `grok models` prints "Default model: X", then a bullet per model with the
// default marked. grok publishes no display name, so the id is the label.
export function parseGrokModels(stdout) {
  const text = String(stdout ?? '')
  const declared = /^\s*Default model:\s*(\S+)\s*$/m.exec(text)
  const preferred = declared && validModelId(declared[1]) ? declared[1] : null
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[*-]\s+(\S+)\s*(\(default\))?\s*$/.exec(raw)
    if (!m || !validModelId(m[1])) continue
    out.push({ id: m[1], label: m[1], default: m[1] === preferred || Boolean(m[2]) })
  }
  return out
}

// ---- codex: files, read every time (they are two small local reads) --------

function codexHome() {
  return process.env.CODEX_HOME || LAYOUT.codex.home()
}

function readIfPresent(file) {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
}

export function codexModels() {
  const dir = codexHome()
  return parseCodexModels(readIfPresent(join(dir, 'models_cache.json')), readIfPresent(join(dir, 'config.toml')))
}

// ---- agy and grok: a process, cached ---------------------------------------

export function modelsCacheFile(agent) {
  return join(home(), 'models', `${agent}.json`)
}

function readCache(agent) {
  try {
    const value = JSON.parse(readFileSync(modelsCacheFile(agent), 'utf8'))
    if (!Array.isArray(value?.models)) return null
    return { models: value.models.filter((m) => validModelId(m?.id)).map((m) => ({ id: String(m.id), label: String(m.label ?? m.id), default: m.default === true })), observed_at: value.observed_at ?? null, attempted_at: value.attempted_at ?? null }
  } catch { return null }
}

// `observed_at` is when a list was last SEEN, `attempted_at` when the probe was
// last RUN. They part company on a fruitless probe: an agent that is not
// installed prints nothing, and without the attempt stamp that answer left no
// cache entry at all, so every board page load, every New card dialog and every
// floor load spawned a fresh `agy models` and `grok models` for the same
// nothing. The attempt is cached; the last list Leg really saw is kept.
function writeCache(agent, models, { observedAt = new Date().toISOString(), attemptedAt = new Date().toISOString() } = {}) {
  try {
    mkdirSync(join(home(), 'models'), { recursive: true })
    writeJsonAtomic(modelsCacheFile(agent), { models, observed_at: observedAt, attempted_at: attemptedAt })
  } catch { /* a catalog that cannot be cached is still a catalog */ }
}

// The binary each adapter already resolves, so a probe runs the same agy or
// grok a leg would, including the LEG_AGY_BIN / LEG_GROK_BIN test seams. No
// shell: the argv is fixed, and a shell here would be one more thing between
// Leg and a list of names.
const PROBES = {
  agy: { adapter: agyAdapter, args: ['models'], parse: parseAgyModels },
  grok: { adapter: grokAdapter, args: ['models'], parse: parseGrokModels },
}

function probeArgv(probe) {
  const { bin, viaNode } = probe.adapter.resolve()
  return viaNode ? { bin: process.execPath, args: [bin, ...probe.args] } : { bin, args: [...probe.args] }
}

// One refresh per agent in flight at a time. Two board tabs opening at once
// used to be two `agy models` processes for the same answer.
const inFlight = new Map()

function stale(entry) {
  if (!entry) return true
  const ms = (v) => { const n = Date.parse(v ?? ''); return Number.isFinite(n) ? n : -Infinity }
  // the newer of the two stamps: a probe that answered nothing an hour ago is
  // due again, and one that answered nothing a second ago is not
  const at = Math.max(ms(entry.observed_at), ms(entry.attempted_at))
  return !Number.isFinite(at) || Date.now() - at >= CACHE_MS
}

// Runs the probe and caches what it prints. Never throws: an agent that is not
// installed, is not logged in, or hangs leaves the cache exactly as it was.
export function refreshModels(agent) {
  const probe = PROBES[agent]
  if (!probe) return Promise.resolve(readCache(agent)?.models ?? [])
  if (inFlight.has(agent)) return inFlight.get(agent)
  const run = new Promise((resolve) => {
    let spec
    try { spec = probeArgv(probe) } catch { resolve(readCache(agent)?.models ?? []); return }
    execFile(spec.bin, spec.args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20 }, (_err, stdout) => {
      // a non-zero exit still prints the list when the CLI is only
      // unauthenticated (grok says so and lists anyway), so stdout is parsed
      // before the exit code is believed
      const models = probe.parse(stdout ?? '')
      const prev = readCache(agent)
      // a fruitless probe is still an answer about this machine: it is stamped
      // so the next request is served from here instead of spawning again, and
      // the last list Leg did see is kept until a probe supersedes it
      if (models.length) writeCache(agent, models)
      else writeCache(agent, prev?.models ?? [], { observedAt: prev?.observed_at ?? null })
      resolve(models.length ? models : (prev?.models ?? []))
    })
  }).finally(() => inFlight.delete(agent))
  inFlight.set(agent, run)
  return run
}

// The cached answer, with a refresh kicked off behind it when it is stale.
// Synchronous on purpose: no board request waits on a child process.
function cachedModels(agent) {
  const entry = readCache(agent)
  if (stale(entry)) refreshModels(agent).catch(() => {})
  return entry?.models ?? []
}

// ---- the catalog ------------------------------------------------------------

// Every model this machine can start `agent` on, strongest or default first as
// that agent's own source orders them. An empty list is an honest answer: it
// means Leg could not read a catalog, and the caller offers "provider default".
export function modelsFor(agent) {
  if (agent === 'claude') return claudeModels()
  if (agent === 'codex') return codexModels()
  if (agent === 'agy' || agent === 'grok') return cachedModels(agent)
  return []
}

export function listModels() {
  const models = {}
  for (const agent of MODEL_AGENTS) models[agent] = modelsFor(agent)
  return { models, observed_at: new Date().toISOString() }
}

// The model a bare `leg <agent>` would run, or null when the agent picks for
// itself. Used to label the first option of a model select.
export function defaultModelFor(agent) {
  return modelsFor(agent).find((m) => m.default)?.id ?? null
}
