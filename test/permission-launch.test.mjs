// Real Leg entry points with recording stubs, isolated homes and no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeHome, testEnv, initRepo, LEG, ROOT } from './helpers.mjs'
import { ensureTrust } from '../src/trust.mjs'

const AGENTS = ['claude', 'codex', 'agy', 'grok']
const FLAGS = { claude: '--dangerously-skip-permissions', codex: '--ask-for-approval', agy: '--dangerously-skip-permissions', grok: '--always-approve' }

function fixture() {
  const home = makeHome()
  const repo = initRepo('permission-launch-')
  const clients = join(home, 'clients')
  const stubs = join(home, 'stubs')
  mkdirSync(stubs)
  const env = testEnv(home, {
    USERPROFILE: clients, HOME: clients,
    CLAUDE_CONFIG_DIR: join(clients, 'claude'), CODEX_HOME: join(clients, 'codex'),
    GEMINI_CONFIG_DIR: join(clients, 'gemini'), ANTIGRAVITY_APP_DATA_DIR: join(clients, 'gemini', 'antigravity-cli'), GROK_HOME: join(clients, 'grok'),
    LEG_NO_BOARD: '1', LEG_NO_OPEN: '1', LEG_ATTACH_POLL_MS: '50', LEG_ACCOUNT: 'default', BATON_ACCOUNT: 'default',
    STUB_OUT: home,
  })
  for (const prefix of ['LEG', 'BATON']) {
    for (const setting of ['TRUST', 'AUTO_APPROVE', 'NO_AUTO_APPROVE', 'NO_HANDOFF']) delete env[`${prefix}_${setting}`]
    for (const agent of AGENTS) {
      delete env[`${prefix}_${agent.toUpperCase()}_ARGS`]
      env[`${prefix}_${agent.toUpperCase()}_BIN`] = join(stubs, `${agent}.mjs`)
    }
  }
  const files = {
    [join(clients, 'claude', '.claude.json')]: '{"projects":{},"numStartups":4}',
    [join(clients, 'claude', 'settings.json')]: '{"permissions":{"defaultMode":"default"}}',
    [join(clients, 'codex', 'config.toml')]: 'approval_policy = "on-request"\n',
    [join(clients, 'gemini', 'antigravity-cli', 'settings.json')]: '{"trustedWorkspaces":[]}',
    [join(clients, 'gemini', 'config', 'projects', 'default-cli-project.json')]: '{"projectResources":{"resources":[]}}',
    [join(clients, 'gemini', 'trustedFolders.json')]: '{}',
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  const tree = readdirSync(clients, { recursive: true }).sort()
  for (const [i, agent] of AGENTS.entries()) {
    const next = AGENTS[i + 1]
    writeFileSync(join(stubs, `${agent}.mjs`), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.env.STUB_OUT, '${agent}.json'), JSON.stringify(process.argv.slice(2)))
if (process.env.STUB_HANDOFF === '1' && ${Boolean(next)}) {
  const { requestControl } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'sessions.mjs')).href)})
  if ('${agent}' === 'claude') {
    const { writePreferences } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'preferences.mjs')).href)})
    writePreferences({ auto_approve: process.env.STUB_FLIP === 'true' })
  }
  requestControl(process.env.LEG_SESSION, { handoff: true, target: { agent: '${next}', account: 'default' } })
  setTimeout(() => {}, 20000)
}
`)
  }
  return {
    home, repo, env,
    prefs(value) { writeFileSync(join(home, 'preferences.json'), JSON.stringify(value)) },
    launch(agent, args = [], extra = {}) {
      const result = spawnSync(process.execPath, [LEG, agent, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 45000, windowsHide: true })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return JSON.parse(readFileSync(join(home, `${agent}.json`), 'utf8'))
    },
    untouched() {
      for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(file, 'utf8'), text, file)
      assert.deepEqual(readdirSync(clients, { recursive: true }).sort(), tree, 'no client config or lock files created')
    },
  }
}

for (const agent of AGENTS) {
  test(`${agent}: CLI default, saved settings, environment, opt-in and opt-out precedence`, () => {
    const f = fixture()
    assert.ok(!f.launch(agent).includes(FLAGS[agent]))
    assert.equal(existsSync(join(f.home, 'preferences.json')), false, 'launch does not persist a default')
    const printArgs = agent === 'grok' ? ['--prompt', 'Inspect this task'] : ['-p', 'Inspect this task']
    assert.ok(!f.launch(agent, printArgs).includes(FLAGS[agent]), 'a piped/print launch does not imply approval')
    for (const scenario of [
      { saved: true, on: true },
      { saved: false, on: false },
      { saved: true, env: { LEG_AUTO_APPROVE: '' }, on: false },
      { saved: true, env: { LEG_AUTO_APPROVE: 'typo' }, on: false },
      { saved: false, env: { LEG_AUTO_APPROVE: '1' }, on: true },
      { saved: true, env: { LEG_AUTO_APPROVE: '1', LEG_NO_AUTO_APPROVE: '1' }, on: false },
      { saved: true, args: ['--no-auto-approve'], env: { LEG_AUTO_APPROVE: '1' }, on: false },
      { saved: false, args: ['--auto-approve'], env: { LEG_AUTO_APPROVE: '0' }, on: true },
      { saved: true, args: ['--auto-approve', '--no-auto-approve'], on: false },
      { saved: true, args: ['--no-auto-approve', '--auto-approve'], on: false },
    ]) {
      f.prefs({ auto_approve: scenario.saved })
      const before = readFileSync(join(f.home, 'preferences.json'), 'utf8')
      const argv = f.launch(agent, scenario.args, scenario.env)
      assert.equal(argv.includes(FLAGS[agent]), scenario.on, JSON.stringify(scenario))
      assert.ok(!argv.includes('--auto-approve') && !argv.includes('--no-auto-approve'), 'Leg consumes both switches')
      assert.equal(readFileSync(join(f.home, 'preferences.json'), 'utf8'), before, 'launch does not rewrite preferences')
    }
    f.prefs({ auto_approve: false })
    const native = agent === 'codex' ? ['resume', 'native-session'] : ['--resume', 'native-session']
    assert.ok(!f.launch(agent, native).includes(FLAGS[agent]), 'native resume adds no bypass')
    const literal = f.launch(agent, ['--', '--auto-approve'])
    assert.ok(literal.includes('--auto-approve'), 'arguments after -- belong to the client')
    assert.ok(!literal.includes(FLAGS[agent]))
    f.untouched()
  })
}

for (const enabled of [false, true]) {
  test(`handoffs through all four clients retain initial auto-approve=${enabled} despite a later preference edit`, () => {
    const f = fixture()
    f.prefs({ auto_approve: enabled, may_spend: true, handoff_order: AGENTS })
    f.launch('claude', [], { STUB_HANDOFF: '1', STUB_FLIP: String(!enabled) })
    for (const agent of AGENTS) {
      const argv = JSON.parse(readFileSync(join(f.home, `${agent}.json`), 'utf8'))
      assert.equal(argv.includes(FLAGS[agent]), enabled, agent)
    }
    f.untouched()
  })
}

test('default and invalid trust policies never write existing or absent client configs', () => {
  const f = fixture()
  for (const policy of [undefined, '', 'typo', 'never']) {
    const env = { ...f.env }
    if (policy !== undefined) env.LEG_TRUST = policy
    for (const agent of AGENTS) assert.deepEqual(ensureTrust(agent, f.repo, { env }).wrote, [])
    f.untouched()
  }
  const absent = join(f.home, 'absent-configs')
  const env = { CLAUDE_CONFIG_DIR: absent, CODEX_HOME: absent, GEMINI_CONFIG_DIR: absent }
  for (const agent of AGENTS) ensureTrust(agent, f.repo, { env })
  assert.equal(existsSync(absent), false)
})

test('explicit trust opt-in still records trust and disabling it does not revoke that decision', () => {
  const f = fixture()
  for (const agent of ['claude', 'codex', 'agy']) {
    const result = ensureTrust(agent, f.repo, { env: { ...f.env, LEG_TRUST: 'auto' } })
    assert.ok(result.wrote.length > 0, agent)
    const before = readFileSync(result.file, 'utf8')
    assert.deepEqual(ensureTrust(agent, f.repo, { env: { ...f.env, LEG_TRUST: 'never' } }).wrote, [])
    assert.equal(readFileSync(result.file, 'utf8'), before)
  }
})
