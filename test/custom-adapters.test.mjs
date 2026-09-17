// Custom adapters: any CLI as a card agent, from a JSON spec on disk.
// The spec surface is the whole contract, so every rule in it is pinned here —
// a spec that could smuggle a bypass flag, lose the prompt, or name a built-in
// is the failure mode this file exists to stop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, licenseHome, testEnv, LEG } from './helpers.mjs'
import { execFileSync } from 'node:child_process'
import {
  validateSpec, makeAdapter, listSpecs, SpecError, NEVER_ALLOWED, TEMPLATE, adaptersDir,
} from '../src/adapters/custom.mjs'

const BUILTINS = ['fake', 'claude', 'codex', 'agy', 'grok']

const base = {
  name: 'muse',
  bin: 'muse',
  args: ['run', '--json', ['--dir', '{{cwd}}'], ['--model', '{{model}}'], '{{prompt}}'],
  modes: { default: 'auto', allowed: ['auto', 'readonly'] },
  result: { format: 'json', sessionId: 'session_id', message: 'result', stopReason: 'stop_reason' },
}

test('a minimal spec becomes an adapter with the shape every caller expects', () => {
  const a = makeAdapter(validateSpec(base))
  assert.equal(a.name, 'muse')
  assert.equal(a.stdin, 'ignore')
  assert.equal(a.custom, true)
  assert.equal(a.modes.default, 'auto')
  assert.equal(typeof a.argv, 'function')
  assert.equal(typeof a.parseResult, 'function')
  assert.equal(a.env({ OPENAI_API_KEY: 'x', PATH: 'p' }).OPENAI_API_KEY, undefined)
})

test('a group is dropped when a placeholder inside it is unset, kept when it resolves', () => {
  const a = makeAdapter(validateSpec(base))
  assert.deepEqual(a.argv({ prompt: 'do it', cwd: 'C:\\wt', model: 'm1' }).args,
    ['run', '--json', '--dir', 'C:\\wt', '--model', 'm1', 'do it'])
  // no model: the whole ["--model", "{{model}}"] group goes, never a bare --model
  assert.deepEqual(a.argv({ prompt: 'do it', cwd: 'C:\\wt' }).args,
    ['run', '--json', '--dir', 'C:\\wt', 'do it'])
})

test('every placeholder resolves from the opts the runner passes', () => {
  const spec = validateSpec({
    ...base,
    args: ['{{prompt}}', ['--file', '{{promptFile}}'], ['--cwd', '{{cwd}}'], ['--mode', '{{mode}}'],
      ['--turns', '{{maxTurns}}'], ['--resume', '{{resume}}'], ['--out', '{{runDir}}']],
  })
  const { args } = makeAdapter(spec).argv({
    prompt: 'p', promptFile: 'C:\\r\\prompt.txt', cwd: 'C:\\wt', mode: 'readonly',
    maxTurns: 4, resume: 's1', runDir: 'C:\\r',
  })
  assert.deepEqual(args, ['p', '--file', 'C:\\r\\prompt.txt', '--cwd', 'C:\\wt', '--mode', 'readonly',
    '--turns', '4', '--resume', 's1', '--out', 'C:\\r'])
})

test('a mode outside modes.allowed is refused before anything spawns', () => {
  const a = makeAdapter(validateSpec(base))
  assert.throws(() => a.argv({ prompt: 'x', mode: 'wideopen' }), /forbidden flag/)
  for (const m of ['auto', 'readonly']) assert.doesNotThrow(() => a.argv({ prompt: 'x', mode: m }))
})

test('the never-allowed flags are refused in args, in modes, and at argv time', () => {
  for (const flag of NEVER_ALLOWED) {
    assert.throws(() => validateSpec({ ...base, args: ['run', flag, '{{prompt}}'] }), SpecError,
      `a spec must not be able to install ${flag}`)
  }
  assert.throws(() => validateSpec({ ...base, modes: { default: '--yolo', allowed: ['--yolo'] } }), SpecError)
  // and a chain entry cannot smuggle one past a clean spec either
  const a = makeAdapter(validateSpec(base))
  for (const flag of ['--yolo', '--dangerously-skip-permissions', '--full-auto']) {
    assert.throws(() => a.argv({ prompt: 'x', extraArgs: [flag] }), /forbidden flag/)
  }
})

test('a spec that loses the prompt, names a built-in, or shells out is refused with a sentence', () => {
  assert.throws(() => validateSpec({ ...base, args: ['run', '--json'] }), /nothing carries the prompt/)
  // unless it says the prompt goes on stdin
  assert.doesNotThrow(() => validateSpec({ ...base, stdin: 'pipe', args: ['run', '--json'] }))
  assert.throws(() => validateSpec({ ...base, name: 'claude' }, { reserved: BUILTINS }), /built-in adapter/)
  assert.throws(() => validateSpec({ ...base, bin: 'muse | tee log' }), /never through a shell/)
  assert.throws(() => validateSpec({ ...base, name: 'Muse!' }), /lowercase letters/)
  assert.throws(() => validateSpec({ ...base, args: ['{{prompt}}', '{{nope}}'] }), /unknown placeholder/)
  assert.throws(() => validateSpec({ ...base, args: [{ x: 1 }] }), /must be a string or an array/)
  assert.throws(() => validateSpec({ ...base, modes: { default: 'nope', allowed: ['auto'] } }), /is not in modes.allowed/)
  assert.throws(() => validateSpec({ ...base, result: { format: 'yaml' } }), /result.format is one of/)
  assert.throws(() => validateSpec({ ...base, stdin: 'inherit' }), /"pipe" or "ignore"/)
  assert.throws(() => validateSpec(null), /a spec is a JSON object/)
})

test('parseResult: json, jsonl and text, with dotted paths', () => {
  const j = makeAdapter(validateSpec(base))
  const r = j.parseResult('a warning line\n{"session_id":"s9","result":"done","stop_reason":"end"}')
  assert.equal(r.session_id, 's9')
  assert.equal(r.last_message, 'done')
  assert.equal(r.stop_reason, 'end')
  assert.equal(j.parseResult('nothing parseable'), null)

  const dotted = makeAdapter(validateSpec({ ...base, result: { format: 'jsonl', sessionId: 'thread.id', message: 'item.text', stopReason: 'state' } }))
  const l = dotted.parseResult([
    JSON.stringify({ thread: { id: 't1' } }),
    JSON.stringify({ item: { text: 'first' } }),
    JSON.stringify({ item: { text: 'last' }, state: 'ok' }),
    JSON.stringify({ state: 'ok' }),
  ].join('\n'))
  // the last line carrying a message wins, not the last line
  assert.equal(l.last_message, 'last')
  assert.equal(l.stop_reason, 'ok')
  assert.equal(dotted.parseResult(''), null)

  const text = makeAdapter(validateSpec({ ...base, result: { format: 'text' } }))
  assert.equal(text.parseResult('{"result":"done"}'), null, 'format text never parses; the DONE marker and the diff judge the leg')
})

test('the shipped template is a valid spec', () => {
  assert.doesNotThrow(() => validateSpec(TEMPLATE))
})

test('listSpecs reports a broken file instead of throwing, so one typo cannot stop the board', () => {
  const home = makeHome()
  const prev = process.env.LEG_HOME
  process.env.LEG_HOME = home
  try {
    mkdirSync(adaptersDir(), { recursive: true })
    writeFileSync(join(adaptersDir(), 'good.json'), JSON.stringify({ ...base, name: 'good' }))
    writeFileSync(join(adaptersDir(), 'bad.json'), '{ not json')
    writeFileSync(join(adaptersDir(), 'mismatch.json'), JSON.stringify({ ...base, name: 'other' }))
    const specs = listSpecs({ reserved: BUILTINS })
    assert.deepEqual(specs.map((s) => s.name), ['bad', 'good', 'mismatch'])
    assert.equal(specs.find((s) => s.name === 'good').error, null)
    assert.match(specs.find((s) => s.name === 'bad').error, /JSON/)
    assert.match(specs.find((s) => s.name === 'mismatch').error, /does not match the file name/)
    assert.equal(specs.filter((s) => s.adapter).length, 1)
  } finally {
    if (prev === undefined) delete process.env.LEG_HOME; else process.env.LEG_HOME = prev
  }
})

test('the spec cache still notices a spec appearing and disappearing', async () => {
  const home = makeHome()
  const prev = process.env.LEG_HOME
  process.env.LEG_HOME = home
  try {
    const { names, BUILTIN_NAMES } = await import('../src/adapters/index.mjs')
    const extra = () => names().filter((n) => !BUILTIN_NAMES.includes(n))
    mkdirSync(adaptersDir(), { recursive: true })
    assert.deepEqual(extra(), [])
    // names() is cached against the directory's mtime because /api/health calls
    // it once per adapter; a spec added must still show up without a restart
    writeFileSync(join(adaptersDir(), 'amp.json'), JSON.stringify({ ...base, name: 'amp' }))
    assert.deepEqual(extra(), ['amp'])
    rmSync(join(adaptersDir(), 'amp.json'))
    assert.deepEqual(extra(), [])
  } finally {
    if (prev === undefined) delete process.env.LEG_HOME; else process.env.LEG_HOME = prev
  }
})

test('a spec with no name takes it from the file name', () => {
  const home = makeHome()
  const prev = process.env.LEG_HOME
  process.env.LEG_HOME = home
  try {
    mkdirSync(adaptersDir(), { recursive: true })
    const { name, ...noName } = base
    void name
    writeFileSync(join(adaptersDir(), 'amp.json'), JSON.stringify(noName))
    const specs = listSpecs({ reserved: BUILTINS })
    assert.equal(specs[0].name, 'amp')
    assert.equal(specs[0].error, null)
  } finally {
    if (prev === undefined) delete process.env.LEG_HOME; else process.env.LEG_HOME = prev
  }
})

// The CLI seam, spawned the way a human runs it.
test('leg adapter add | list | check | show | rm, end to end', () => {
  const home = licenseHome(makeHome())
  const env = testEnv(home)
  const run = (...argv) => execFileSync(process.execPath, [LEG, 'adapter', ...argv], { encoding: 'utf8', env })

  const specFile = join(home, 'muse-spec.json')
  writeFileSync(specFile, JSON.stringify(base))

  const added = run('add', specFile)
  assert.match(added, /added muse/)
  assert.ok(existsSync(join(home, 'adapters', 'muse.json')), 'the spec lands in $LEG_HOME/adapters')

  const listed = run('list')
  assert.match(listed, /muse/)
  assert.match(listed, /grok/, 'built-ins are listed beside custom ones')

  const checked = run('check', 'muse', '--cwd', 'C:\\wt')
  assert.match(checked, /custom spec/)
  assert.match(checked, /--dir C:\\wt/)

  const shown = JSON.parse(run('show', 'muse'))
  assert.equal(shown.name, 'muse')
  // the never-allowed list is merged in on save, not only at argv time
  assert.ok(shown.forbiddenFlags.includes('--yolo'))

  const removed = run('rm', 'muse')
  assert.match(removed, /removed muse/)
  assert.equal(existsSync(join(home, 'adapters', 'muse.json')), false)
})

test('leg adapter add refuses a spec that names a built-in, with exit 2', () => {
  const home = licenseHome(makeHome())
  const env = testEnv(home)
  const specFile = join(home, 'bad.json')
  writeFileSync(specFile, JSON.stringify({ ...base, name: 'codex' }))
  let code = 0
  let stderr = ''
  try {
    execFileSync(process.execPath, [LEG, 'adapter', 'add', specFile], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) { code = err.status; stderr = String(err.stderr) }
  assert.equal(code, 2)
  assert.match(stderr, /built-in adapter/)
})
