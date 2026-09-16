// One named test per LESSONS.md line that applies to Leg (docs/REUSE.md
// § LESSONS.md). All run without a real CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from '../src/env.mjs'
import { get as getAdapter, names } from '../src/adapters/index.mjs'
import { resolveNpmCliEntry } from '../src/adapters/resolve.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const RUNNER = join(SRC, 'runner.mjs')
const LEDGER = join(SRC, 'ledger.mjs')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(mjs|js)$/.test(name)) out.push(p)
  }
  return out
}
const sourceFiles = () => [...walk(SRC), ...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'scripts'))]
const grep = (re, files = sourceFiles()) => {
  const hits = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`) })
  }
  return hits
}

function makeEnv(root, extra = {}) {
  const env = { ...process.env, BATON_HOME: root, BATON_TIMERS_MS: '60000,120000', FAKE_MODE: 'success', ...extra }
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  return env
}
function makeCard(root, env, adapter = 'fake') {
  return execFileSync(process.execPath, [LEDGER, 'create', '--slug', 'lesson', '--task', 't', '--repo', root,
    '--chain', JSON.stringify([{ adapter }])], { env, encoding: 'utf8' }).trim()
}
function prepRun(root, id, adapter = 'fake') {
  const dir = join(root, 'cards', id, 'runs', '1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prompt.txt'), 'Task: lesson\n')
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ card_id: id, run: 1, adapter, status: 'launching', supervisor_pid: process.pid, cwd: root, outcome: null }))
  return dir
}
function supervise(root, id, env, adapter = 'fake') {
  try {
    return { status: 0, out: execFileSync(process.execPath, [RUNNER, 'supervise', '--card', id, '--adapter', adapter, '--run', '1', '--cwd', root], { env, encoding: 'utf8' }) }
  } catch (err) {
    return { status: err.status, out: err.stdout?.toString() ?? '' }
  }
}
const runJson = (root, id) => JSON.parse(readFileSync(join(root, 'cards', id, 'runs', '1', 'run.json'), 'utf8'))
const batonEvents = (root, id) => {
  const dir = join(root, 'cards', id)
  const f = existsSync(join(dir, 'events-leg.jsonl')) ? join(dir, 'events-leg.jsonl') : join(dir, 'events-baton.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
}

test('env-sanitized: the 7 forbidden keys and every CLAUDE_CODE_* except the ceiling are removed', () => {
  const out = sanitizeEnv({
    ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_BASE_URL: 'c', OPENAI_API_KEY: 'd',
    CLAUDECODE: '1', CLAUDE_EFFORT: 'e', CLAUDE_PLUGIN_DATA: 'f', CLAUDE_CODE_SESSION_ID: 'g', CLAUDE_CODE_ENTRYPOINT: 'h', KEEP: '1',
  })
  assert.deepEqual(Object.keys(out).sort(), ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'KEEP'])
})

test('bg-wait-ceiling-zero: every registered adapter\'s child env has CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0', async () => {
  for (const name of names()) {
    const a = await getAdapter(name)
    assert.equal(a.env({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '5000' }).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0', name)
  }
})

test('agent-tool-never-disallowed: no adapter argv carries --disallowedTools Agent and src/ never mentions disallowedTools', async () => {
  for (const name of names()) {
    const a = await getAdapter(name)
    const joined = a.argv({ prompt: 'x', cwd: ROOT, runDir: ROOT, killMs: 1000 }).args.join(' ')
    assert.ok(!/disallowedTools/.test(joined), name)
  }
  assert.deepEqual(grep(/disallowedTools/, walk(SRC)), [])
})

test('codex-stdin-ignored: codex adapter stdin is ignore, and the runner gives such an agent no stdin at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root)
  const id = makeCard(root, env, 'fake-nostdin')
  prepRun(root, id, 'fake-nostdin')
  supervise(root, id, env, 'fake-nostdin')
  const out = JSON.parse(readFileSync(join(root, 'cards', id, 'runs', '1', 'out.log'), 'utf8'))
  assert.equal(out.prompt_chars, 0, 'stdin must be ignored: the agent saw no prompt bytes')
  assert.equal(runJson(root, id).outcome, 'completed')
})

test('codex-stdin-ignored (unit): codex adapter declares stdin ignore', async () => {
  assert.equal((await getAdapter('codex')).stdin, 'ignore')
})

test('no-shell-spawn: no shell:true, exec(, execSync( anywhere in src/ bin/ scripts/', () => {
  assert.deepEqual(grep(/shell:\s*true/), [])
  assert.deepEqual(grep(/(^|[^a-zA-Z_.])exec\(/), [])
  assert.deepEqual(grep(/(^|[^a-zA-Z_.])execSync\(/), [])
})

test('no-cmd-shim: resolveNpmCliEntry never returns a .cmd/.ps1 path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', bin: { x: 'bin/x.js' } }))
  const entry = resolveNpmCliEntry('x', 'x', { pkgDir: dir })
  assert.ok(entry.endsWith('x.js'))
  assert.equal(resolveNpmCliEntry('x', 'x', { binOverride: 'x.cmd', pkgDir: join(dir, 'absent') }), null)
  for (const name of ['codex']) {
    // whatever this machine resolves to, it is never a shim
    assert.ok(!/\.(cmd|ps1)$/i.test(String(resolveNpmCliEntry(name))))
  }
})

test('npm-entry-from-execpath: a POSIX prefix that is not under /usr still resolves (macOS, Homebrew, nvm)', () => {
  // The macOS runner keeps node in ~/hostedtoolcache, so neither
  // /usr/local/lib/node_modules nor /usr/lib/node_modules exists and `npm test`
  // during a Land died with "cannot resolve npm's JS entry". The prefix has to
  // come from the running binary: <prefix>/bin/node -> <prefix>/lib/node_modules.
  // A name that exists only inside the fake prefix, so this asserts the
  // execPath-derived candidate and not whatever npm this machine has installed
  // (on Windows the real one under APPDATA is found first and would mask it).
  const NAME = 'baton-fake-cli'
  const prefix = mkdtempSync(join(tmpdir(), 'nodeprefix-'))
  const pkgDir = join(prefix, 'lib', 'node_modules', NAME)
  mkdirSync(join(pkgDir, 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: NAME, bin: { [NAME]: 'bin/cli.js' } }))
  writeFileSync(join(pkgDir, 'bin', 'cli.js'), '')

  const entry = resolveNpmCliEntry(NAME, NAME, { execPath: join(prefix, 'bin', 'node') })
  assert.equal(entry, join(pkgDir, 'bin', 'cli.js'))

  // and the check fails when the layout is absent, so it is really looking
  const empty = mkdtempSync(join(tmpdir(), 'nodeprefix-'))
  mkdirSync(join(empty, 'bin'), { recursive: true })
  assert.equal(resolveNpmCliEntry('definitely-not-a-package', 'x', { execPath: join(empty, 'bin', 'node') }), null)
})

test('no-global-fetch: Node code under src/ never calls global fetch (Node 24 on Windows crashes at exit); the browser board is exempt', () => {
  const nodeFiles = walk(SRC).filter((f) => !f.includes(`${sep}board${sep}`))
  assert.ok(nodeFiles.length > 10)
  assert.deepEqual(grep(/(^|[^a-zA-Z_.])fetch\(/, nodeFiles), [])
})

test('no-yolo-flags: forbidden flags appear only inside forbiddenFlags declarations, and no argv emits one', async () => {
  const forbidden = [/--dangerously-skip-permissions/, /--allow-dangerously-skip-permissions/, /--dangerously-bypass-approvals-and-sandbox/, /--yolo/, /--always-approve/, /bypassPermissions/, /danger-full-access/]
  for (const re of forbidden) {
    const hits = grep(re).filter((h) => !/forbiddenFlags|allowed: \[|NOT|never|not /.test(h))
    assert.deepEqual(hits, [], `${re} outside a forbidden-list declaration`)
  }
  for (const name of names()) {
    const a = await getAdapter(name)
    const joined = a.argv({ prompt: 'x', cwd: ROOT, runDir: ROOT, killMs: 1000 }).args.join(' ')
    for (const re of forbidden) assert.ok(!re.test(joined), `${name} argv carries ${re}`)
  }
})

test('codex-sandbox-ladder: refuses danger-full-access, always -C <worktree>, network off unless the chain entry says network: true', async () => {
  const a = await getAdapter('codex')
  assert.throws(() => a.argv({ prompt: 'x', mode: 'danger-full-access' }), /forbidden flag/)
  const off = a.argv({ prompt: 'x', cwd: 'C:\\wt' }).args
  assert.equal(off[off.indexOf('-C') + 1], 'C:\\wt')
  assert.ok(off.includes('sandbox_workspace_write.network_access=false'))
  const on = a.argv({ prompt: 'x', cwd: 'C:\\wt', network: true }).args
  assert.ok(on.includes('sandbox_workspace_write.network_access=true'))
})

test('node-test-bare: package.json test script uses native discovery, optionally serialized', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.test, /^node --test(?: --test-concurrency=\d+)?(?: &&|$)/)
  assert.doesNotMatch(pkg.scripts.test, /^node --test (?!(?:--test-concurrency=\d+)?(?:\s*&&|$))\S/)
})

test('json-only-at-end: the supervisor reads out.log only inside the exit handler, and run.json has no session_id before exit', () => {
  const src = readFileSync(RUNNER, 'utf8')
  const reads = [...src.matchAll(/readFileSync\(outPath/g)].length
  assert.equal(reads, 1, 'exactly one read of the result file')
  const exitHandler = src.slice(src.indexOf("child.on('exit'"), src.indexOf('} else if (cmd === \'sweep\')'))
  assert.match(exitHandler, /readFileSync\(outPath/)
  // behavioural: with a delayed agent, the record carries no session id until exit
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, { FAKE_DELAY_MS: '1500' })
  const id = makeCard(root, env)
  prepRun(root, id)
  const t0 = Date.now()
  const r = supervise(root, id, env)
  assert.equal(r.status, 0)
  assert.ok(Date.now() - t0 >= 1400)
  assert.equal(runJson(root, id).session_id, 'sess-fake')
})

test('taskkill-tree-on-windows: killTree uses taskkill /PID <pid> /T /F on win32 and process-group SIGKILL elsewhere', () => {
  const src = readFileSync(RUNNER, 'utf8')
  const kill = src.slice(src.indexOf('function killTree'), src.indexOf('function legOpts'))
  assert.match(kill, /spawnSync\('taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/)
  assert.match(kill, /process\.kill\(-pid, 'SIGKILL'\)/)
  assert.match(kill, /BATON_SKIP_KILL/)
})

test('auth-source-is-launch-failure: fake auth mode → outcome auth_failed, handoff false, ledger error event', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-'))
  const env = makeEnv(root, { FAKE_MODE: 'auth' })
  const id = makeCard(root, env)
  prepRun(root, id)
  const r = supervise(root, id, env)
  assert.equal(r.status, 13)
  const rj = runJson(root, id)
  assert.equal(rj.outcome, 'auth_failed')
  assert.equal(rj.handoff, false)
  assert.ok(batonEvents(root, id).some((e) => e.type === 'error' && /auth_failed/.test(e.summary)))
})

test('msys-no-pathconv: every git spawn in src/ sets MSYS_NO_PATHCONV=1 (and none passes a leading-slash argument)', () => {
  const sites = grep(/(execFileSync|spawnSync)\('git'/, walk(SRC))
  assert.ok(sites.length >= 3, 'expected git spawn sites in src/')
  for (const s of sites) assert.match(s, /MSYS_NO_PATHCONV: '1'/, s)
  assert.deepEqual(grep(/\['git', \[.*'\/[a-z]/, walk(SRC)), [])
})

// 2026-09-11: 0.3.0 on npm crashed on every command because src/limits.mjs
// reads fixtures/limits at load time and `files` did not ship it. The
// tarball must carry every directory the runtime reads.
test('the npm tarball ships what src reads at runtime, and never an env file', () => {
  const npmCli = process.env.npm_execpath || [
    join(dirname(process.execPath), 'node_modules', 'npm'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
  ].map((pkgDir) => resolveNpmCliEntry('npm', 'npm', { pkgDir })).find(Boolean) || resolveNpmCliEntry('npm', 'npm')
  const out = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const need of ['src/limits.mjs', 'src/license.mjs', 'bin/leg.mjs', 'LICENSE', 'fixtures/limits/', 'fixtures/live/', 'docs/faq.md']) {
    assert.ok(files.some((f) => f.startsWith(need)), `tarball is missing ${need}`)
  }
  assert.deepEqual(files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')), [], 'an env file is in the tarball')
})
