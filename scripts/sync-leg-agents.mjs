#!/usr/bin/env node
// Keep packages/leg-agents on the same version as @ucsandman/legcli.
// Source of truth: the root package.json version and engines.node.
//
//   node scripts/sync-leg-agents.mjs          write version, pin, LICENSE, NOTICE
//   node scripts/sync-leg-agents.mjs --check  exit 1 if any of those drifted
//
// npm test runs --check. `npm version` runs the writer so a bump cannot
// leave the alias behind.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCommand } from '../src/commands.mjs'

export const ALIAS_NAME = 'leg-agents'
export const PRIMARY_NAME = '@ucsandman/legcli'
export const PACKED_FILES = ['package.json', 'bin/leg.mjs', 'LICENSE', 'NOTICE', 'README.md']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function inspect (rootDir = root) {
  const alias = join(rootDir, 'packages', 'leg-agents')
  const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const aliasPkg = JSON.parse(readFileSync(join(alias, 'package.json'), 'utf8'))
  const wrapper = readFileSync(join(alias, 'bin', 'leg.mjs'), 'utf8')
  const rootLicense = readFileSync(join(rootDir, 'LICENSE'))
  const rootNotice = readFileSync(join(rootDir, 'NOTICE'))
  const aliasLicense = readFileSync(join(alias, 'LICENSE'))
  const aliasNotice = readFileSync(join(alias, 'NOTICE'))
  const problems = []

  if (rootPkg.name !== PRIMARY_NAME) {
    problems.push(`root package name is ${rootPkg.name}, expected ${PRIMARY_NAME}`)
  }
  if (aliasPkg.name !== ALIAS_NAME) {
    problems.push(`alias package name is ${aliasPkg.name}, expected ${ALIAS_NAME}`)
  }
  if (aliasPkg.version !== rootPkg.version) {
    problems.push(`alias version ${aliasPkg.version} != ${PRIMARY_NAME} ${rootPkg.version}`)
  }
  const pin = aliasPkg.dependencies?.[PRIMARY_NAME]
  if (pin !== rootPkg.version) {
    problems.push(`alias pins ${PRIMARY_NAME}@${pin ?? '(missing)'}, expected ${rootPkg.version}`)
  }
  if (aliasPkg.engines?.node !== rootPkg.engines?.node) {
    problems.push(`alias engines.node ${aliasPkg.engines?.node} != root ${rootPkg.engines?.node}`)
  }
  if (aliasPkg.bin?.leg !== 'bin/leg.mjs') {
    problems.push(`alias bin.leg is ${aliasPkg.bin?.leg}, expected bin/leg.mjs`)
  }
  if (!Array.isArray(rootPkg.files) || rootPkg.files.includes('packages') || rootPkg.files.some((f) => String(f).startsWith('packages/'))) {
    problems.push('root package.json files must not ship packages/leg-agents')
  }
  if (!rootLicense.equals(aliasLicense)) problems.push('packages/leg-agents/LICENSE does not match root LICENSE')
  if (!rootNotice.equals(aliasNotice)) problems.push('packages/leg-agents/NOTICE does not match root NOTICE')
  if (!wrapper.startsWith('#!/usr/bin/env node')) {
    problems.push('packages/leg-agents/bin/leg.mjs is missing the node shebang')
  }
  if (!wrapper.includes("require.resolve('@ucsandman/legcli/package.json')")) {
    problems.push('alias wrapper does not resolve @ucsandman/legcli/package.json')
  }
  if (!wrapper.includes('pathToFileURL')) {
    problems.push('alias wrapper must import via pathToFileURL so Windows absolute paths work')
  }
  if (!wrapper.includes("join(pkgRoot, 'bin', 'leg.mjs')")) {
    problems.push('alias wrapper does not load bin/leg.mjs from the pinned package')
  }

  return { rootPkg, aliasPkg, wrapper, problems, aliasDir: alias }
}

export function packedFileList (dir) {
  const { bin, args } = resolveCommand('npm pack --dry-run --json --ignore-scripts')
  const stdout = execFileSync(bin, args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  const startArr = stdout.indexOf('[')
  const startObj = stdout.indexOf('{')
  const start = startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startArr, startObj)
  if (start === -1) throw new Error(`npm pack produced no JSON:\n${stdout}`)
  const parsed = JSON.parse(stdout.slice(start))
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  const files = (entry.files || []).map((f) => f.path || f)
  return files.sort()
}

export function sync (rootDir = root) {
  const { rootPkg, aliasPkg } = inspect(rootDir)
  const alias = join(rootDir, 'packages', 'leg-agents')
  const next = {
    ...aliasPkg,
    version: rootPkg.version,
    dependencies: { ...aliasPkg.dependencies, [PRIMARY_NAME]: rootPkg.version },
    engines: { ...aliasPkg.engines, node: rootPkg.engines.node }
  }
  writeFileSync(join(alias, 'package.json'), JSON.stringify(next, null, 2) + '\n')
  copyFileSync(join(rootDir, 'LICENSE'), join(alias, 'LICENSE'))
  copyFileSync(join(rootDir, 'NOTICE'), join(alias, 'NOTICE'))
  return next
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const check = process.argv.includes('--check')
  if (!check) sync()
  const { rootPkg, problems, aliasDir: dir } = inspect()
  let packed
  try {
    packed = packedFileList(dir)
  } catch (error) {
    problems.push(`npm pack --dry-run failed: ${error.message}`)
  }
  if (packed) {
    const expected = [...PACKED_FILES].sort()
    if (packed.join('\n') !== expected.join('\n')) {
      problems.push(`packed files are [${packed.join(', ')}], expected [${expected.join(', ')}]`)
    }
  }
  if (problems.length) {
    console.error(`leg-agents is out of lockstep with ${PRIMARY_NAME}@${rootPkg.version}:\n`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nRun: node scripts/sync-leg-agents.mjs')
    process.exitCode = 1
  } else {
    console.log(`leg-agents: in lockstep with ${PRIMARY_NAME}@${rootPkg.version}`)
  }
}
