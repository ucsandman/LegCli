#!/usr/bin/env node
// Push the site's secrets from .env to the Vercel project without printing
// them: each value goes to `vercel env add NAME production` on stdin.
//   node --env-file=.env scripts/vercel-env.mjs --mode test|live --site https://batonagents.com
import { spawnSync } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length))
if (!['test', 'live'].includes(args.mode)) {
  console.error('Usage: node scripts/vercel-env.mjs --mode test|live [--site URL]')
  process.exit(2)
}
const live = args.mode === 'live'
const vars = {
  STRIPE_SECRET_KEY: live ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: live ? process.env.STRIPE_LIVE_WEBHOOK_SECRET : process.env.STRIPE_TEST_WEBHOOK_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  BATON_LICENSE_PRIVATE_KEY: process.env.BATON_LICENSE_PRIVATE_KEY,
  BATON_SITE_ORIGIN: args.site || 'https://baton-agents.vercel.app',
  BATON_MAIL_FROM: 'Baton <baton@practicalsystems.io>',
  BATON_MAIL_REPLY_TO: 'wes@practicalsystems.io',
}
const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) { console.error('missing in .env: ' + missing.join(', ')); process.exit(2) }
// The Vercel CLI's JS entry, run with this node: no shell, so a value with
// shell characters is never interpreted and the repo's no-shell rule holds.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const roots = [process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global', 'lib', 'node_modules')].filter(Boolean)
const vercelJs = roots.map((r) => join(r, 'vercel', 'dist', 'index.js')).find((f) => existsSync(f))
if (!vercelJs) { console.error('vercel CLI not found in a global node_modules; npm i -g vercel'); process.exit(2) }
for (const [k, v] of Object.entries(vars)) {
  spawnSync(process.execPath, [vercelJs, 'env', 'rm', k, 'production', '--yes'], { cwd: 'site', encoding: 'utf8' })
  const r = spawnSync(process.execPath, [vercelJs, 'env', 'add', k, 'production'], { cwd: 'site', input: v, encoding: 'utf8' })
  console.log(`${k.padEnd(28)} ${r.status === 0 ? 'set' : 'FAILED ' + (r.stderr || r.stdout).split('\n').filter(Boolean).slice(-1)[0]}`)
}
