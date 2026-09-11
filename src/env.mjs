// Child-process variable sanitization shared by every adapter. Lives in its
// own module (re-exported by src/runner.mjs) so adapters can import it without
// a top-level-await import cycle through the runner.
//
// Subscription auth only: every provider API key and base-URL override goes
// (Anthropic, OpenAI, and the Google/Gemini set agy honours), and so do the session markers
// a Claude Code parent would leak into the child (a leaked session key
// overrides the machine login and kills the run with "Invalid API key"). The
// print ceiling must be 0 for a detached claude -p.
export function sanitizeEnv(env, { interactive = false } = {}) {
  const out = { ...env }
  for (const key of Object.keys(out)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_ENTERPRISE|GOOGLE_CLOUD_PROJECT|CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA)$/.test(key)) {
      delete out[key]
    }
  }
  if (!interactive) out.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
  return out
}
