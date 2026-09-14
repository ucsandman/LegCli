// Shared by the site's functions: Stripe calls, license signing (the same
// key shape src/license.mjs verifies), and the key email. CommonJS because
// Vercel's Node runtime loads these as plain functions.
'use strict';
const crypto = require('node:crypto');

const STRIPE = 'https://api.stripe.com/v1';
const SITE = process.env.BATON_SITE_ORIGIN || 'https://baton-agents.vercel.app';
const FROM = process.env.BATON_MAIL_FROM || 'Baton <baton@practicalsystems.io>';

function form(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x, i) => out.push(...(typeof x === 'object' ? [form(x, `${key}[${i}]`)] : [`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`])));
    else if (typeof v === 'object') out.push(form(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

async function stripe(path, { method = 'GET', body, query } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const url = STRIPE + path + (query ? '?' + form(query) : '');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body ? form(body) : undefined });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error?.message || `stripe ${r.status}`); e.status = r.status; throw e; }
  return j;
}

function signLicense(payload) {
  const priv = process.env.BATON_LICENSE_PRIVATE_KEY;
  if (!priv) throw new Error('BATON_LICENSE_PRIVATE_KEY is not set');
  const key = crypto.createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' });
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, body, key);
  return `BATON-${body.toString('base64url')}.${sig.toString('base64url')}`;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const emailHash = (email) => sha(String(email || '').trim().toLowerCase()).slice(0, 16);
const isoDay = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
function plusMonths(iso, months) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); }
function plusDays(unixSeconds, days) { return new Date(unixSeconds * 1000 + days * 86400000).toISOString().slice(0, 10); }

// The plan is read from the price's lookup_key (baton_personal | baton_team),
// set when the prices were created, so a renamed product cannot change it.
function planOf(price) {
  const k = price?.lookup_key;
  if (k === 'baton_team') return 'team';
  if (k === 'baton_personal') return 'personal';
  return null;
}

// A paid Checkout Session becomes exactly one license. The id is derived from
// the session (personal) or the subscription (team), so the thanks page, the
// webhook and a refresh all produce the same key for the same purchase.
async function licenseFromSession(sessionId) {
  const s = await stripe(`/checkout/sessions/${sessionId}`, { query: { expand: ['line_items.data.price', 'subscription'] } });
  if (s.payment_status !== 'paid' && !(s.mode === 'subscription' && s.status === 'complete')) { const e = new Error('this checkout is not paid'); e.status = 402; throw e; }
  const item = s.line_items?.data?.[0];
  const plan = planOf(item?.price);
  if (!plan) { const e = new Error('this checkout is not for a Baton plan'); e.status = 400; throw e; }
  if (s.mode === 'subscription' && plan !== 'team') { const e = new Error('this checkout is not for a Baton plan'); e.status = 400; throw e; }
  const email = s.customer_details?.email || s.customer_email || '';
  if (plan === 'personal') {
    const issued = isoDay(s.created);
    const payload = { v: 1, id: 'lic_' + sha(s.id).slice(0, 20), plan, seats: 1, email_hash: emailHash(email), issued, updates_until: plusMonths(issued, 12) };
    return { key: signLicense(payload), payload, email };
  }
  const sub = typeof s.subscription === 'object' ? s.subscription : await stripe(`/subscriptions/${s.subscription}`);
  return licenseFromSubscription(sub, { email, seats: item.quantity || 1 });
}

function licenseFromSubscription(sub, { email, seats } = {}) {
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  if (!active) { const e = new Error(`the subscription is ${sub.status}`); e.status = 402; throw e; }
  const item = sub.items?.data?.[0];
  if (planOf(item?.price) !== 'team') { const e = new Error('this subscription is not for a Baton Team plan'); e.status = 400; throw e; }
  const periodEnd = item?.current_period_end || sub.current_period_end;
  const payload = { v: 1, id: 'lic_' + sha(sub.id).slice(0, 20), plan: 'team', seats: seats || item?.quantity || 1, email_hash: emailHash(email || ''), issued: isoDay(sub.created), expires: plusDays(periodEnd, 3), sub: sub.id };
  return { key: signLicense(payload), payload, email: email || '' };
}

async function sendKeyEmail({ to, key, payload }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'missing_resend_api_key', retryable: true };
  if (!to) return { skipped: true, reason: 'missing_recipient', retryable: false };
  const plan = payload.plan === 'team' ? `Team, ${payload.seats} seat${payload.seats === 1 ? '' : 's'}` : 'Personal';
  const until = payload.plan === 'team' ? `It renews with your subscription and is valid through ${payload.expires}; a renewed key is emailed each period, and "baton license refresh" fetches it.` : `It covers every Baton release dated on or before ${payload.updates_until}. The version you have keeps working after that.`;
  const text = `Your Baton license (${plan})\n\nKey:\n${key}\n\nActivate it on each machine:\n\n  baton license activate ${key}\n\n${until}\n\nYour receipt is in the email from Stripe. Reply to this email for help.\n\n${SITE}\n`;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to: [to], subject: `Your Baton ${payload.plan === 'team' ? 'Team' : 'Personal'} license key`, text, reply_to: process.env.BATON_MAIL_REPLY_TO || undefined }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `resend ${r.status}`);
  return { id: j.id };
}

function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  const t = parts.t; const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Math.abs(Date.now() / 1000 - Number(t)) <= toleranceSec;
}

function readRaw(req) {
  return new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });
}

const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}***@${d}` : ''; };

module.exports = { stripe, signLicense, planOf, licenseFromSession, licenseFromSubscription, sendKeyEmail, verifyStripeSignature, readRaw, maskEmail, sha, SITE };
