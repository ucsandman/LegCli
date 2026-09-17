// grok adapter — Grok CLI headless (`grok -p <prompt> --output-format json`).
// Facts and sources: docs/cli-contracts.md § grok. Every flag below was read
// from `grok --help` on grok 1.0.34 (3736acbc8658) on 2026-09-17:
//   -p, --single <PROMPT>        single-turn prompt, prints the response and exits
//   --prompt-file <PATH>         the same prompt from a file (no argv length limit)
//   --output-format <plain|json|streaming-json|streaming-messages-json>
//   --permission-mode <default|acceptEdits|auto|dontAsk|plan>, and one more
//     that Leg never passes and refuses in a chain entry (see modes.allowed)
//   --cwd <CWD>, -m <MODEL>, -r <SESSION_ID_OR_TITLE>
// --cwd is passed explicitly rather than relying on the spawn's cwd: grok can
// run against a shared leader process (~/.grok/leader.sock), and a leg must
// edit its own worktree, never whatever directory the leader was started in.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { sanitizeEnv } from '../env.mjs'
import { assertAllowed, firstExisting } from './common.mjs'

const adapter = {
  name: 'grok',
  stdin: 'ignore', // the prompt travels by --prompt-file or argv, never stdin
  modes: {
    default: 'acceptEdits',
    // grok 1.0.34 --permission-mode choices; the bypass mode is never allowed.
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
    const cwd = opts.cwd ?? process.cwd()
    // A hand-off prompt carries the whole bundle summary and can run to
    // thousands of characters; Windows caps one command line at ~32k, so the
    // file form is used whenever the runner has written one.
    const args = opts.promptFile
      ? ['--prompt-file', opts.promptFile]
      : ['-p', opts.prompt ?? '']
    args.push('--output-format', 'json', '--permission-mode', mode, '--cwd', cwd)
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
    if (opts.model) args.push('-m', opts.model)
    if (opts.resume) args.push('-r', opts.resume)
    return viaNode ? { bin: process.execPath, args: [bin, ...args] } : { bin, args }
  },
  env(base) { return sanitizeEnv(base) },
  // grok's headless writer emits the Claude Code result envelope. The field
  // names were read out of the shipped grok.exe on 2026-09-17 ("type":"result",
  // subtype, is_error, session_id, "result", num_turns, stop_reason, total_cost)
  // and the error envelope was observed live the same day:
  //   {"type":"error","message":"Internal error: { \"message\": \"API error
  //    (status 402 Payment Required): Grok Build usage balance exhausted\" }"}
  // The scan starts at each `{` because --output-format json still lets a
  // plugin or a warning print a line before the envelope.
  parseResult(text) {
    const s = String(text)
    for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
      let j
      try { j = JSON.parse(s.slice(i)) } catch { continue }
      if (!j || typeof j !== 'object') continue
      if (j.type === 'error') {
        return {
          session_id: j.session_id ?? null,
          last_message: typeof j.message === 'string' ? j.message : null,
          stop_reason: 'error',
          subtype: null,
          is_error: true,
          num_turns: null,
          raw: j,
        }
      }
      return {
        session_id: j.session_id ?? j.sessionId ?? null,
        last_message: typeof j.result === 'string' ? j.result : (typeof j.response === 'string' ? j.response : null),
        stop_reason: j.stop_reason ?? j.stopReason ?? null,
        subtype: j.subtype ?? null,
        is_error: j.is_error ?? null,
        num_turns: j.num_turns ?? null,
        raw: j,
      }
    }
    return null
  },
}

export default adapter
