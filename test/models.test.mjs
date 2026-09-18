// models: the model catalog per agent (src/models.mjs), the route that serves
// it (/api/models), and the rung validation that lets a catalog id onto a
// ladder in the first place.
//
// Every parser is tested against a fixture captured from this machine on
// 2026-09-18 (fixtures/models/), not against a list retyped here: the whole
// point of the module is that it reads the catalog each CLI already publishes,
// so a test that asserts against a hand-written list would go green on a
// parser that returned its own input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome } from './helpers.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(ROOT, 'fixtures', 'models')
const fixture = (name) => readFileSync(join(FIX, name), 'utf8')

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
delete process.env.BATON_TOKEN
delete process.env.BATON_BIND
delete process.env.BATON_PERSON

const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const models = await import('../src/models.mjs')
const prefs = await import('../src/preferences.mjs')

// ---- codex: a JSON cache plus the config's default -------------------------

test('codex publishes the models it marks visible, and only those', () => {
  const list = models.parseCodexModels(fixture('codex-models_cache.json'), fixture('codex-config.toml'))
  assert.deepEqual(list.map((m) => m.id), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
  // gpt-reserve and codex-auto-review carry visibility "hide": codex's own word
  // for "not a model to offer a human", and neither is a leg anyone would start
  assert.equal(list.some((m) => m.id === 'gpt-reserve'), false)
  assert.equal(list.some((m) => m.id === 'codex-auto-review'), false)
  // the label is codex's display name, not the slug: a select that reads
  // "gpt-5.6-luna" is a select nobody can rank
  assert.equal(list.find((m) => m.id === 'gpt-5.6-luna').label, 'GPT-5.6-Luna')
})

test("the codex default is the top-level `model` in config.toml, not a profile's", () => {
  const list = models.parseCodexModels(fixture('codex-models_cache.json'), fixture('codex-config.toml'))
  assert.deepEqual(list.filter((m) => m.default).map((m) => m.id), ['gpt-6-astra'])
  // the fixture's [profiles.cheap] also says model = "gpt-5.5". A profile is
  // not what a bare `codex` runs, and reading it would label the wrong row.
  assert.equal(models.parseCodexDefault(fixture('codex-config.toml')), 'gpt-6-astra')
  assert.equal(models.parseCodexDefault('[profiles.x]\nmodel = "gpt-5.5"\n'), null)
  assert.equal(models.parseCodexDefault('# model = "commented-out"\n'), null)
})

// Finding 22: `model = "gpt-5-codex"  # the fast one` is ordinary TOML and
// common in that file. Anchoring the quote at end of line read it as no default
// at all, so the board's codex select offered "provider default" for a codex
// that has one.
test('a trailing comment on the codex model line still names the default', () => {
  assert.equal(models.parseCodexDefault('model = "gpt-5-codex"  # the fast one\n'), 'gpt-5-codex')
  assert.equal(models.parseCodexDefault("model = 'gpt-5-codex' #pinned\n"), 'gpt-5-codex')
  assert.equal(models.parseCodexDefault('model = "gpt-5-codex"\t# tabbed\n'), 'gpt-5-codex')
  // a line that is itself a comment is still not a default, and a profile's
  // model is still not the one a bare `codex` runs
  assert.equal(models.parseCodexDefault('# model = "commented-out"\n'), null)
  assert.equal(models.parseCodexDefault('[profiles.x]\nmodel = "gpt-5.5" # no\n'), null)
  // and it reaches the catalog, not just the parser beside it
  const list = models.parseCodexModels(fixture('codex-models_cache.json'), 'model = "gpt-5.6-luna"  # pinned for now\n')
  assert.deepEqual(list.filter((m) => m.default).map((m) => m.id), ['gpt-5.6-luna'])
})

test('an unreadable codex cache is an empty catalog, never a throw', () => {
  assert.deepEqual(models.parseCodexModels('not json at all', ''), [])
  assert.deepEqual(models.parseCodexModels('', ''), [])
  assert.deepEqual(models.parseCodexModels('{"models":"nope"}', ''), [])
})

// ---- agy: tab-separated id and label ---------------------------------------

test('agy models: the progress line is not a model, every tabbed line is', () => {
  const list = models.parseAgyModels(fixture('agy-models.txt'))
  assert.equal(list.length, 14, `agy parsed ${list.length} models`)
  assert.equal(list[0].id, 'gemini-3.8-flash-high')
  assert.equal(list[0].label, 'Gemini 3.8 Flash (High)')
  assert.ok(list.some((m) => m.id === 'claude-opus-4-6-thinking'), 'the claude models agy proxies are models too')
  assert.ok(list.some((m) => m.id === 'gpt-oss-120b-medium'))
  // "Fetching available models..." has no tab, so it cannot become a model id
  assert.equal(list.some((m) => /Fetching/i.test(m.id)), false)
  // agy publishes no default, and inventing one would label a row the CLI
  // never promised
  assert.equal(list.some((m) => m.default), false)
})

// ---- grok: bullets, with the default marked twice ---------------------------

test('grok models: the bullets are the list and the default is marked', () => {
  const list = models.parseGrokModels(fixture('grok-models.txt'))
  assert.deepEqual(list.map((m) => m.id), ['grok-4.6', 'grok-4.5'])
  assert.deepEqual(list.filter((m) => m.default).map((m) => m.id), ['grok-4.6'])
  // the login line is prose, not a bullet, so it is not a model
  assert.equal(list.some((m) => /logged/i.test(m.id)), false)
})

test('grok still lists its models when it is not logged in', () => {
  const list = models.parseGrokModels('Not logged in. Run grok login.\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n')
  assert.deepEqual(list.map((m) => m.id), ['grok-4.6', 'grok-4.5'])
  // no "Default model:" line, so the (default) marker on the bullet is the
  // only evidence there is, and it is believed
  assert.deepEqual(list.filter((m) => m.default).map((m) => m.id), ['grok-4.6'])
})

// ---- the shape gate --------------------------------------------------------
// A model id is pushed onto an agent's argv. Everything below is a flag, a
// path or a command in disguise, and a parser that "corrected" one would put a
// model nobody published on a real command line.

test('a model id that is not a model id never leaves a parser', () => {
  for (const bad of ['--dangerously-skip-permissions', '-m', '../../etc/passwd', 'a b', 'a"b', '$(whoami)', '', 'x'.repeat(80)]) {
    assert.equal(models.validModelId(bad), false, `${JSON.stringify(bad)} passed the shape gate`)
  }
  for (const good of ['gpt-5.6-luna', 'claude-opus-4-6-thinking', 'grok-4.6', 'fable', 'gemini-3.8-flash-high']) {
    assert.equal(models.validModelId(good), true, `${good} was refused`)
  }
  // and the gate is wired into the parsers, not just exported beside them
  assert.deepEqual(models.parseAgyModels('--rm -rf\tEvil\ngood-1\tGood\n').map((m) => m.id), ['good-1'])
  assert.deepEqual(models.parseGrokModels('  * --evil (default)\n  - fine-1\n').map((m) => m.id), ['fine-1'])
})

// ---- claude: the closed list, labelled --------------------------------------

test('claude offers its four aliases, labelled, with no default of its own', () => {
  const list = models.claudeModels()
  assert.deepEqual(list.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(list.map((m) => m.label), ['Claude Fable', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku'])
  // Claude Code picks its own model when Leg passes no --model; naming one here
  // would be Leg making a choice the human never made
  assert.equal(list.some((m) => m.default), false)
})

// ---- the cache: an agy or grok answer is never waited on --------------------

test('a cached agy catalog is served without running agy', () => {
  mkdirSync(join(HOME, 'models'), { recursive: true })
  writeFileSync(models.modelsCacheFile('agy'), JSON.stringify({
    models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', default: false }],
    observed_at: new Date().toISOString(),
  }))
  const t0 = Date.now()
  const list = models.modelsFor('agy')
  // the whole point: synchronous, off the cache file, in far less time than
  // spawning a CLI takes
  assert.ok(Date.now() - t0 < 200, `modelsFor('agy') took ${Date.now() - t0}ms: it waited on a process`)
  assert.deepEqual(list.map((m) => m.id), ['gemini-3.8-flash-high'])
})

test('a cache entry whose id is not a model id is dropped on the way out', () => {
  mkdirSync(join(HOME, 'models'), { recursive: true })
  writeFileSync(models.modelsCacheFile('grok'), JSON.stringify({
    models: [{ id: '--dangerously-skip-permissions' }, { id: 'grok-4.6', label: 'grok-4.6', default: true }],
    observed_at: new Date().toISOString(),
  }))
  assert.deepEqual(models.modelsFor('grok').map((m) => m.id), ['grok-4.6'])
  assert.equal(models.defaultModelFor('grok'), 'grok-4.6')
})

// Finding 13: an agent that is not installed, not logged in, or printing its
// list somewhere other than stdout answered nothing, nothing was cached, the
// entry stayed stale forever, and every board page load, New card dialog and
// floor load spawned a fresh `agy models` and `grok models`.
test('a probe that prints nothing is cached too, so a missing agy is asked once an hour and not once a request', async () => {
  const dir = join(HOME, 'probe-stub')
  mkdirSync(dir, { recursive: true })
  const counter = join(dir, 'spawns.log')
  const stub = join(dir, 'agy-stub.mjs')
  writeFileSync(counter, '')
  // exits 1 with nothing on stdout, the way an agy that is not logged in does,
  // and leaves one character per spawn behind it
  writeFileSync(stub, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(counter)}, 'x')\nprocess.exit(1)\n`)
  const before = { LEG: process.env.LEG_AGY_BIN, BATON: process.env.BATON_AGY_BIN }
  process.env.BATON_AGY_BIN = stub
  delete process.env.LEG_AGY_BIN
  const spawns = () => readFileSync(counter, 'utf8').length
  try {
    // a catalog Leg really saw once, an hour before this fruitless probe
    mkdirSync(join(HOME, 'models'), { recursive: true })
    const seenAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    writeFileSync(models.modelsCacheFile('agy'), JSON.stringify({ models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', default: false }], observed_at: seenAt }))

    assert.deepEqual(await models.refreshModels('agy'), [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', default: false }], 'the last list Leg saw survives a fruitless probe')
    assert.equal(spawns(), 1, `the first refresh spawned ${spawns()} processes`)

    // three more requests through the same door the board uses
    for (let i = 0; i < 3; i++) assert.deepEqual(models.modelsFor('agy').map((m) => m.id), ['gemini-3.8-flash-high'])
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(spawns(), 1, `three more requests spawned ${spawns() - 1} more agy processes`)

    // and the attempt is on the cache file, beside the older sighting
    const entry = JSON.parse(readFileSync(models.modelsCacheFile('agy'), 'utf8'))
    assert.equal(entry.observed_at, seenAt, 'a probe that saw nothing does not claim to have seen the list')
    assert.ok(Date.now() - Date.parse(entry.attempted_at) < 60_000, `the attempt was not stamped: ${entry.attempted_at}`)
  } finally {
    if (before.LEG === undefined) delete process.env.LEG_AGY_BIN; else process.env.LEG_AGY_BIN = before.LEG
    if (before.BATON === undefined) delete process.env.BATON_AGY_BIN; else process.env.BATON_AGY_BIN = before.BATON
  }
})

test('listModels names every agent, even the ones with nothing to say', () => {
  const { models: catalog, observed_at: at } = models.listModels()
  assert.deepEqual(Object.keys(catalog).sort(), ['agy', 'claude', 'codex', 'grok'])
  for (const agent of Object.keys(catalog)) assert.ok(Array.isArray(catalog[agent]), `${agent} is not a list`)
  assert.ok(Number.isFinite(Date.parse(at)), `observed_at is not a time: ${at}`)
})

// ---- the ladder accepts a catalog id ----------------------------------------

test('a rung may name a codex, agy or grok model from the live catalog', () => {
  const ladder = prefs.requireHandoffLadder([
    { agent: 'claude', account: 'default', model: 'fable' },
    { agent: 'codex', account: 'default', model: 'gpt-5.6-luna' },
    { agent: 'agy', account: 'default', model: 'gemini-3.8-flash-high' },
    { agent: 'grok', account: 'default', model: 'grok-4.6' },
  ])
  assert.deepEqual(ladder.map((r) => `${r.agent}/${r.model}`), ['claude/fable', 'codex/gpt-5.6-luna', 'agy/gemini-3.8-flash-high', 'grok/grok-4.6'])
})

test("claude's list is closed, so a fifth alias is refused by name", () => {
  assert.throws(
    () => prefs.requireHandoffLadder([{ agent: 'claude', account: 'default', model: 'astra' }]),
    /claude has no model "astra" \(fable, opus, sonnet, haiku\)/,
  )
})

test('a rung model that is a flag or a path is refused whatever the agent', () => {
  for (const agent of ['claude', 'codex', 'agy', 'grok']) {
    for (const bad of ['--dangerously-skip-permissions', '../../etc/passwd', 'two words', 'a"b']) {
      assert.throws(
        () => prefs.requireHandoffLadder([{ agent, account: 'default', model: bad }]),
        /must be a model id|has no model/,
        `${agent} accepted ${JSON.stringify(bad)} as a model`,
      )
    }
  }
})

// Finding 14: the docs still described the rule the code had before the board
// gained a model picker ("only claude has any"), so a user reading them could
// not predict which values preferences.json would refuse — while the board
// beside them saved codex, agy and grok models happily.
test('docs/configuration.md states the rung-model rule the code actually enforces', () => {
  const md = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8')
  const row = md.split('\n').find((l) => l.startsWith('| `handoff_ladder`'))
  assert.ok(row, 'the handoff_ladder row is gone from docs/configuration.md')
  assert.equal(/only claude has any/.test(row), false, 'the docs still say a rung may only name a claude alias')
  assert.ok(/closed list/.test(row), 'the docs do not say claude\'s four aliases are the closed half of the rule')
  for (const agent of ['codex', 'agy', 'grok']) {
    assert.ok(row.includes(agent), `the docs do not say ${agent} takes an id from its own catalog`)
  }
  // the two halves the code really has: a closed list for claude, a shape gate
  // for the rest (src/preferences.mjs validRungModel)
  assert.equal(prefs.validRungModel('claude', 'astra'), 'claude has no model "astra" (fable, opus, sonnet, haiku)')
  assert.equal(prefs.validRungModel('codex', 'gpt-5.6-luna'), null)
  assert.match(prefs.validRungModel('codex', 'gpt 5'), /must be a model id/)
  // and the site mirror was regenerated from the markdown, not left behind
  const html = readFileSync(join(ROOT, 'site', 'docs', 'configuration.html'), 'utf8')
  assert.equal(/only claude has any/.test(html), false, 'site/docs/configuration.html was not rebuilt from docs/configuration.md')
})

// ---- the route --------------------------------------------------------------

function request(base, path, { token = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(new URL(base + path), { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { /* not json */ } resolvePromise({ status: r.statusCode, text: data, json }) })
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/models answers the owner and refuses a guest', async () => {
  const TOKENS = { wes: share.newToken(), sam: share.newToken() }
  const roster = {
    version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: false,
    people: [['wes', 'owner'], ['sam', 'guest']].map(([name, role]) => ({ name, role, token_sha256: share.hashToken(TOKENS[name]), created_at: new Date().toISOString(), last_seen: null })),
  }
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster })
  const { port } = await srv.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const owner = await request(base, '/api/models', { token: TOKENS.wes })
    assert.equal(owner.status, 200, `the owner got ${owner.status}: ${owner.text.slice(0, 200)}`)
    assert.deepEqual(Object.keys(owner.json.models).sort(), ['agy', 'claude', 'codex', 'grok'])
    assert.deepEqual(owner.json.models.claude.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku'])

    // a guest picking a model is a guest spending the owner's plan: the same
    // 403 /api/adapters and /api/presets give, from the same guard
    const guest = await request(base, '/api/models', { token: TOKENS.sam })
    assert.equal(guest.status, 403, `a guest reached /api/models (${guest.status}): ${guest.text.slice(0, 200)}`)
    assert.match(guest.json.error, /belongs to the owner and the operators/)

    // L1: the same request with no token at all is refused before the guard,
    // so the 403 above really is the role check and not a dead route
    const stranger = await request(base, '/api/models')
    assert.equal(stranger.status, 401, `no token got ${stranger.status}`)
  } finally {
    await srv.stop()
  }
})
