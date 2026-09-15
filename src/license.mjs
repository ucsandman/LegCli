// license — the paid-product gate. A license key is a signed, self-contained
// token that Baton checks offline with the public key embedded below; the
// private key never leaves the seller's machine. Two plans:
//
//   personal  one-time purchase; every release dated on or before the key's
//             updates_until activates, later releases refuse the key but the
//             installed one keeps working (the Sublime Text shape)
//   team      per-seat subscription; the key carries an expiry a few days past
//             the billing period, `baton license refresh` fetches a renewed one
//
// There is no trial. Baton pays off in the moment a limit lands mid-flow, which
// is not a thing a fortnight of evaluation reliably contains; the risk reversal
// is a 30-day money-back guarantee instead, which costs no code and no expiry
// machinery. Key shape: BATON-<base64url payload>.<base64url signature> where
// the signature is Ed25519 over the payload bytes exactly as encoded.
import { createPublicKey, createPrivateKey, verify as cryptoVerify, sign as cryptoSign, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.mjs'

export const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAIpVQymHHJAkIrZHv0u4o0bgfFmtW3Crm7uMwYHP53X8='
// The suite has to exercise the gate itself — `baton share on` refusing a
// Personal key, `baton <agent>` refusing nothing at all — and it cannot sign a
// key for the real public key, which is the point of the real public key. This
// env seam lets a spawned CLI verify against a throwaway pair. It weakens
// nothing: Baton ships as readable JavaScript, so anyone who would set this
// could edit the constant above instead.
const ACTIVE_PUBLIC_KEY = process.env.BATON_PUBLIC_KEY_B64 || PUBLIC_KEY_B64
// The date this release was cut. A personal key activates when this is on or
// before its updates_until. Bumped with every published version.
export const RELEASE_DATE = '2026-09-15'
export const GUARANTEE_DAYS = 30
export const SITE = process.env.BATON_SITE || 'https://baton-agents.vercel.app'
export const BUY_URL = `${SITE}/#pricing`
export const PLANS = {
  personal: { label: 'Personal', gates: ['run'] },
  team: { label: 'Team', gates: ['run', 'share'] },
}
const PREFIX = 'BATON-'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(s, 'base64url')
const isoToday = () => new Date().toISOString().slice(0, 10)

export function signLicense(payload, privateKeyB64) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const sig = cryptoSign(null, body, key)
  return `${PREFIX}${b64u(body)}.${b64u(sig)}`
}

export function parseLicense(key) {
  const s = String(key ?? '').trim()
  if (!s.startsWith(PREFIX)) throw new Error('malformed')
  const [p, sig, extra] = s.slice(PREFIX.length).split('.')
  if (!p || !sig || extra !== undefined) throw new Error('malformed')
  let payload
  try { payload = JSON.parse(unb64u(p).toString('utf8')) } catch { throw new Error('malformed') }
  if (!payload || typeof payload !== 'object' || payload.v !== 1) throw new Error('malformed')
  return { payload, body: unb64u(p), sig: unb64u(sig) }
}

// { ok, reason, payload }. reason is one of: malformed, bad-signature,
// unknown-plan, personal-updates-ended, team-expired.
export function verifyLicense(key, { publicKeyB64 = ACTIVE_PUBLIC_KEY, today = isoToday(), releaseDate = RELEASE_DATE } = {}) {
  let parsed
  try { parsed = parseLicense(key) } catch (e) { return { ok: false, reason: e.message } }
  const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
  let good = false
  try { good = cryptoVerify(null, parsed.body, pub, parsed.sig) } catch { good = false }
  if (!good) return { ok: false, reason: 'bad-signature', payload: parsed.payload }
  const p = parsed.payload
  if (!PLANS[p.plan]) return { ok: false, reason: 'unknown-plan', payload: p }
  if (p.plan === 'personal' && !(typeof p.updates_until === 'string' && p.updates_until >= releaseDate)) return { ok: false, reason: 'personal-updates-ended', payload: p }
  if (p.plan === 'team' && !(typeof p.expires === 'string' && p.expires >= today)) return { ok: false, reason: 'team-expired', payload: p }
  return { ok: true, payload: p }
}

export function licensePath() { return join(home(), 'license.json') }

function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
function writeJson(f, obj) {
  mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32' && existsSync(f)) chmodSync(f, 0o600)
  writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
}

export function readLicense() {
  const l = readJson(licensePath())
  return l && typeof l.key === 'string' ? l : null
}

export function activate(key, opts = {}) {
  const v = verifyLicense(key, opts)
  if (!v.ok) { const e = new Error(explain(v.reason, v.payload)); e.reason = v.reason; throw e }
  writeJson(licensePath(), { key: String(key).trim(), activated_at: new Date().toISOString(), id: v.payload.id, plan: v.payload.plan })
  return v.payload
}

export function deactivate() {
  const had = existsSync(licensePath())
  if (had) unlinkSync(licensePath())
  return had
}

// What this machine may do right now: a valid key, or nothing, with the reason
// the stored key (if any) was refused.
export function entitlement({ today = isoToday(), releaseDate = RELEASE_DATE } = {}) {
  const lic = readLicense()
  if (!lic) return { ok: false, plan: 'none', reason: 'no-license', refused: null }
  const v = verifyLicense(lic.key, { today, releaseDate })
  if (v.ok) return { ok: true, plan: v.payload.plan, seats: v.payload.seats ?? 1, payload: v.payload, source: 'license' }
  return { ok: false, plan: 'none', reason: v.reason, refused: v.reason }
}

export function allows(ent, gate) {
  if (!ent.ok) return false
  return (PLANS[ent.plan]?.gates ?? []).includes(gate)
}

export function explain(reason, payload) {
  switch (reason) {
    case 'malformed': return 'that is not a Baton license key (expected BATON-<payload>.<signature>)'
    case 'bad-signature': return 'the key\'s signature does not check out; copy it again from your receipt'
    case 'unknown-plan': return `the key names a plan this version does not know (${payload?.plan})`
    case 'personal-updates-ended': return `this Personal key covers releases up to ${payload?.updates_until}; this release is dated ${RELEASE_DATE}. Keep the version you have, or renew at ${BUY_URL}`
    case 'team-expired': return `this Team key expired on ${payload?.expires}; run "baton license refresh" (the subscription renews it) or see ${BUY_URL}`
    case 'no-license': return `Baton needs a license key. Buy one at ${BUY_URL} (${GUARANTEE_DAYS}-day money-back guarantee), then: baton license activate <key>`
    default: return String(reason)
  }
}

export function describe(ent) {
  if (!ent.ok) return `no license: ${explain(ent.reason)}`
  const p = ent.payload
  const until = p.plan === 'personal' ? `updates through ${p.updates_until}` : `renews; valid through ${p.expires}`
  return `${PLANS[p.plan].label} license ${p.id}${p.seats > 1 ? ` · ${p.seats} seats` : ''} · ${until}`
}

// Team renewal: ask the site for a fresh key for this subscription. Offline
// or refused, the current key stays in place until it expires.
export async function refresh({ site = SITE, fetchImpl = globalThis.fetch } = {}) {
  const lic = readLicense()
  if (!lic) throw new Error('no license to refresh; baton license activate <key>')
  const { payload } = parseLicense(lic.key)
  if (payload.plan !== 'team') throw new Error('only Team keys renew; a Personal key does not expire')
  const r = await fetchImpl(`${site}/api/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: lic.key }),
  })
  if (!r.ok) throw new Error(`the site answered ${r.status}`)
  const j = await r.json()
  if (!j.key) throw new Error(j.error || 'no key in the answer')
  return activate(j.key)
}

export function emailHash(email) { return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16) }
