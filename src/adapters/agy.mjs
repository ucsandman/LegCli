// agy adapter — agy CLI headless (`agy -p <prompt> --output-format json`).
// Facts and sources: docs/cli-contracts.md § agy.
import { join } from 'node:path'
import { sanitizeEnv } from '../env.mjs'
import { assertAllowed, firstExisting, goDuration } from './common.mjs'

const adapter = {
  name: 'agy',
  stdin: 'ignore',
  modes: {
    default: 'accept-edits',
    allowed: ['accept-edits', 'plan'],
  },
  forbiddenFlags: ['--dangerously-skip-permissions'],
  resolve() {
    const bin = (process.env.LEG_AGY_BIN || process.env.BATON_AGY_BIN) || firstExisting([
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null,
    ], 'agy')
    return { bin, viaNode: /\.(mjs|cjs|js)$/.test(bin), entry: null }
  },
  argv(opts = {}) {
    const mode = assertAllowed(adapter, opts)
    const { bin, viaNode } = adapter.resolve()
    // agy does not work in the process cwd: with no project it writes into its
    // own scratch workspace (probe 2026-09-10 put hello-agy.txt under
    // ~/.gemini/antigravity-cli/scratch/). --add-dir puts the worktree in the
    // workspace and the prompt names it as the working directory.
    // --print-timeout defaults to 5m; tie it to the card's kill timer so the
    // supervisor, not agy, decides when a leg is a runaway.
    const cwd = opts.cwd ?? process.cwd()
    const prompt = `Working directory: ${cwd}\nEvery relative path in this task is relative to that directory; create files there, never in a scratch workspace.\n\n${opts.prompt ?? ''}`
    const args = ['-p', prompt, '--output-format', 'json', '--mode', mode,
      '--add-dir', cwd, '--print-timeout', goDuration(opts.killMs ?? 5400000)]
    if (opts.model) args.push('--model', opts.model)
    if (opts.resume) args.push('--conversation', opts.resume)
    return viaNode ? { bin: process.execPath, args: [bin, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    const s = String(text)
    for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
      try {
        const j = JSON.parse(s.slice(i))
        return {
          session_id: j.conversation_id ?? j.conversationId ?? j.session_id ?? null,
          last_message: typeof j.response === 'string' ? j.response : (typeof j.result === 'string' ? j.result : null),
          stop_reason: j.stop_reason ?? j.status ?? null,
          raw: j,
        }
      } catch { continue }
    }
    return null
  },
}

export default adapter
