#!/usr/bin/env node
// sync-harness-engine — the one way the vendored harness engine changes.
//
// Leg's portable-harness subsystem (src/harness/) runs the Agnostic AI port
// engine (MIT, github.com/ucsandman/Agnostic-AI) as a library. The engine is
// copied byte for byte into src/harness/vendor/agnostic-ai/ so the package has
// no runtime dependency and no build step, and this script is the only thing
// that writes there:
//
//   node scripts/sync-harness-engine.mjs <path-to-agnostic-ai-checkout>
//       copy the engine files, record the upstream commit and every file's
//       sha256 in src/harness/vendor/agnostic-ai/UPSTREAM.json
//   node scripts/sync-harness-engine.mjs --check
//       verify every vendored file still matches the recorded hash (runs in
//       `npm test`); a hand edit under vendor/ fails the build, because a
//       fix belongs upstream and then here through this script
//   node scripts/sync-harness-engine.mjs --diff <path-to-agnostic-ai-checkout>
//       list vendored files that differ from that checkout (exit 1 if any)
//
// Every verdict prints the number of files it looked at.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const VENDOR_DIR = join(ROOT, 'src', 'harness', 'vendor', 'agnostic-ai')
export const MANIFEST = join(VENDOR_DIR, 'UPSTREAM.json')

// What Leg embeds: the engine as a library plus the two data files it reads by
// default and the hook shim its targets point at. The repo's own CLI
// (engine/harness/cli.cjs) and everything outside engine/harness stay upstream.
export const FILES = [
  'LICENSE',
  'engine/harness/README.md',
  'engine/harness/index.cjs',
  'engine/harness/common.cjs',
  'engine/harness/bundle.cjs',
  'engine/harness/capture.cjs',
  'engine/harness/apply.cjs',
  'engine/harness/status.cjs',
  'engine/harness/toml.cjs',
  'engine/harness/sources/claude.cjs',
  'engine/harness/sources/codex.cjs',
  'engine/harness/targets/generic.cjs',
  'engine/harness/targets/claude.cjs',
  'engine/harness/targets/codex.cjs',
  'engine/harness/targets/gemini.cjs',
  'engine/harness/targets/agy.cjs',
  'engine/harness/targets/cursor.cjs',
  'engine/hooks/shim.cjs',
  'core/templates/targets.json',
  'core/safety/guards.json',
]

const posix = (p) => p.replace(/\\/g, '/')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
// Line endings are normalised before hashing so a checkout with autocrlf and one
// without agree on what "identical" means.
const hashFile = (file) => sha256(readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'))

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

export function sync(upstream) {
  const src = resolve(upstream)
  for (const rel of FILES) if (!existsSync(join(src, rel))) throw new Error(`upstream is missing ${rel}: ${src}`)
  if (existsSync(VENDOR_DIR)) {
    for (const f of walk(VENDOR_DIR)) if (posix(relative(VENDOR_DIR, f)) !== 'UPSTREAM.json') rmSync(f, { force: true })
  }
  const files = {}
  for (const rel of FILES) {
    const dest = join(VENDOR_DIR, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(src, rel), dest)
    files[rel] = hashFile(dest)
  }
  const commit = git(src, ['rev-parse', 'HEAD'])
  const dirty = git(src, ['status', '--porcelain']) || ''
  const manifest = {
    _comment: 'Written by scripts/sync-harness-engine.mjs; never edited by hand. Every file under this directory is a byte-for-byte copy of the Agnostic AI engine at the commit below, and `npm test` fails if one drifts.',
    upstream: 'https://github.com/ucsandman/Agnostic-AI',
    license: 'MIT (see LICENSE beside this file)',
    commit,
    upstreamDirty: Boolean(dirty.split('\n').filter(Boolean).some((l) => FILES.some((rel) => l.endsWith(rel)))),
    syncedAt: new Date().toISOString(),
    files,
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export function check() {
  const manifest = readManifest()
  const problems = []
  let checked = 0
  for (const [rel, hash] of Object.entries(manifest.files)) {
    checked++
    const file = join(VENDOR_DIR, rel)
    if (!existsSync(file)) { problems.push(`${rel}: missing`); continue }
    if (hashFile(file) !== hash) problems.push(`${rel}: differs from the recorded upstream hash (edit upstream, then re-run the sync)`)
  }
  for (const f of walk(VENDOR_DIR)) {
    const rel = posix(relative(VENDOR_DIR, f))
    if (rel === 'UNOWNED' || rel === 'UPSTREAM.json') continue
    checked++
    if (!manifest.files[rel]) problems.push(`${rel}: not in UPSTREAM.json (only the sync script adds files here)`)
  }
  return { problems, checked, commit: manifest.commit }
}

export function diff(upstream) {
  const manifest = readManifest()
  const src = resolve(upstream)
  const changed = []
  let checked = 0
  for (const rel of Object.keys(manifest.files)) {
    checked++
    const theirs = join(src, rel)
    if (!existsSync(theirs)) { changed.push(`${rel}: gone upstream`); continue }
    if (hashFile(theirs) !== hashFile(join(VENDOR_DIR, rel))) changed.push(rel)
  }
  return { changed, checked, commit: git(src, ['rev-parse', 'HEAD']) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2)
  if (mode === '--check') {
    const r = check()
    for (const p of r.problems) process.stdout.write(`  ${p}\n`)
    process.stdout.write(`harness-engine: ${r.problems.length ? 'DRIFT' : 'ok'} checked=${r.checked} upstream=${r.commit ?? 'unknown'}\n`)
    process.exit(r.problems.length ? 1 : 0)
  }
  if (mode === '--diff') {
    if (!arg) { process.stderr.write('usage: sync-harness-engine.mjs --diff <agnostic-ai checkout>\n'); process.exit(2) }
    const r = diff(arg)
    for (const p of r.changed) process.stdout.write(`  ${p}\n`)
    process.stdout.write(`harness-engine: ${r.changed.length} of ${r.checked} vendored file(s) differ from ${arg} (${r.commit ?? 'no git'})\n`)
    process.exit(r.changed.length ? 1 : 0)
  }
  if (!mode || mode.startsWith('--')) { process.stderr.write('usage: sync-harness-engine.mjs <agnostic-ai checkout> | --check | --diff <checkout>\n'); process.exit(2) }
  const m = sync(mode)
  process.stdout.write(`harness-engine: vendored ${Object.keys(m.files).length} file(s) from ${m.commit ?? 'no git'}${m.upstreamDirty ? ' (upstream working tree had uncommitted engine changes)' : ''}\n`)
}
