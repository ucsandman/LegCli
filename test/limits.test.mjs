import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, SIGNALS, OUTCOMES } from '../src/limits.mjs'

const base = { adapter: 'claude', exitCode: 0, stdout: '', stderr: '', result: null, doneMarker: false, diff: { changed: false, files: 0 }, killedByTimer: false, spawnError: null }

test('every fixture carries source, produced_by, where, text, classification', () => {
  assert.ok(SIGNALS.length >= 20)
  for (const s of SIGNALS) {
    assert.ok(['observed-live', 'docs-only'].includes(s.source), `${s.id} source`)
    assert.ok(s.produced_by.length > 10, `${s.id} produced_by`)
    assert.ok(['stdout', 'stderr', 'result.json', 'exit_code', 'any'].includes(s.where), `${s.id} where`)
    assert.ok(typeof s.text === 'string', `${s.id} text`)
    assert.ok(['limit', 'auth', 'launch', 'budget', 'info'].includes(s.classification), `${s.id} classification`)
  }
})

// One test per positive fixture: its own recorded text, on its own stream,
// classifies as the class it declares (limit → outcome limit + that signal).
for (const s of SIGNALS.filter((x) => x.classification === 'limit')) {
  test(`fixture ${s.id} (${s.source}) → limit`, () => {
    const input = { ...base, adapter: s.adapter === '*' ? 'agy' : s.adapter, exitCode: s.exit_code ?? 1 }
    if (s.where === 'stderr') input.stderr = s.text
    else input.stdout = s.text
    const v = classify(input)
    assert.equal(v.outcome, 'limit')
    assert.equal(v.handoff, true)
    // an adapter-specific fixture must win over the generic one for its own adapter
    if (s.adapter !== '*') assert.equal(v.signal, s.id)
    else assert.ok(v.signal.length > 0)
  })
}

for (const s of SIGNALS.filter((x) => x.classification === 'auth')) {
  test(`fixture ${s.id} (${s.source}) → auth_failed, no handoff, even with exit 0`, () => {
    const v = classify({ ...base, adapter: s.adapter === '*' ? 'claude' : s.adapter, exitCode: 0, stderr: s.text, stdout: 'You’ve hit your session limit' })
    assert.equal(v.outcome, 'auth_failed')
    assert.equal(v.handoff, false)
  })
}

for (const s of SIGNALS.filter((x) => x.classification === 'launch')) {
  test(`fixture ${s.id} (${s.source}) → launch_failed, handoff`, () => {
    const v = classify({ ...base, adapter: s.adapter, exitCode: s.exit_code ?? 1, stderr: s.text })
    assert.equal(v.outcome, 'launch_failed')
    assert.equal(v.signal, s.id)
    assert.equal(v.handoff, true)
  })
}

for (const s of SIGNALS.filter((x) => x.classification === 'info')) {
  test(`negative fixture ${s.id} (${s.source}) never classifies as limit`, () => {
    const input = { ...base, adapter: s.adapter === '*' ? 'codex' : s.adapter, exitCode: s.exit_code ?? 1 }
    if (s.where === 'stderr') input.stderr = s.text
    else input.stdout = s.text
    const v = classify(input)
    assert.notEqual(v.outcome, 'limit')
    assert.ok(OUTCOMES.includes(v.outcome))
  })
}

for (const s of SIGNALS.filter((x) => x.classification === 'budget')) {
  test(`budget fixture ${s.id} → not a limit; still hands off; signal recorded`, () => {
    const v = classify({ ...base, exitCode: 0, stdout: s.text, diff: { changed: true, files: 1 } })
    assert.equal(v.outcome, 'incomplete')
    assert.equal(v.handoff, true)
    assert.equal(v.signal, s.id)
  })
}

test('precedence: auth over limit (exit 0, limit text on stdout, auth text on stderr)', () => {
  const v = classify({ ...base, exitCode: 0, stdout: '{"is_error":true,"result":"You’ve hit your session limit"}', stderr: 'warning: another auth source is set' })
  assert.equal(v.outcome, 'auth_failed')
  assert.equal(v.signal, 'auth-source-set')
  assert.equal(v.handoff, false)
})

test('precedence: kill timer → stalled beats limit text and exit code', () => {
  const v = classify({ ...base, exitCode: null, stdout: 'rate limit', killedByTimer: true })
  assert.equal(v.outcome, 'stalled')
  assert.equal(v.handoff, true)
})

test('precedence: killed from the board → killed, no handoff', () => {
  const v = classify({ ...base, exitCode: null, killedByHuman: true, killedByTimer: true })
  assert.equal(v.outcome, 'killed')
  assert.equal(v.handoff, false)
})

test('precedence: DONE marker + exit 0 → completed even if stdout mentions a quota', () => {
  const v = classify({ ...base, exitCode: 0, doneMarker: true, stdout: 'note: quota looks fine' })
  assert.equal(v.outcome, 'completed')
  assert.equal(v.handoff, false)
})

test('spawn error → launch_failed', () => {
  const v = classify({ ...base, spawnError: 'ENOENT' })
  assert.equal(v.outcome, 'launch_failed')
  assert.equal(v.handoff, true)
})

test('exit 0, no DONE, changes → incomplete; no changes → no_progress; non-zero → failed', () => {
  assert.equal(classify({ ...base, exitCode: 0, diff: { changed: true, files: 2 } }).outcome, 'incomplete')
  assert.equal(classify({ ...base, exitCode: 0, diff: { changed: false, files: 0 } }).outcome, 'no_progress')
  assert.equal(classify({ ...base, exitCode: 0, diff: null }).outcome, 'no_progress')
  const f = classify({ ...base, exitCode: 2, stderr: 'TypeError: boom' })
  assert.equal(f.outcome, 'failed')
  assert.equal(f.handoff, true)
})

test('classify always returns one of the nine outcomes with signal and handoff', () => {
  const inputs = [base, { ...base, exitCode: 1 }, { ...base, stdout: 'quota' }, { ...base, killedByTimer: true }]
  for (const i of inputs) {
    const v = classify(i)
    assert.ok(OUTCOMES.includes(v.outcome))
    assert.equal(typeof v.signal, 'string')
    assert.equal(typeof v.handoff, 'boolean')
  }
})

test('adapter-specific fixture wins over the generic one; generic still fires for other adapters', () => {
  const codex = classify({ ...base, adapter: 'codex', exitCode: 1, stdout: 'You’ve hit your usage limit for gpt. Switch to another model now' })
  assert.equal(codex.signal, 'codex-usage-limit')
  const agy = classify({ ...base, adapter: 'agy', exitCode: 1, stderr: 'HTTP 429 Too Many Requests' })
  assert.equal(agy.outcome, 'limit')
  assert.equal(agy.signal, 'generic-429')
})
