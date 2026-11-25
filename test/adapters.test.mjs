import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome } from './helpers.mjs'

// names() also reports the custom specs in $LEG_HOME/adapters, so this file
// gets a home of its own: without it the suite asserted against whatever
// adapters the developer happened to have installed.
process.env.BATON_HOME = makeHome()

const { get: getAdapter, names, BUILTIN_NAMES } = await import('../src/adapters/index.mjs')

const REAL = ['claude', 'codex', 'agy', 'grok']
const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--always-approve']

test('registry lists fake plus every probed CLI, grok included', async () => {
  assert.deepEqual(BUILTIN_NAMES, ['fake', 'fake-claude', 'fake-codex', 'fake-agy', 'fake-nostdin', ...REAL])
  // an empty home has no custom specs, so the two lists agree
  assert.deepEqual(names(), BUILTIN_NAMES)
  await assert.rejects(getAdapter('muse'), /unknown adapter: muse/)
})

const load = (name) => getAdapter(name)

for (const name of REAL) {
  test(`${name}: common export shape and argv in default mode`, async () => {
    const a = await load(name)
    assert.equal(a.name, name)
    assert.ok(['pipe', 'ignore'].includes(a.stdin))
    assert.ok(a.modes.allowed.includes(a.modes.default))
    assert.ok(Array.isArray(a.forbiddenFlags) && a.forbiddenFlags.length > 0)
    const spec = a.argv({ prompt: 'hi', cwd: process.cwd(), runDir: process.cwd(), killMs: 60000 })
    assert.ok(typeof spec.bin === 'string' && spec.bin.length > 0)
    assert.ok(Array.isArray(spec.args))
    const joined = spec.args.join(' ')
    for (const f of FORBIDDEN_FLAGS) assert.ok(!joined.includes(f), `${name} argv must not carry ${f}`)
    assert.ok(!joined.includes('bypassPermissions'))
    assert.ok(!joined.includes('danger-full-access'))
    assert.ok(!/--disallowedTools\s+\S*Agent/.test(joined), 'never disallow the Agent tool')
    const env = a.env({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', PATH: 'p' })
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0')
    assert.equal(env.PATH, 'p')
  })

  test(`${name}: argv throws "forbidden flag" for a disallowed mode and for a smuggled flag`, async () => {
    const a = await load(name)
    const badMode = { claude: 'bypassPermissions', codex: 'danger-full-access', agy: 'yolo', grok: 'bypassPermissions' }[name]
    assert.throws(() => a.argv({ prompt: 'hi', mode: badMode }), /forbidden flag/)
    for (const flag of a.forbiddenFlags.filter((f) => f.startsWith('--'))) {
      assert.throws(() => a.argv({ prompt: 'hi', extraArgs: [flag] }), /forbidden flag/, `${name} must refuse ${flag}`)
    }
    for (const mode of a.modes.allowed) {
      assert.doesNotThrow(() => a.argv({ prompt: 'hi', mode }))
    }
  })
}

test('codex: stdin is ignore, -C points at cwd, network off, prompt last', async () => {
  const a = await getAdapter('codex')
  assert.equal(a.stdin, 'ignore')
  const { args } = a.argv({ prompt: 'do it', cwd: 'C:\\wt', runDir: 'C:\\run' })
  const i = args.indexOf('-C')
  assert.equal(args[i + 1], 'C:\\wt')
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'))
  assert.equal(args[args.length - 1], 'do it')
  assert.deepEqual(args.slice(args.indexOf('exec'), args.indexOf('exec') + 4), ['exec', '--json', '-s', 'workspace-write'])
})

test('claude: stdin is pipe, argv carries -p json and the mode, never --allowedTools by default', async () => {
  const a = await getAdapter('claude')
  assert.equal(a.stdin, 'pipe')
  const { args } = a.argv({ prompt: 'x', maxTurns: 2, resume: 'sess-1' })
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'])
  assert.ok(args.includes('--max-turns') && args.includes('2'))
  assert.ok(args.includes('--resume') && args.includes('sess-1'))
  assert.ok(!args.includes('--allowedTools'))
})

test('agy: print timeout follows the kill timer in Go duration syntax', async () => {
  const a = await getAdapter('agy')
  const { args } = a.argv({ prompt: 'x', killMs: 5400000 })
  assert.equal(args[args.indexOf('--print-timeout') + 1], '90m')
  assert.equal(a.argv({ prompt: 'x', killMs: 90000 }).args.at(-1), '90s')
})

test('grok: prompt goes by file when the runner wrote one, --cwd names the worktree', async () => {
  const a = await getAdapter('grok')
  assert.equal(a.stdin, 'ignore')
  const { args } = a.argv({ prompt: 'do it', promptFile: 'C:\\run\\prompt.txt', cwd: 'C:\\wt', resume: 's1' })
  assert.deepEqual(args.slice(0, 2), ['--prompt-file', 'C:\\run\\prompt.txt'])
  assert.ok(!args.includes('-p'), 'the prompt is never also passed on argv')
  assert.equal(args[args.indexOf('--cwd') + 1], 'C:\\wt')
  assert.deepEqual(args.slice(2, 6), ['--output-format', 'json', '--permission-mode', 'acceptEdits'])
  assert.equal(args[args.indexOf('-r') + 1], 's1')
  // no prompt file (a direct call): the prompt falls back to argv
  assert.deepEqual(a.argv({ prompt: 'do it', cwd: 'C:\\wt' }).args.slice(0, 2), ['-p', 'do it'])
})

test('grok: parseResult reads the result envelope and the live 402 error envelope', async () => {
  const a = await getAdapter('grok')
  const ok = a.parseResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'g1', result: 'Done.', num_turns: 3, stop_reason: 'end_turn' }))
  assert.equal(ok.session_id, 'g1')
  assert.equal(ok.last_message, 'Done.')
  assert.equal(ok.stop_reason, 'end_turn')
  assert.equal(ok.is_error, false)
  assert.equal(ok.num_turns, 3)
  // observed live 2026-09-17 on an account with no balance left
  const err = a.parseResult('{"type":"error","message":"Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted"}')
  assert.equal(err.is_error, true)
  assert.equal(err.stop_reason, 'error')
  assert.match(err.last_message, /usage balance exhausted/)
  assert.equal(a.parseResult('not json'), null)
})

test('parseResult: claude json, codex jsonl', async () => {
  const claude = await getAdapter('claude')
  const c = claude.parseResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 's1', result: 'Done.', num_turns: 2, permission_denials: [] }))
  assert.equal(c.session_id, 's1')
  assert.equal(c.last_message, 'Done.')
  assert.equal(c.stop_reason, 'end_turn')
  assert.equal(c.permission_denials, 0)
  assert.equal(claude.parseResult('not json'), null)
  const codex = await getAdapter('codex')
  const x = codex.parseResult([
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'notice' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n'))
  assert.equal(x.session_id, 't1')
  assert.equal(x.last_message, 'last')
  assert.equal(x.stop_reason, 'turn.completed')
  assert.deepEqual(x.errors, ['notice'])
  assert.equal(codex.parseResult(''), null)
})

// ---- onPath: what a shell-less spawn would actually run --------------------
// Leg spawns every agent without a shell. On Windows that means libuv's own
// search (the cwd, then each PATH entry; the name as given only when it has an
// extension, then .com, then .exe), and a claude.cmd shim on PATH is not
// something it can start. The platform is injected so both rules run on every
// OS; the files are real.
test('onPath on win32 finds x.com and x.exe, never x.cmd or x.ps1, honours quoted entries, else null', async () => {
  const { onPath } = await import('../src/adapters/common.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'leg-onpath-win-'))
  const [cwd, shims, exes, coms, spaced] = ['cwd', 'shims', 'exes', 'coms', 'with space'].map((d) => { mkdirSync(join(root, d)); return join(root, d) })
  writeFileSync(join(shims, 'x.cmd'), '@echo off\n')
  writeFileSync(join(shims, 'x.ps1'), '\n')
  writeFileSync(join(shims, 'x'), '#!/bin/sh\n')
  writeFileSync(join(exes, 'x.exe'), '')
  writeFileSync(join(coms, 'x.com'), '')
  writeFileSync(join(coms, 'x.exe'), '')
  mkdirSync(join(exes, 'y.exe'))
  writeFileSync(join(spaced, 'q.exe'), '')
  const win = (PATH) => ({ env: { PATH }, platform: 'win32', cwd })
  assert.equal(onPath('x', win(shims)), null, 'a .cmd, a .ps1 and an extensionless script are not runnable without a shell')
  assert.equal(onPath('x', win([shims, exes].join(';'))), join(exes, 'x.exe'))
  assert.equal(onPath('x', win([coms, exes].join(';'))), join(coms, 'x.com'), '.com is tried before .exe')
  assert.equal(onPath('q', win(`${shims};"${spaced}"`)), join(spaced, 'q.exe'), 'a quoted entry is unquoted')
  assert.equal(onPath('y', win(exes)), null, 'a directory named y.exe is not a program')
  assert.equal(onPath('x.cmd', win(exes)), null)
  assert.equal(onPath('x.exe', win(exes)), join(exes, 'x.exe'), 'a name with an extension is tried as given')
  assert.equal(onPath('x', { env: { Path: exes }, platform: 'win32', cwd }), join(exes, 'x.exe'), 'Windows spells it Path as often as PATH')
  writeFileSync(join(cwd, 'x.exe'), '')
  assert.equal(onPath('x', win(coms)), join(cwd, 'x.exe'), 'the cwd is searched first')
  assert.equal(onPath('nothing', win([shims, exes, coms].join(';'))), null)
})

test('onPath on POSIX wants a regular file with the execute bit', { skip: process.platform === 'win32' ? 'Windows has no execute bit: every file passes X_OK there, so the case cannot fail on this OS' : false }, async () => {
  const { onPath } = await import('../src/adapters/common.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'leg-onpath-posix-'))
  const [a, b] = ['a', 'b'].map((d) => { mkdirSync(join(root, d)); return join(root, d) })
  writeFileSync(join(a, 'x'), '#!/bin/sh\n')
  chmodSync(join(a, 'x'), 0o644)
  mkdirSync(join(a, 'y'))
  const posix = { env: { PATH: [a, b].join(':') }, platform: 'linux', cwd: root }
  assert.equal(onPath('x', posix), null, 'not executable')
  assert.equal(onPath('y', posix), null, 'a directory')
  writeFileSync(join(b, 'x'), '#!/bin/sh\n')
  chmodSync(join(b, 'x'), 0o755)
  assert.equal(onPath('x', posix), join(b, 'x'))
})

// Claude Code installed with npm on Windows leaves claude, claude.cmd and
// claude.ps1 on PATH, none of which a shell-less spawn can run, and the real
// program at node_modules/@anthropic-ai/claude-code/bin/claude.exe: that
// package's "bin" is {"claude": "bin/claude.exe"} (read from a real install of
// 2.1.332 on 2026-11-25). The fixture below is that layout, under APPDATA.
test('claude resolve() on Windows falls back to the npm package\'s claude.exe when PATH holds only the shims', { skip: process.platform === 'win32' ? false : 'resolve() reads process.platform, and the npm fallback exists only on Windows; POSIX npm puts a runnable claude symlink on PATH' }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'leg-claude-npm-'))
  const prefix = join(root, 'appdata', 'npm')
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.332', bin: { claude: 'bin/claude.exe' } }))
  for (const shim of ['claude', 'claude.cmd', 'claude.ps1']) writeFileSync(join(prefix, shim), '')
  const exe = join(pkg, 'bin', 'claude.exe')
  const keys = ['APPDATA', 'USERPROFILE', 'HOME', 'PATH', 'LEG_CLAUDE_BIN', 'BATON_CLAUDE_BIN']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    process.env.APPDATA = join(root, 'appdata')
    process.env.USERPROFILE = join(root, 'home') // no ~/.local/bin/claude.exe
    process.env.HOME = join(root, 'home')
    process.env.PATH = prefix
    delete process.env.LEG_CLAUDE_BIN
    delete process.env.BATON_CLAUDE_BIN
    const claude = (await import('../src/adapters/claude.mjs')).default
    // the package is there but its postinstall never ran: no claude.exe yet
    assert.deepEqual(claude.resolve(), { bin: 'claude', viaNode: false, entry: null }, 'a bin path that does not exist is not returned')
    writeFileSync(exe, '')
    assert.deepEqual(claude.resolve(), { bin: exe, viaNode: false, entry: null })
    assert.equal(claude.argv({ prompt: 'x' }).bin, exe, 'the headless leg spawns it directly')
    // a claude.exe on PATH wins over the npm package, as it would for a shell
    const elsewhere = join(root, 'bin'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'claude.exe'), '')
    process.env.PATH = `${elsewhere};${prefix}`
    assert.equal(claude.resolve().bin, 'claude')
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
})
