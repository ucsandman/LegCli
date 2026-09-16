// The portable harness, unit level: the vendored engine is intact and
// attributed, ESM can drive it, a capture is complete and carries no
// credential, the fingerprint is stable, the registry honours the config-dir
// variables, and the preferences shape is what every existing caller expects.
// Every test runs against throwaway homes: LEG_HARNESS_HOME is set before the
// harness module is imported and never points at the developer's own config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as fsSync from 'node:fs'
import { join } from 'node:path'
import { makeHome, ROOT } from './helpers.mjs'
import { buildClaudeHome, buildCodexHome, CANARY, fakeToken, CLAUDE_HOOK_TOTAL, PLANTED } from './harness-fixture.mjs'

const HOME = makeHome()
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
process.env.LEG_HARNESS_HOME = HOME
const h = await import('../src/harness/index.mjs')
const { check, readManifest, FILES } = await import('../scripts/sync-harness-engine.mjs')
const { readPreferences, writePreferences, normalizeHarness, requireHarness, HARNESS_DEFAULTS } = await import('../src/preferences.mjs')

const fresh = () => { const dir = makeHome(); process.env.LEG_HOME = join(dir, 'leg'); process.env.BATON_HOME = process.env.LEG_HOME; process.env.LEG_HARNESS_HOME = dir; return dir }

test('vendored engine: every file matches the recorded upstream hash, the MIT licence travels with it, and NOTICE says so', () => {
  const r = check()
  assert.deepEqual(r.problems, [], r.problems.join('\n'))
  assert.ok(r.checked >= FILES.length * 2, `checked=${r.checked}`)
  const m = readManifest()
  assert.match(m.upstream, /github\.com\/ucsandman\/Agnostic-AI/)
  assert.match(m.commit ?? '', /^[0-9a-f]{40}$/, 'the upstream commit is recorded')
  const lic = readFileSync(join(ROOT, 'src', 'harness', 'vendor', 'agnostic-ai', 'LICENSE'), 'utf8')
  assert.match(lic, /MIT License/)
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
  assert.match(notice, /Agnostic AI/)
  assert.match(notice, /MIT/)
})

test('vendored engine: a hand edit under vendor/ is refused by --check (the check is seen failing)', () => {
  const file = join(ROOT, 'src', 'harness', 'vendor', 'agnostic-ai', 'engine', 'harness', 'toml.cjs')
  const before = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, before + '\n// local edit\n')
    const r = check()
    assert.ok(r.problems.some((p) => p.includes('toml.cjs')), `expected toml.cjs flagged, got ${JSON.stringify(r.problems)}`)
  } finally { writeFileSync(file, before) }
  assert.deepEqual(check().problems, [])
})

test('ESM drives the CommonJS engine: the library entry loads, configure() brands it live, Leg secret shapes are in force', () => {
  const engine = h.configureEngine()
  assert.equal(typeof engine.capture, 'function')
  assert.equal(engine.common.GENERATED_MARK, h.BRAND.mark)
  assert.equal(engine.common.regionMarkers('hooks').start, `# >>> ${h.BRAND.region} hooks start (generated, do not edit)`)
  assert.ok(engine.common.shimPath().endsWith(join('engine', 'hooks', 'shim.cjs')))
  assert.ok(existsSync(engine.common.shimPath()), 'the hook shim ships as a real file')
  // an Anthropic key shape from src/redact.mjs, not in the engine's own list
  assert.ok(engine.common.looksSecret('X', 'sk-ant-' + 'a'.repeat(30)))
  assert.ok(engine.common.looksSecret('TOKEN', 'ghp_' + 'b'.repeat(36)))
  assert.ok(!engine.common.looksSecret('PORT', '8080'))
})

test('capture claude: every component lands, a credential becomes ${NAME} with a warning, and the oauth block is never read', () => {
  const home = fresh('cap')
  buildClaudeHome(home)
  h.setHarnessConfig({ enabled: true, source: 'claude', policy: 'sync' })
  const c = h.captureHarness({ source: 'claude' })
  assert.equal(c.cached, false)
  const b = c.bundle
  assert.equal(b.manifest.source, 'claude')
  assert.deepEqual(b.manifest.components, { rules: 1, identity: 1, hooks: CLAUDE_HOOK_TOTAL, skills: 3, agents: 2, commands: 1, mcp: 3, permissions: 4 })
  assert.match(b.rules, /Batch tool calls/)
  assert.match(b.rules, /Never commit secrets/, 'the @import was inlined')
  assert.ok(!b.rules.includes('@~/.claude/team-rules.md'))
  assert.equal(b.mcp.servers.docs.env.CONTEXT7_API_KEY, '${CONTEXT7_API_KEY}')
  assert.equal(b.mcp.servers.docs.env.PORT, '8080')
  assert.equal(b.mcp.servers.remote.headers.Authorization, '${Authorization}')
  assert.ok(c.warnings.some((w) => /CONTEXT7_API_KEY/.test(w)))
  for (const f of ['manifest.json', 'rules.md', 'hooks.json', 'mcp.json', 'skills.json', 'permissions.json']) {
    const text = readFileSync(join(h.bundleDir(), f), 'utf8')
    assert.ok(!text.includes(CANARY.claude), `${f} must not carry the oauth token`)
    assert.ok(!text.includes(fakeToken('a')) && !text.includes(fakeToken('b')), `${f} must not carry an MCP credential`)
  }
  assert.ok(!existsSync(join(h.bundleDir(), '.credentials.json')))
  assert.equal(h.readHistory().at(-1).op, 'capture')
})

test('capture is fingerprinted: unchanged source = cached bundle; a rules edit or a new skill = a new capture and a new fingerprint', () => {
  const home = fresh('fp')
  buildClaudeHome(home)
  h.setHarnessConfig({ enabled: true, source: 'claude', policy: 'sync' })
  const a = h.captureHarness()
  const b = h.captureHarness()
  assert.equal(b.cached, true)
  assert.equal(b.bundle.manifest.fingerprint, a.bundle.manifest.fingerprint)
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8') + '\n- One more rule.\n')
  const c = h.captureHarness()
  assert.equal(c.cached, false, 'a rules edit invalidates the cache')
  assert.notEqual(c.bundle.manifest.fingerprint, a.bundle.manifest.fingerprint)
  mkdirSync(join(home, '.claude', 'skills', 'delta'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'delta', 'SKILL.md'), '---\nname: delta\ndescription: d\n---\n\nDo delta.\n')
  const d = h.captureHarness()
  assert.equal(d.cached, false, 'a new skill invalidates the cache')
  assert.equal(d.bundle.skills.skills.length, 4)
  assert.equal(h.getHarnessStatus().source_changed, false)
})

test('a bundle that carries a literal secret is refused by the engine; a corrupt bundle is reported, never applied', () => {
  const home = fresh('secret')
  buildClaudeHome(home)
  const engine = h.configureEngine()
  const b = engine.bundle.createBundle('claude', home)
  b.rules = '# rules\n\nx\n'
  b.mcp = { servers: { docs: { transport: 'stdio', command: 'npx', env: { API_KEY: fakeToken('z') } } } }
  const problems = engine.bundle.validate(b)
  assert.ok(problems.some((p) => /looks like a secret/.test(p)), JSON.stringify(problems))
  assert.throws(() => engine.bundle.save(b, join(home, 'bad-bundle')), /refusing to save an invalid bundle/)
  // a corrupt bundle on disk
  h.setHarnessConfig({ enabled: true, source: 'claude', policy: 'sync' })
  h.captureHarness()
  writeFileSync(join(h.bundleDir(), 'hooks.json'), '{not json')
  const i = h.inspectHarness()
  assert.ok(i.corrupt, 'inspect names the corruption')
  assert.throws(() => h.applyHarness({ to: 'codex', bundle: null }), /unreadable/)
  const p = h.prepareHarnessForHandoff({ from: 'claude', to: 'codex' })
  // capture.json still matches the source, but the bundle no longer matches its fingerprint: re-captured, not trusted
  assert.ok(['synced', 'partial', 'unsupported'].includes(p.state), p.summary)
})

test('a credential in the rules, the identity, a hook command, an MCP argument, an MCP url or an agent body never reaches the bundle or a destination', () => {
  const home = fresh()
  buildClaudeHome(home, { plantSecrets: true })
  buildCodexHome(home)
  h.setHarnessConfig({ enabled: true, source: 'claude', policy: 'sync' })
  const c = h.captureHarness({ source: 'claude' })
  const planted = Object.values(PLANTED)
  const bundleFiles = ['rules.md', 'identity.md', 'hooks.json', 'mcp.json', 'agents/advisor.md']
  for (const f of bundleFiles) {
    const text = readFileSync(join(h.bundleDir(), f), 'utf8')
    for (const p of planted) assert.ok(!text.includes(p), `${f} must not carry ${p.slice(0, 8)}...`)
  }
  assert.match(c.bundle.rules, /\[REDACTED\]/, 'the rules text was redacted, not dropped')
  assert.match(c.bundle.identity, /\[REDACTED\]/)
  assert.equal(c.bundle.hooks.events.PreToolUse.reduce((n, g) => n + g.hooks.length, 0), 2, 'the hook with a token on its command line is not carried')
  assert.ok(!c.bundle.mcp.servers.keyed && !c.bundle.mcp.servers.signed, 'servers with a credential in args or url are not carried')
  assert.ok(c.bundle.mcp.servers.docs, 'the clean server still travels')
  assert.ok(c.warnings.some((w) => /rules: 1 credential-shaped value/.test(w)), c.warnings.join('\n'))
  assert.ok(c.warnings.some((w) => /hooks\.PreToolUse.*not carried/.test(w)))
  assert.ok(c.warnings.some((w) => /mcp\.keyed/.test(w)) && c.warnings.some((w) => /mcp\.signed/.test(w)))
  h.prepareHarnessForHandoff({ from: 'claude', to: 'codex' })
  for (const f of [join(home, '.codex', 'AGENTS.md'), join(home, '.codex', 'config.toml'), join(home, '.codex', 'agents', 'advisor.toml')]) {
    const text = readFileSync(f, 'utf8')
    for (const p of planted) assert.ok(!text.includes(p), `${f} must not carry a planted credential`)
  }
  // and the engine refuses a bundle that still carries one, in every one of those places
  const engine = h.configureEngine()
  const b = engine.bundle.createBundle('claude', home)
  b.rules = `rules ${PLANTED.rules}`; b.identity = `id ${PLANTED.identity}`
  b.hooks.events = { PreToolUse: [{ hooks: [{ type: 'command', command: `node x.cjs ${PLANTED.hook}` }] }] }
  b.mcp.servers = { a: { transport: 'stdio', command: 'npx', args: [PLANTED.arg] }, s: { transport: 'http', url: PLANTED.url + '?token=' + 'z'.repeat(20) } }
  b.agents = [{ name: 'one', meta: { description: 'd' }, body: PLANTED.agent }]
  const problems = engine.bundle.validate(b)
  for (const where of ['rules.md', 'identity.md', 'hooks.events.PreToolUse', 'mcp.a.args', 'mcp.s.url', 'agent one']) assert.ok(problems.some((p) => p.startsWith(where)), `${where} flagged; got ${JSON.stringify(problems)}`)
})

test('secret shapes: a password in a connection string, a bare hex secret, a token in a webhook path and a single-class token are credentials; ports, urls, paths and names are not', () => {
  const engine = h.configureEngine()
  const yes = [['DATABASE_URL', ['postgres://app:', 'S3cret', 'Passw0rd', 'XYZ@db.example.com:5432/prod'].join('')], ['DSN', '9f3a2b7c41d5e6088a1b2c3d4e5f6071'], ['SESSION_TOKEN', 'https://hooks.example.com/t/9f3a2b7c41d5e6088a1b'], ['GH_PAT', 'a'.repeat(40)], ['ANY', 'Ab1'.repeat(12)]]
  const no = [['PORT', '8080'], ['URL', 'https://example.com/mcp'], ['MCP_URL', 'https://example.com/api/v1/servers'], ['HOME', 'C:/Users/x/AppData/Local/Programs/node_modules/whatever/thing'], ['NAME', 'my-plain-server-name'], ['DESC', 'a normal sentence with spaces that is long enough to be over thirty two chars'], ['KEY', '${KEY}']]
  for (const [k, v] of yes) assert.ok(engine.common.looksSecret(k, v), `${k} should be a secret`)
  for (const [k, v] of no) assert.ok(!engine.common.looksSecret(k, v), `${k} should not be a secret`)
})

test('CLAUDE_CONFIG_DIR outside the OS home: the capture reads THAT directory, and its fingerprint follows it', () => {
  const home = fresh()
  const elsewhere = makeHome()
  const cfg = join(elsewhere, 'claudecfg')
  buildClaudeHome(elsewhere, { rulesExtra: '- The active profile rule.' })
  // move the fixture's .claude to a directory that is not under the OS home
  const { renameSync } = fsSync
  renameSync(join(elsewhere, '.claude'), cfg)
  renameSync(join(elsewhere, '.claude.json'), join(cfg, '.claude.json'))
  buildClaudeHome(home, { rulesExtra: '- The DORMANT rule in the default dir.' })
  const env = { ...process.env, LEG_HARNESS_HOME: home, CLAUDE_CONFIG_DIR: cfg }
  h.setHarnessConfig({ enabled: true, source: 'claude', policy: 'sync' })
  const c = h.captureHarness({ source: 'claude', env })
  assert.match(c.bundle.rules, /The active profile rule/)
  assert.doesNotMatch(c.bundle.rules, /DORMANT/, 'the default directory was not read')
  writeFileSync(join(cfg, 'CLAUDE.md'), readFileSync(join(cfg, 'CLAUDE.md'), 'utf8') + '\n- Edited in the config dir.\n')
  const c2 = h.captureHarness({ source: 'claude', env })
  assert.equal(c2.cached, false, 'the fingerprint tracks the directory being captured')
  assert.match(c2.bundle.rules, /Edited in the config dir/)
})

test('registry: the config-dir variables move a client, ~/.claude.json follows CLAUDE_CONFIG_DIR, grok has no adapter, fakes map to their client', () => {
  const home = fresh('reg')
  const env = { LEG_HARNESS_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'alt-claude'), CODEX_HOME: join(home, 'alt-codex'), GEMINI_CONFIG_DIR: join(home, 'alt-gemini') }
  const reg = h.registry({ env })
  const by = Object.fromEntries(reg.map((t) => [t.id, t]))
  assert.equal(by.claude.home, join(home, 'alt-claude'))
  assert.equal(by.claude.mcpConfigFile, join(home, 'alt-claude', '.claude.json'))
  assert.equal(by.claude.rulesFile, join(home, 'alt-claude', 'leg-rules.md'))
  assert.equal(by.codex.home, join(home, 'alt-codex'))
  assert.equal(by.codex.hooksConfigFile, join(home, 'alt-codex', 'config.toml'))
  assert.equal(by.agy.home, join(home, 'alt-gemini', 'antigravity-cli'))
  assert.equal(by.gemini.rulesFile, join(home, 'alt-gemini', 'GEMINI.md'))
  for (const t of reg) assert.match(t.preamble, /GENERATED by Leg harness/)
  assert.deepEqual(reg.map((t) => t.id), ['claude', 'codex', 'gemini', 'agy'])
  assert.ok(h.NO_ADAPTER.grok)
  assert.equal(h.clientFor('fake-codex'), 'codex')
  assert.equal(h.clientFor('fake'), null)
  assert.equal(h.clientFor('claude'), 'claude')
  assert.equal(h.clientFor(null), null)
})

test('preferences: harness is off for an old preferences file, unknown values fall back, writes validate, and the two older keys are untouched', () => {
  fresh('prefs')
  assert.deepEqual(readPreferences().harness, HARNESS_DEFAULTS)
  assert.deepEqual(normalizeHarness({ enabled: 'yes', policy: 'bogus', source: 'grok' }), { enabled: false, policy: 'warn', source: null })
  assert.throws(() => requireHarness({ policy: 'loose' }), TypeError)
  assert.throws(() => requireHarness({ source: 'grok' }), TypeError)
  const before = readPreferences()
  const next = writePreferences({ harness: { enabled: true, policy: 'strict', source: 'codex' } })
  assert.deepEqual(next.harness, { enabled: true, policy: 'strict', source: 'codex' })
  assert.deepEqual(next.handoff_order, before.handoff_order)
  assert.equal(next.auto_approve, before.auto_approve)
  assert.deepEqual(readPreferences().harness, next.harness)
  // a file from before this feature reads as off
  writeFileSync(join(process.env.LEG_HOME, 'preferences.json'), JSON.stringify({ handoff_order: ['codex', 'claude', 'agy'], auto_approve: false }))
  const old = readPreferences()
  assert.deepEqual(old.harness, HARNESS_DEFAULTS)
  assert.deepEqual(old.handoff_order, ['codex', 'claude', 'agy'])
  assert.equal(old.auto_approve, false)
})

test('a source codex home captures too (reverse direction), with its per-invocation approvals left out and its auth file never read', () => {
  const home = fresh('codex-src')
  buildCodexHome(home)
  h.setHarnessConfig({ enabled: true, source: 'codex', policy: 'sync' })
  const c = h.captureHarness()
  assert.equal(c.bundle.manifest.source, 'codex')
  assert.match(c.bundle.rules, /Keep diffs minimal/)
  assert.deepEqual(c.bundle.permissions.allow, ['Bash(ls *)'])
  assert.deepEqual(c.bundle.permissions.deny, ['Bash(rm -rf *)'])
  assert.equal(c.bundle.agents[0].meta.model, 'sonnet', 'the Codex model slug maps back to its tier')
  assert.equal(String(c.bundle.agents[0].meta.readonly), 'true')
  for (const f of ['mcp.json', 'hooks.json', 'rules.md']) assert.ok(!readFileSync(join(h.bundleDir(), f), 'utf8').includes(CANARY.codex))
})

test('the board source carries a Harness section and a card chip built only from the recorded outcome', () => {
  const src = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')
  assert.match(src, /section\('Harness', 'the working environment this leg was given'/)
  assert.match(src, /function harnessBadge\(h\)/)
  assert.match(src, /function harnessSection\(s, d\)/)
  assert.ok(src.indexOf("section('What happens next'") < src.indexOf("section('Harness'"), 'the harness block comes after what happens next')
  assert.match(src, /h\.state === 'off' \|\| h\.state === 'same-client'/, 'nothing is shown when the feature is off')
})
