// fake adapter — drives bin/fake-agent.mjs, a stand-in CLI for tests and the
// demo. FAKE_MODE in the environment selects its behaviour (see the bin).
// Registered as `fake`, and as `fake-claude` / `fake-codex` so demo events read
// like a real chain; `fake-nostdin` is the same agent with stdin ignored.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from '../env.mjs'

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'fake-agent.mjs')

export function makeFake(name = 'fake', stdin = 'pipe') {
  const m = /^fake-(claude|codex|agy)$/.exec(name)
  return {
    name,
    stdin,
    // The classifier treats fake-<cli> as that CLI (its limit fixtures apply).
    emulates: m ? m[1] : null,
    modes: { default: 'acceptEdits', allowed: ['acceptEdits', 'plan', 'workspace-write', 'read-only', 'accept-edits', 'auto_edit'] },
    forbiddenFlags: ['--dangerously-skip-permissions', '--yolo'],
    resolve() { return { bin: process.execPath, viaNode: true, entry: FAKE_AGENT } },
    argv({ mode, maxTurns, resume, model, network } = {}) {
      const args = [FAKE_AGENT]
      if (mode) args.push('--mode', mode)
      if (maxTurns) args.push('--max-turns', String(maxTurns))
      if (resume) args.push('--resume', resume)
      if (model) args.push('--model', model)
      if (network) args.push('--network')
      return { bin: process.execPath, args }
    },
    env(base) { return sanitizeEnv(base) },
    parseResult(text) {
      try {
        const j = JSON.parse(text)
        return {
          session_id: j.session_id ?? null,
          last_message: typeof j.result === 'string' ? j.result : null,
          stop_reason: j.is_error ? 'error' : 'end_turn',
          is_error: j.is_error ?? false,
          raw: j,
        }
      } catch {
        return null
      }
    },
  }
}

export default makeFake('fake')
