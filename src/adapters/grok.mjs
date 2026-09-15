// grok adapter — Grok CLI headless (`grok -p <prompt> --output-format json`).
// NOT REGISTERED in index.mjs: the phase-3 probe could not verify it because
// the build machine had no grok login (device-code prompt, exit "Cancelled").
// Built from `grok --help` only; see docs/cli-contracts.md § grok. Register it
// after `grok` is logged in and `node scripts/probe.mjs --adapter grok` passes.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { sanitizeEnv } from '../env.mjs'
import { assertAllowed, firstExisting } from './common.mjs'

const adapter = {
  name: 'grok',
  stdin: 'ignore',
  modes: {
    default: 'acceptEdits',
    allowed: ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'],
  },
  forbiddenFlags: ['--always-approve', 'bypassPermissions', '--permission-mode=bypassPermissions'],
  resolve() {
    const bin = (process.env.LEG_GROK_BIN || process.env.BATON_GROK_BIN) || firstExisting([
      join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'),
    ], 'grok')
    return { bin, viaNode: /\.(mjs|cjs|js)$/.test(bin), entry: null }
  },
  argv(opts = {}) {
    const mode = assertAllowed(adapter, opts)
    const { bin, viaNode } = adapter.resolve()
    const args = ['-p', opts.prompt ?? '', '--output-format', 'json', '--permission-mode', mode]
    if (opts.model) args.push('-m', opts.model)
    if (opts.resume) args.push('-r', opts.resume)
    return viaNode ? { bin: process.execPath, args: [bin, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    const s = String(text)
    for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
      try {
        const j = JSON.parse(s.slice(i))
        return {
          session_id: j.session_id ?? j.sessionId ?? null,
          last_message: typeof j.response === 'string' ? j.response : (typeof j.result === 'string' ? j.result : null),
          stop_reason: j.stop_reason ?? null,
          raw: j,
        }
      } catch { continue }
    }
    return null
  },
}

export default adapter
