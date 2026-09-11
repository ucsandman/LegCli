import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, literalPrefix, overlap, anyOverlap, conflicts, held } from '../src/leases.mjs'

test('exact', () => {
  assert.equal(overlap('src/a.js', 'src/a.js'), true)
  assert.equal(overlap('src/a.js', 'src/b.js'), false)
})

test('prefix', () => {
  assert.equal(overlap('src', 'src/a.js'), true)
})

test('glob', () => {
  assert.equal(overlap('src/**', 'src/a.js'), true)
  assert.equal(overlap('src/*', 'src/x/a.js'), true) // deliberate approximation
})

test('disjoint', () => {
  assert.equal(overlap('src/**', 'docs/**'), false)
})

test('wildcard', () => {
  assert.equal(overlap('**', 'anything'), true)
})

test('empty-means-wildcard', () => {
  assert.equal(normalize(''), '**')
  assert.equal(normalize(null), '**')
  assert.equal(normalize(undefined), '**')
  assert.equal(overlap('', 'x'), true)
})

test('backslash-normalization', () => {
  assert.equal(normalize('src\\a.js'), 'src/a.js')
  assert.equal(normalize('./src//a.js/'), 'src/a.js')
  assert.equal(normalize('/src/a.js'), 'src/a.js')
  assert.equal(overlap('src\\a.js', 'src/a.js'), true)
})

test('segment-wise-not-string-prefix', () => {
  assert.equal(overlap('src/ab', 'src/a'), false)
})

test('anyOverlap', () => {
  assert.equal(anyOverlap(['src/**'], ['docs/**', 'src/a.js']), true)
  assert.equal(anyOverlap(['src/**'], ['docs/**']), false)
  assert.equal(anyOverlap([], ['anything']), true) // empty means wildcard
  assert.equal(anyOverlap(undefined, ['anything']), true)
})

test('literalPrefix', () => {
  assert.deepEqual(literalPrefix('src/**'), ['src'])
  assert.deepEqual(literalPrefix('src/a/*.js'), ['src', 'a'])
  assert.deepEqual(literalPrefix('docs/x.md'), ['docs', 'x.md'])
  assert.deepEqual(literalPrefix('**'), [])
})

test('conflicts names holder and both leases', () => {
  const candidate = { card_id: 'c-new', leases: ['src/a.js'] }
  const running = [
    { card_id: 'c-1', leases: ['docs/**'] },
    { card_id: 'c-2', leases: ['src/**'] },
  ]
  const out = conflicts(candidate, running)
  assert.deepEqual(out, [{ holder: 'c-2', lease: 'src/**', against: 'src/a.js' }])
})

test('conflicts treats missing/empty leases as wildcard on both sides', () => {
  assert.deepEqual(
    conflicts({ card_id: 'c-new', leases: [] }, [{ card_id: 'c-1', leases: ['docs/**'] }]),
    [{ holder: 'c-1', lease: 'docs/**', against: '**' }],
  )
  assert.deepEqual(
    conflicts({ card_id: 'c-new', leases: ['src/a.js'] }, [{ card_id: 'c-1', leases: [] }]),
    [{ holder: 'c-1', lease: '**', against: 'src/a.js' }],
  )
})

test('conflicts returns empty array when free to start', () => {
  const out = conflicts({ card_id: 'c-new', leases: ['src/a.js'] }, [{ card_id: 'c-1', leases: ['docs/**'] }])
  assert.deepEqual(out, [])
})

test('held lists running and handing_off cards only', () => {
  const cards = [
    { card_id: 'c-2', leases: ['src/**'], station: 'build', status: 'running', updated_at: '2026-09-10T00:00:02Z' },
    { card_id: 'c-1', leases: [], station: 'plan', status: 'handing_off', updated_at: '2026-09-10T00:00:01Z' },
    { card_id: 'c-3', leases: ['docs/**'], station: 'done', status: 'done', updated_at: '2026-09-10T00:00:03Z' },
    { card_id: 'c-4', leases: ['docs/**'], station: 'backlog', status: 'backlog', updated_at: '2026-09-10T00:00:04Z' },
  ]
  assert.deepEqual(held(cards), [
    { lease: '**', card_id: 'c-1', station: 'plan', since: '2026-09-10T00:00:01Z' },
    { lease: 'src/**', card_id: 'c-2', station: 'build', since: '2026-09-10T00:00:02Z' },
  ])
})
