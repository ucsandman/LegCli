import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)
const lib = require('../site/api/_lib.js')
const keyHandler = require('../site/api/key.js')
const webhookHandler = require('../site/api/webhook.js')

const originalFetch = globalThis.fetch
const originalEnv = {
  BATON_LICENSE_PRIVATE_KEY: process.env.BATON_LICENSE_PRIVATE_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET
}
const pair = generateKeyPairSync('ed25519')
process.env.BATON_LICENSE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
process.env.STRIPE_SECRET_KEY = 'sk_test_site_api'

after(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body })
const teamSubscription = (over = {}) => ({
  id: 'sub_team',
  status: 'active',
  created: 1789084800,
  items: { data: [{ price: { lookup_key: 'baton_team' }, quantity: 4, current_period_end: 1791763200 }] },
  ...over
})
const response = () => {
  const result = { statusCode: 200, headers: {}, body: '' }
  result.setHeader = (key, value) => { result.headers[key] = value }
  result.end = (body = '') => { result.body = body }
  return result
}

async function callWebhook(event, secret) {
  const raw = JSON.stringify(event)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  const req = Readable.from([Buffer.from(raw)])
  req.method = 'POST'
  req.headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` }
  const res = response()
  await webhookHandler(req, res)
  return res
}

async function captureErrors(run) {
  const original = console.error
  const lines = []
  console.error = (...args) => { lines.push(args.map(String).join(' ')) }
  try { await run() } finally { console.error = original }
  return lines
}

async function rejects400(run) {
  await assert.rejects(run, (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /not for a Baton plan/)
    return true
  })
}

function throws400(run) {
  assert.throws(run, (error) => {
    assert.equal(error.status, 400)
    assert.equal(error.message, 'this subscription is not for a Baton Team plan')
    return true
  })
}

test('planOf accepts only the two exact Baton lookup keys', () => {
  assert.equal(lib.planOf({ lookup_key: 'baton_team' }), 'team')
  assert.equal(lib.planOf({ lookup_key: 'baton_personal' }), 'personal')
  assert.equal(lib.planOf({ lookup_key: 'unrelated_team' }), null)
  assert.equal(lib.planOf({ lookup_key: 'unrelated_personal' }), null)
  assert.equal(lib.planOf({ metadata: { plan: 'team' } }), null)
  assert.equal(lib.planOf({ metadata: { plan: 'personal' } }), null)
})

test('an unrelated subscription is rejected with 400 before license signing', async () => {
  const privateKey = process.env.BATON_LICENSE_PRIVATE_KEY
  delete process.env.BATON_LICENSE_PRIVATE_KEY
  try {
    throws400(() => lib.licenseFromSubscription(teamSubscription({
      id: 'sub_unrelated',
      items: { data: [{ price: { lookup_key: 'unrelated_team', metadata: { plan: 'team' } }, quantity: 99, current_period_end: 1791763200 }] }
    })))
  } finally {
    process.env.BATON_LICENSE_PRIVATE_KEY = privateKey
  }
})

test('an unrelated paid checkout is rejected despite lookup-key and metadata impostors', async () => {
  globalThis.fetch = async () => jsonResponse({
    id: 'cs_test_unrelated',
    payment_status: 'paid',
    mode: 'payment',
    status: 'complete',
    created: 1789084800,
    customer_details: { email: 'buyer@example.test' },
    line_items: { data: [{ price: { lookup_key: 'unrelated_personal', metadata: { plan: 'personal' } }, quantity: 1 }] }
  })
  await rejects400(() => lib.licenseFromSession('cs_test_unrelated'))
})

test('a subscription-mode Personal checkout is rejected without issuing or emailing a key', async () => {
  const secret = 'test-webhook-secret'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = 'test-resend-key'
  const session = {
    id: 'cs_test_personalsub',
    payment_status: 'paid',
    mode: 'subscription',
    status: 'complete',
    created: 1789084800,
    customer_details: { email: 'buyer@example.test' },
    subscription: 'sub_personalsub',
    line_items: { data: [{ price: { lookup_key: 'baton_personal' }, quantity: 1 }] }
  }
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/checkout/sessions/')) return jsonResponse(session)
    return jsonResponse({ id: 'email_should_not_send' })
  }
  await rejects400(() => lib.licenseFromSession(session.id))
  const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  const req = Readable.from([Buffer.from(raw)])
  req.method = 'POST'
  req.headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` }
  const res = response()
  await webhookHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).error, 'this checkout is not for a Baton plan')
  assert.equal(calls.filter((url) => url.includes('api.resend.com')).length, 0)
})

test('a valid Baton Team subscription signs the expected plan and seats', () => {
  const { key, payload } = lib.licenseFromSubscription(teamSubscription())
  assert.match(key, /^BATON-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(payload.plan, 'team')
  assert.equal(payload.seats, 4)
})

test('a valid paid Baton Personal checkout signs a personal license', async () => {
  globalThis.fetch = async () => jsonResponse({
    id: 'cs_test_personal',
    payment_status: 'paid',
    mode: 'payment',
    status: 'complete',
    created: 1789084800,
    customer_details: { email: 'buyer@example.test' },
    line_items: { data: [{ price: { lookup_key: 'baton_personal' }, quantity: 1 }] }
  })
  const { key, payload } = await lib.licenseFromSession('cs_test_personal')
  assert.match(key, /^BATON-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(payload.plan, 'personal')
  assert.equal(payload.seats, 1)
})

test('/api/key cannot refresh an unrelated subscription into a Team license', async () => {
  const sub = teamSubscription({
    id: 'sub_refreshbad',
    items: { data: [{ price: { lookup_key: 'unrelated_team', metadata: { plan: 'team' } }, quantity: 25, current_period_end: 1791763200 }] }
  })
  globalThis.fetch = async () => jsonResponse(sub)
  const license = 'lic_' + lib.sha(sub.id).slice(0, 20)
  const res = response()
  await keyHandler({ method: 'GET', url: `/api/key?license=${license}&sub=${sub.id}` }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'this subscription is not for a Baton Team plan')
  assert.equal(JSON.parse(res.body).key, undefined)
})

test('an unrelated subscription-cycle invoice is acknowledged without sending email', async () => {
  const secret = 'whsec_site_api_test'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = 're_test_site_api'
  const raw = JSON.stringify({
    type: 'invoice.paid',
    data: { object: { subscription: 'sub_invoicebad', billing_reason: 'subscription_cycle', customer_email: 'buyer@example.test' } }
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/subscriptions/')) return jsonResponse(teamSubscription({
      id: 'sub_invoicebad',
      items: { data: [{ price: { lookup_key: 'unrelated_team', metadata: { plan: 'team' } }, quantity: 10, current_period_end: 1791763200 }] }
    }))
    return jsonResponse({ id: 'email_should_not_send' })
  }
  const req = Readable.from([Buffer.from(raw)])
  req.method = 'POST'
  req.headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` }
  const res = response()
  await webhookHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).error, 'this subscription is not for a Baton Team plan')
  assert.equal(calls.filter((url) => url.includes('api.resend.com')).length, 0)
})

test('missing Resend configuration is a retryable visible failure with redacted logs', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  delete process.env.RESEND_API_KEY
  const skipped = await lib.sendKeyEmail({ to: 'sensitive-recipient@example.test', key: '<TEST_LICENSE_KEY>', payload: { plan: 'personal' } })
  assert.deepEqual(skipped, { skipped: true, reason: 'missing_resend_api_key', retryable: true })
  const session = {
    id: 'cs_test_missingmail', payment_status: 'paid', mode: 'payment', status: 'complete', created: 1789084800,
    customer_details: { email: 'sensitive-recipient@example.test' },
    line_items: { data: [{ price: { lookup_key: 'baton_personal' }, quantity: 1 }] }
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('/checkout/sessions/')) return jsonResponse(session)
    throw new Error('email transport must not run without configuration')
  }
  let res
  const logs = await captureErrors(async () => { res = await callWebhook({ type: 'checkout.session.completed', data: { object: session } }, secret) })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { received: true, delivery: { status: 'failed', reason: 'missing_resend_api_key', retryable: true } })
  assert.deepEqual(logs, ['Baton license delivery failed: reason=missing_resend_api_key retryable=true'])
  assert.doesNotMatch(logs.join('\n'), /sensitive-recipient|TEST_LICENSE_KEY|Authorization|customer_details/)
})

test('missing recipient is a terminal visible failure with redacted logs', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = '<TEST_RESEND_API_KEY>'
  globalThis.fetch = async (url) => {
    if (String(url).includes('/subscriptions/')) return jsonResponse(teamSubscription({ id: 'sub_sensitive_customer' }))
    throw new Error('email transport must not run without a recipient')
  }
  let res
  const event = { type: 'invoice.paid', data: { object: { subscription: 'sub_sensitive_customer', billing_reason: 'subscription_cycle' } } }
  const logs = await captureErrors(async () => { res = await callWebhook(event, secret) })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true, delivery: { status: 'failed', reason: 'missing_recipient', retryable: false } })
  assert.deepEqual(logs, ['Baton license delivery failed: reason=missing_recipient retryable=false'])
  assert.doesNotMatch(logs.join('\n'), /sub_sensitive_customer|TEST_LICENSE_KEY|Authorization|customer/)
})

test('an accepted Resend request is visible without exposing delivery details', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = '<TEST_RESEND_API_KEY>'
  const session = {
    id: 'cs_test_acceptedmail', payment_status: 'paid', mode: 'payment', status: 'complete', created: 1789084800,
    customer_details: { email: 'buyer@example.test' },
    line_items: { data: [{ price: { lookup_key: 'baton_personal' }, quantity: 1 }] }
  }
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/checkout/sessions/')) return jsonResponse(session)
    return jsonResponse({ id: '<TEST_MESSAGE_ID>' })
  }
  const res = await callWebhook({ type: 'checkout.session.completed', data: { object: session } }, secret)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true, delivery: { status: 'accepted' } })
  assert.equal(calls.filter((url) => url.includes('api.resend.com')).length, 1)
})

test('an ignored Stripe event makes no email-delivery claim', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  globalThis.fetch = async () => { throw new Error('ignored events must not make requests') }
  const res = await callWebhook({ type: 'customer.created', data: { object: { id: 'cus_ignored' } } }, secret)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true })
})
