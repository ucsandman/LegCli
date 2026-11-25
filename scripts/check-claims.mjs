#!/usr/bin/env node
// Every dated or numbered claim Leg makes in public, checked against one
// file. Two separate jobs:
//
//   node scripts/check-claims.mjs            consistency, offline, runs in CI
//   node scripts/check-claims.mjs --strict   also asks each CLI what it is now
//
// Consistency asks: does every surface state the versions and counts in
// fixtures/verified.json? A surface that says "463 tests" while another says
// "406" is a trust liability whichever one is right, so a mismatch fails.
//
// Strict asks: is the pin still fresh? An agent CLI ships most weeks, and
// "verified against 2.1.268" quietly becomes a claim about a version nobody
// runs any more. Comparing for equality against a CLI that ships daily is red
// every week (2026-11-09, 11-16 and 11-24), so strict prints what moved and
// fails only once the dated verification is older than the pin's maxAgeDays.
// This half is scheduled weekly rather than run on every push, because drift
// is not a broken build, it is a prompt to go and re-verify.
//
//   --pin <file>        another pin file (default fixtures/verified.json)
//   --today YYYY-MM-DD  the date to judge the pin's age against (implies --strict)
//
// Every verdict prints the number of things it looked at. A check that can
// pass without touching anything is indistinguishable from a clean week.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argValue = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : (process.argv[i + 1] ?? '')
}
const usage = (message) => { console.error(`check-claims: ${message}`); process.exit(2) }

const todayArg = argValue('--today')
const strict = process.argv.includes('--strict') || todayArg !== undefined
const testsArg = process.argv.indexOf('--tests')
const measuredTests = testsArg !== -1 ? Number(process.argv[testsArg + 1]) : null

const DAY = 86400000
const dayOf = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : null
}
if (todayArg !== undefined && dayOf(todayArg) === null) usage(`--today wants a real date as YYYY-MM-DD, got "${todayArg}"`)

const pinArg = argValue('--pin')
if (pinArg === '') usage('--pin wants a file')
const pinPath = pinArg ? resolve(pinArg) : join(root, 'fixtures', 'verified.json')
if (!existsSync(pinPath)) usage(`pin file not found: ${pinArg}`)
const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
const problems = []
let checked = 0

// ---------------------------------------------------------------- consistency

// A version string is only a claim about a CLI when the CLI is named near it,
// so each surface is searched for the version and then for a contradicting one:
// any OTHER version of the same shape attached to the same CLI's name.
const versionsSeen = new Map()

for (const surface of pin.surfaces) {
  const path = join(root, surface)
  if (!existsSync(path)) { problems.push(`surface missing: ${surface}`); continue }
  const text = readFileSync(path, 'utf8')

  for (const [key, cli] of Object.entries(pin.clis)) {
    // Every version-shaped token that sits next to this CLI's label.
    const near = new RegExp(`${cli.label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]{0,24}?(\\d+\\.\\d+\\.\\d+)`, 'g')
    for (const m of text.matchAll(near)) {
      checked++
      const found = m[1]
      versionsSeen.set(`${key}:${found}`, (versionsSeen.get(`${key}:${found}`) || 0) + 1)
      if (found !== cli.version) {
        problems.push(`${surface}: says ${cli.label} ${found}, fixtures/verified.json pins ${cli.version}`)
      }
    }
  }

  // Test counts. "463 tests" and "406 tests" on two pages is the same defect
  // whichever number is right.
  for (const m of text.matchAll(/(\d{2,5})\s+tests\b/g)) {
    checked++
    if (Number(m[1]) !== pin.tests) {
      problems.push(`${surface}: says ${m[1]} tests, fixtures/verified.json pins ${pin.tests}`)
    }
  }

  // The verification date, in both the forms the surfaces use.
  for (const m of text.matchAll(/(?:verified|checked)[^\n.]{0,40}?(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]+ \d{4})/gi)) {
    checked++
    const found = m[1]
    if (found !== pin.verifiedOn && found !== pin.verifiedOnLong) {
      problems.push(`${surface}: says verified ${found}, fixtures/verified.json pins ${pin.verifiedOn} / ${pin.verifiedOnLong}`)
    }
  }
}

if (measuredTests !== null && Number.isFinite(measuredTests)) {
  checked++
  if (measuredTests !== pin.tests) {
    problems.push(`the suite just reported ${measuredTests} tests, fixtures/verified.json pins ${pin.tests}`)
  }
}

console.log(`claims: ${checked} version, count and date mentions checked across ${pin.surfaces.length} surfaces`)

// ---------------------------------------------------------------------- drift

// A version command prints more than the version ("grok 1.0.34 (3736acbc8658)
// [stable]", "codex-cli 0.154.0"), so every answer is reduced to its first
// x.y.z before it is compared with a pin that only ever holds x.y.z.
const semver = (text) => String(text ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? null

// The binary Leg itself would spawn (the adapter's resolve()), then the bare
// name on PATH. Spawned as argv and never through a shell, like every other
// spawn in this repo; on Windows that means naming the extension ourselves.
async function localVersion(key, probe) {
  const [name, ...args] = probe.split(' ')
  const candidates = []
  try {
    const { bin, viaNode, entry } = (await import(`../src/adapters/${key}.mjs`)).default.resolve()
    candidates.push(viaNode ? [process.execPath, [entry ?? bin, ...args]] : [bin, args])
  } catch { /* not a built-in adapter: PATH only */ }
  for (const spelling of process.platform === 'win32' ? [`${name}.exe`, name] : [name]) candidates.push([spelling, args])
  for (const [bin, argv] of candidates) {
    try {
      const v = semver(execFileSync(bin, argv, { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
      if (v) return v
    } catch { /* try the next spelling */ }
  }
  return null
}

async function npmLatest(pkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, { headers: { Accept: 'application/json' } })
    return res.ok ? semver((await res.json()).version) : null
  } catch { return null }
}

if (strict) {
  let probed = 0
  const moved = []
  const total = Object.keys(pin.clis).length
  const pad = Math.max(...Object.values(pin.clis).map((c) => c.label.length))

  // npm latest is printed for information only: what this machine runs is
  // what the taps were verified on, and the registry is consulted for the
  // "moved" count only where no local binary answers (a CI runner).
  for (const [key, cli] of Object.entries(pin.clis)) {
    const npm = cli.npm ? await npmLatest(cli.npm) : null
    const local = cli.probe ? await localVersion(key, cli.probe) : null
    console.log(`  ${cli.label.padEnd(pad)}  pinned ${cli.version.padEnd(9)} npm ${(npm ?? '-').padEnd(9)} local ${local ?? '-'}`)
    const current = local ?? npm
    if (!current) continue
    probed++
    if (current !== cli.version) moved.push(`${cli.label}: pinned ${cli.version}, now ${current} (${local ? 'local' : 'npm'})`)
  }

  console.log(`drift: ${probed} of ${total} CLIs reachable and compared`)
  for (const m of moved) console.log(`  moved: ${m}`)

  const verified = dayOf(pin.verifiedOn)
  const today = todayArg ?? new Date().toISOString().slice(0, 10)
  const budget = Number.isInteger(pin.maxAgeDays) ? pin.maxAgeDays : 30
  if (verified === null) {
    console.error(`the pin's verifiedOn "${pin.verifiedOn}" is not a YYYY-MM-DD date`)
    process.exitCode = 1
  } else {
    const age = Math.round((dayOf(today) - verified) / DAY)
    const due = new Date(verified + budget * DAY).toISOString().slice(0, 10)
    if (age > budget) {
      console.error(`re-verification overdue: verified ${pin.verifiedOn}, ${age} days ago, budget ${budget}; ${moved.length} of ${probed} reachable CLIs moved`)
      console.error('Re-run the taps on a real machine, then update the pin and every surface in the same commit.')
      process.exitCode = 1
    } else {
      console.log(`within budget, due by ${due}; ${moved.length} moved`)
    }
  }
}

// --------------------------------------------------------------------- verdict

if (problems.length) {
  console.error(`\n${problems.length} claim${problems.length === 1 ? '' : 's'} disagree with fixtures/verified.json:\n`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exitCode = 1
} else {
  console.log('every surface agrees with the pin')
}
