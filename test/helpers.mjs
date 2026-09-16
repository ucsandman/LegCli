// Shared test helpers: a throwaway BATON_HOME, a toy git repo, and the CLI.
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, sign as cryptoSign, createHash, createPrivateKey } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEG = join(ROOT, 'bin', 'leg.mjs')
export const BATON = LEG

export function makeHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'leg-home-')))
}

// Leg is a licensed product with no trial, so an unlicensed throwaway home
// refuses every session and most of the suite would be testing the refusal
// instead of the thing it names. Each test home gets a Team key signed by this
// pair, and BATON_PUBLIC_KEY_B64 points the spawned CLI at its public half. A
// test that wants the refusal passes BATON_UNLICENSED=1 and gets an empty home.
const TEST_PAIR = generateKeyPairSync('ed25519')
export const TEST_PUBLIC_KEY_B64 = TEST_PAIR.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const TEST_PRIVATE_KEY_B64 = TEST_PAIR.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')

// The key format is reproduced here rather than imported from src/license.mjs:
// that module pulls in store.mjs, which reads BATON_HOME once at import time,
// and helpers.mjs is imported by every test file BEFORE it sets BATON_HOME.
// Importing it here pinned the ledger to whatever home happened to be set.
// It is four lines; the shape is pinned by test/license.test.mjs.
export function signTestLicense(payload = {}) {
  const emailHash = (e) => createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex').slice(0, 16)
  const full = {
    v: 1, id: 'lic_test', plan: 'team', seats: 9, email_hash: emailHash('suite@baton.test'),
    issued: '2026-01-01', expires: '2099-12-31', sub: 'sub_test', ...payload,
  }
  const body = Buffer.from(JSON.stringify(full), 'utf8')
  const key = createPrivateKey({ key: Buffer.from(TEST_PRIVATE_KEY_B64, 'base64'), format: 'der', type: 'pkcs8' })
  const b64u = (b) => Buffer.from(b).toString('base64url')
  return `LEG-${b64u(body)}.${b64u(cryptoSign(null, body, key))}`
}

export function licenseHome(home, payload = {}) {
  // some tests point BATON_HOME at a path the CLI has not created yet
  mkdirSync(home, { recursive: true })
  const body = { key: signTestLicense(payload), activated_at: new Date().toISOString(), id: 'lic_test', plan: payload.plan ?? 'team' }
  writeFileSync(join(home, 'license.json'), JSON.stringify(body, null, 2) + '\n')
  return home
}

export function testEnv(home, extra = {}) {
  // BATON_TRUST=never: a test spawns agents in throwaway repos, and without
  // this the suite would write a trust record for every one of them into the
  // developer's own ~/.claude.json, ~/.codex/config.toml and ~/.gemini.
  const { BATON_UNLICENSED, ...rest } = extra
  if (rest.BATON_QUIET !== undefined && rest.LEG_QUIET === undefined) rest.LEG_QUIET = rest.BATON_QUIET
  if (rest.BATON_PORT !== undefined && rest.LEG_PORT === undefined) rest.LEG_PORT = rest.BATON_PORT
  if (rest.BATON_BIND !== undefined && rest.LEG_BIND === undefined) rest.LEG_BIND = rest.BATON_BIND
  if (rest.BATON_MAX_CONCURRENT !== undefined && rest.LEG_MAX_CONCURRENT === undefined) rest.LEG_MAX_CONCURRENT = rest.BATON_MAX_CONCURRENT
  if (rest.BATON_LIVE_DIR !== undefined && rest.LEG_LIVE_DIR === undefined) rest.LEG_LIVE_DIR = rest.BATON_LIVE_DIR
  const base = { LEG_HOME: home, BATON_HOME: home, LEG_TIMERS_MS: '60000,120000', BATON_TIMERS_MS: '60000,120000', LEG_POLL_MS: '50', BATON_POLL_MS: '50', LEG_QUIET: '1', BATON_QUIET: '1', LEG_TRUST: 'never', BATON_TRUST: 'never', LEG_PUBLIC_KEY_B64: TEST_PUBLIC_KEY_B64, BATON_PUBLIC_KEY_B64: TEST_PUBLIC_KEY_B64 }
  const env = Object.assign({}, process.env, base, rest)
  if (BATON_UNLICENSED !== '1') licenseHome(home)
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  delete env.FAKE_MODE
  return env
}

export function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initRepo(prefix = 'toy-') {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), '# toy\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

export function leg(args, env) {
  return execFileSync(process.execPath, [LEG, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export const baton = leg

export function legFail(args, env) {
  try {
    return { status: 0, stdout: leg(args, env), stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

export const batonFail = legFail

export function legSpawn(args, env, { cwd } = {}) {
  return spawn(process.execPath, [LEG, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
}

export const batonSpawn = legSpawn

export function readCard(home, id) {
  const file = join(home, 'cards', id, 'card.json')
  // the ledger renames into place; a reader can still race a rename on Windows
  for (let i = 0; ; i++) {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { if (i >= 20) throw err }
    const t = Date.now() + 25
    while (Date.now() < t) { /* spin */ }
  }
}

export function events(home, id) {
  const dir = join(home, 'cards', id)
  const out = []
  for (const f of ['events-human-local.jsonl', 'events-leg.jsonl', 'events-baton.jsonl']) {
    if (existsSync(join(dir, f))) out.push(...readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// `card run` that explains itself when the card does not end `done`.
export function runCardOrExplain(home, id, env) {
  try {
    return baton(['card', 'run', id], env)
  } catch (err) {
    const evs = events(home, id).map((e) => `${e.ts.slice(11, 19)} ${e.type} ${e.summary}${e.body ? ` :: ${String(e.body).slice(0, 300)}` : ''}`)
    const runsDir = join(home, 'cards', id, 'runs')
    const runs = existsSync(runsDir) ? readdirSync(runsDir).map((n) => { try { const r = JSON.parse(readFileSync(join(runsDir, n, 'run.json'), 'utf8')); return `run ${n}: ${r.status} ${r.outcome} exit=${r.exit_code} ${r.reason ?? ''}` } catch { return `run ${n}: unreadable` } }) : []
    throw new Error(`card run ${id} exited ${err.status}\nevents:\n  ${evs.join('\n  ')}\nruns:\n  ${runs.join('\n  ')}\nstderr: ${err.stderr?.toString().slice(-800)}`)
  }
}
