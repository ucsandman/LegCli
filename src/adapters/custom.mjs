// custom adapters — any coding-agent CLI becomes a Leg adapter through a JSON
// spec in $LEG_HOME/adapters/<name>.json, with no code in this package.
//
// This is what makes the chain open-ended: claude, codex, agy and grok ship
// with taps and a probe, and anything else (Muse, Amp, aider, a house script)
// joins as "argv in, JSON out". A custom adapter is a CARD adapter: it runs
// headless in a worktree and hands off like any other leg. It is not an
// interactive `leg <agent>` terminal, because that needs a usage tap and a
// wall signal that only the four supervised CLIs expose.
//
// Spec:
//   {
//     "name": "muse",
//     "bin": "muse",                        // argv[0]; never a shell string
//     "stdin": "ignore",                    // "pipe" sends the prompt on stdin
//     "args": ["run", "--json",
//              ["--dir", "{{cwd}}"],        // a group is dropped when a
//              ["--model", "{{model}}"],    //   placeholder inside it is unset
//              "{{prompt}}"],
//     "modes": { "default": "auto", "allowed": ["auto", "readonly"] },
//     "forbiddenFlags": ["--yolo"],
//     "result": { "format": "json", "sessionId": "session_id",
//                 "message": "result", "stopReason": "stop_reason" }
//   }
//
// Placeholders: {{prompt}} {{promptFile}} {{cwd}} {{mode}} {{model}}
// {{resume}} {{maxTurns}} {{runDir}}. A bare string is always kept, so put
// anything optional in a group.
//
// result.format: "json" (first parseable object in stdout), "jsonl" (the last
// line that carries the message field) or "text" (no parsing; the leg is then
// judged by its .leg/DONE marker and its diff, as every adapter is when
// parseResult returns null). sessionId/message/stopReason are dotted paths.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from '../store.mjs'
import { sanitizeEnv } from '../env.mjs'
import { assertAllowed } from './common.mjs'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/
export const PLACEHOLDERS = ['prompt', 'promptFile', 'cwd', 'mode', 'model', 'resume', 'maxTurns', 'runDir']
export const FORMATS = ['json', 'jsonl', 'text']

// Never allowed in a spec, whoever wrote it: these are the flags that turn a
// supervised agent into an unsupervised one, and Leg's whole permission story
// is that no adapter passes them. The same list the built-ins are tested for.
export const NEVER_ALLOWED = [
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', // not allowed
  '--dangerously-bypass-approvals-and-sandbox', '--dangerous-mode', // not allowed
  '--yolo', '--always-approve', '--full-auto', '--approve-for-me', // not allowed
  'bypassPermissions', 'danger-full-access', // not allowed
]

export class SpecError extends Error {
  constructor(msg) { super(msg); this.name = 'SpecError' }
}

export function adaptersDir() { return join(home(), 'adapters') }
export function specPath(name) { return join(adaptersDir(), `${name}.json`) }

function str(v) { return typeof v === 'string' ? v : null }

// Throws SpecError with a sentence naming the field. Returns the normalized spec.
export function validateSpec(raw, { reserved = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SpecError('a spec is a JSON object')
  const name = str(raw.name)
  if (!name || !NAME_RE.test(name)) throw new SpecError(`name "${raw.name ?? ''}": lowercase letters, digits, dash and underscore, up to 30 characters`)
  if (reserved.includes(name)) throw new SpecError(`"${name}" is a built-in adapter; choose another name`)
  const bin = str(raw.bin)
  if (!bin) throw new SpecError(`${name}: "bin" must be the executable to run (argv[0]), not a shell command line`)
  if (/[<>|&;]/.test(bin)) throw new SpecError(`${name}: "bin" is spawned directly, never through a shell, so it cannot contain < > | & or ;`)
  const stdin = raw.stdin ?? 'ignore'
  if (!['pipe', 'ignore'].includes(stdin)) throw new SpecError(`${name}: "stdin" is "pipe" or "ignore"`)
  if (!Array.isArray(raw.args)) throw new SpecError(`${name}: "args" must be an array of strings and groups`)

  const flat = []
  const args = raw.args.map((entry, i) => {
    if (typeof entry === 'string') { flat.push(entry); return entry }
    if (Array.isArray(entry) && entry.every((x) => typeof x === 'string')) { flat.push(...entry); return [...entry] }
    throw new SpecError(`${name}: args[${i}] must be a string or an array of strings`)
  })
  for (const piece of flat) {
    for (const [, key] of piece.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) {
      if (!PLACEHOLDERS.includes(key)) throw new SpecError(`${name}: unknown placeholder {{${key}}} (known: ${PLACEHOLDERS.join(', ')})`)
    }
    const banned = NEVER_ALLOWED.find((f) => piece === f || piece.startsWith(`${f}=`) || piece.endsWith(`=${f}`))
    if (banned) throw new SpecError(`${name}: args carry ${banned}, which no Leg adapter may pass`)
  }
  const usesPrompt = flat.some((p) => p.includes('{{prompt}}') || p.includes('{{promptFile}}'))
  if (stdin !== 'pipe' && !usesPrompt) throw new SpecError(`${name}: nothing carries the prompt — put {{prompt}} or {{promptFile}} in args, or set "stdin": "pipe"`)

  const modes = raw.modes ?? {}
  const allowed = Array.isArray(modes.allowed) && modes.allowed.length ? modes.allowed.map(String) : ['default']
  const def = str(modes.default) ?? allowed[0]
  if (!allowed.includes(def)) throw new SpecError(`${name}: modes.default "${def}" is not in modes.allowed (${allowed.join(', ')})`)
  for (const m of allowed) if (NEVER_ALLOWED.includes(m)) throw new SpecError(`${name}: mode "${m}" is never allowed`)

  const forbidden = Array.isArray(raw.forbiddenFlags) ? raw.forbiddenFlags.map(String) : []
  const result = raw.result ?? {}
  const format = str(result.format) ?? 'json'
  if (!FORMATS.includes(format)) throw new SpecError(`${name}: result.format is one of ${FORMATS.join(', ')}`)

  return {
    name,
    bin,
    stdin,
    args,
    modes: { default: def, allowed },
    // the never-allowed list is refused on top of whatever the spec adds
    forbiddenFlags: [...new Set([...forbidden, ...NEVER_ALLOWED])],
    result: {
      format,
      sessionId: str(result.sessionId) ?? 'session_id',
      message: str(result.message) ?? 'result',
      stopReason: str(result.stopReason) ?? 'stop_reason',
    },
  }
}

function dig(obj, path) {
  let cur = obj
  for (const key of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return null
    cur = cur[key]
  }
  return cur ?? null
}

function fill(piece, values) {
  return piece.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key) => (values[key] === undefined || values[key] === null ? '' : String(values[key])))
}

function hasUnset(piece, values) {
  for (const [, key] of piece.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) {
    const v = values[key]
    if (v === undefined || v === null || v === '') return true
  }
  return false
}

// spec → the adapter object every other module expects (see common.mjs).
export function makeAdapter(spec) {
  const adapter = {
    name: spec.name,
    stdin: spec.stdin,
    modes: spec.modes,
    forbiddenFlags: spec.forbiddenFlags,
    custom: true,
    spec,
    resolve() {
      const override = process.env[`LEG_${spec.name.toUpperCase().replace(/-/g, '_')}_BIN`]
      const bin = override || spec.bin
      return { bin, viaNode: /\.(mjs|cjs|js)$/.test(bin), entry: null }
    },
    argv(opts = {}) {
      const mode = assertAllowed(adapter, opts)
      const { bin, viaNode } = adapter.resolve()
      const values = {
        prompt: opts.prompt ?? '',
        promptFile: opts.promptFile ?? null,
        cwd: opts.cwd ?? process.cwd(),
        mode,
        model: opts.model ?? null,
        resume: opts.resume ?? null,
        maxTurns: opts.maxTurns ?? null,
        runDir: opts.runDir ?? null,
      }
      const args = []
      for (const entry of spec.args) {
        if (typeof entry === 'string') { args.push(fill(entry, values)); continue }
        // a group survives only when every placeholder in it resolved
        if (entry.some((piece) => hasUnset(piece, values))) continue
        for (const piece of entry) args.push(fill(piece, values))
      }
      return viaNode ? { bin: process.execPath, args: [bin, ...args] } : { bin, args }
    },
    env(base) { return sanitizeEnv(base) },
    parseResult(text) {
      const s = String(text)
      if (spec.result.format === 'text') return null
      const shape = (j) => ({
        session_id: dig(j, spec.result.sessionId),
        last_message: typeof dig(j, spec.result.message) === 'string' ? dig(j, spec.result.message) : null,
        stop_reason: dig(j, spec.result.stopReason),
        raw: j,
      })
      if (spec.result.format === 'jsonl') {
        const objs = []
        for (const line of s.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('{')) continue
          try { objs.push(JSON.parse(t)) } catch { continue }
        }
        if (!objs.length) return null
        // the last line that actually carries a message, else the last line
        const withMsg = objs.filter((j) => typeof dig(j, spec.result.message) === 'string')
        return shape(withMsg.length ? withMsg[withMsg.length - 1] : objs[objs.length - 1])
      }
      for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
        try {
          const j = JSON.parse(s.slice(i))
          if (j && typeof j === 'object') return shape(j)
        } catch { continue }
      }
      return null
    },
  }
  return adapter
}

// names() is on the board's hot path — /api/health asks every adapter where
// its binary is, which called this once for the list and once per custom
// adapter — so the parsed result is cached against the spec directory's mtime
// and a one-second floor. A spec added or removed changes the directory mtime
// and is picked up at once; a spec edited in place lands within the second.
// Without this, one board poll was a readdir plus a readFile and a JSON.parse
// per spec, on the same event loop the terminals lane is pushed from.
// The key is the directory listing itself, not its mtime: one readdir is a
// single cheap syscall, and a directory's mtime is too coarse on Windows to
// notice a spec added in the same tick as the last read. So a spec appearing
// or disappearing is seen at once, and only a spec edited in place waits out
// the one-second floor.
const SPEC_TTL_MS = 1000
let specCache = { key: null, at: 0, specs: null }

export function clearSpecCache() { specCache = { key: null, at: 0, specs: null } }

// Every spec on disk. A broken file is reported, never thrown, so one bad spec
// cannot stop the board, the scheduler or `leg card add`.
// → [{ name, spec, adapter, file, error }]
export function listSpecs({ reserved = [] } = {}) {
  const dir = adaptersDir()
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).sort().filter((f) => f.endsWith('.json'))
  const key = `${dir}|${reserved.join(',')}|${files.join(',')}`
  if (specCache.specs && specCache.key === key && Date.now() - specCache.at < SPEC_TTL_MS) return specCache.specs
  const out = []
  for (const file of files) {
    const full = join(dir, file)
    const stem = file.slice(0, -5)
    try {
      const raw = JSON.parse(readFileSync(full, 'utf8'))
      if (raw && typeof raw === 'object' && raw.name === undefined) raw.name = stem
      const spec = validateSpec(raw, { reserved })
      if (spec.name !== stem) throw new SpecError(`name "${spec.name}" does not match the file name ${file}`)
      out.push({ name: spec.name, spec, adapter: makeAdapter(spec), file: full, error: null })
    } catch (err) {
      out.push({ name: stem, spec: null, adapter: null, file: full, error: err.message })
    }
  }
  specCache = { key, at: Date.now(), specs: out }
  return out
}

export function loadSpec(name, { reserved = [] } = {}) {
  const f = specPath(name)
  if (!existsSync(f)) return null
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  if (raw && typeof raw === 'object' && raw.name === undefined) raw.name = name
  return validateSpec(raw, { reserved })
}

export const TEMPLATE = {
  name: 'my-agent',
  bin: 'my-agent',
  stdin: 'ignore',
  args: ['--json', ['--dir', '{{cwd}}'], ['--model', '{{model}}'], ['--resume', '{{resume}}'], '{{prompt}}'],
  modes: { default: 'default', allowed: ['default'] },
  forbiddenFlags: [],
  result: { format: 'json', sessionId: 'session_id', message: 'result', stopReason: 'stop_reason' },
}
