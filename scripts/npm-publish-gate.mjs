#!/usr/bin/env node
// Registry gate for a main-branch publish. Checks @ucsandman/legcli and
// leg-agents, refuses to ship if their versions differ, and writes
// GITHUB_OUTPUT so ci.yml can publish only the missing package(s).
// Fail closed: network errors, invalid JSON, prereleases, stale versions,
// and metadata drift exit 1.
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseSection } from './release-notes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_REPOSITORY = 'https://github.com/ucsandman/legcli.git'
const PRIMARY_NAME = '@ucsandman/legcli'
const ALIAS_NAME = 'leg-agents'

const fail = (message) => { throw new Error(message) }

const stableVersion = (value) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

const writeOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  console.log(`${name}=${value}`)
}

async function registryStatus (name, version) {
  const candidate = stableVersion(version)
  if (!candidate) fail(`invalid stable package version: ${name}@${version}`)
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  let response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    fail(`npm registry request failed for ${name}@${version}: ${error.message}`)
  }

  if (response.status === 404) {
    let packageResponse
    try {
      packageResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { headers: { Accept: 'application/json' } })
    } catch (error) {
      fail(`npm package metadata request failed for ${name}: ${error.message}`)
    }
    if (packageResponse.status === 404) {
      console.log(`${name}@${version} is missing (package not yet on npm); publication is required`)
      return false
    }
    if (packageResponse.status !== 200) {
      fail(`npm package metadata for ${name} returned unexpected status ${packageResponse.status}`)
    }
    let metadata
    try {
      metadata = await packageResponse.json()
    } catch {
      fail(`npm package metadata for ${name} returned invalid JSON`)
    }
    const latestText = metadata?.['dist-tags']?.latest
    const latest = stableVersion(latestText)
    if (!latest) fail(`npm latest tag for ${name} is not a stable version: ${latestText ?? '(missing)'}`)
    const changedPart = candidate.findIndex((part, index) => part !== latest[index])
    const newer = changedPart !== -1 && candidate[changedPart] > latest[changedPart]
    if (!newer) fail(`refusing to publish missing ${name}@${version} because npm latest is ${latestText}`)
    console.log(`${name}@${version} is missing and newer than npm latest ${latestText}; publication is required`)
    return false
  }
  if (response.status !== 200) fail(`npm registry returned unexpected status ${response.status} for ${name}@${version}`)
  let published
  try {
    published = await response.json()
  } catch {
    fail(`npm registry returned invalid JSON for existing ${name}@${version}`)
  }
  if (published?.name !== name || published?.version !== version) {
    fail(`npm registry response did not match the requested ${name}@${version}`)
  }
  console.log(`${name}@${version} already exists; skipping publication`)
  return true
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const alias = JSON.parse(readFileSync(join(root, 'packages', 'leg-agents', 'package.json'), 'utf8'))
const lockRoot = lock.packages?.['']

try {
  if (!lockRoot || pkg.name !== PRIMARY_NAME || lockRoot.name !== pkg.name || lockRoot.version !== pkg.version || lock.version !== pkg.version) {
    fail('package.json and package-lock.json root metadata do not match')
  }
  if (pkg.repository?.url !== EXPECTED_REPOSITORY || lockRoot.repository?.url !== EXPECTED_REPOSITORY) {
    fail('package repository metadata does not match the npm trusted publisher binding')
  }
  if (alias.name !== ALIAS_NAME) fail(`alias package name is ${alias.name}, expected ${ALIAS_NAME}`)
  if (alias.version !== pkg.version) {
    fail(`refusing to publish: ${ALIAS_NAME}@${alias.version} is not in lockstep with ${PRIMARY_NAME}@${pkg.version}`)
  }
  if (alias.dependencies?.[PRIMARY_NAME] !== pkg.version) {
    fail(`refusing to publish: ${ALIAS_NAME} pins ${PRIMARY_NAME}@${alias.dependencies?.[PRIMARY_NAME] ?? '(missing)'}, expected ${pkg.version}`)
  }
  if (alias.repository?.url !== EXPECTED_REPOSITORY) {
    fail('alias package repository metadata does not match the npm trusted publisher binding')
  }
  // The GitHub release ci.yml creates after the publish is this section, so a
  // version nobody wrote up in CHANGELOG.md never reaches npm either.
  releaseSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), pkg.version)

  const primaryPublished = await registryStatus(pkg.name, pkg.version)
  const aliasPublished = await registryStatus(alias.name, alias.version)
  writeOutput('published', String(primaryPublished))
  writeOutput('alias_published', String(aliasPublished))
} catch (error) {
  console.error(`registry gate failed: ${error.message}`)
  process.exitCode = 1
}
