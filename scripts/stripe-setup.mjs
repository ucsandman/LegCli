#!/usr/bin/env node
// Create (idempotently) the two Baton plans in Stripe, their payment links,
// and the webhook endpoint for the site. Test mode by default, --live for the
// live account. Secrets never print: the webhook signing secret and the link
// URLs are written to .env (gitignored); ids and public URLs print.
//   node --env-file=.env scripts/stripe-setup.mjs --site https://batonagents.com [--live]
import { readFileSync, writeFileSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter((x) => x.length))
const live = args.live === true
const key = live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY
if (!key) { console.error(live ? 'STRIPE_SECRET_KEY missing' : 'STRIPE_TEST_SECRET_KEY missing'); process.exit(2) }
if (live && !key.startsWith('sk_live')) { console.error('--live but the key is not sk_live'); process.exit(2) }
if (!live && !key.startsWith('sk_test')) { console.error('test run but the key is not sk_test'); process.exit(2) }
const SITE = args.site || 'https://legcli.com'

function form(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) v.forEach((x, i) => out.push(typeof x === 'object' ? form(x, `${name}[${i}]`) : `${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(x)}`))
    else if (typeof v === 'object') out.push(form(v, name))
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(v)}`)
  }
  return out.filter(Boolean).join('&')
}
async function stripe(path, { method = 'GET', body, query } = {}) {
  const r = await fetch('https://api.stripe.com/v1' + path + (query ? '?' + form(query) : ''), { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body ? form(body) : undefined })
  const j = await r.json()
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error?.message}`)
  return j
}

async function priceByLookup(lookup) {
  const r = await stripe('/prices', { query: { lookup_keys: [lookup], active: true, limit: 1 } })
  return r.data[0] || null
}

async function ensurePlan({ name, description, lookup, unit_amount, recurring, statement }) {
  let price = await priceByLookup(lookup)
  if (price) return { price, created: false }
  const product = await stripe('/products', { method: 'POST', body: { name, description, statement_descriptor: statement, metadata: { plan: lookup.replace('baton_', '') } } })
  price = await stripe('/prices', { method: 'POST', body: { product: product.id, currency: 'usd', unit_amount, lookup_key: lookup, recurring, tax_behavior: 'exclusive', metadata: { plan: lookup.replace('baton_', '') } } })
  return { price, created: true }
}

async function ensureLink(price, { adjustable, mode }) {
  const existing = await stripe('/payment_links', { query: { active: true, limit: 100 } })
  for (const l of existing.data) {
    if (l.metadata?.baton_price === price.id && l.metadata?.baton_site === SITE) return { link: l, created: false }
  }
  const body = {
    'line_items[0][price]': price.id, 'line_items[0][quantity]': 1,
    'after_completion[type]': 'redirect', 'after_completion[redirect][url]': `${SITE}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    'automatic_tax[enabled]': true, 'tax_id_collection[enabled]': true, billing_address_collection: 'auto', allow_promotion_codes: true,
    'metadata[baton_price]': price.id, 'metadata[baton_site]': SITE,
  }
  if (adjustable) { body['line_items[0][adjustable_quantity][enabled]'] = true; body['line_items[0][adjustable_quantity][minimum]'] = 1; body['line_items[0][adjustable_quantity][maximum]'] = 200 }
  if (mode === 'payment') body['invoice_creation[enabled]'] = true
  const link = await stripe('/payment_links', { method: 'POST', body })
  return { link, created: true }
}

async function ensureWebhook() {
  const url = `${SITE}/api/webhook`
  const existing = await stripe('/webhook_endpoints', { query: { limit: 100 } })
  const have = existing.data.find((w) => w.url === url && w.status === 'enabled')
  if (have) return { endpoint: have, secret: null, created: false }
  const endpoint = await stripe('/webhook_endpoints', { method: 'POST', body: { url, enabled_events: ['checkout.session.completed', 'invoice.paid'], description: 'Leg license delivery' } })
  return { endpoint, secret: endpoint.secret, created: true }
}

function setEnv(pairs) {
  let env = readFileSync('.env', 'utf8')
  for (const [k, v] of Object.entries(pairs)) {
    if (v === null || v === undefined) continue
    env = new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env + (env.endsWith('\n') ? '' : '\n') + `${k}=${v}\n`
  }
  writeFileSync('.env', env)
}

// Refuse to create anything in an account that is not the seller's.
const acct = await stripe('/account')
const acctName = acct.settings?.dashboard?.display_name || acct.business_profile?.name || ''
if (!/practical systems/i.test(acctName)) { console.error(`this key belongs to "${acctName}", not Practical Systems; pin the right one with creds mint STRIPE_SECRET_KEY`); process.exit(3) }
console.log(`account: ${acctName} (${live ? 'live' : 'test'})`)

const personal = await ensurePlan({ name: 'Leg Personal', description: 'One machine or several, one human. Every Leg release for 12 months; the version you have keeps working after that.', lookup: 'leg_personal', unit_amount: 7900, statement: 'LEG PERSONAL' })
const team = await ensurePlan({ name: 'Leg Team', description: 'Per seat, per month. Everything in Personal plus the shared board (leg share) and Land for more than one human.', lookup: 'leg_team', unit_amount: 1200, recurring: { interval: 'month' }, statement: 'LEG TEAM' })
const lp = await ensureLink(personal.price, { adjustable: false, mode: 'payment' })
const lt = await ensureLink(team.price, { adjustable: true, mode: 'subscription' })
const wh = await ensureWebhook()
const mode = live ? 'LIVE' : 'TEST'
setEnv({ [`STRIPE_${mode}_PAYMENT_LINK_PERSONAL`]: lp.link.url, [`STRIPE_${mode}_PAYMENT_LINK_TEAM`]: lt.link.url, [`STRIPE_${mode}_WEBHOOK_SECRET`]: wh.secret })
console.log(`${mode} mode against ${SITE}`)
console.log(`personal  ${personal.price.id} $79 once      link ${lp.link.url}${personal.created ? ' (created)' : ''}`)
console.log(`team      ${team.price.id} $12/seat/mo   link ${lt.link.url}${team.created ? ' (created)' : ''}`)
console.log(`webhook   ${wh.endpoint.id} -> ${wh.endpoint.url} ${wh.created ? '(created; secret written to .env)' : '(existing; secret unchanged)'}`)
