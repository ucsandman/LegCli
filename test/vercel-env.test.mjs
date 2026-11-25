import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const script = join(import.meta.dirname, '..', 'scripts', 'vercel-env.mjs')
const strippedEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  WINDIR: process.env.WINDIR
}
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: join(import.meta.dirname, '..'), env: strippedEnv, encoding: 'utf8' })

test('vercel-env requires an explicit mode before credential resolution', () => {
  for (const args of [[], ['--mode', 'production'], ['--mode', 'TEST']]) {
    const result = run(...args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Usage: .* --mode test\|live/)
    assert.doesNotMatch(result.stderr, /missing in \.env|STRIPE_|RESEND_|BATON_|vercel CLI/)
  }
})

test('test mode reaches credential validation but not Vercel when names are absent', () => {
  const result = run('--mode', 'test')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /missing in \.env: .*STRIPE_SECRET_KEY.*STRIPE_WEBHOOK_SECRET.*RESEND_API_KEY.*BATON_LICENSE_PRIVATE_KEY/)
  assert.doesNotMatch(result.stderr, /vercel CLI not found/)
})

test('live mode reaches credential validation but not Vercel when names are absent', () => {
  const result = run('--mode', 'live')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /missing in \.env: .*STRIPE_SECRET_KEY.*STRIPE_WEBHOOK_SECRET.*RESEND_API_KEY.*BATON_LICENSE_PRIVATE_KEY/)
  assert.doesNotMatch(result.stderr, /vercel CLI not found/)
})

test('--dry prints the target per mode, never a value, and never looks up Vercel', () => {
  const home = mkdtempSync(join(tmpdir(), 'vercel-env-'))
  const names = ['STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_LIVE_WEBHOOK_SECRET', 'STRIPE_TEST_WEBHOOK_SECRET', 'RESEND_API_KEY', 'BATON_LICENSE_PRIVATE_KEY']
  const env = { ...strippedEnv, HOME: home, USERPROFILE: home, APPDATA: home, ...Object.fromEntries(names.map((n) => [n, `placeholder-${n}-value`])) }
  try {
    for (const [mode, want, other] of [['test', 'preview', 'production'], ['live', 'production', 'preview']]) {
      const result = spawnSync(process.execPath, [script, '--mode', mode, '--dry'], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      const lines = result.stdout.split('\n').filter(Boolean)
      assert.equal(lines.length, 22)
      assert.ok(lines.every((l) => /^env (rm|add) \w+ /.test(l) && l.endsWith(` ${want}`)), result.stdout)
      assert.doesNotMatch(result.stdout, new RegExp(other))
      assert.doesNotMatch(result.stdout + result.stderr, /placeholder-|vercel CLI/)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
