#!/usr/bin/env node
// fake-agent — stands in for a coding-agent CLI in tests and the demo. It acts
// in the process cwd (the card's worktree). FAKE_MODE selects behaviour:
//   success      write the target file and .leg/DONE, print a result JSON, exit 0
//   incomplete   write the target file but no DONE marker, exit 0
//   limit        print the recorded limit text (FAKE_LIMIT_FIXTURE, default
//                claude-session-limit) to the fixture's stream, exit with its code
//   stall        never finish (10 min), so the supervisor's timers fire
//   auth         print "another auth source is set" to stderr, exit 1
//   crash        print a stack trace to stderr, exit 2
//   no_progress  exit 0 touching nothing
//   break-test   (land demo) write the target plus a failing test, DONE
//   fix-test     (land demo) remove the failing test, DONE
//   resolve-rebase (land demo) git rebase -X theirs <FAKE_TRUNK>, DONE
// FAKE_CONTENT is the target file's content (default "hi").
//   fail         (phase 2 alias of crash with a fake secret in stderr) exit 1
//   sleep        (phase 2 alias of stall)
//   envcheck     report which forbidden variables leaked into this process
// FAKE_TARGET names the file success/incomplete write (default hello-fake.txt).
// FAKE_DELAY_MS waits before acting. Output goes through process.stdout/stderr
// on purpose: this IS a CLI.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.env.FAKE_MODE || 'success'
const target = process.env.FAKE_TARGET || 'hello-fake.txt'
const delay = parseInt(process.env.FAKE_DELAY_MS || '0', 10)
const cwd = process.cwd()
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'limits')

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolvePromise(data))
    process.stdin.on('error', () => resolvePromise(data))
    process.stdin.resume()
  })
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadFixture(id) {
  for (const d of readdirSync(FIXTURES)) {
    const f = join(FIXTURES, d, `${id}.json`)
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  }
  throw new Error(`unknown FAKE_LIMIT_FIXTURE ${id}`)
}

function writeTarget() {
  mkdirSync(dirname(join(cwd, target)), { recursive: true })
  writeFileSync(join(cwd, target), (process.env.FAKE_CONTENT ?? 'hi') + '\n')
}

function writeDone(line) {
  mkdirSync(join(cwd, '.leg'), { recursive: true })
  writeFileSync(join(cwd, '.leg', 'DONE'), line + '\n')
}

const prompt = process.stdin.isTTY ? '' : await readStdin()
if (delay > 0) await sleep(delay)

if (mode === 'success') {
  writeTarget()
  writeDone(`wrote ${target}`)
  out({ session_id: 'sess-fake', result: `wrote ${target} and .leg/DONE`, prompt_chars: prompt.length, argv: process.argv.slice(2) })
  process.exit(0)
} else if (mode === 'break-test') {
  // land demo: ship the change together with a failing test
  writeTarget()
  mkdirSync(join(cwd, 'test'), { recursive: true })
  writeFileSync(join(cwd, 'test', 'broken.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('broken on purpose by fake-agent', () => { assert.equal(1, 2) })\n")
  writeDone(`wrote ${target} and a failing test`)
  out({ session_id: 'sess-fake', result: 'done (with a broken test)' })
  process.exit(0)
} else if (mode === 'fix-test') {
  // land demo: the bounce told us the tests are red; remove the broken one
  rmSync(join(cwd, 'test', 'broken.test.mjs'), { force: true })
  writeTarget()
  writeDone('fixed the failing test')
  out({ session_id: 'sess-fake', result: 'removed the broken test' })
  process.exit(0)
} else if (mode === 'resolve-rebase') {
  // land demo: the bounce said the rebase conflicted; rebase onto trunk keeping our side
  const trunk = process.env.FAKE_TRUNK || 'main'
  const r = spawnSync('git', ['rebase', '-X', 'theirs', trunk], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) {
    spawnSync('git', ['rebase', '--abort'], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
    process.stderr.write(`fake-agent: rebase failed: ${r.stderr}\n`)
    process.exit(1)
  }
  writeDone(`rebased onto ${trunk}`)
  out({ session_id: 'sess-fake', result: `rebased onto ${trunk}` })
  process.exit(0)
} else if (mode === 'incomplete') {
  writeTarget()
  out({ session_id: 'sess-fake', result: `wrote ${target}, ran out of turns before DONE`, prompt_chars: prompt.length })
  process.exit(0)
} else if (mode === 'limit') {
  const fx = loadFixture(process.env.FAKE_LIMIT_FIXTURE || 'claude-session-limit')
  const text = fx.text
  if (fx.where === 'stderr') {
    process.stderr.write(text + '\n')
  } else {
    // claude-shaped error result so the real adapter's parseResult reads it too
    out({ type: 'result', subtype: 'error', is_error: true, result: text, session_id: 'sess-fake' })
  }
  process.exit(fx.exit_code ?? 1)
} else if (mode === 'stall' || mode === 'sleep') {
  await sleep(600000)
  process.exit(0)
} else if (mode === 'auth') {
  process.stderr.write('Error: another auth source is set (ANTHROPIC_API_KEY); using it instead of your login\n')
  process.exit(1)
} else if (mode === 'crash') {
  process.stderr.write('TypeError: Cannot read properties of undefined (reading \'plan\')\n    at run (file:///fake-agent.mjs:1:1)\n')
  process.exit(2)
} else if (mode === 'fail') {
  process.stderr.write('boom line one\n')
  process.stderr.write('api_key=sk-abcdefgh12345678 leaked\n')
  process.exit(1)
} else if (mode === 'no_progress') {
  out({ session_id: 'sess-fake', result: 'I could not find anything to do.', prompt_chars: prompt.length })
  process.exit(0)
} else if (mode === 'envcheck') {
  const forbidden = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA']
  const leaked = forbidden.filter((k) => process.env[k] !== undefined)
  for (const k of Object.keys(process.env)) {
    if (/^CLAUDE_CODE_/.test(k) && k !== 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS') leaked.push(k)
  }
  if (process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS !== '0') leaked.push('CEILING!=0')
  out({ session_id: leaked.length ? 'LEAKED:' + leaked.join('+') : 'clean-env' })
  process.exit(0)
} else {
  process.stderr.write(`fake-agent: unknown FAKE_MODE "${mode}"\n`)
  process.exit(2)
}
