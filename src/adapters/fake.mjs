// fake adapter — drives bin/fake-agent.mjs, a stand-in CLI for tests and the
// demo. FAKE_MODE in the environment selects its behaviour (see the bin).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from '../env.mjs'

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'fake-agent.mjs')

export default {
  name: 'fake',
  stdin: 'pipe',
  argv({ mode, maxTurns, resume } = {}) {
    const args = [FAKE_AGENT]
    if (mode) args.push('--mode', mode)
    if (maxTurns) args.push('--max-turns', String(maxTurns))
    if (resume) args.push('--resume', resume)
    return { bin: process.execPath, args }
  },
  env(base) { return sanitizeEnv(base) },
  parseResult(text) {
    try {
      const j = JSON.parse(text)
      return { session_id: j.session_id ?? null, raw: j }
    } catch {
      return null
    }
  },
}
