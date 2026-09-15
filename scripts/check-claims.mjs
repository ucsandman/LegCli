#!/usr/bin/env node
// Every dated or numbered claim Baton makes in public, checked against one
// file. Two separate jobs:
//
//   node scripts/check-claims.mjs            consistency, offline, runs in CI
//   node scripts/check-claims.mjs --strict   also asks each CLI what it is now
//
// Consistency asks: does every surface state the versions and counts in
// fixtures/verified.json? A surface that says "463 tests" while another says
// "406" is a trust liability whichever one is right, so a mismatch fails.
//
// Strict asks: is the pin still true? An agent CLI ships most weeks, and
// "verified against 2.1.268" quietly becomes a claim about a version nobody
// runs any more. This half is scheduled weekly rather than run on every push,
// because drift is not a broken build, it is a prompt to go and re-verify.
//
// Every verdict prints the number of things it looked at. A check that can
// pass without touching anything is indistinguishable from a clean week.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const testsArg = process.argv.indexOf('--tests')
const measuredTests = testsArg !== -1 ? Number(process.argv[testsArg + 1]) : null

const pin = JSON.parse(readFileSync(join(root, 'fixtures', 'verified.json'), 'utf8'))
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

if (strict) {
  let probed = 0
  const drift = []

  for (const [, cli] of Object.entries(pin.clis)) {
    let current = null
    let how = null

    if (cli.npm) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(cli.npm)}/latest`, { headers: { Accept: 'application/json' } })
        if (res.ok) { current = (await res.json()).version; how = `npm ${cli.npm}` }
        else drift.push(`${cli.label}: npm returned ${res.status}, could not check`)
      } catch (error) {
        drift.push(`${cli.label}: npm request failed (${error.message}), could not check`)
      }
    } else {
      // No registry to ask, so ask the binary if this machine has it. Spawned
      // as argv and never through a shell, like every other spawn in this
      // repo; on Windows that means naming the shim extension ourselves rather
      // than letting cmd resolve it.
      const [bin, ...args] = cli.probe.split(' ')
      const candidates = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
      for (const candidate of candidates) {
        try {
          current = execFileSync(candidate, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim()
          how = cli.probe
          break
        } catch { /* try the next spelling */ }
      }
      if (!current) {
        console.log(`  ${cli.label}: no npm package and ${cli.probe} is not available here; not checked`)
      }
    }

    if (!current) continue
    probed++
    if (current !== cli.version) {
      drift.push(`${cli.label}: pinned ${cli.version}, current ${current} (${how})`)
    }
  }

  console.log(`drift: ${probed} of ${Object.keys(pin.clis).length} CLIs reachable and compared`)

  if (drift.length) {
    console.error(`\nThe verified-against versions are behind. Re-run the taps on a real machine, then update fixtures/verified.json and every surface in the same commit.\n`)
    for (const d of drift) console.error(`  - ${d}`)
    process.exitCode = 1
  } else if (probed > 0) {
    console.log(`every reachable CLI still matches the pin of ${pin.verifiedOn}`)
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
