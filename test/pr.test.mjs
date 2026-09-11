import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prArgv, prBody, openPr } from '../src/stations/pr.mjs'

const card = { card_id: 'card-1', title: 'Rename greet', task: 'Rename greet() to hello()', trunk: 'main', repo: process.cwd(), pipeline: [{ name: 'build' }, { name: 'land' }] }

test('pr mode builds the gh pr create argv and runs it only through BATON_GH_BIN (a stub here); never a real gh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'))
  const stub = join(dir, 'gh-stub.mjs')
  writeFileSync(stub, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.GH_STUB_LOG, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write('https://example.invalid/org/repo/pull/42\\n')\n")
  const log = join(dir, 'argv.json')
  const runDir = join(dir, 'run')
  const prev = { bin: process.env.BATON_GH_BIN, log: process.env.GH_STUB_LOG }
  process.env.BATON_GH_BIN = stub
  process.env.GH_STUB_LOG = log
  try {
    const r = openPr({ card, runDir, bundleSummary: 'two findings' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.url, 'https://example.invalid/org/repo/pull/42')
    const argv = JSON.parse(readFileSync(log, 'utf8'))
    assert.deepEqual(argv.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', 'baton/card-1'])
    assert.equal(argv[argv.indexOf('--title') + 1], 'Rename greet')
    const body = readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8')
    assert.ok(body.includes('Rename greet() to hello()'))
    assert.ok(body.includes('two findings'))
    assert.ok(existsSync(join(runDir, 'pr-body.md')))
  } finally {
    if (prev.bin === undefined) delete process.env.BATON_GH_BIN; else process.env.BATON_GH_BIN = prev.bin
    if (prev.log === undefined) delete process.env.GH_STUB_LOG; else process.env.GH_STUB_LOG = prev.log
  }
})

test('pr mode without BATON_GH_BIN refuses (stub-only build) instead of finding a real gh', () => {
  const prev = process.env.BATON_GH_BIN
  delete process.env.BATON_GH_BIN
  try {
    const r = openPr({ card, runDir: mkdtempSync(join(tmpdir(), 'pr-')) })
    assert.equal(r.ok, false)
    assert.match(r.error, /BATON_GH_BIN is not set/)
  } finally {
    if (prev !== undefined) process.env.BATON_GH_BIN = prev
  }
  assert.deepEqual(prArgv({ card, bodyFile: 'b.md' }), ['pr', 'create', '--base', 'main', '--head', 'baton/card-1', '--title', 'Rename greet', '--body-file', 'b.md'])
  assert.match(prBody(card), /## Task/)
})
