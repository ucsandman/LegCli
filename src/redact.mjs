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
  ['GitHub token (ghp_)', /(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9]{20,}/g],
  ['GitHub server token (ghs_)', /(?<![A-Za-z0-9_-])ghs_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token (github_pat_)', /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}/g],
  ['AWS key (AKIA)', /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{12,}/g],
  ['Slack token (xox)', /(?<![A-Za-z0-9_-])xox[bp]-\S*/g],
  ['key=value secret', /api[_-]?key\s*[=:]\s*\S+/gi],
]

export const SECRET_RES = PATTERNS.map(([, re]) => re)
// non-global copies for `.test()` (a /g regex carries lastIndex state)
export const SECRET_PATTERNS = PATTERNS.map(([name, re]) => [name, new RegExp(re.source, re.flags.replace('g', ''))])

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DASHCLAW_API_KEY', 'BATON_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']
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
