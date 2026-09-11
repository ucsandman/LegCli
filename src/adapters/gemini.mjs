// gemini adapter — Gemini CLI headless (`gemini -p <prompt> -o json`).
// Facts and sources: docs/cli-contracts.md § gemini.
import { sanitizeEnv } from '../env.mjs'
import { resolveNpmCliEntry } from './resolve.mjs'
import { assertAllowed } from './common.mjs'

const PKG = '@google/gemini-cli'

const adapter = {
  name: 'gemini',
  stdin: 'ignore', // prompt in argv; gemini would append any stdin to it
  modes: {
    default: 'auto_edit',
    allowed: ['default', 'auto_edit', 'plan'],
  },
  forbiddenFlags: ['--yolo', '-y', 'yolo', '--approval-mode=yolo'],
  resolve() {
    if (process.env.BATON_GEMINI_BIN) {
      const bin = process.env.BATON_GEMINI_BIN
      return /\.(mjs|cjs|js)$/.test(bin)
        ? { bin: process.execPath, viaNode: true, entry: bin }
        : { bin, viaNode: false, entry: null }
    }
    const entry = resolveNpmCliEntry(PKG, 'gemini')
    if (entry) return { bin: process.execPath, viaNode: true, entry }
    return { bin: 'gemini', viaNode: false, entry: null }
  },
  argv(opts = {}) {
    const mode = assertAllowed(adapter, opts)
    const { bin, viaNode, entry } = adapter.resolve()
    // --skip-trust: headless gemini in an untrusted folder overrides the
    // approval mode to "default" (prompt) and exits 55 (probe 2026-09-10). The
    // card's worktree is Baton's own checkout. Workspace trust is not a
    // permission bypass; the approval mode still gates every tool.
    const args = ['-p', opts.prompt ?? '', '-o', 'json', '--approval-mode', mode, '--skip-trust']
    if (opts.model) args.push('-m', opts.model)
    if (opts.resume) args.push('-r', opts.resume)
    return viaNode ? { bin, args: [entry, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    // gemini -o json prints one JSON object; anything before it (deprecation
    // notices) is skipped by finding the first "{" that parses.
    const s = String(text)
    for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
      try {
        const j = JSON.parse(s.slice(i))
        return {
          session_id: j.session_id ?? j.sessionId ?? null,
          last_message: typeof j.response === 'string' ? j.response : null,
          stop_reason: j.error ? 'error' : (j.response !== undefined ? 'completed' : null),
          error: j.error ?? null,
          stats: j.stats ?? null,
          raw: j,
        }
      } catch { continue }
    }
    return null
  },
}

export default adapter
