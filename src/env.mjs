// Child-process variable sanitization shared by every adapter. Lives in its
// own module (re-exported by src/runner.mjs) so adapters can import it without
// a top-level-await import cycle through the runner.
//
// Subscription auth only: the four API keys go, and so do the session markers
// a Claude Code parent would leak into the child (a leaked session key
// overrides the machine login and kills the run with "Invalid API key"). The
// print ceiling must be 0 for a detached claude -p.
export function sanitizeEnv(env) {
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY|CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA)$/.test(key)) {
      delete out[key]
    }
  }
  out.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
  return out
}
