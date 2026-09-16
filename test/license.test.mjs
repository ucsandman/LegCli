// The license gate: signed keys verify offline, a personal key is a date
// window over releases, a team key expires, an unlicensed machine is refused, and the
// CLI refuses a session once nothing is left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeHome, testEnv, BATON } from './helpers.mjs'
import { signLicense, verifyLicense, parseLicense, activate, deactivate, readLicense, licensePath, entitlement, allows, describe as describeEnt, refresh, emailHash, GUARANTEE_DAYS } from '../src/license.mjs'

const pair = generateKeyPairSync('ed25519')
const PUB = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const PRIV = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const personal = (over = {}) => ({ v: 1, id: 'lic_p1', plan: 'personal', seats: 1, email_hash: emailHash('a@b.c'), issued: '2026-09-11', updates_until: '2027-09-11', ...over })
const team = (over = {}) => ({ v: 1, id: 'lic_t1', plan: 'team', seats: 5, email_hash: emailHash('a@b.c'), issued: '2026-09-11', expires: '2026-10-14', sub: 'sub_x', ...over })
const opts = (o = {}) => ({ publicKeyB64: PUB, today: '2026-09-12', releaseDate: '2026-09-11', ...o })

test('a signed key round-trips and verifies; the payload is exactly what was signed', () => {
  const key = signLicense(personal(), PRIV)
  assert.match(key, /^LEG-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(parseLicense(key).payload, personal())
  const v = verifyLicense(key, opts())
  assert.equal(v.ok, true)
  assert.equal(v.payload.id, 'lic_p1')
})

test('a key signed by another private key, a tampered payload, and junk are all refused with a reason', () => {
  assert.equal(verifyLicense(signLicense(personal(), other), opts()).reason, 'bad-signature')
  const key = signLicense(personal(), PRIV)
  const [p, sig] = key.slice(4).split('.')
  const forged = Buffer.from(JSON.stringify({ ...personal(), plan: 'team', expires: '2099-01-01' })).toString('base64url')
  assert.equal(verifyLicense(`LEG-${forged}.${sig}`, opts()).reason, 'bad-signature')
  assert.equal(verifyLicense(`LEG-${p}`, opts()).reason, 'malformed')
  assert.equal(verifyLicense('hello', opts()).reason, 'malformed')
  assert.equal(verifyLicense('', opts()).reason, 'malformed')
  assert.equal(verifyLicense(signLicense({ ...personal(), plan: 'gold' }, PRIV), opts()).reason, 'unknown-plan')
})

test('a personal key is a window over release dates: later releases refuse it, the installed one keeps working', () => {
  const key = signLicense(personal({ updates_until: '2027-09-11' }), PRIV)
  assert.equal(verifyLicense(key, opts({ releaseDate: '2027-09-11' })).ok, true, 'the last covered day activates')
  assert.equal(verifyLicense(key, opts({ releaseDate: '2027-09-12' })).reason, 'personal-updates-ended')
  assert.equal(verifyLicense(key, opts({ releaseDate: '2027-09-12', today: '2030-01-01' })).ok, false)
  assert.equal(verifyLicense(key, opts({ releaseDate: '2026-01-01', today: '2030-01-01' })).ok, true, 'wall-clock time never expires a personal key')
})

test('a team key expires on the calendar and is refused after its date', () => {
  const key = signLicense(team({ expires: '2026-10-14' }), PRIV)
  assert.equal(verifyLicense(key, opts({ today: '2026-10-14' })).ok, true)
  assert.equal(verifyLicense(key, opts({ today: '2026-10-15' })).reason, 'team-expired')
  assert.equal(verifyLicense(signLicense(team({ expires: undefined }), PRIV), opts()).reason, 'team-expired')
})

test('activate writes the key under BATON_HOME, refuses a bad one, and deactivate removes it', () => {
  process.env.BATON_HOME = makeHome()
  const key = signLicense(personal(), PRIV)
  const p = activate(key, opts())
  assert.equal(p.id, 'lic_p1')
  assert.equal(readLicense().key, key)
  assert.throws(() => activate('LEG-nope.nope', opts()), /not a Leg license key/)
  assert.throws(() => activate(signLicense(personal(), other), opts()), /signature/)
  assert.equal(readLicense().key, key, 'a refused key does not overwrite the good one')
  assert.equal(deactivate(), true)
  assert.equal(readLicense(), null)
  assert.equal(deactivate(), false)
})

test('license storage uses private POSIX permissions for new and existing files', { skip: process.platform === 'win32' }, () => {
  const parent = makeHome()
  process.env.BATON_HOME = join(parent, 'secure-home')
  const key = signLicense(personal(), PRIV)
  activate(key, opts())
  assert.equal(statSync(process.env.BATON_HOME).mode & 0o777, 0o700)
  assert.equal(statSync(licensePath()).mode & 0o777, 0o600)
  chmodSync(licensePath(), 0o644)
  activate(key, opts())
  assert.equal(statSync(licensePath()).mode & 0o777, 0o600)
})

test('refresh posts the installed Team key and preserves it when the site refuses', async () => {
  process.env.BATON_HOME = makeHome()
  const key = signLicense(team(), PRIV)
  activate(key, opts())
  let request
  await assert.rejects(() => refresh({
    site: 'https://example.test',
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: false, status: 403 } }
  }), /site answered 403/)
  assert.equal(request.url, 'https://example.test/api/key')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(request.options.body), { key })
  assert.equal(readLicense().key, key)
})

// There is no trial: Leg is bought up front and the risk reversal is a
// 30-day money-back guarantee, which lives on the site and needs no clock here.
test('an unlicensed machine is refused, and says so without inventing a grace period', () => {
  process.env.BATON_HOME = makeHome()
  const e0 = entitlement({ today: '2026-09-11' })
  assert.deepEqual([e0.ok, e0.plan, e0.reason], [false, 'none', 'no-license'])
  assert.equal(allows(e0, 'run'), false, 'no key opens no gate')
  assert.equal(allows(e0, 'share'), false)
  assert.match(describeEnt(e0), /needs a license key/)
  assert.match(describeEnt(e0), new RegExp(`${GUARANTEE_DAYS}-day money-back`))
  assert.equal(existsSync(join(process.env.BATON_HOME, 'trial.json')), false, 'nothing writes a trial clock any more')
  // a key for another public key is refused, not trusted
  writeFileSync(join(process.env.BATON_HOME, 'license.json'), JSON.stringify({ key: signLicense(personal(), PRIV) }))
  const e2 = entitlement({ today: '2026-10-01' })
  assert.deepEqual([e2.ok, e2.reason], [false, 'bad-signature'])
})

test('the CLI: baton license status, activate, deactivate; a refused key exits 2', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_UNLICENSED: '1' })
  const run = (args) => spawnSync(process.execPath, [BATON, 'license', ...args], { env, encoding: 'utf8' })
  const st = run(['status'])
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /needs a license key/)
  assert.match(st.stdout, /30-day money-back/)
  const bad = run(['activate', 'LEG-x.y'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /not a Leg license key/)
  const off = run(['deactivate'])
  assert.equal(off.status, 0)
  assert.match(off.stdout, /no license was stored/)
})

test('both LEG- and legacy BATON- keys are accepted and verified; activate normalizes to LEG-', () => {
  const key = signLicense(personal(), PRIV)
  assert.match(key, /^LEG-/)
  const legacyKey = 'BATON-' + key.slice(4)
  const v = verifyLicense(legacyKey, opts())
  assert.equal(v.ok, true)
  assert.equal(v.payload.id, 'lic_p1')
  process.env.LEG_HOME = makeHome()
  const activated = activate(legacyKey, opts())
  assert.equal(activated.id, 'lic_p1')
  assert.match(readLicense().key, /^LEG-/)
})

test('the CLI refuses baton <agent> with no key at all, and says where to buy', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_UNLICENSED: '1', PATH: process.env.PATH })
  const r = spawnSync(process.execPath, [BATON, 'claude', '--version'], { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 4, r.stderr)
  assert.match(r.stderr, /needs a license key/)
  assert.match(r.stderr, /#pricing/)
})

test('share on needs a Team plan: a Personal key is told no, an unlicensed machine sooner', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_UNLICENSED: '1' })
  // a personal key for the real public key does not exist in tests; simulate the
  // decision through allows()
  assert.equal(allows({ ok: true, plan: 'personal' }, 'share'), false)
  assert.equal(allows({ ok: true, plan: 'team' }, 'share'), true)
  assert.equal(allows({ ok: false, plan: 'none' }, 'run'), false)
  const r = spawnSync(process.execPath, [BATON, 'share', 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  // no key: share on is refused before it touches the board
  const on = spawnSync(process.execPath, [BATON, 'share', 'on'], { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(on.status, 2, on.stdout)
  assert.match(on.stderr, /needs a license key/)
})
