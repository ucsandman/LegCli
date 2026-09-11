// commands — run a repository command (tests) as argv, never through a shell.
// `npm`/`npx`/`node` resolve to node + their JS entry so the Windows .cmd shim
// is never needed (LESSONS 07-11).
import { spawnSync, spawn } from 'node:child_process'
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

// A nested `node --test` inherits NODE_TEST_CONTEXT from a parent test runner
// and then reports to that parent instead of exiting red; the repo's tests
// must run as a plain process.
function commandEnv() {
  const env = { ...process.env, MSYS_NO_PATHCONV: '1', CI: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k]
  return env
}

export function runCommand(cmd, cwd, { timeoutMs = 600000, tailLines = 40 } = {}) {
  const { bin, args } = resolveCommand(cmd)
  const r = spawnSync(bin, args, { cwd, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, env: commandEnv() })
  const tail = scrub(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).trim().split('\n').slice(-tailLines).join('\n')
  return { green: r.status === 0, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', tail, command: `${bin} ${args.join(' ')}` }
}

// The same result without blocking the event loop: the board server lands a
// terminal's branch in-process, and a long test run must not freeze the board.
export function runCommandAsync(cmd, cwd, { timeoutMs = 600000, tailLines = 40 } = {}) {
  const { bin, args } = resolveCommand(cmd)
  return new Promise((resolvePromise) => {
    let out = ''
    let timedOut = false
    let done = false
    const child = spawn(bin, args, { cwd, windowsHide: true, env: commandEnv() })
    const keep = (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    // On timeout, kill the whole process TREE: child.kill() ends only the npm
    // node process, and a grandchild (a watcher, a dev server) keeps the stdio
    // pipes open so 'close' never fires and the landing hangs in 'landing'
    // forever, wedging the repo's merge queue. taskkill /T /F takes the tree.
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {} }
      else { try { child.kill('SIGKILL') } catch {} }
    }, timeoutMs)
    const finish = (status, err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const tail = scrub(`${out}${err ? `\n${err.message}` : ''}`).trim().split('\n').slice(-tailLines).join('\n')
      resolvePromise({ green: status === 0 && !timedOut, status, timedOut, tail, command: `${bin} ${args.join(' ')}` })
    }
    child.on('error', (err) => finish(null, err))
    // resolve on 'exit' (fires when the process ends) as well as 'close' (waits
    // for every inherited pipe to close, which a detached grandchild can hold
    // open indefinitely); finish is idempotent via `done`
    child.on('exit', (code) => finish(code))
    child.on('close', (code) => finish(code))
  })
}
