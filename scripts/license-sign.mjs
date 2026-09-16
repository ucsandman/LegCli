#!/usr/bin/env node
// Sign a Leg license key by hand (the site's /api/key does the same for
// paid orders). Needs BATON_LICENSE_PRIVATE_KEY in the environment:
//   node --env-file=.env scripts/license-sign.mjs --plan personal --email you@example.com
//   node --env-file=.env scripts/license-sign.mjs --plan team --email ops@acme.com --seats 5 --months 1
// Prints the key on stdout and nothing else.
import { randomBytes } from 'node:crypto'
import { signLicense, emailHash } from '../src/license.mjs'

const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++ }
const priv = (process.env.LEG_LICENSE_PRIVATE_KEY || process.env.BATON_LICENSE_PRIVATE_KEY)
if (!priv) { process.stderr.write('BATON_LICENSE_PRIVATE_KEY is not set\n'); process.exit(2) }
const plan = args.plan === 'team' ? 'team' : 'personal'
const issued = args.issued || new Date().toISOString().slice(0, 10)
const months = parseInt(args.months || (plan === 'team' ? '1' : '12'), 10)
const end = new Date(issued + 'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + months)
const endIso = new Date(end.getTime() + (plan === 'team' ? 3 * 86400000 : 0)).toISOString().slice(0, 10)
const payload = { v: 1, id: args.id || ('lic_' + randomBytes(8).toString('hex')), plan, seats: parseInt(args.seats || '1', 10), email_hash: emailHash(args.email || ''), issued }
if (plan === 'personal') payload.updates_until = endIso
else { payload.expires = endIso; if (args.sub) payload.sub = args.sub }
process.stdout.write(signLicense(payload, priv) + '\n')
