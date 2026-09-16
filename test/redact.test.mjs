import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub, redact, SECRET_PATTERNS, _resetHeldValues } from '../src/redact.mjs'

// Fixture strings are assembled at runtime so no secret-shaped literal sits in the tree.
const fake = (prefix, body = 'abcdefgh12345678') => prefix + body
const CASES = [
  ['sk-', `key ${fake('sk-')} here`],
  ['sk-ant-', `ANTHROPIC ${fake('sk-ant-', 'api03-abcdefghijklmnop')}`],
  ['oc_live_', fake('oc_live_', '0123abcd')],
  ['Bearer', `Authorization: ${fake('Bearer ', 'abcdefghijklmnop.qrstuvwxyz')}`],
  ['ghp_', `token ${fake('ghp_', 'abcdefghijklmnopqrstuvwxyz1234')}`],
  ['ghs_', fake('ghs_', 'abcdefghijklmnopqrstuvwxyz1234')],
  ['github_pat_', fake('github_pat_', 'abcdefghijklmnopqrstuvwxyz_1234')],
  ['AKIA', fake('AKIA', 'ABCDEFGHIJKL1234')],
  ['xoxb', fake('xoxb-', '1234-5678-abcdefgh')],
  ['api_key=', fake('api_key=', 'whatever-secret')],
  ['sk_live_', `stripe ${fake('sk_live_', 'abcdefgh12345678')}`],
  ['AIza', fake('AIza', 'abcdefgh12345678abcdefgh12345678ab')],
  ['xai-', fake('xai-', 'abcdefgh12345678abcdefgh')],
  ['npm_', fake('npm_', 'abcdefgh12345678abcdefgh')],
  ['glpat-', fake('glpat-', 'abcdefgh12345678abcd')],
  ['hf_', fake('hf_', 'abcdefgh12345678abcdefgh')],
  ['JWT', `jwt ${fake('eyJ', 'abcdefgh12345678')}.${fake('eyJ', 'abcdefgh12345678')}.${fake('', 'abcdefgh12345678')}`],
  ['private key block', `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n${fake('', 'abcdefgh12345678')}\n${['-----END', 'PRIVATE KEY-----'].join(' ')}`],
  ['Basic auth', `Authorization: ${fake('Basic ', 'abcdefgh12345678abcd')}`],
  ['url credentials', `postgres://user:${fake('', 'whatever-secret')}@db.example/app`],
  ['password=', fake('password=', 'whatever-secret1')],
  ['gho_', fake('gho_', 'abcdefghijklmnopqrstuvwxyz1234')],
  ['xapp-', fake('xapp-', '1234-5678-abcdefgh')],
]

for (const [name, line] of CASES) {
  test(`scrub redacts ${name}`, () => {
    const outLine = scrub(line)
    assert.ok(outLine.includes('[REDACTED]'), outLine)
    assert.ok(!/abcdefgh|whatever-secret|0123abcd|ABCDEFGHIJKL/.test(outLine), outLine)
  })
}

test('scrub leaves ordinary lines alone and SECRET_PATTERNS are non-global (safe for .test)', () => {
  assert.equal(scrub('leg exited code 0: completed'), 'leg exited code 0: completed')
  assert.equal(scrub('const token = session.token'), 'const token = session.token')
  assert.equal(scrub('postgres://user:secret1234@db.example/app'), 'postgres://user:[REDACTED]@db.example/app')
  for (const [, re] of SECRET_PATTERNS) assert.equal(re.global, false)
  const [, sk] = SECRET_PATTERNS.find(([n]) => n.startsWith('api key'))
  assert.equal(sk.test(fake('sk-')), true)
  assert.equal(sk.test(fake('sk-')), true, 'no lastIndex state between calls')
})

test('redact also removes values the process holds for the well-known key variables', () => {
  const planted = ['planted', 'value', '9f8e7d6c'].join('-')
  const prev = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = planted
  _resetHeldValues()
  try {
    const line = redact(`child said: ${planted} and again ${planted}`)
    assert.equal(line, 'child said: [REDACTED] and again [REDACTED]')
    assert.ok(!line.includes('planted'))
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev
    _resetHeldValues()
  }
})
