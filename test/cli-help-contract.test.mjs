// Every flag Leg passes to an agent CLI must be one that CLI still lists in its
// own --help. fixtures/help/<cli>.txt is the help text captured from the
// version pinned in fixtures/verified.json, so a CLI that renames or drops a
// flag fails here on the next re-capture instead of in a user's terminal.
// Headless flags come from each adapter's argv() in every variant it has;
// interactive flags are the ones src/attach.mjs spawnSpec adds, and
// codex's headless flags are read against `codex exec --help`, the subcommand
// they belong to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import claude from '../src/adapters/claude.mjs'
import codex from '../src/adapters/codex.mjs'
import agy from '../src/adapters/agy.mjs'
import grok from '../src/adapters/grok.mjs'
import { modelFlagFor } from '../src/buckets.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const help = (name) => readFileSync(join(root, 'fixtures', 'help', `${name}.txt`), 'utf8')

// The option heads of a help text: a line indented at most six spaces that
// starts with a dash, cut at the first two-space gap (where a same-line
// description begins). Description lines are indented further, so a flag a
// description merely mentions is never counted as an option.
function options(text) {
  const set = new Set()
  for (const line of text.split('\n')) {
    const m = line.match(/^( {0,6})(-\S.*)$/)
    if (!m) continue
    const head = m[2].split(/\s{2,}/)[0]
    for (const flag of head.matchAll(/(?<![\w-])--?[A-Za-z][\w-]*/g)) set.add(flag[0])
  }
  return set
}

// A flag the CLI accepts without listing it. One entry at most, each with
// the document that says so and the live run that proved it.
const UNLISTED = {
  claude: {
    // fixtures/live/claude/max-turns-probe.json: accepted by 2.1.332 in print mode
    '--max-turns': 'https://code.claude.com/docs/en/cli-reference',
  },
}

const VARIANTS = [
  {},
  { model: 'm' },
  { resume: 'r' },
  { maxTurns: 3 },
  { promptFile: 'p.txt' },
  { allowedTools: ['Read'] },
  { runDir: 'run' },
]

function headlessFlags(adapter) {
  const flags = new Set()
  for (const v of VARIANTS) {
    const { args } = adapter.argv({ prompt: 'hi', cwd: root, ...v })
    for (const a of args) if (/^--?[A-Za-z]/.test(a)) flags.add(a)
  }
  return [...flags]
}

const INTERACTIVE = {
  claude: ['-n', '--settings', '--resume', '--dangerously-skip-permissions'],
  codex: ['--ask-for-approval'],
  agy: ['--log-file', '-i', '--dangerously-skip-permissions'],
  grok: ['--debug-file', '--always-approve'],
}

const CASES = [
  ['claude', claude, 'claude'],
  ['codex', codex, 'codex-exec'],
  ['agy', agy, 'agy'],
  ['grok', grok, 'grok'],
]

for (const [name, adapter, helpFile] of CASES) {
  test(`${name}: every headless flag the adapter emits is listed in fixtures/help/${helpFile}.txt`, () => {
    const listed = options(help(helpFile))
    assert.ok(listed.size > 5, `${helpFile}.txt parsed to ${listed.size} options`)
    const flags = headlessFlags(adapter)
    assert.ok(flags.length >= 3, `${name} argv emitted ${flags.length} flags`)
    const missing = flags.filter((f) => !listed.has(f) && !UNLISTED[name]?.[f])
    assert.deepEqual(missing, [], `${name} passes ${missing.join(', ')}, which fixtures/help/${helpFile}.txt does not list`)
  })

  test(`${name}: every interactive flag Leg adds is listed in fixtures/help/${name}.txt`, () => {
    const listed = options(help(name))
    const attach = readFileSync(join(root, 'src', 'attach.mjs'), 'utf8')
    const flags = [...INTERACTIVE[name], modelFlagFor(name)]
    for (const f of INTERACTIVE[name]) assert.ok(attach.includes(`'${f}'`), `src/attach.mjs still passes ${f} for ${name}`)
    const missing = flags.filter((f) => !listed.has(f))
    assert.deepEqual(missing, [], `leg ${name} passes ${missing.join(', ')}, which fixtures/help/${name}.txt does not list`)
  })
}

test('codex: exec is a codex command and resume is an exec command', () => {
  assert.match(help('codex'), /^ {2}exec\s/m)
  assert.match(help('codex-exec'), /^ {2}resume\s/m)
})

test('the unlisted allowlist stays at one flag, each with a documentation URL', () => {
  const entries = Object.values(UNLISTED).flatMap((o) => Object.entries(o))
  assert.ok(entries.length <= 1, `${entries.length} unlisted flags`)
  for (const [flag, url] of entries) assert.match(url, /^https:\/\//, `${flag} names its source`)
  assert.ok(!options(help('claude')).has('--max-turns'), 'claude --help now lists --max-turns: drop the allowlist entry')
})
