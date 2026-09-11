#!/usr/bin/env node
// fake-agent — stands in for a coding-agent CLI. FAKE_MODE selects behaviour:
//   success  read the prompt from stdin, print a result JSON with a session id, exit 0
//   sleep    never finish (10 s), so the supervisor's timers fire
//   fail     print stderr (including a fake secret that must be scrubbed), exit 1
//   envcheck report which forbidden variables leaked into this process
// Phase 4 adds limit / stall / auth-failure modes.
const mode = process.env.FAKE_MODE || 'success'

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolvePromise(data))
    process.stdin.on('error', () => resolvePromise(data))
    process.stdin.resume()
  })
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

if (mode === 'success') {
  const prompt = await readStdin()
  out({ session_id: 'sess-fake', result: 'ok', prompt_chars: prompt.length, argv: process.argv.slice(2) })
  process.exit(0)
} else if (mode === 'sleep') {
  setTimeout(() => process.exit(0), 10000)
} else if (mode === 'fail') {
  process.stderr.write('boom line one\n')
  process.stderr.write('api_key=sk-abcdefgh12345678 leaked\n')
  process.exit(1)
} else if (mode === 'envcheck') {
  await readStdin()
  const forbidden = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA']
  const leaked = forbidden.filter((k) => process.env[k] !== undefined)
  for (const k of Object.keys(process.env)) {
    if (/^CLAUDE_CODE_/.test(k) && k !== 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS') leaked.push(k)
  }
  if (process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS !== '0') leaked.push('CEILING!=0')
  out({ session_id: leaked.length ? 'LEAKED:' + leaked.join('+') : 'clean-env' })
  process.exit(0)
} else {
  process.stderr.write(`fake-agent: unknown FAKE_MODE "${mode}"\n`)
  process.exit(2)
}
