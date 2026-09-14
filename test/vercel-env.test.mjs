import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

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
