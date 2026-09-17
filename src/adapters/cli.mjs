// `leg adapter …` — the custom-adapter surface. A spec is a JSON file in
// $LEG_HOME/adapters/<name>.json; these verbs write, validate and explain it
// so a bad spec is caught here rather than when a card tries to spawn.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeJsonAtomic } from '../fsx.mjs'
import { BUILTIN_NAMES, customSpecs, get as getAdapter } from './index.mjs'
import { adaptersDir, specPath, validateSpec, makeAdapter, SpecError, TEMPLATE, PLACEHOLDERS } from './custom.mjs'

const USAGE = `usage:
  leg adapter list                       every adapter this machine has, built-in and custom
  leg adapter show <name>                the spec, as JSON
  leg adapter check <name>               validate it and print the command line a leg would run
  leg adapter add <file.json> [--name n] validate a spec and install it
  leg adapter rm <name>                  remove a custom spec
  leg adapter template [--name n]        print a starter spec to fill in`

function quote(a) { return /\s/.test(a) ? JSON.stringify(a) : a }

export async function adapterCommand(verb, args, { out, die }) {
  const first = args._?.[0]

  if (!verb || verb === 'help' || verb === '--help') { out(USAGE); return 0 }

  if (verb === 'list') {
    const specs = customSpecs()
    if (args.json) {
      out(JSON.stringify({
        builtin: BUILTIN_NAMES,
        custom: specs.map((s) => ({ name: s.name, file: s.file, ok: Boolean(s.adapter), error: s.error, bin: s.spec?.bin ?? null })),
      }, null, 2))
      return specs.some((s) => s.error) ? 1 : 0
    }
    out('built-in:')
    for (const n of BUILTIN_NAMES) out(`  ${n}`)
    out(`custom (${adaptersDir()}):`)
    if (!specs.length) out('  none yet — leg adapter template > my-agent.json, then leg adapter add my-agent.json')
    for (const s of specs) {
      out(s.adapter ? `  ${s.name.padEnd(20)} ${s.spec.bin}` : `  ${s.name.padEnd(20)} BROKEN: ${s.error}`)
    }
    return specs.some((s) => s.error) ? 1 : 0
  }

  if (verb === 'template') {
    const spec = { ...TEMPLATE }
    // the common case is that the command is called what the adapter is called
    if (typeof args.name === 'string') { spec.name = args.name; spec.bin = args.name }
    out(JSON.stringify(spec, null, 2))
    return 0
  }

  if (verb === 'show') {
    if (!first) return die(2, 'usage: leg adapter show <name>')
    const hit = customSpecs().find((s) => s.name === first)
    if (!hit) {
      if (BUILTIN_NAMES.includes(first)) return die(2, `${first} is a built-in adapter, not a spec on disk (src/adapters/${first}.mjs)`)
      return die(3, `no custom adapter called "${first}" in ${adaptersDir()}`)
    }
    if (hit.error) return die(1, `${first}: ${hit.error}`)
    out(JSON.stringify(hit.spec, null, 2))
    return 0
  }

  if (verb === 'check') {
    if (!first) return die(2, 'usage: leg adapter check <name>')
    let adapter
    try { adapter = await getAdapter(first) } catch (err) { return die(3, err.message) }
    const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd()
    let spec
    try {
      spec = adapter.argv({
        prompt: 'THE TASK PROMPT',
        promptFile: typeof args['prompt-file'] === 'string' ? args['prompt-file'] : null,
        cwd,
        mode: typeof args.mode === 'string' ? args.mode : undefined,
        model: typeof args.model === 'string' ? args.model : null,
        runDir: null,
        killMs: 5400000,
      })
    } catch (err) { return die(1, `${first}: ${err.message}`) }
    out(`${first}: ${adapter.custom ? 'custom spec' : 'built in'}`)
    out(`  stdin        ${adapter.stdin}`)
    out(`  modes        ${adapter.modes.allowed.join(', ')} (default ${adapter.modes.default})`)
    out(`  would run    ${[spec.bin, ...spec.args].map(quote).join(' ')}`)
    // A spec that names a binary nothing can find spawns once and fails once;
    // saying so here is the difference between a typo and a mystery.
    const bin = spec.bin
    const found = existsSync(bin) || !/[\\/]/.test(bin)
    out(`  binary       ${bin}${existsSync(bin) ? ' (found)' : found ? ' (looked up on PATH at spawn time)' : ' — NOT FOUND at that path'}`)
    return existsSync(bin) || found ? 0 : 1
  }

  if (verb === 'add') {
    if (!first) return die(2, 'usage: leg adapter add <file.json> [--name <name>]')
    const file = resolve(first)
    if (!existsSync(file)) return die(2, `no such file: ${file}`)
    let raw
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return die(2, `${file} is not JSON: ${err.message}`) }
    if (raw && typeof raw === 'object' && typeof args.name === 'string') raw.name = args.name
    let spec
    try { spec = validateSpec(raw, { reserved: BUILTIN_NAMES }) } catch (err) {
      if (err instanceof SpecError) return die(2, err.message)
      throw err
    }
    const dest = specPath(spec.name)
    const replacing = existsSync(dest)
    mkdirSync(adaptersDir(), { recursive: true })
    writeJsonAtomic(dest, spec)
    const adapter = makeAdapter(spec)
    // the runner always writes a prompt file, so the preview shows one too
    const line = adapter.argv({ prompt: 'THE TASK PROMPT', promptFile: '<run>/prompt.txt', cwd: process.cwd() })
    out(`${replacing ? 'replaced' : 'added'} ${spec.name} → ${dest}`)
    out(`  would run  ${[line.bin, ...line.args].map(quote).join(' ')}`)
    out(`  use it     leg card add --repo <path> --task "<t>" --chain ${spec.name},claude --queue`)
    return 0
  }

  if (verb === 'rm' || verb === 'remove') {
    if (!first) return die(2, 'usage: leg adapter rm <name>')
    if (BUILTIN_NAMES.includes(first)) return die(2, `${first} is built in; there is no spec file to remove`)
    const dest = specPath(first)
    if (!existsSync(dest)) return die(3, `no custom adapter called "${first}" in ${adaptersDir()}`)
    rmSync(dest, { force: true })
    out(`removed ${first} (${dest})`)
    out('cards that already name it keep their chain; they will fail to launch until it is added again')
    return 0
  }

  return die(2, `unknown: leg adapter ${verb}\n\n${USAGE}\n\nplaceholders: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}`)
}
