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
  LEG_LICENSE_PRIVATE_KEY: process.env.LEG_LICENSE_PRIVATE_KEY,
  BATON_LICENSE_PRIVATE_KEY: process.env.BATON_LICENSE_PRIVATE_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET
}
const pair = generateKeyPairSync('ed25519')
process.env.LEG_LICENSE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
process.env.BATON_LICENSE_PRIVATE_KEY = process.env.LEG_LICENSE_PRIVATE_KEY
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

async function callKeyRefresh(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/key'
  req.headers = { 'content-type': 'application/json' }
  const res = response()
  await keyHandler(req, res)
  return res
}

function teamProof(sub, over = {}) {
  return lib.signLicense({
    v: 1,
    id: 'lic_' + lib.sha(sub).slice(0, 20),
    plan: 'team',
    seats: 4,
    issued: '2025-01-01',
    expires: '2025-01-04',
    sub,
    ...over
  })
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
    assert.match(error.message, /not for a (Leg|Leg) plan/)
    return true
  })
}

function throws400(run) {
  assert.throws(run, (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /this subscription is not for a (Leg|Leg) Team plan/)
    return true
  })
}

test('planOf accepts both leg and legacy baton lookup keys', () => {
  assert.equal(lib.planOf({ lookup_key: 'leg_team' }), 'team')
  assert.equal(lib.planOf({ lookup_key: 'leg_personal' }), 'personal')
  assert.equal(lib.planOf({ lookup_key: 'baton_team' }), 'team')
  assert.equal(lib.planOf({ lookup_key: 'baton_personal' }), 'personal')
  assert.equal(lib.planOf({ lookup_key: 'unrelated_team' }), null)
  assert.equal(lib.planOf({ lookup_key: 'unrelated_personal' }), null)
  assert.equal(lib.planOf({ metadata: { plan: 'team' } }), null)
  assert.equal(lib.planOf({ metadata: { plan: 'personal' } }), null)
})

test('an unrelated subscription is rejected with 400 before license signing', async () => {
  const privateKey = process.env.LEG_LICENSE_PRIVATE_KEY || process.env.BATON_LICENSE_PRIVATE_KEY
  delete process.env.LEG_LICENSE_PRIVATE_KEY
  delete process.env.BATON_LICENSE_PRIVATE_KEY
  try {
    throws400(() => lib.licenseFromSubscription(teamSubscription({
      id: 'sub_unrelated',
      items: { data: [{ price: { lookup_key: 'unrelated_team', metadata: { plan: 'team' } }, quantity: 99, current_period_end: 1791763200 }] }
    })))
  } finally {
    process.env.LEG_LICENSE_PRIVATE_KEY = privateKey
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
  assert.equal(JSON.parse(res.body).error, 'this checkout is not for a Leg plan')
  assert.equal(calls.filter((url) => url.includes('api.resend.com')).length, 0)
})

test('a valid Leg Team subscription signs the expected plan and seats', () => {
  const { key, payload } = lib.licenseFromSubscription(teamSubscription())
  assert.match(key, /^(LEG|BATON)-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(payload.plan, 'team')
  assert.equal(payload.seats, 4)
})

test('a valid paid Leg Personal checkout signs a personal license', async () => {
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
  assert.match(key, /^(LEG|BATON)-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(payload.plan, 'personal')
  assert.equal(payload.seats, 1)
  const res = response()
  await keyHandler({ method: 'GET', url: '/api/key?session_id=cs_test_personal' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).plan, 'personal')
})

test('/api/key requires a signed Team key before looking up a subscription', async () => {
  const calls = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return jsonResponse(teamSubscription()) }

  const publicSub = 'sub_public'
  const publicLicense = 'lic_' + lib.sha(publicSub).slice(0, 20)
  const oldGet = response()
  await keyHandler({ method: 'GET', url: `/api/key?license=${publicLicense}&sub=${publicSub}` }, oldGet)
  assert.equal(oldGet.statusCode, 405)

  const missing = await callKeyRefresh({})
  assert.equal(missing.statusCode, 403)

  const genuine = teamProof('sub_forged')
  const [payload, signature] = genuine.replace(/^(LEG|BATON)-/, '').split('.')
  const forged = await callKeyRefresh({ key: `LEG-${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}` })
  assert.equal(forged.statusCode, 403)

  const personal = await callKeyRefresh({ key: lib.signLicense({ v: 1, id: 'lic_personal', plan: 'personal', seats: 1, issued: '2025-01-01', updates_until: '2027-01-01' }) })
  assert.equal(personal.statusCode, 403)

  const mismatch = await callKeyRefresh({ key: teamProof('sub_mismatch', { id: 'lic_wrong' }) })
  assert.equal(mismatch.statusCode, 403)
  assert.equal(calls.length, 0, 'no unproved subscription id reaches Stripe')
})

test('/api/key refreshes an expired signed Team key while the subscription is active', async () => {
  const calls = []
  const sub = teamSubscription({ id: 'sub_expiredproof' })
  globalThis.fetch = async (url) => { calls.push(String(url)); return jsonResponse(sub) }
  const res = await callKeyRefresh({ key: teamProof(sub.id) })
  assert.equal(res.statusCode, 200)
  assert.match(JSON.parse(res.body).key, /^(LEG|BATON)-/)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/subscriptions\/sub_expiredproof$/)
})

test('/api/key refuses an inactive subscription after signed proof', async () => {
  const sub = teamSubscription({ id: 'sub_inactive', status: 'canceled' })
  globalThis.fetch = async () => jsonResponse(sub)
  const res = await callKeyRefresh({ key: teamProof(sub.id) })
  assert.equal(res.statusCode, 402)
  assert.equal(JSON.parse(res.body).error, 'the subscription is canceled')
  assert.equal(JSON.parse(res.body).key, undefined)
})

test('/api/key cannot refresh an unrelated subscription into a Team license', async () => {
  const sub = teamSubscription({
    id: 'sub_refreshbad',
    items: { data: [{ price: { lookup_key: 'unrelated_team', metadata: { plan: 'team' } }, quantity: 25, current_period_end: 1791763200 }] }
  })
  globalThis.fetch = async () => jsonResponse(sub)
  const res = await callKeyRefresh({ key: teamProof(sub.id) })
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'this subscription is not for a Leg Team plan')
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
  assert.equal(JSON.parse(res.body).error, 'this subscription is not for a Leg Team plan')
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
  assert.deepEqual(logs, ['Leg license delivery failed: reason=missing_resend_api_key retryable=true'])
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
  assert.deepEqual(logs, ['Leg license delivery failed: reason=missing_recipient retryable=false'])
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

test('a valid Stripe v1 signature is accepted during secret rollover regardless of header order', () => {
  const secret = 'whsec_rotation'
  const raw = JSON.stringify({ id: 'evt_rotation' })
  const timestamp = Math.floor(Date.now() / 1000)
  const valid = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  assert.equal(lib.verifyStripeSignature(raw, `t=${timestamp},v1=${valid},v1=invalid`, secret), true)
  assert.equal(lib.verifyStripeSignature(raw, `t=${timestamp},v1=invalid,v1=${valid}`, secret), true)
})

test('an identical webhook replay uses one Resend idempotency key', async () => {
  const secret = 'whsec_replay'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = 're_test_replay'
  const session = {
    id: 'cs_test_replay', payment_status: 'paid', mode: 'payment', status: 'complete', created: 1789084800,
    customer_details: { email: 'buyer@example.test' },
    line_items: { data: [{ price: { lookup_key: 'baton_personal' }, quantity: 1 }] }
  }
  const resendKeys = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/checkout/sessions/')) return jsonResponse(session)
    if (String(url).includes('api.resend.com')) {
      resendKeys.push(options.headers['Idempotency-Key'])
      return jsonResponse({ id: '<TEST_MESSAGE_ID>' })
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const event = { id: 'evt_test_replay', type: 'checkout.session.completed', data: { object: session } }
  const first = await callWebhook(event, secret)
  const second = await callWebhook(event, secret)
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(resendKeys.length, 2)
  assert.equal(resendKeys[0], resendKeys[1])
  assert.equal(resendKeys[0], 'stripe-webhook:evt_test_replay:checkout.session.completed')
})

test('a replay with changed Team seats keeps its delivery key and accepts Resend payload conflict', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = '<TEST_RESEND_API_KEY>'
  const subscription = teamSubscription({ id: 'sub_replay_changed' })
  const session = (quantity) => ({
    id: 'cs_test_replay_changed', payment_status: 'paid', mode: 'subscription', status: 'complete', created: 1789084800,
    customer_details: { email: 'buyer@example.test' }, subscription,
    line_items: { data: [{ price: { lookup_key: 'baton_team' }, quantity }] }
  })
  const sessions = [session(3), session(4)]
  const resendKeys = []
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/checkout/sessions/')) return jsonResponse(sessions.shift())
    if (String(url).includes('api.resend.com')) {
      resendKeys.push(options.headers['Idempotency-Key'])
      return resendKeys.length === 1
        ? jsonResponse({ id: '<TEST_MESSAGE_ID>' })
        : { ok: false, status: 409, json: async () => ({ name: 'invalid_idempotent_request', message: 'modified body' }) }
    }
    throw new Error(`unexpected request: ${url}`)
  }
  const event = { id: 'evt_test_replay_changed', type: 'checkout.session.completed', data: { object: session(3) } }
  const first = await callWebhook(event, secret)
  const second = await callWebhook(event, secret)
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(resendKeys, [
    'stripe-webhook:evt_test_replay_changed:checkout.session.completed',
    'stripe-webhook:evt_test_replay_changed:checkout.session.completed'
  ])
  assert.deepEqual(JSON.parse(second.body), { received: true, delivery: { status: 'failed', reason: 'idempotency_payload_mismatch', retryable: false } })
})

test('a concurrent Resend idempotency conflict remains retryable', async () => {
  process.env.RESEND_API_KEY = '<TEST_RESEND_API_KEY>'
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ name: 'concurrent_idempotent_requests', message: 'in progress' }) })
  await assert.rejects(
    lib.sendKeyEmail({ to: 'buyer@example.test', key: '<TEST_LICENSE_KEY>', payload: { plan: 'personal' }, idempotencyKey: 'stripe-webhook:evt_concurrent:checkout.session.completed' }),
    /in progress/
  )
})

test('an ignored Stripe event makes no email-delivery claim', async () => {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  globalThis.fetch = async () => { throw new Error('ignored events must not make requests') }
  const res = await callWebhook({ type: 'customer.created', data: { object: { id: 'cus_ignored' } } }, secret)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true })
})

// Checkout and license delivery: delayed Personal payments, and Team keys
// that read their seats from the subscription as it is now.

const keyPayload = (key) => JSON.parse(Buffer.from(key.replace(/^(LEG|BATON)-/, '').split('.')[0], 'base64url').toString('utf8'))
const personalSession = (over = {}) => ({
  id: 'cs_test_delayed', object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', created: 1789084800,
  customer_details: { email: 'buyer@example.test' },
  line_items: { data: [{ price: { lookup_key: 'leg_personal' }, quantity: 1 }] },
  ...over
})

// A Stripe and Resend double: the session Stripe returns now (which can differ
// from the copy inside an event), and every email Resend was asked to send.
function stripeAndResend({ session, subscription, resend = () => jsonResponse({ id: '<TEST_MESSAGE_ID>' }) } = {}) {
  const calls = { stripe: [], emails: [] }
  globalThis.fetch = async (url, options = {}) => {
    url = String(url)
    if (url.includes('api.resend.com')) {
      calls.emails.push({ idempotencyKey: options.headers['Idempotency-Key'], ...JSON.parse(options.body) })
      return resend(calls.emails.length)
    }
    calls.stripe.push(url)
    if (url.includes('/checkout/sessions/')) return jsonResponse(session)
    if (url.includes('/subscriptions/')) return jsonResponse(subscription)
    throw new Error(`unexpected request: ${url}`)
  }
  return calls
}
const emailedKey = (email) => email.text.match(/Key:\n(\S+)/)[1]

function webhookEnv() {
  const secret = '<TEST_WEBHOOK_SECRET>'
  process.env.STRIPE_WEBHOOK_SECRET = secret
  process.env.RESEND_API_KEY = '<TEST_RESEND_API_KEY>'
  return secret
}

test('a delayed Personal payment that succeeds is fulfilled once from the re-read session', async () => {
  const secret = webhookEnv()
  const calls = stripeAndResend({ session: personalSession() })
  const event = { id: 'evt_async_ok', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }
  const res = await callWebhook(event, secret)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true, delivery: { status: 'accepted' } })
  assert.equal(calls.stripe.length, 1)
  assert.match(calls.stripe[0], /\/checkout\/sessions\/cs_test_delayed\?/)
  assert.equal(calls.emails.length, 1)
  assert.deepEqual(calls.emails[0].to, ['buyer@example.test'])
  assert.equal(calls.emails[0].idempotencyKey, 'stripe-webhook:evt_async_ok:checkout.session.async_payment_succeeded')
  const payload = keyPayload(emailedKey(calls.emails[0]))
  assert.equal(payload.plan, 'personal')
  assert.equal(payload.seats, 1)
})

test('a delayed-success event whose session Stripe still reports unpaid issues no key', async () => {
  const secret = webhookEnv()
  const calls = stripeAndResend({ session: personalSession({ payment_status: 'unpaid' }) })
  const event = { id: 'evt_async_unpaid', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }
  const res = await callWebhook(event, secret)
  assert.equal(calls.emails.length, 0)
  assert.equal(JSON.parse(res.body).key, undefined)
  assert.equal(JSON.parse(res.body).delivery, undefined)
})

test('a delayed-success event for a non-Personal one-time price issues no key', async () => {
  const secret = webhookEnv()
  const impostor = personalSession({ line_items: { data: [{ price: { lookup_key: 'leg_team' }, quantity: 1 }] } })
  const calls = stripeAndResend({ session: impostor })
  const res = await callWebhook({ id: 'evt_async_team_price', type: 'checkout.session.async_payment_succeeded', data: { object: impostor } }, secret)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).error, 'this checkout is not for a Leg plan')
  assert.equal(calls.emails.length, 0)
  const unrelated = personalSession({ line_items: { data: [{ price: { lookup_key: 'unrelated_personal', metadata: { plan: 'personal' } }, quantity: 1 }] } })
  const again = stripeAndResend({ session: unrelated })
  const res2 = await callWebhook({ id: 'evt_async_unrelated', type: 'checkout.session.async_payment_succeeded', data: { object: unrelated } }, secret)
  assert.equal(res2.statusCode, 200)
  assert.equal(JSON.parse(res2.body).error, 'this checkout is not for a Leg plan')
  assert.equal(again.emails.length, 0)
})

test('a delayed payment that fails, or a checkout that completes unpaid, issues no key and calls nobody', async () => {
  const secret = webhookEnv()
  const calls = stripeAndResend({ session: personalSession({ payment_status: 'unpaid' }) })
  const unpaid = personalSession({ payment_status: 'unpaid' })
  const completed = await callWebhook({ id: 'evt_completed_unpaid', type: 'checkout.session.completed', data: { object: unpaid } }, secret)
  const failed = await callWebhook({ id: 'evt_async_failed', type: 'checkout.session.async_payment_failed', data: { object: unpaid } }, secret)
  for (const res of [completed, failed]) {
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { received: true })
  }
  assert.deepEqual(calls, { stripe: [], emails: [] })
})

test('delayed success arriving before the unpaid completion sends exactly one key', async () => {
  const secret = webhookEnv()
  // by the time either event is handled, Stripe reports the session paid
  const calls = stripeAndResend({ session: personalSession() })
  const succeeded = await callWebhook({ id: 'evt_order_success', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }, secret)
  const completed = await callWebhook({ id: 'evt_order_completed', type: 'checkout.session.completed', data: { object: personalSession({ payment_status: 'unpaid' }) } }, secret)
  assert.equal(succeeded.statusCode, 200)
  assert.equal(completed.statusCode, 200)
  assert.equal(calls.emails.length, 1)
  assert.equal(calls.emails[0].idempotencyKey, 'stripe-webhook:evt_order_success:checkout.session.async_payment_succeeded')
})

test('a delayed-success replay after a mail failure retries with the same key and idempotency key', async () => {
  const secret = webhookEnv()
  const calls = stripeAndResend({
    session: personalSession(),
    resend: (n) => n === 1 ? { ok: false, status: 500, json: async () => ({ message: 'resend unavailable' }) } : jsonResponse({ id: '<TEST_MESSAGE_ID>' })
  })
  const event = { id: 'evt_async_retry', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }
  const first = await callWebhook(event, secret)
  assert.equal(first.statusCode, 500, 'a failed send asks Stripe to retry')
  assert.equal(JSON.parse(first.body).delivery, undefined)
  const second = await callWebhook(event, secret)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(JSON.parse(second.body), { received: true, delivery: { status: 'accepted' } })
  const third = await callWebhook(event, secret)
  assert.equal(third.statusCode, 200)
  assert.equal(calls.emails.length, 3)
  assert.deepEqual(new Set(calls.emails.map((e) => e.idempotencyKey)), new Set(['stripe-webhook:evt_async_retry:checkout.session.async_payment_succeeded']))
  assert.equal(new Set(calls.emails.map(emailedKey)).size, 1, 'every attempt carries the same key')
})

test('a delayed-success event without mail configuration is a retryable failure', async () => {
  const secret = webhookEnv()
  delete process.env.RESEND_API_KEY
  const calls = stripeAndResend({ session: personalSession() })
  let res
  const logs = await captureErrors(async () => { res = await callWebhook({ id: 'evt_async_nomail', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }, secret) })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { received: true, delivery: { status: 'failed', reason: 'missing_resend_api_key', retryable: true } })
  assert.equal(calls.emails.length, 0)
  assert.deepEqual(logs, ['Leg license delivery failed: reason=missing_resend_api_key retryable=true'])
})

test('a delayed-success event for a Team subscription checkout sends no second key', async () => {
  const secret = webhookEnv()
  const session = personalSession({ id: 'cs_test_team_async', mode: 'subscription', subscription: teamSubscription(), line_items: { data: [{ price: { lookup_key: 'leg_team' }, quantity: 4 }] } })
  const calls = stripeAndResend({ session, subscription: teamSubscription() })
  const res = await callWebhook({ id: 'evt_async_team', type: 'checkout.session.async_payment_succeeded', data: { object: session } }, secret)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { received: true })
  assert.equal(calls.emails.length, 0)
})

test('an unsigned delayed-success event is refused before any request', async () => {
  webhookEnv()
  const calls = stripeAndResend({ session: personalSession() })
  const res = await callWebhook({ id: 'evt_async_forged', type: 'checkout.session.async_payment_succeeded', data: { object: personalSession() } }, 'whsec_wrong')
  assert.equal(res.statusCode, 400)
  assert.equal(res.body, 'bad signature')
  assert.deepEqual(calls, { stripe: [], emails: [] })
})

const teamSession = (quantity, subscription) => ({
  id: 'cs_test_teamseats', mode: 'subscription', status: 'complete', payment_status: 'paid', created: 1789084800,
  customer_details: { email: 'buyer@example.test' }, subscription,
  line_items: { data: [{ price: { lookup_key: 'leg_team' }, quantity }] }
})
// the current period ends 2026-11-12, so a key from it is valid through 2026-11-15
const teamItem = (quantity, over = {}) => ({ price: { lookup_key: 'leg_team' }, quantity, current_period_end: 1794441600, ...over })

async function keyFromCheckout(sessionId = 'cs_test_teamseats') {
  const res = response()
  await keyHandler({ method: 'GET', url: `/api/key?session_id=${sessionId}` }, res)
  return res
}

for (const [label, bought, now] of [['an increase', 3, 5], ['a decrease', 5, 2]]) {
  test(`an old Team checkout link after ${label} in seats returns the subscription's current seats and period`, async () => {
    const sub = teamSubscription({ id: 'sub_seatchange', items: { data: [teamItem(now)] } })
    stripeAndResend({ session: teamSession(bought, sub) })
    const res = await keyFromCheckout()
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.seats, now)
    assert.equal(body.expires, '2026-11-15')
    assert.equal(keyPayload(body.key).seats, now)
  })
}

test('checkout, refresh and renewal sign the same Team payload for the same subscription', async () => {
  const secret = webhookEnv()
  const sub = teamSubscription({ id: 'sub_consistent', items: { data: [teamItem(7)] } })
  const calls = stripeAndResend({ session: teamSession(2, sub), subscription: sub })
  const checkout = keyPayload(JSON.parse((await keyFromCheckout()).body).key)
  const refresh = keyPayload(JSON.parse((await callKeyRefresh({ key: teamProof(sub.id, { seats: 2 }) })).body).key)
  const renewal = await callWebhook({ id: 'evt_renewal_consistent', type: 'invoice.paid', data: { object: { subscription: sub.id, billing_reason: 'subscription_cycle', customer_email: 'buyer@example.test' } } }, secret)
  assert.equal(renewal.statusCode, 200)
  const renewed = keyPayload(emailedKey(calls.emails[0]))
  // a refresh is proved by the old key, not an email address, so it signs no email hash
  const withoutEmail = (payload) => { const copy = { ...payload }; delete copy.email_hash; return copy }
  assert.equal(checkout.seats, 7)
  assert.deepEqual(withoutEmail(refresh), withoutEmail(checkout))
  assert.deepEqual(renewed, checkout)
})

test('an old Team checkout link for a canceled subscription returns no key', async () => {
  stripeAndResend({ session: teamSession(4, teamSubscription({ id: 'sub_canceled_link', status: 'canceled' })) })
  const res = await keyFromCheckout()
  assert.equal(res.statusCode, 402)
  assert.deepEqual(JSON.parse(res.body), { error: 'the subscription is canceled' })
})

test('a Team seat count that is missing, zero, negative, fractional or text issues no key', async () => {
  for (const quantity of [undefined, null, 0, -1, 2.5, '3', Number.NaN]) {
    const sub = teamSubscription({ id: 'sub_badseats', items: { data: [teamItem(quantity)] } })
    assert.throws(() => lib.licenseFromSubscription(sub), (error) => {
      assert.equal(error.status, 400, `quantity ${String(quantity)}`)
      assert.match(error.message, /no valid Leg Team seat count/)
      return true
    })
    stripeAndResend({ session: teamSession(3, sub) })
    const res = await keyFromCheckout()
    assert.equal(res.statusCode, 400, `checkout with quantity ${String(quantity)}`)
    assert.equal(JSON.parse(res.body).key, undefined)
  }
})

test('a subscription with two Leg Team items is ambiguous and issues no key', async () => {
  const sub = teamSubscription({ id: 'sub_twoitems', items: { data: [teamItem(3), teamItem(9)] } })
  assert.throws(() => lib.licenseFromSubscription(sub), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /more than one Leg Team item/)
    return true
  })
  stripeAndResend({ subscription: sub })
  const res = await callKeyRefresh({ key: teamProof(sub.id) })
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).key, undefined)
})

test('the one Leg Team item is found beside an unrelated item, for its seats and its period', () => {
  const sub = teamSubscription({ id: 'sub_mixed', items: { data: [{ price: { lookup_key: 'unrelated_addon' }, quantity: 40, current_period_end: 1791763200 }, teamItem(6)] } })
  const { payload } = lib.licenseFromSubscription(sub)
  assert.equal(payload.seats, 6)
  assert.equal(payload.expires, '2026-11-15')
})
