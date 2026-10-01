// scripts/stripe-setup.mjs configures the seller's Stripe account, so here it
// never reaches Stripe: it runs in a temp directory with a fake test key, and
// a preloaded fetch double answers every request and records what was sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

const SITE = 'https://example.test'
const HOOK_URL = `${SITE}/api/webhook`
const REQUIRED = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'invoice.paid']

const DOUBLE = `
import { appendFileSync, readFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.env.STRIPE_DOUBLE_STATE, 'utf8'))
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url))
  if (u.origin !== 'https://api.stripe.com') throw new Error('unexpected host ' + u.origin)
  const method = options.method || 'GET'
  const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null
  appendFileSync(process.env.STRIPE_DOUBLE_LOG, JSON.stringify({ method, path: u.pathname, body }) + '\\n')
  if (u.pathname === '/v1/account') return json({ settings: { dashboard: { display_name: 'Practical Systems' } } })
  if (u.pathname === '/v1/prices') return json({ data: [{ id: 'price_' + u.searchParams.get('lookup_keys[0]') }] })
  if (u.pathname === '/v1/payment_links') return json({ data: ['price_leg_personal', 'price_leg_team'].map((p) => ({ url: 'https://buy.example.test/' + p, metadata: { baton_price: p, baton_site: state.site } })) })
  if (u.pathname === '/v1/webhook_endpoints' && method === 'GET') return json({ data: state.endpoints })
  if (u.pathname === '/v1/webhook_endpoints' && method === 'POST') return json({ id: 'we_created', url: body.url, status: 'enabled', secret: 'whsec_fixture' })
  if (u.pathname.startsWith('/v1/webhook_endpoints/') && method === 'POST') return json({ id: u.pathname.split('/').pop(), url: state.endpoints[0].url, status: 'enabled' })
  throw new Error('unexpected request ' + method + ' ' + u.pathname)
}
`

function runSetup(endpoints) {
  const dir = mkdtempSync(join(tmpdir(), 'leg-stripe-setup-'))
  try {
    const double = join(dir, 'double.mjs')
    const log = join(dir, 'requests.jsonl')
    writeFileSync(double, DOUBLE)
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ site: SITE, endpoints }))
    writeFileSync(join(dir, '.env'), '')
    writeFileSync(log, '')
    const stdout = execFileSync(process.execPath, ['--import', pathToFileURL(double).href, join(ROOT, 'scripts', 'stripe-setup.mjs'), '--site', SITE], {
      cwd: dir,
      encoding: 'utf8',
      // only a fake test key: nothing from the real environment reaches the script
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, STRIPE_TEST_SECRET_KEY: 'sk_test_fixture', STRIPE_DOUBLE_STATE: join(dir, 'state.json'), STRIPE_DOUBLE_LOG: log }
    })
    const requests = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return { stdout, requests }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const eventsOf = (body) => Object.keys(body).filter((k) => k.startsWith('enabled_events[')).map((k) => body[k])
const webhookWrites = (requests) => requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/webhook_endpoints'))

test('a new webhook endpoint subscribes to delayed payment success', () => {
  const { requests } = runSetup([])
  const writes = webhookWrites(requests)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/v1/webhook_endpoints')
  assert.equal(writes[0].body.url, HOOK_URL)
  assert.deepEqual(eventsOf(writes[0].body).sort(), [...REQUIRED].sort())
})

test('an existing endpoint without delayed payment success gets it added and keeps its other events', () => {
  const { stdout, requests } = runSetup([{ id: 'we_existing', url: HOOK_URL, status: 'enabled', enabled_events: ['checkout.session.completed', 'invoice.paid', 'customer.created'] }])
  const writes = webhookWrites(requests)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/v1/webhook_endpoints/we_existing')
  assert.deepEqual(eventsOf(writes[0].body).sort(), [...REQUIRED, 'customer.created'].sort())
  assert.equal(writes[0].body.url, undefined, 'the endpoint URL is not rewritten')
  assert.match(stdout, /added checkout\.session\.async_payment_succeeded/)
})

test('an endpoint that already receives every event is left alone', () => {
  for (const enabled_events of [REQUIRED, ['*']]) {
    const { requests } = runSetup([{ id: 'we_complete', url: HOOK_URL, status: 'enabled', enabled_events }])
    assert.deepEqual(webhookWrites(requests), [], `enabled_events ${enabled_events.join(',')}`)
    assert.ok(requests.length >= 4, `the script ran (${requests.length} requests)`)
  }
})
