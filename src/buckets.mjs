// buckets — the one place per-model knowledge lives: the wording a CLI uses
// when it walls a single model, the model names Leg is willing to say out
// loud, and the flag each CLI spells its model with.
// Why one file: the same three facts were about to be needed by the usage
// record (which wall goes where), the taps (what a StopFailure message meant)
// and argv building (`--model` vs `-m`). Split across those, a reworded wall
// or a new alias would have to be fixed in three places and would be found by
// whichever one was missed. Nothing here reads or writes state.
//
// Sources for the wording table: docs/en/costs ("You've hit your Opus limit",
// session and weekly limits shared across models), the live StopFailure in
// fixtures/live/claude/limit-rate_limit.json ("You've reached your Fable
// limit."), and docs/cli-contracts.md:464 for codex ("usage limit for {name}",
// docs-only: no live codex per-model wall has been captured).
// Flags: verified in the adapters — src/adapters/claude.mjs:29 and agy.mjs:34
// push `--model`, codex.mjs:42 and grok.mjs:45 push `-m`.

// Model names per agent, lowercase, in ladder order (strongest first).
// Only claude publishes per-model buckets today; the others take a model on
// the command line but expose no per-model limit, so their lists stay empty
// rather than carrying a guess.
export const MODEL_ALIASES = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: [],
  agy: [],
  grok: [],
}

const MODEL_FLAGS = { claude: '--model', agy: '--model', fake: '--model', codex: '-m', grok: '-m' }

// The flag this agent's CLI spells a model with, or null when Leg does not
// know it. A null answer means "do not pass a model", never "guess --model".
export function modelFlagFor(agent) {
  return MODEL_FLAGS[agent] ?? null
}

// Where a model sits on its agent's own list: 0 is the strongest. -1 means Leg
// does not know the name, and an unknown name is never called stronger or
// weaker than anything.
export function modelRank(agent, model) {
  if (!model) return -1
  return (MODEL_ALIASES[agent] ?? []).indexOf(String(model).toLowerCase())
}

// A downshift is a move to a weaker model of the SAME login. It is the only
// move `claude --resume <id> --model <alias>` is used for: the probe in
// fixtures/live/claude/resume-model-probe.json shows the conversation survives
// and only the new model answers, but the context is re-read at the new model's
// rate (cache read 0 on the first resumed turn), so an upshift back to fable
// would pay that re-read at fable's price and takes the bundle instead.
export function isDownshift(from, to) {
  if (!from || !to) return false
  if (from.agent !== to.agent || (from.account ?? 'default') !== (to.account ?? 'default')) return false
  const a = modelRank(from.agent, from.model)
  const b = modelRank(to.agent, to.model)
  return a >= 0 && b >= 0 && b > a
}

const SESSION_OR_WEEKLY = /(session|weekly) limit/i
const SPEND_WALL = /spend limit/i
const CODEX_MODEL_WALL = /usage limit for ([\w .-]+)/i

// "You've hit your Fable limit" / "You've reached your Opus limit". Built from
// the agent's own alias list, so codex's "You've hit your usage limit" can
// never be read as a model called "usage": a name Leg does not know falls
// through to rule 5 and walls the login.
function modelWallRe(agent) {
  const names = MODEL_ALIASES[agent] ?? []
  if (!names.length) return null
  return new RegExp(`You.ve (?:hit|reached) your (${names.join('|')}) limit`, 'i')
}

// What a wall message walled. Ordered; the first rule that matches wins.
//   { scope: 'account' }                      the whole login is out
//   { scope: 'account', bucket: 'spend' }     the spend cap, not a window
//   { scope: 'model', model: 'fable' }        one model family only
// Unrecognised wording is 'account' on purpose: walling the whole login is the
// direction that fails safe when the wording is reworded again, which it
// already was once ("hit" became "reached").
export function bucketFromWall(agent, text) {
  const s = String(text ?? '')
  // 1. session and weekly limits are shared across every model (docs/en/costs),
  //    so switching model buys nothing: the account is out.
  if (SESSION_OR_WEEKLY.test(s)) return { scope: 'account' }
  // 2. "You've hit/reached your <Model> limit" — one family.
  const re = modelWallRe(agent)
  const m = re ? re.exec(s) : null
  if (m) return { scope: 'model', model: m[1].toLowerCase() }
  // 3. the spend cap is an account fact, and it is not a window.
  if (SPEND_WALL.test(s)) return { scope: 'account', bucket: 'spend' }
  // 4. codex names the limit it hit (docs-only wording). The name runs to the
  //    end of the sentence, so cut at the first period that ends one: a model
  //    name's own dots (gpt-5.6-sol) are never followed by a space.
  const c = CODEX_MODEL_WALL.exec(s)
  if (c) {
    const model = c[1].split(/\.(?=\s|$)/)[0].trim().toLowerCase()
    if (model) return { scope: 'model', model }
  }
  // 5. anything else: the whole login.
  return { scope: 'account' }
}
