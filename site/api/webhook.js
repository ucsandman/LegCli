// POST /api/webhook   Stripe events: a paid checkout emails the key; a paid
// renewal invoice emails a fresh Team key. Signature-checked on the raw body.
'use strict';
const { licenseFromSession, licenseFromSubscription, planOf, sendKeyEmail, verifyStripeSignature, readRaw, sha, stripe } = require('./_lib.js');

function emailIdempotencyKey(eventId, deliveryKind) {
  const stableEventId = String(eventId || '').length <= 128 ? String(eventId || '') : sha(eventId).slice(0, 32);
  return `stripe-webhook:${stableEventId}:${deliveryKind}`;
}

function deliveryOf(result) {
  if (!result?.skipped) return { status: 'accepted' };
  const delivery = { status: 'failed', reason: result.reason, retryable: result.retryable };
  console.error(`Baton license delivery failed: reason=${delivery.reason} retryable=${delivery.retryable}`);
  return delivery;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
  const raw = await readRaw(req);
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) { res.statusCode = 400; return res.end('bad signature'); }
  let event;
  try { event = JSON.parse(raw); } catch { res.statusCode = 400; return res.end('bad json'); }
  try {
    let delivery;
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.payment_status === 'paid' || s.mode === 'subscription') {
        const { key, payload, email } = await licenseFromSession(s.id);
        delivery = deliveryOf(await sendKeyEmail({ to: email, key, payload, idempotencyKey: emailIdempotencyKey(event.id, 'checkout.session.completed') }));
      }
    } else if (event.type === 'invoice.paid') {
      const inv = event.data.object;
      const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id || inv.parent?.subscription_details?.subscription;
      if (subId && inv.billing_reason === 'subscription_cycle') {
        const sub = await stripe(`/subscriptions/${subId}`);
        if (planOf(sub.items?.data?.[0]?.price) !== 'team') { const e = new Error('this subscription is not for a Baton Team plan'); e.status = 400; throw e; }
        const { key, payload } = licenseFromSubscription(sub, { email: inv.customer_email });
        delivery = deliveryOf(await sendKeyEmail({ to: inv.customer_email, key, payload, idempotencyKey: emailIdempotencyKey(event.id, 'invoice.paid') }));
      }
    }
    if (delivery?.retryable) res.statusCode = 500;
    res.end(JSON.stringify({ received: true, ...(delivery && { delivery }) }));
  } catch (err) {
    // a 500 makes Stripe retry, which is what a transient Resend or Stripe
    // failure needs; a bad plan never becomes good, so answer 200 for that
    res.statusCode = err.status === 400 ? 200 : 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};

module.exports.config = { api: { bodyParser: false } };
