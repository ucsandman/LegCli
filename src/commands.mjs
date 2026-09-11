// commands — run a repository command (tests) as argv, never through a shell.
// `npm`/`npx`/`node` resolve to node + their JS entry so the Windows .cmd shim
// is never needed (LESSONS 07-11).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveNpmCliEntry } from './adapters/resolve.mjs'
import { scrub } from './runner.mjs'

function tokenize(cmd) {
  return cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
}

export function resolveCommand(cmd) {
  const tokens = tokenize(cmd)
  if (!tokens.length) throw new Error('empty test command')
  const [bin, ...rest] = tokens
  if (bin === 'node') return { bin: process.execPath, args: rest }
  if (bin === 'npm' || bin === 'npx') {
    const entry = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${bin}-cli.js`)
    const found = existsSync(entry) ? entry : resolveNpmCliEntry('npm', bin)
    if (!found) throw new Error(`cannot resolve ${bin}'s JS entry`)
    return { bin: process.execPath, args: [found, ...rest] }
  }
  return { bin, args: rest }
}

export function runCommand(cmd, cwd, { timeoutMs = 600000, tailLines = 40 } = {}) {
  const { bin, args } = resolveCommand(cmd)
  // A nested `node --test` inherits NODE_TEST_CONTEXT from a parent test runner
  // and then reports to that parent instead of exiting red; the repo's tests
  // must run as a plain process.
  const env = { ...process.env, MSYS_NO_PATHCONV: '1', CI: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k]
  const r = spawnSync(bin, args, { cwd, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, env })
  const tail = scrub(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).trim().split('\n').slice(-tailLines).join('\n')
  return { green: r.status === 0, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', tail, command: `${bin} ${args.join(' ')}` }
}
