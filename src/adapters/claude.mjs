// claude adapter — Claude Code headless (`claude -p --output-format json`).
// Facts and sources: docs/cli-contracts.md § claude.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { sanitizeEnv } from '../env.mjs'
import { assertAllowed, firstExisting } from './common.mjs'

const adapter = {
  name: 'claude',
  stdin: 'pipe', // the prompt goes to stdin; argv stays short
  modes: {
    default: 'acceptEdits',
    // claude 2.1.268 --permission-mode choices; the bypass mode is never allowed.
    allowed: ['acceptEdits', 'auto', 'plan', 'manual', 'dontAsk'],
  },
  forbiddenFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions', 'bypassPermissions'],
  resolve() {
    const bin = process.env.BATON_CLAUDE_BIN || firstExisting([
      join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ], 'claude')
    return { bin, viaNode: /\.(mjs|cjs|js)$/.test(bin), entry: null }
  },
  argv(opts = {}) {
    const mode = assertAllowed(adapter, opts)
    const { bin, viaNode } = adapter.resolve()
    const args = ['-p', '--output-format', 'json', '--permission-mode', mode]
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
    if (opts.resume) args.push('--resume', opts.resume)
    if (opts.model) args.push('--model', opts.model)
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','))
    // The Agent tool is never denied: a lead without it degrades to solo (LESSONS 07-10).
    return viaNode ? { bin: process.execPath, args: [bin, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    let j
    try { j = JSON.parse(text) } catch { return null }
    if (!j || typeof j !== 'object') return null
    return {
      session_id: j.session_id ?? null,
      last_message: typeof j.result === 'string' ? j.result : null,
      stop_reason: j.stop_reason ?? null,
      subtype: j.subtype ?? null,
      is_error: j.is_error ?? null,
      num_turns: j.num_turns ?? null,
      terminal_reason: j.terminal_reason ?? null,
      api_error_status: j.api_error_status ?? null,
      permission_denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : null,
      raw: j,
    }
  },
}

export default adapter
