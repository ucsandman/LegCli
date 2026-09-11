// codex adapter — OpenAI Codex CLI headless (`codex exec --json`).
// Facts and sources: docs/cli-contracts.md § codex.
// stdin is 'ignore' on purpose: codex exec reads stdin whenever it is not a
// TTY and hangs on an open pipe ("Reading additional input from stdin...").
import { join } from 'node:path'
import { sanitizeEnv } from '../env.mjs'
import { resolveNpmCliEntry } from './resolve.mjs'
import { assertAllowed, firstExisting } from './common.mjs'

const PKG = '@openai/codex'

const adapter = {
  name: 'codex',
  stdin: 'ignore',
  modes: {
    default: 'workspace-write',
    allowed: ['read-only', 'workspace-write'],
  },
  forbiddenFlags: ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--full-auto', '--approve-for-me'],
  resolve() {
    if (process.env.BATON_CODEX_BIN) {
      const bin = process.env.BATON_CODEX_BIN
      return { bin, viaNode: /\.(mjs|cjs|js)$/.test(bin), entry: null }
    }
    // The npm package's bin/codex.js only spawns the platform package's native
    // exe; spawning that exe directly keeps one process to kill.
    const pkgDir = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', PKG) : null
    const native = pkgDir ? firstExisting([
      join(pkgDir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
      join(pkgDir, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
    ], null) : null
    if (native) return { bin: native, viaNode: false, entry: null }
    const entry = resolveNpmCliEntry(PKG, 'codex')
    if (entry) return { bin: process.execPath, viaNode: true, entry }
    return { bin: 'codex', viaNode: false, entry: null }
  },
  argv(opts = {}) {
    const mode = assertAllowed(adapter, opts)
    const { bin, viaNode, entry } = adapter.resolve()
    const args = ['exec', '--json', '-s', mode, '-C', opts.cwd ?? process.cwd(),
      '-c', `sandbox_workspace_write.network_access=${opts.network ? 'true' : 'false'}`]
    if (opts.model) args.push('-m', opts.model)
    if (opts.runDir) args.push('-o', join(opts.runDir, 'last.md'))
    if (opts.resume) args.push('resume', opts.resume)
    args.push(opts.prompt ?? '')
    return viaNode ? { bin, args: [entry, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    const events = []
    for (const line of String(text).split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { events.push(JSON.parse(t)) } catch { continue }
    }
    if (!events.length) return null
    const started = events.find((e) => e.type === 'thread.started')
    const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    const errors = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'error').map((e) => e.item.message)
    const turnDone = events.find((e) => e.type === 'turn.completed')
    const turnFailed = events.find((e) => e.type === 'turn.failed' || e.type === 'error')
    return {
      session_id: started?.thread_id ?? null,
      last_message: messages.length ? messages[messages.length - 1].item.text ?? null : null,
      stop_reason: turnDone ? 'turn.completed' : turnFailed ? (turnFailed.type) : null,
      usage: turnDone?.usage ?? null,
      errors,
      raw: events,
    }
  },
}

export default adapter
