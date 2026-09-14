// The license gate: signed keys verify offline, a personal key is a date
// window over releases, a team key expires, the trial counts down, and the
// CLI refuses a session once nothing is left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeHome, testEnv, BATON } from './helpers.mjs'
import { signLicense, verifyLicense, parseLicense, activate, deactivate, readLicense, licensePath, trial, entitlement, allows, describe as describeEnt, refresh, emailHash, TRIAL_DAYS } from '../src/license.mjs'

const pair = generateKeyPairSync('ed25519')
const PUB = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const PRIV = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const personal = (over = {}) => ({ v: 1, id: 'lic_p1', plan: 'personal', seats: 1, email_hash: emailHash('a@b.c'), issued: '2026-09-11', updates_until: '2027-09-11', ...over })
const team = (over = {}) => ({ v: 1, id: 'lic_t1', plan: 'team', seats: 5, email_hash: emailHash('a@b.c'), issued: '2026-09-11', expires: '2026-10-14', sub: 'sub_x', ...over })
const opts = (o = {}) => ({ publicKeyB64: PUB, today: '2026-09-12', releaseDate: '2026-09-11', ...o })

test('a signed key round-trips and verifies; the payload is exactly what was signed', () => {
  const key = signLicense(personal(), PRIV)
  assert.match(key, /^BATON-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(parseLicense(key).payload, personal())
  const v = verifyLicense(key, opts())
  assert.equal(v.ok, true)
  assert.equal(v.payload.id, 'lic_p1')
})

test('a key signed by another private key, a tampered payload, and junk are all refused with a reason', () => {
  assert.equal(verifyLicense(signLicense(personal(), other), opts()).reason, 'bad-signature')
  const key = signLicense(personal(), PRIV)
  const [p, sig] = key.slice(6).split('.')
  const forged = Buffer.from(JSON.stringify({ ...personal(), plan: 'team', expires: '2099-01-01' })).toString('base64url')
  assert.equal(verifyLicense(`BATON-${forged}.${sig}`, opts()).reason, 'bad-signature')
  assert.equal(verifyLicense(`BATON-${p}`, opts()).reason, 'malformed')
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
  assert.throws(() => activate('BATON-nope.nope', opts()), /not a Baton license key/)
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

test('the trial starts on first ask, counts down by calendar day, and ends after TRIAL_DAYS', () => {
  process.env.BATON_HOME = makeHome()
  assert.equal(trial({ today: '2026-09-11', start: false }).started, null)
  const t0 = trial({ today: '2026-09-11' })
  assert.deepEqual([t0.started, t0.daysLeft, t0.expired], ['2026-09-11', TRIAL_DAYS, false])
  const t1 = trial({ today: '2026-09-24' })
  assert.deepEqual([t1.daysLeft, t1.expired], [1, false])
  const t2 = trial({ today: '2026-09-25' })
  assert.deepEqual([t2.daysLeft, t2.expired], [0, true])
  assert.equal(trial({ today: '2026-01-01' }).expired, true, 'a clock set back before the start is not a fresh trial')
})

test('entitlement prefers a valid key, falls back to the trial, then refuses with the reason', () => {
  process.env.BATON_HOME = makeHome()
  const e0 = entitlement({ today: '2026-09-11' })
  assert.deepEqual([e0.ok, e0.plan, e0.daysLeft], [true, 'trial', TRIAL_DAYS])
  assert.equal(allows(e0, 'share'), true, 'the trial opens every gate')
  const e1 = entitlement({ today: '2026-10-01' })
  assert.deepEqual([e1.ok, e1.plan, e1.reason], [false, 'none', 'trial-expired'])
  assert.match(describeEnt(e1), /trial has ended/)
  // a personal key signed with the real embedded public key cannot be made here,
  // so store a key for the test pair and verify through the same path
  writeFileSync(join(process.env.BATON_HOME, 'license.json'), JSON.stringify({ key: signLicense(personal(), PRIV) }))
  const e2 = entitlement({ today: '2026-10-01' })
  assert.equal(e2.ok, false, 'a key for another public key is refused, not trusted')
  assert.equal(e2.reason, 'bad-signature')
})

test('the CLI: baton license status, activate, deactivate; a refused key exits 2', () => {
  const home = makeHome()
  const env = testEnv(home)
  const run = (args) => spawnSync(process.execPath, [BATON, 'license', ...args], { env, encoding: 'utf8' })
  const st = run(['status'])
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /trial: 14 days left/)
  assert.equal(existsSync(join(home, 'trial.json')), true)
  const bad = run(['activate', 'BATON-x.y'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /not a Baton license key/)
  const off = run(['deactivate'])
  assert.equal(off.status, 0)
  assert.match(off.stdout, /no license was stored/)
})

test('the CLI refuses baton <agent> once the trial is over and nothing is activated, and says where to buy', () => {
  const home = makeHome()
  writeFileSync(join(home, 'trial.json'), JSON.stringify({ started: '2020-01-01' }))
  const env = testEnv(home, { PATH: process.env.PATH })
  const r = spawnSync(process.execPath, [BATON, 'claude', '--version'], { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 4, r.stderr)
  assert.match(r.stderr, /trial has ended/)
  assert.match(r.stderr, /#pricing/)
})

test('share on needs a Team plan: the trial allows it, a Personal key is told no', () => {
  const home = makeHome()
  const env = testEnv(home)
  // a personal key for the real public key does not exist in tests; simulate the
  // decision through allows()
  assert.equal(allows({ ok: true, plan: 'personal' }, 'share'), false)
  assert.equal(allows({ ok: true, plan: 'team' }, 'share'), true)
  assert.equal(allows({ ok: true, plan: 'trial' }, 'share'), true)
  assert.equal(allows({ ok: false, plan: 'none' }, 'run'), false)
  const r = spawnSync(process.execPath, [BATON, 'share', 'status'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(join(home, 'trial.json')), false, 'looking at share status is not a licensed use and starts no clock')
  // an expired trial and no key: share on is refused before it touches the board
  writeFileSync(join(home, 'trial.json'), JSON.stringify({ started: '2020-01-01' }))
  const on = spawnSync(process.execPath, [BATON, 'share', 'on'], { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(on.status, 2, on.stdout)
  assert.match(on.stderr, /trial has ended/)
})
