// redact — the one list of secret shapes. `scrub()` rewrites (logs, bundles,
// launcher output); the ledger's assertNoSecrets refuses (src/ledger.mjs).
// The source tooling kept two copies on purpose; Leg keeps one here.
// Values the launcher's own process holds for the well-known key variables
// are read once at startup and never printed.
// Every prefix shape starts at a token boundary: the `sk-` inside
// "task-management-system" is a word, not a key, and the ledger refuses a card
// whose task matches.
const PATTERNS = [
  ['api key (sk-)', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g],
  ['Anthropic key (sk-ant-)', /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g],
  ['DashClaw key (oc_live_)', /(?<![A-Za-z0-9_-])oc_live_[a-f0-9]\w*/g],
  ['bearer token', /Bearer\s+[A-Za-z0-9._-]{16,}/g],
  ['GitHub token (gh[pousr]_)', /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token (github_pat_)', /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}/g],
  ['AWS key (AKIA)', /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{12,}/g],
  ['Slack token (xox/xapp)', /(?<![A-Za-z0-9_-])(?:xox[baprs]|xapp)-\S+/g],
  ['key=value secret', /api[_-]?key[ \t]*[=:][ \t]*\S+/gi],
  // shapes a discovered transcript from another agent carries that the list
  // above missed (measured 2026-09-16: 15 of 18 common shapes went through)
  ['Stripe key (sk_live_/rk_live_)', /(?<![A-Za-z0-9_-])[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g],
  ['Google API key (AIza)', /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}/g],
  ['xAI key (xai-)', /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{16,}/g],
  ['npm token (npm_)', /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{20,}/g],
  ['GitLab token (glpat-)', /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{16,}/g],
  ['Hugging Face token (hf_)', /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{20,}/g],
  ['JWT', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  // a digit or two capitals somewhere: base64 of any credential has one of
  // them, "Basic authentication/authorization" in prose has neither
  ['basic auth header', /Basic\s+(?=[A-Za-z0-9+/=]*(?:[0-9]|[A-Z][A-Za-z0-9+/=]*[A-Z]))[A-Za-z0-9+/=]{16,}/g],
  ['URL with credentials', /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]{4,}(?=@)/gi],
  // an environment-style NAME (upper case): `cache_key = build(...)` and
  // `refresh_token: string` in code are not secrets; a value never crosses a
  // line break, so `SECRET_KEY=` at the end of a line takes nothing after it
  ['env-style secret assign', /(?:[A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)|aws_secret_access_key)[ \t]*[=:][ \t]*["']?[^\s"',;]{8,}/g],
  ['password=value', /\b(?:password|passwd)[ \t]*[=:][ \t]*["']?[^\s"',;]{8,}/gi],
]

export const SECRET_RES = PATTERNS.map(([, re]) => re)
// non-global copies for `.test()` (a /g regex carries lastIndex state)
export const SECRET_PATTERNS = PATTERNS.map(([name, re]) => [name, new RegExp(re.source, re.flags.replace('g', ''))])

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DASHCLAW_API_KEY', 'LEG_TOKEN', 'BATON_TOKEN', 'LEG_LICENSE_PRIVATE_KEY', 'BATON_LICENSE_PRIVATE_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'RESEND_API_KEY', 'NPM_TOKEN']
let envValues = null
function heldValues() {
  if (envValues) return envValues
  envValues = ENV_KEYS.map((k) => process.env[k]).filter((v) => typeof v === 'string' && v.length >= 8)
  return envValues
}

export function scrub(s) {
  let out = String(s)
  for (const re of SECRET_RES) { re.lastIndex = 0; out = out.replace(re, '[REDACTED]') }
  return out
}

export function redact(line) {
  let out = scrub(line)
  for (const v of heldValues()) out = out.split(v).join('[REDACTED]')
  return out
}

// tests plant a value and need the cache dropped
export function _resetHeldValues() { envValues = null }
