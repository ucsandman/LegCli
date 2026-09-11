import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickRunnable, landingRepos } from '../src/scheduler.mjs'

// default leases are distinct per card so only the cap or an explicit lease decides
const c = (id, over = {}) => ({ card_id: id, repo: 'R', status: 'queued', leases: [`lanes/${id}/**`], created_at: `2026-09-10T00:00:0${id.slice(-1)}Z`, station: 'build', leg: 0, ...over })

test('pickRunnable honours the concurrency cap in created order', () => {
  const { start, blocked } = pickRunnable([c('c3'), c('c1'), c('c2')], { max: 2 })
  assert.deepEqual(start.map((x) => x.card_id), ['c1', 'c2'])
  assert.deepEqual(blocked.map((b) => [b.card.card_id, b.reason]), [['c3', 'concurrency cap 2']])
})

test('pickRunnable counts running and handing_off cards against the cap', () => {
  const { start, blocked } = pickRunnable([c('c1', { status: 'running' }), c('c2', { status: 'handing_off' }), c('c3')], { max: 2 })
  assert.deepEqual(start, [])
  assert.equal(blocked[0].card.card_id, 'c3')
})

test('pickRunnable serializes overlapping leases and names the holder', () => {
  const { start, blocked } = pickRunnable([c('c1', { status: 'running', leases: ['src/**'] }), c('c2', { leases: ['src/x.js'] }), c('c3', { leases: ['docs/**'] })], { max: 5 })
  assert.deepEqual(start.map((x) => x.card_id), ['c3'])
  assert.equal(blocked[0].card.card_id, 'c2')
  assert.deepEqual(blocked[0].conflicts[0], { holder: 'c1', lease: 'src/**', against: 'src/x.js' })
})

test('pickRunnable: a card started this tick blocks a later overlapping one; no leases = wildcard', () => {
  const { start, blocked } = pickRunnable([c('c1', { leases: ['src/a/**'] }), c('c2', { leases: ['src/a/x.js'] }), c('c3', { leases: [] })], { max: 5 })
  assert.deepEqual(start.map((x) => x.card_id), ['c1'])
  assert.deepEqual(blocked.map((b) => b.card.card_id), ['c2', 'c3'])
  assert.equal(blocked[1].conflicts[0].holder, 'c1')
})

test('pickRunnable: leases only conflict within the same repo; a landing repo blocks its queued cards', () => {
  const { start } = pickRunnable([c('c1', { status: 'running', repo: 'A', leases: ['src/**'] }), c('c2', { repo: 'B', leases: ['src/**'] })], { max: 5 })
  assert.deepEqual(start.map((x) => x.card_id), ['c2'])
  const landPipe = [{ name: 'build', kind: 'agent', chain: [{ adapter: 'fake' }] }, { name: 'land', kind: 'land' }]
  const landing = pickRunnable([c('c2', { repo: 'B', station: 'land', pipeline: landPipe }), c('c3', { repo: 'B', station: 'build', pipeline: landPipe })], { max: 5, landing: new Set(['B']) })
  assert.deepEqual(landing.start.map((x) => x.card_id), ['c3'], 'a build station keeps running while the repo lands')
  assert.equal(landing.blocked[0].card.card_id, 'c2')
  assert.equal(landing.blocked[0].reason, 'repo is landing')
})

test('the landing set comes from the station KIND and compares repos canonically', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sched-repo-'))
  const spelledTwice = join(tmp, 'r', '..', 'r')
  const pipe = [{ name: 'build', kind: 'agent', chain: [{ adapter: 'fake' }] }, { name: 'ship', kind: 'land' }]
  const landing = landingRepos([c('c1', { status: 'running', station: 'ship', pipeline: pipe, repo: join(tmp, 'r') })])
  assert.equal(landing.size, 1, 'a land station named anything but "land" still counts')
  const { start, blocked } = pickRunnable([c('c2', { station: 'ship', pipeline: pipe, repo: spelledTwice })], { max: 5, landing })
  assert.deepEqual(start, [])
  assert.equal(blocked[0]?.reason, 'repo is landing')
})
