// GET /api/key?session_id=cs_...   the key for a paid checkout (the thanks page)
// GET /api/key?license=lic_...&sub=sub_...   a renewed Team key (baton license refresh)
'use strict';
const { licenseFromSession, licenseFromSubscription, stripe, sha, maskEmail } = require('./_lib.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'GET only' })); }
  const url = new URL(req.url, 'http://x');
  try {
    const sessionId = url.searchParams.get('session_id');
    if (sessionId) {
      if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw Object.assign(new Error('bad session id'), { status: 400 });
      const { key, payload, email } = await licenseFromSession(sessionId);
      return res.end(JSON.stringify({ key, plan: payload.plan, seats: payload.seats, updates_until: payload.updates_until, expires: payload.expires, email: maskEmail(email) }));
    }
    const license = url.searchParams.get('license'); const sub = url.searchParams.get('sub');
    if (license && sub) {
      if (!/^sub_[A-Za-z0-9]+$/.test(sub) || 'lic_' + sha(sub).slice(0, 20) !== license) throw Object.assign(new Error('license and subscription do not match'), { status: 403 });
      const s = await stripe(`/subscriptions/${sub}`);
      const { key, payload } = licenseFromSubscription(s, { email: '' });
      return res.end(JSON.stringify({ key, plan: payload.plan, seats: payload.seats, expires: payload.expires }));
    }
    throw Object.assign(new Error('session_id, or license and sub, are required'), { status: 400 });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
