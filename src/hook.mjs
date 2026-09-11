#!/usr/bin/env node
// hook — the process Claude Code runs for a Baton session's hooks and status
// line (wired by src/taps/claude.mjs through `--settings`). Reads the JSON
// payload on stdin, updates the session record, exits 0 always: a broken hook
// must never stall the user's session.
//   node hook.mjs claude-hook --session <id>
//   node hook.mjs claude-statusline --session <id>
// The status line entry records rate_limits when a Claude Code build runs it
// (2.1.268 does not; see src/taps/claude-usage.mjs) and prints one Baton line.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleHook, handleStatusline } from './taps/claude.mjs'
import { sessionDir } from './sessions.mjs'
import { captureLive } from './live-capture.mjs'

function readStdin() {
  return new Promise((resolve) => {
    let d = ''
    const t = setTimeout(() => resolve(d), 4000)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { d += c })
    process.stdin.on('end', () => { clearTimeout(t); resolve(d) })
    process.stdin.on('error', () => { clearTimeout(t); resolve(d) })
  })
}

const [kind, ...rest] = process.argv.slice(2)
const i = rest.indexOf('--session')
const sessionId = i !== -1 ? rest[i + 1] : null

try {
  const raw = await readStdin()
  let payload = {}
  try { payload = JSON.parse(raw) } catch {}
  if (!sessionId) process.exit(0)
  if (kind === 'claude-hook') {
    const line = handleHook(sessionId, payload)
    try { appendFileSync(join(sessionDir(sessionId), 'hook.log'), `${new Date().toISOString()} ${payload.hook_event_name ?? '?'} ${line}\n`) } catch {}
    // the first real StopFailure per error kind is kept as evidence (never a simulated one)
    if (payload.hook_event_name === 'StopFailure' && payload.error) {
      try { captureLive('claude', String(payload.error), payload, { sessionId }) } catch {}
    }
  } else if (kind === 'claude-statusline') {
    const { text } = handleStatusline(sessionId, payload)
    try { appendFileSync(join(sessionDir(sessionId), 'hook.log'), `${new Date().toISOString()} statusline rate_limits=${JSON.stringify(payload.rate_limits ?? null)}\n`) } catch {}
    process.stdout.write(text + '\n')
  }
} catch {}
process.exit(0)
