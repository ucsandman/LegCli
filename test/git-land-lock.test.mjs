// One land at a time per repo root — across two spellings of that root and
// across two processes. Each land's test command writes <tag>-start, waits for
// the other land's start marker, then writes <tag>-end, so two lands that run
// at the same time interleave the four lines and a serialised pair never does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { makeHome, initRepo } from './helpers.mjs'
import { ensure } from '../src/worktree.mjs'
import { land, isLanding } from '../src/mergequeue.mjs'

process.env.BATON_HOME = makeHome()

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'land-lock-'))

const marker = join(scratch, 'marker.mjs')
writeFileSync(marker, [
  "import { appendFileSync, readFileSync } from 'node:fs'",
  'const [file, tag, other, waitMs] = process.argv.slice(2)',
  "appendFileSync(file, tag + '-start\\n')",
  'const deadline = Date.now() + Number(waitMs)',
  'while (Date.now() < deadline) {',
  "  if (readFileSync(file, 'utf8').includes(other + '-start')) break",
  '  await new Promise((r) => setTimeout(r, 50))',
  '}',
  "appendFileSync(file, tag + '-end\\n')",
  '',
].join('\n'))

const childLander = join(scratch, 'child-land.mjs')
writeFileSync(childLander, [
  `const { land } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'mergequeue.mjs')).href)})`,
  'const [repo, wt, id, cmd] = process.argv.slice(2)',
  "const r = await land({ card_id: id, title: id, repo, trunk: 'main', test_command: cmd, land_attempts: 0 }, wt)",
  'process.stdout.write(JSON.stringify(r))',
  '',
].join('\n'))

const markerCommand = (log, tag, other, waitMs) => `node ${marker} ${log} ${tag} ${other} ${waitMs}`
const card = (repo, id, testCommand) => ({ card_id: id, title: `card ${id}`, repo, trunk: 'main', test_command: testCommand, land_attempts: 0 })

function lines(log) {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

function newLog(name) {
  const log = join(scratch, name)
  writeFileSync(log, '')
  return log
}

test('two spellings of one repo root take the same turn (the queue key is canonical)', async () => {
  const repo = initRepo('land-canon-')
  const other = process.platform === 'win32' ? repo[0].toLowerCase() + repo.slice(1) : repo + sep
  assert.notEqual(other, repo, 'the two spellings differ as raw strings')
  const log = newLog('canon.log')
  const wtA = ensure(repo, 'canon-a').path
  const wtB = ensure(repo, 'canon-b').path
  writeFileSync(join(wtA, 'a.txt'), 'a\n')
  writeFileSync(join(wtB, 'b.txt'), 'b\n')
  const a = land(card(repo, 'canon-a', markerCommand(log, 'A', 'B', 1500)), wtA)
  assert.equal(isLanding(other), true, 'isLanding sees the other spelling of the same root')
  const b = land(card(other, 'canon-b', markerCommand(log, 'B', 'A', 1500)), wtB)
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.landed, true, JSON.stringify(ra))
  assert.equal(rb.landed, true, JSON.stringify(rb))
  const seq = lines(log)
  assert.equal(seq.length, 4, seq.join(' '))
  assert.equal(seq[0][0], seq[1][0], `the two lands overlapped: ${seq.join(' ')}`)
})

test('a second process cannot land into the same root while this one holds the turn', async () => {
  const repo = initRepo('land-proc-')
  const log = newLog('proc.log')
  const wtA = ensure(repo, 'proc-a').path
  const wtB = ensure(repo, 'proc-b').path
  writeFileSync(join(wtA, 'a.txt'), 'a\n')
  writeFileSync(join(wtB, 'b.txt'), 'b\n')
  const child = execFileAsync(process.execPath, [childLander, repo, wtB, 'proc-b', markerCommand(log, 'B', 'A', 4000)], { env: process.env, encoding: 'utf8' })
  const ra = await land(card(repo, 'proc-a', markerCommand(log, 'A', 'B', 4000)), wtA)
  const out = await child
  const rb = JSON.parse(out.stdout)
  assert.equal(ra.landed, true, JSON.stringify(ra))
  assert.equal(rb.landed, true, out.stdout + out.stderr)
  const seq = lines(log)
  assert.equal(seq.length, 4, seq.join(' '))
  assert.equal(seq[0][0], seq[1][0], `two processes landed into one root at once: ${seq.join(' ')}`)
})
