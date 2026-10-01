// site/thanks.html is where a buyer lands after paying, and the one place they
// are told where their key is. /api/key proves the key; it knows nothing about
// whether the copy emailed by the webhook was sent or delivered, so the page
// may not say it was. The page script runs here through the same Function seam
// the board tests use, against a stub document and a stubbed /api/key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const HTML = readFileSync(join(ROOT, 'site', 'thanks.html'), 'utf8')
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1]
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const FAIL_COPY = textOf(HTML.match(/<div class="state" id="fail"[^>]*>([\s\S]*?)<\/div>/)[1])

// wording that says an email went out or is waiting in an inbox
const DELIVERY_CLAIM = /went to|has been sent|was sent to|is in (the|your) (email|inbox)|in the email from/i

async function render({ status = 200, body }) {
  const els = new Map()
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] }, addEventListener() {} })
      return els.get(id)
    }
  }
  const fetch = async () => ({ ok: status < 400, status, json: async () => body })
  new Function('document', 'location', 'fetch', 'navigator', SCRIPT)(document, { search: '?session_id=cs_test_thanks' }, fetch, { clipboard: { writeText: async () => {} } })
  await new Promise((resolve) => setImmediate(resolve))
  return (id) => document.getElementById(id)
}

test('a fetched key is shown without claiming its email copy was sent or delivered', async () => {
  const el = await render({ body: { key: 'LEG-payload.signature', plan: 'personal', seats: 1, updates_until: '2027-09-11', email: 'bu***@example.test' } })
  assert.equal(el('ok').hidden, false)
  assert.equal(el('key').textContent, 'LEG-payload.signature')
  const note = el('emailed').textContent
  assert.doesNotMatch(note, DELIVERY_CLAIM)
  assert.match(note, /bu\*\*\*@example\.test/)
  assert.match(note, /cannot confirm/i)
  assert.match(note, /reopen/i)
})

test('a key with no checkout address names no email at all', async () => {
  const el = await render({ body: { key: 'LEG-payload.signature', plan: 'team', seats: 3, expires: '2026-11-15', email: '' } })
  assert.equal(el('ok').hidden, false)
  assert.doesNotMatch(el('emailed').textContent, DELIVERY_CLAIM)
  assert.doesNotMatch(el('emailed').textContent, /@/)
})

test('a key that cannot be fetched gets recovery steps that do not assume an email exists', async () => {
  const el = await render({ status: 402, body: { error: 'this checkout is not paid' } })
  assert.equal(el('fail').hidden, false)
  assert.equal(el('why').textContent, 'this checkout is not paid')
  assert.doesNotMatch(FAIL_COPY, DELIVERY_CLAIM)
  assert.match(FAIL_COPY, /bank/i, 'a delayed payment is told why there is no key yet')
  assert.match(FAIL_COPY, /reopen this link/i)
  assert.match(FAIL_COPY, /legcli@practicalsystems\.io/)
})
