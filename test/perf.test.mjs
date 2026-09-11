// Scale check: 50 backlog cards should not slow the scheduler's read side or
// the board's card list. Seeds through scripts/seed-fake-cards.mjs (the same
// createCard path the CLI uses), then times one in-process scheduler tick and
// one GET /api/cards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { makeHome, initRepo, ROOT } from './helpers.mjs'

const CARD_COUNT = 50

// BATON_HOME must be set before scheduler.mjs / server.mjs (and the store.mjs
// they import) load, same as test/server.test.mjs.
const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
const repo = initRepo('perf-')

const SEED_SCRIPT = join(ROOT, 'scripts', 'seed-fake-cards.mjs')
const seedOut = execFileSync(process.execPath, [SEED_SCRIPT, '--home', HOME, '--repo', repo, '--count', String(CARD_COUNT)], { encoding: 'utf8' })

test(`seed-fake-cards.mjs creates ${CARD_COUNT} backlog cards`, () => {
  assert.match(seedOut, new RegExp(`seeded ${CARD_COUNT} card\\(s\\)`))
})

test(`scheduler tick with ${CARD_COUNT} cards stays under 50 ms`, async (t) => {
  const { createScheduler } = await import('../src/scheduler.mjs')
  const s = createScheduler({ intervalMs: 60000 })
  const t0 = performance.now()
  await s.tick()
  const ms = performance.now() - t0
  t.diagnostic(`scheduler tick (${CARD_COUNT} cards): ${ms.toFixed(2)} ms`)
  assert.ok(ms < 50, `tick took ${ms.toFixed(2)} ms, expected < 50 ms`)
})

test(`GET /api/cards for ${CARD_COUNT} cards answers in < 200 ms`, async (t) => {
  const { createBoardServer } = await import('../src/server.mjs')
  const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false })
  const { port } = await srv.start()
  try {
    const t0 = performance.now()
    const body = await new Promise((resolvePromise, reject) => {
      http.get(`http://127.0.0.1:${port}/api/cards`, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolvePromise(data))
      }).on('error', reject)
    })
    const ms = performance.now() - t0
    const json = JSON.parse(body)
    t.diagnostic(`GET /api/cards (${CARD_COUNT} cards): ${ms.toFixed(2)} ms`)
    assert.equal(json.cards.length, CARD_COUNT)
    assert.ok(ms < 200, `GET /api/cards took ${ms.toFixed(2)} ms, expected < 200 ms`)
  } finally {
    await srv.stop()
  }
})
