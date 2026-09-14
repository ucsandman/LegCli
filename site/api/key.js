// GET /api/key?session_id=cs_...   the key for a paid checkout (the thanks page)
// POST /api/key { key: "BATON-..." }   a renewed Team key, authenticated by the old key
'use strict';
const crypto = require('node:crypto');
const { licenseFromSession, licenseFromSubscription, stripe, sha, maskEmail, readRaw } = require('./_lib.js');

async function requestBody(req) {
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  }
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

function refreshSubscription(key) {
  const value = String(key || '').trim();
  if (!value.startsWith('BATON-')) throw Object.assign(new Error('a signed Team key is required'), { status: 403 });
  const [encoded, encodedSignature, extra] = value.slice(6).split('.');
  if (!encoded || !encodedSignature || extra !== undefined) throw Object.assign(new Error('a signed Team key is required'), { status: 403 });
  let body; let signature; let payload;
  try {
    body = Buffer.from(encoded, 'base64url');
    signature = Buffer.from(encodedSignature, 'base64url');
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('a signed Team key is required'), { status: 403 });
  }
  const privateKey = process.env.BATON_LICENSE_PRIVATE_KEY;
  if (!privateKey) throw new Error('BATON_LICENSE_PRIVATE_KEY is not set');
  let valid = false;
  try {
    const sellerKey = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    valid = crypto.verify(null, body, crypto.createPublicKey(sellerKey), signature);
  } catch { valid = false; }
  if (!valid) throw Object.assign(new Error('the key signature does not check out'), { status: 403 });
  if (payload?.v !== 1 || payload.plan !== 'team') throw Object.assign(new Error('a signed Team key is required'), { status: 403 });
  if (!/^sub_[A-Za-z0-9]+$/.test(payload.sub || '') || payload.id !== 'lic_' + sha(payload.sub).slice(0, 20)) {
    throw Object.assign(new Error('license and subscription do not match'), { status: 403 });
  }
  return payload.sub;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET') {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) {
        const oldRefresh = url.searchParams.has('license') || url.searchParams.has('sub');
        throw Object.assign(new Error(oldRefresh ? 'Team renewal requires POST with the signed key' : 'session_id is required'), { status: oldRefresh ? 405 : 400 });
      }
      if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw Object.assign(new Error('bad session id'), { status: 400 });
      const { key, payload, email } = await licenseFromSession(sessionId);
      return res.end(JSON.stringify({ key, plan: payload.plan, seats: payload.seats, updates_until: payload.updates_until, expires: payload.expires, email: maskEmail(email) }));
    }
    if (req.method === 'POST') {
      let input;
      try { input = await requestBody(req); } catch { throw Object.assign(new Error('valid JSON is required'), { status: 400 }); }
      const sub = refreshSubscription(input?.key);
      const s = await stripe(`/subscriptions/${sub}`);
      const { key, payload } = licenseFromSubscription(s, { email: '' });
      return res.end(JSON.stringify({ key, plan: payload.plan, seats: payload.seats, expires: payload.expires }));
    }
    throw Object.assign(new Error('GET checkout or POST refresh only'), { status: 405 });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
