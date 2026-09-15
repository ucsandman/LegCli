// trust — Baton writes the folder-trust answer each agent CLI would otherwise
// stop and ask for, so a 3am handoff into a repo the incoming agent has never
// seen does not sit on a prompt until morning.
//
// These tests care about one thing above correctness of the happy path: Baton
// is writing files it does not own. Every case below is either "it wrote the
// right thing" or "it kept its hands off", and the second kind is the point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo } from './helpers.mjs'
import {
  ensureTrust, ensureClaudeTrust, ensureCodexTrust, ensureAgyTrust,
  externalImports, repoRootOf, trustPolicy, codexTrustedPaths, claudeConfigFile, trustLine, claudeProjectKey,
} from '../src/trust.mjs'

const tmp = (p = 'baton-trust-') => mkdtempSync(join(tmpdir(), p))

function claudeHome({ config = { projects: {}, numStartups: 4 } } = {}) {
  const dir = tmp('baton-claude-cfg-')
  if (config) writeFileSync(join(dir, '.claude.json'), JSON.stringify(config, null, 2))
  return { dir, env: { CLAUDE_CONFIG_DIR: dir }, file: join(dir, '.claude.json') }
}

const read = (f) => JSON.parse(readFileSync(f, 'utf8'))

// ---- policy ----

test('the default policy is auto, and BATON_TRUST=never turns it off', () => {
  assert.equal(trustPolicy({}), 'auto')
  assert.equal(trustPolicy({ BATON_TRUST: 'auto' }), 'auto')
  for (const off of ['never', 'off', '0', 'NEVER', ' never ']) {
    assert.equal(trustPolicy({ BATON_TRUST: off }), 'never', `${off} should turn trust recording off`)
  }
})

test('BATON_TRUST=never writes nothing at all', () => {
  const repo = initRepo('baton-trust-repo-')
  const { env, file } = claudeHome()
  const before = readFileSync(file, 'utf8')
  const r = ensureTrust('claude', repo, { env: { ...env, BATON_TRUST: 'never' } })
  assert.deepEqual(r.wrote, [])
  assert.equal(r.skipped, 'BATON_TRUST=never')
  assert.equal(readFileSync(file, 'utf8'), before, 'the config must be byte-identical')
})

// ---- the repository root is the unit of trust ----

test('a subdirectory and a Baton worktree both resolve to the repository root', () => {
  const repo = initRepo('baton-trust-repo-')
  const deep = join(repo, '.baton-worktrees', 'card-1', 'src')
  mkdirSync(deep, { recursive: true })
  assert.equal(repoRootOf(deep), repoRootOf(repo))
  assert.equal(repoRootOf(join(repo, 'src')), repoRootOf(repo))
})

// ---- claude ----

test('claude: the trust flag is written for the repo root and nothing else is lost', () => {
  const repo = initRepo('baton-trust-repo-')
  const { env, file } = claudeHome({ config: { numStartups: 7, projects: { 'C:\\other': { allowedTools: ['Bash'] } }, oauthAccount: { id: 'keep-me' } } })
  const r = ensureClaudeTrust(repo, { env })
  assert.equal(r.skipped, null)
  assert.ok(r.wrote.includes('hasTrustDialogAccepted'))
  const cfg = read(file)
  assert.equal(cfg.numStartups, 7, 'unrelated top-level keys survive')
  assert.deepEqual(cfg.oauthAccount, { id: 'keep-me' }, 'the login block survives')
  assert.deepEqual(cfg.projects['C:\\other'], { allowedTools: ['Bash'] }, 'another project survives untouched')
  const mine = cfg.projects[claudeProjectKey(repoRootOf(repo))]
  assert.ok(mine, 'the repo root has an entry')
  assert.equal(mine.hasTrustDialogAccepted, true)
})

// Regression. Claude Code keys a project by a forward-slash path with an
// upper-case drive letter; Baton first shipped this with Windows-native
// backslashes, which writes a second entry that Claude Code never reads. The
// flag was on file, the prompt still appeared, and nothing said why.
test('claude: the project key is the spelling Claude Code actually looks up', () => {
  assert.equal(claudeProjectKey('C:\\Projects\\baton'), 'C:/Projects/baton')
  assert.equal(claudeProjectKey('c:\\Projects\\baton\\'), 'C:/Projects/baton', 'drive upper-cased, trailing separator dropped')
  const repo = initRepo('baton-trust-repo-')
  const key = claudeProjectKey(repoRootOf(repo))
  assert.ok(!key.includes('\\'), `no backslash in the key, got ${key}`)
  const { env, file } = claudeHome()
  ensureClaudeTrust(repo, { env })
  assert.ok(Object.prototype.hasOwnProperty.call(read(file).projects, key), 'the entry is under the key Claude Code reads')
})

test('claude: an entry already there under an older spelling is corrected, not duplicated', () => {
  const repo = initRepo('baton-trust-repo-')
  const root = repoRootOf(repo)
  const legacy = root.replace(/\//g, '\\')
  const { env, file } = claudeHome({ config: { projects: { [legacy]: { allowedTools: ['Bash'] } } } })
  ensureClaudeTrust(repo, { env })
  const projects = read(file).projects
  assert.equal(projects[claudeProjectKey(root)].hasTrustDialogAccepted, true, 'the current spelling gets the flag')
  if (legacy !== claudeProjectKey(root)) {
    assert.equal(projects[legacy].hasTrustDialogAccepted, true, 'an existing older entry is brought up to date too')
    assert.deepEqual(projects[legacy].allowedTools, ['Bash'], 'and keeps what it already had')
  }
  assert.equal(Object.keys(projects).length, legacy === claudeProjectKey(root) ? 1 : 2, 'no third entry invented')
})

// The answer on file is the user's, including "no". An earlier version treated
// "not true" as "not asked yet", which silently turned a folder the user had
// deliberately refused to trust into a trusted one, on every run in that repo.
test('claude: a folder the user refused to trust stays refused', () => {
  const repo = initRepo('baton-trust-repo-')
  const key = claudeProjectKey(repoRootOf(repo))
  const { env, file } = claudeHome({ config: { projects: { [key]: { hasTrustDialogAccepted: false, allowedTools: [] } } } })
  const before = readFileSync(file, 'utf8')
  const r = ensureClaudeTrust(repo, { env })
  assert.deepEqual(r.wrote, [], 'a refusal is an answer, not a gap')
  assert.match(r.skipped, /answered no/)
  assert.equal(readFileSync(file, 'utf8'), before, 'the config must be byte-identical')
  assert.equal(read(file).projects[key].hasTrustDialogAccepted, false)
})

test('claude: imports declined earlier are not re-approved', () => {
  const parent = tmp('baton-trust-tree-')
  mkdirSync(join(parent, '.claude'), { recursive: true })
  writeFileSync(join(parent, '.claude', 'shared.md'), 'x\n')
  writeFileSync(join(parent, 'CLAUDE.md'), '@.claude/shared.md\n')
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  const key = claudeProjectKey(repoRootOf(repo))
  // WarningShown true with Approved false is exactly what declining records.
  const { env, file } = claudeHome({ config: { projects: { [key]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } } } })
  ensureClaudeTrust(repo, { env })
  const entry = read(file).projects[key]
  assert.equal(entry.hasClaudeMdExternalIncludesApproved, false, 'a declined import stays declined')
  assert.equal(entry.hasTrustDialogAccepted, true, 'the unanswered trust question is still answered')
})

test('agy: a folder recorded as not trusted stays that way', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-gemini-')
  const file = join(dir, 'trustedFolders.json')
  writeFileSync(file, JSON.stringify({ [repoRootOf(repo)]: 'DO_NOT_TRUST' }, null, 2))
  const before = readFileSync(file, 'utf8')
  const r = ensureAgyTrust(repo, { env: { GEMINI_CONFIG_DIR: dir } })
  assert.deepEqual(r.wrote, [])
  assert.match(r.skipped, /answered no/)
  assert.equal(readFileSync(file, 'utf8'), before, 'the trust file must be byte-identical')
})

test('claude: a second call writes nothing, because the file already says it', () => {
  const repo = initRepo('baton-trust-repo-')
  const { env, file } = claudeHome()
  ensureClaudeTrust(repo, { env })
  const after = readFileSync(file, 'utf8')
  const again = ensureClaudeTrust(repo, { env })
  assert.deepEqual(again.wrote, [], 'nothing to say that the file does not already say')
  assert.equal(readFileSync(file, 'utf8'), after, 'byte-identical on the second run')
})

test('claude: no config file means claude has never run, so Baton does not create one', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-claude-empty-')
  const r = ensureClaudeTrust(repo, { env: { CLAUDE_CONFIG_DIR: dir } })
  assert.deepEqual(r.wrote, [])
  assert.match(r.skipped, /no claude config/)
  assert.equal(existsSync(join(dir, '.claude.json')), false, 'Baton must not create the config')
})

test('claude: an unreadable config is left exactly as it was found', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-claude-bad-')
  const file = join(dir, '.claude.json')
  writeFileSync(file, '{ this is not json')
  const r = ensureClaudeTrust(repo, { env: { CLAUDE_CONFIG_DIR: dir } })
  assert.deepEqual(r.wrote, [])
  assert.match(r.skipped, /not readable json/)
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json')
})

test('claude: the config path follows CLAUDE_CONFIG_DIR, and falls back to the home file', () => {
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: 'C:\\cfg' }), join('C:\\cfg', '.claude.json'))
  assert.match(claudeConfigFile({}), /\.claude\.json$/)
})

// ---- external CLAUDE.md imports ----

test('an import that resolves outside the working directory is found and reported', () => {
  const parent = tmp('baton-trust-tree-')
  const shared = join(parent, '.claude')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'house-rules.md'), 'rules\n')
  writeFileSync(join(parent, 'CLAUDE.md'), '@.claude/house-rules.md\n')
  const repo = join(parent, 'work')
  mkdirSync(repo)
  writeFileSync(join(repo, 'CLAUDE.md'), '# local\n@./local-only.md\n')
  writeFileSync(join(repo, 'local-only.md'), 'local\n')

  const found = externalImports(repo)
  assert.equal(found.length, 1, `expected one external import, got ${JSON.stringify(found)}`)
  assert.match(found[0], /house-rules\.md$/)
  assert.ok(!found.some((f) => /local-only/.test(f)), 'an import inside the working directory is not external')
})

test('claude: the import booleans are set only when there is an external import to approve', () => {
  const plain = initRepo('baton-trust-plain-')
  const a = claudeHome()
  const noImports = ensureClaudeTrust(plain, { env: a.env })
  assert.deepEqual(noImports.imports, [])
  const entry = read(a.file).projects[claudeProjectKey(repoRootOf(plain))]
  assert.equal(entry.hasTrustDialogAccepted, true)
  assert.equal(entry.hasClaudeMdExternalIncludesApproved, undefined, 'nothing to approve, so nothing is approved')
  assert.equal(entry.hasClaudeMdExternalIncludesWarningShown, undefined)

  const parent = tmp('baton-trust-tree-')
  mkdirSync(join(parent, '.claude'), { recursive: true })
  writeFileSync(join(parent, '.claude', 'shared.md'), 'x\n')
  writeFileSync(join(parent, 'CLAUDE.md'), '@.claude/shared.md\n')
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  const b = claudeHome()
  const withImports = ensureClaudeTrust(repo, { env: b.env })
  assert.equal(withImports.imports.length, 1)
  const e2 = read(b.file).projects[claudeProjectKey(repoRootOf(repo))]
  assert.equal(e2.hasClaudeMdExternalIncludesApproved, true)
  assert.equal(e2.hasClaudeMdExternalIncludesWarningShown, true)
})

test('the printed line names the repo, the file, and every import it approved', () => {
  const parent = tmp('baton-trust-tree-')
  mkdirSync(join(parent, '.claude'), { recursive: true })
  writeFileSync(join(parent, '.claude', 'shared.md'), 'x\n')
  writeFileSync(join(parent, 'CLAUDE.md'), '@.claude/shared.md\n')
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  const { env } = claudeHome()
  const line = trustLine(ensureClaudeTrust(repo, { env }))
  assert.match(line, /shared\.md/, 'the approved import is named, not counted')
  assert.match(line, /BATON_TRUST=never/, 'the line says how to turn it off')
  assert.equal(trustLine({ agent: 'claude', wrote: [] }), null, 'nothing written, nothing printed')
})

// ---- codex ----

test('codex: the project table is appended and the rest of the file is untouched', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-codex-')
  const file = join(dir, 'config.toml')
  const original = 'model = "gpt-5"\n\n[projects."C:\\\\Projects\\\\elsewhere"]\ntrust_level = "trusted"\n'
  writeFileSync(file, original)
  const r = ensureCodexTrust(repo, { env: { CODEX_HOME: dir } })
  assert.deepEqual(r.wrote, ['trust_level'])
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith(original), 'the original content is still there, unchanged, at the top')
  assert.ok(codexTrustedPaths(text).some((p) => p.toLowerCase() === repoRootOf(repo).toLowerCase()))
})

test('codex: a folder already trusted is not written again, in either spelling', () => {
  const repo = initRepo('baton-trust-repo-')
  const root = repoRootOf(repo)
  for (const spelling of [root, `\\\\?\\${root}`]) {
    const dir = tmp('baton-codex-')
    const file = join(dir, 'config.toml')
    writeFileSync(file, `[projects."${spelling.replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`)
    const before = readFileSync(file, 'utf8')
    const r = ensureCodexTrust(repo, { env: { CODEX_HOME: dir } })
    assert.deepEqual(r.wrote, [], `already trusted as ${spelling}`)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('codex: no config file means no write', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-codex-empty-')
  const r = ensureCodexTrust(repo, { env: { CODEX_HOME: dir } })
  assert.deepEqual(r.wrote, [])
  assert.equal(existsSync(join(dir, 'config.toml')), false)
})

// ---- agy ----

test('agy: the folder is added to trustedFolders.json and the others survive', () => {
  const repo = initRepo('baton-trust-repo-')
  const dir = tmp('baton-gemini-')
  const file = join(dir, 'trustedFolders.json')
  writeFileSync(file, JSON.stringify({ 'C:\\Projects\\elsewhere': 'TRUST_FOLDER' }, null, 2))
  const r = ensureAgyTrust(repo, { env: { GEMINI_CONFIG_DIR: dir } })
  assert.deepEqual(r.wrote, ['TRUST_FOLDER'])
  const map = read(file)
  assert.equal(map['C:\\Projects\\elsewhere'], 'TRUST_FOLDER', 'the other folder survives')
  assert.equal(map[repoRootOf(repo)], 'TRUST_FOLDER')
  assert.deepEqual(ensureAgyTrust(repo, { env: { GEMINI_CONFIG_DIR: dir } }).wrote, [], 'idempotent')
})

test('agy: no ~/.gemini at all means no write', () => {
  const repo = initRepo('baton-trust-repo-')
  const r = ensureAgyTrust(repo, { env: { GEMINI_CONFIG_DIR: join(tmpdir(), 'baton-gemini-not-here-at-all') } })
  assert.deepEqual(r.wrote, [])
  assert.match(r.skipped, /no agy config/)
})

// ---- dispatcher ----

test('an agent with no trust record of its own is a no-op, not an error', () => {
  const repo = initRepo('baton-trust-repo-')
  const r = ensureTrust('fake', repo, { env: {} })
  assert.deepEqual(r.wrote, [])
  assert.match(r.skipped, /no trust record/)
})

test('a failure to write a trust record never throws at the caller', () => {
  const r = ensureTrust('claude', join(tmpdir(), 'baton-no-such-repo-at-all'), { env: { CLAUDE_CONFIG_DIR: join(tmpdir(), 'baton-no-such-cfg') } })
  assert.deepEqual(r.wrote, [])
  assert.ok(r.skipped, 'it reports why rather than failing the session')
})
