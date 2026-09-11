import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get as getAdapter, names } from '../src/adapters/index.mjs'

const REAL = ['claude', 'codex', 'agy']
const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--always-approve']

test('registry lists fake plus every probed CLI; grok stays out until it is verified live', async () => {
  assert.deepEqual(names(), ['fake', 'fake-claude', 'fake-codex', 'fake-agy', 'fake-nostdin', ...REAL])
  await assert.rejects(getAdapter('grok'), /unknown adapter: grok/)
})

// grok.mjs is unit-tested through the shape/guard loops below even though it
// is unregistered, so registering it later needs no new tests.
const grokModule = (await import('../src/adapters/grok.mjs')).default
const load = (name) => (name === 'grok' ? Promise.resolve(grokModule) : getAdapter(name))

for (const name of [...REAL, 'grok']) {
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
