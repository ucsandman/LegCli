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
  const [payload, signature] = genuine.slice(6).split('.')
  const forged = await callKeyRefresh({ key: `BATON-${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}` })
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
  assert.match(JSON.parse(res.body).key, /^BATON-/)
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
