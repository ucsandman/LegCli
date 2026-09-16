// Scale check for history discovery: a store the size of a busy year (2,000
// Claude transcripts across 40 project dirs, 300 Codex rollouts) indexes in
// seconds the first time, in well under a second when nothing changed, and
// a page of the list comes back fast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { makeHome } from './helpers.mjs'
import { allStores, id as uuid } from './history-fixture.mjs'

const HOME = makeHome()
process.env.LEG_HOME = HOME
process.env.BATON_HOME = HOME
const H = await import('../src/history/index.mjs')

const CLAUDE = 2000
const CODEX = 300
const claude = Array.from({ length: CLAUDE }, (_, i) => ({ id: uuid(10000 + i), title: `conversation ${i}`, cwd: `C:\\Projects\\p${i % 40}`, updated: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(), prompts: ['one', 'two'] }))
const codex = Array.from({ length: CODEX }, (_, i) => ({ id: uuid(20000 + i), title: `thread ${i}`, cwd: `C:\\Projects\\p${i % 40}`, day: `2026/0${1 + (i % 9)}/${String(1 + (i % 28)).padStart(2, '0')}`, updated: new Date(Date.UTC(2026, 3, 1) + i * 3600000).toISOString() }))
const f = allStores(join(HOME, 'stores'), { claude, codex })

test(`a first pass over ${CLAUDE + CODEX} transcripts stays under 8 s`, (t) => {
  const t0 = performance.now()
  const r = H.refreshIndex({ homes: f.homes })
  const ms = performance.now() - t0
  t.diagnostic(`first refresh (${CLAUDE + CODEX} files): ${ms.toFixed(0)} ms`)
  assert.equal(r.stats[0].records, CLAUDE)
  assert.equal(r.stats[1].records, CODEX)
  assert.ok(ms < 8000, `first refresh took ${ms.toFixed(0)} ms`)
})

test('a pass with nothing changed re-reads no file and stays under 1.5 s', (t) => {
  const t0 = performance.now()
  const r = H.refreshIndex({ homes: f.homes })
  const ms = performance.now() - t0
  t.diagnostic(`unchanged refresh: ${ms.toFixed(0)} ms`)
  assert.deepEqual(r.stats.slice(0, 2).map((s) => s.parsed), [0, 0])
  assert.ok(ms < 1500, `unchanged refresh took ${ms.toFixed(0)} ms`)
})

test('a page of fifty, filtered and searched, answers in under 400 ms', (t) => {
  const t0 = performance.now()
  const page = H.listHistory({ homes: f.homes, refresh: false, sessions: [], limit: 50 })
  const filtered = H.listHistory({ homes: f.homes, refresh: false, sessions: [], provider: 'codex', search: 'thread 12', limit: 50 })
  const ms = performance.now() - t0
  t.diagnostic(`two listings over ${CLAUDE + CODEX} records: ${ms.toFixed(0)} ms`)
  assert.equal(page.total, CLAUDE + CODEX)
  assert.equal(page.records.length, 50)
  assert.equal(page.records[0].title, 'thread 299', 'newest first')
  assert.ok(filtered.total >= 1 && filtered.total <= 11)
  assert.ok(ms < 400, `listing took ${ms.toFixed(0)} ms`)
})
