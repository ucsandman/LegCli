// board-verdict: the verdict's branch table (redesign spec A.5) and the
// capacity strip's tokens (A.1, A.4 row 3).
//
// Two things are checked here that nothing else can check:
//   1. every branch's headline fits VERDICT_CH characters. That number is a
//      MEASUREMENT, not a taste: at 1280 the verdict column is 26ch (891px)
//      and 300 sampled sentences per length still fit two 56.16px lines at 60
//      characters, so the budget is 56 with four characters of slack. A
//      headline over it wraps 52px type to a third line, which is the defect
//      the character budget exists to stop.
//   2. the strip refuses to print a number it does not have: agy draws no
//      instrument at all, a walled login says when it is back, and a payload
//      with no `buckets` (an older record, or a login the endpoint has never
//      described) still renders from the two legacy windows.
//
// src/board/sessions.js runs in the browser and the repo has no DOM harness,
// so it is loaded through the same `module` seam board-updates.test.mjs uses
// on board.js, with a stub document underneath it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const SRC = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')

function node() {
  const n = {
    children: [], attrs: {}, className: '', listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    appendChild(c) { this.children.push(c); return c },
    addEventListener(k, fn) { this.listeners[k] = fn },
    querySelector() { return null },
  }
  Object.defineProperty(n, 'textContent', {
    get() { return this._text !== undefined ? this._text : this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('') },
    set(v) { this._text = String(v); this.children = [] },
  })
  return n
}

function load() {
  const doc = {
    createElement: () => node(),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: node(),
  }
  const mod = { exports: {} }
  const store = new Map()
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  new Function('module', 'document', 'window', 'localStorage', 'setInterval', 'setTimeout', SRC)(
    mod, doc, { addEventListener() {} }, localStorage, () => 0, () => 0,
  )
  return mod.exports
}

const B = load()
const HOUR = 3600
const nowS = () => Math.floor(Date.now() / 1000)
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

function acct(extra = {}) {
  return {
    agent: 'claude', account: 'default', five_hour: null, seven_day: null,
    limited_until: null, limited_reason: null, source: 'statusline',
    observed_at: iso(30_000), updated_at: iso(30_000), stale: false, live: 0,
    buckets: [], walls: {}, extra_usage: null, facts: null, ...extra,
  }
}
function bucket(kind, percent, extra = {}) {
  return { kind, group: kind.startsWith('weekly') ? 'weekly' : 'session', model: null, percent, resets_at: nowS() + 40 * HOUR, is_active: false, severity: 'normal', ...extra }
}
function session(extra = {}) {
  return { session_id: 's-20260917-0049-claude-7f3a', agent: 'claude', account: 'default', active: true, status: 'running', repo_name: 'leg', started_at: iso(600_000), ...extra }
}
// the seeded shape: a session bucket, an account weekly, and the model weekly
// the endpoint itself marks active
const CLAUDE_LIVE = () => acct({
  stale: true, observed_at: iso(2 * 3600_000 + 13 * 60_000), live: 3,
  five_hour: { pct: 38, resets_at: nowS() + 3 * HOUR }, seven_day: { pct: 95, resets_at: nowS() + 40 * HOUR },
  buckets: [bucket('session', 38), bucket('weekly_all', 95), bucket('weekly_scoped', 63, { model: 'fable', is_active: true })],
})
const CODEX_WALLED = () => acct({ agent: 'codex', limited_until: nowS() + 29 * HOUR, limited_reason: 'usage_limit_exceeded', seven_day: { pct: 100, resets_at: nowS() + 29 * HOUR } })
const AGY = () => acct({ agent: 'agy', stale: true, observed_at: null, updated_at: null, source: null })

// ---------------------------------------------------------------------------
// the branch table, one case per row of A.5
// ---------------------------------------------------------------------------
const CASES = [
  {
    name: 'loading: no account has come back yet',
    accounts: [{ label: 'accounts', agent: null, account: 'default', loading: true, five_hour: null, seven_day: null }],
    sessions: [],
    line: 'Reading the logins.',
    sub: '',
  },
  {
    name: 'a human is blocked, which outranks every usage figure',
    accounts: [CLAUDE_LIVE(), CODEX_WALLED()],
    sessions: [
      session({ waiting: { type: 'permission_prompt', message: 'Bash(git push origin HEAD)', since: iso(3 * 60_000) } }),
      session({ session_id: 's-1-claude-aa11' }), session({ session_id: 's-2-claude-bb22' }),
    ],
    line: 'leg#7f3a has waited on you for 3 minutes.',
    sub: 'It asked to run Bash(git push origin HEAD). The other 2 terminals are still running.',
  },
  {
    name: 'an idle prompt asks a different question, and the sub says which',
    accounts: [CLAUDE_LIVE()],
    sessions: [session({ waiting: { type: 'idle_prompt', message: 'Claude is waiting for your input', since: iso(11 * 60_000) } })],
    line: 'leg#7f3a has waited on you for 11 minutes.',
    subMatches: /^It has had no input since .+\.$/,
  },
  {
    // the shape src/attach.mjs actually writes: it carries `type` and `since`
    // too, so a filter that tested for those fields read an all-out countdown
    // as a human being waited on
    name: 'the all-out countdown on the same key is not a blocked human',
    accounts: [CLAUDE_LIVE()],
    sessions: [session({ status: 'waiting', waiting: { type: 'reset', agent: 'codex', account: 'default', resets_at: nowS() + HOUR, since: iso(4 * 60_000) } })],
    line: 'Fable is at 63% of its week, the only login open.',
  },
  {
    name: 'a model bucket came back and a terminal is still on the lower rung',
    accounts: [acct({
      live: 1,
      buckets: [bucket('weekly_all', 47), bucket('weekly_scoped', 63, { model: 'fable', is_active: true }), bucket('weekly_scoped', 12, { model: 'opus' })],
      walls: { fable: { limited_until: nowS() - 2 * HOUR, limited_reason: 'model_limit', source: 'claude StopFailure', evidence: "You've reached your Fable limit." } },
    })],
    sessions: [session({ model: 'opus' })],
    line: 'Fable is back; leg#7f3a is still on opus.',
    sub: 'Leg climbs back at the next hand-off. Back to fable on the row does it now.',
  },
  {
    name: 'every login is at its limit',
    accounts: [CODEX_WALLED(), acct({ agent: 'agy', limited_until: nowS() + 50 * HOUR })],
    sessions: [],
    line: 'Every login is at its limit; codex is back first.',
    subStarts: 'codex returns ',
  },
  {
    name: 'an account-scoped bucket binds, so a same-login model rung buys nothing',
    accounts: [
      acct({ live: 1, buckets: [bucket('weekly_all', 97, { is_active: true }), bucket('weekly_scoped', 20, { model: 'fable' })] }),
      acct({ agent: 'codex', seven_day: { pct: 10, resets_at: nowS() + 40 * HOUR } }),
    ],
    sessions: [session()],
    line: 'claude has 3% left, shared by every model.',
    sub: 'Switching to fable buys nothing. Next off claude: codex.',
  },
  {
    name: 'a model is walled while the account window is open',
    accounts: [acct({
      live: 1,
      buckets: [bucket('weekly_all', 47), bucket('weekly_scoped', 100, { model: 'fable' }), bucket('weekly_scoped', 12, { model: 'opus' })],
      walls: { fable: { limited_until: nowS() + 2 * HOUR, limited_reason: 'model_limit', source: 'claude StopFailure', evidence: "You've reached your Fable limit." } },
    })],
    sessions: [session()],
    lineMatches: /^Fable is out until .+; opus is open\.$/,
    subMatches: /^claude still has 53% of its week\. Hand off > claude\/opus keeps this terminal\.$/,
  },
  {
    name: 'one login carries every live terminal',
    accounts: [CLAUDE_LIVE(), CODEX_WALLED()],
    sessions: [session(), session({ session_id: 's-1-claude-aa11' }), session({ session_id: 's-2-claude-bb22' })],
    line: 'Fable is at 63% of its week, the only login open.',
    subStarts: 'Measured ',
  },
  {
    name: 'several logins carry work',
    accounts: [
      acct({ agent: 'codex', live: 1, buckets: [bucket('weekly_all', 88, { is_active: true })] }),
      acct({ live: 2, buckets: [bucket('weekly_scoped', 63, { model: 'fable', is_active: true })] }),
    ],
    sessions: [session({ agent: 'codex', session_id: 's-3-codex-cc33' }), session(), session({ session_id: 's-1-claude-aa11' })],
    line: 'codex has 12% left, and 3 terminals are working.',
    sub: 'claude is at 63% of the Fable week.',
  },
  {
    name: 'nothing running, something walled',
    accounts: [CLAUDE_LIVE(), CODEX_WALLED()],
    sessions: [],
    lineMatches: /^Nothing is running\. codex is back .+\.$/,
    sub: 'Fable is at 63% of its week.',
  },
  {
    name: 'nothing running, nothing walled',
    accounts: [CLAUDE_LIVE()],
    sessions: [],
    line: 'Nothing is running. Fable is at 63% of its week.',
    sub: '',
  },
  {
    name: 'no figure anywhere, and nothing running',
    accounts: [AGY()],
    sessions: [],
    line: 'Nothing is running, and no login has a figure.',
    sub: '',
  },
  {
    name: 'terminals are working and no login has published a figure',
    accounts: [AGY()],
    sessions: [session({ agent: 'agy', session_id: 's-4-agy-dd44' })],
    line: '1 terminal is working, and no login has a figure.',
    subStarts: 'No login has reported',
  },
]

for (const c of CASES) {
  test(`verdict: ${c.name}`, () => {
    const { line, sub } = B.verdictLines(c.accounts, c.sessions)
    if (c.line) assert.equal(line, c.line)
    if (c.lineMatches) assert.match(line, c.lineMatches)
    if (c.sub !== undefined) assert.equal(sub, c.sub)
    if (c.subStarts) assert.ok(sub.startsWith(c.subStarts), `sub was ${JSON.stringify(sub)}`)
    if (c.subMatches) assert.match(sub, c.subMatches)
    assert.ok(line.length <= B.VERDICT_CH, `${line.length} characters: "${line}"`)
    assert.ok(sub.length <= B.SUB_CH, `sub is ${sub.length} characters: "${sub}"`)
  })
}

test('every branch stays under VERDICT_CH with hostile names, not just the fixture ones', () => {
  const long = 'claude/a-very-long-second-account-name-for-this-test'
  const repo = 'a-repository-with-an-unreasonably-long-checkout-name'
  const hostile = [
    [[acct({ label: long, live: 1, buckets: [bucket('weekly_scoped', 63, { model: 'a-very-long-model-name', is_active: true })] })], [session()]],
    [[acct({ label: long, live: 1, buckets: [bucket('weekly_all', 97, { is_active: true }), bucket('weekly_scoped', 20, { model: 'fable' })] })], [session()]],
    [[acct({ label: long, limited_until: nowS() + 9 * HOUR }), acct({ agent: 'codex', label: `${long}-two`, limited_until: nowS() + HOUR })], []],
    [[CLAUDE_LIVE(), acct({ agent: 'codex', label: long, limited_until: nowS() + 9 * HOUR })], []],
    [[CLAUDE_LIVE()], [session({ repo_name: repo, waiting: { type: 'idle_prompt', message: null, since: iso(9 * 3600_000) } })]],
    [[CLAUDE_LIVE(), acct({ agent: 'codex', label: long, live: 1, buckets: [bucket('weekly_all', 88, { is_active: true })] })],
      [session(), session({ agent: 'codex', session_id: 's-3-codex-cc33' })]],
  ]
  for (const [accounts, sessions] of hostile) {
    const { line, sub } = B.verdictLines(accounts, sessions)
    assert.ok(line.length <= B.VERDICT_CH, `${line.length} characters: "${line}"`)
    assert.ok(line.endsWith('.'), `a headline is a sentence: "${line}"`)
    assert.ok(sub.length <= B.SUB_CH, `sub is ${sub.length} characters: "${sub}"`)
  }
})

test('a guest payload carries no percentages at all, and the verdict still says something true', () => {
  const guests = [{ agent: 'claude', account: 'default', live: 2, shared: false }, { agent: 'codex', account: 'default', live: 0, shared: false }]
  const { line } = B.verdictLines(guests, [session(), session({ session_id: 's-1-claude-aa11' })])
  assert.equal(line, '2 terminals are working, and no login has a figure.')
  assert.ok(line.length <= B.VERDICT_CH)
})

// ---------------------------------------------------------------------------
// the capacity strip
// ---------------------------------------------------------------------------
function find(n, cls) {
  const out = []
  const walk = (x) => {
    if (!x || typeof x !== 'object') return
    if (typeof x.className === 'string' && x.className.split(/\s+/).includes(cls)) out.push(x)
    for (const c of x.children || []) walk(c)
  }
  walk(n)
  return out
}

test('agy prints no figure and draws no instrument: an empty track reads as a measurement of zero', () => {
  const token = B.capToken(AGY())
  assert.equal(find(token, 'cap-track').length, 0, 'no track is drawn')
  assert.equal(B.capFigure(AGY(), null), 'no figure')
  const figure = find(token, 'cap-figure')[0]
  assert.equal(figure.textContent, 'no figure')
  assert.equal(figure.getAttribute('role'), 'img', 'with no meter, the figure carries the spoken sentence')
  assert.match(figure.getAttribute('aria-label'), /agy publishes no usage percentage, ever/)
})

test('a login at its wall prints when it is back, and the fill is the wall colour', () => {
  const a = CODEX_WALLED()
  assert.match(B.capFigure(a, B.bindingOf(a)), /^back /)
  const token = B.capToken(a)
  const fill = find(token, 'cap-fill')[0]
  assert.match(fill.getAttribute('style'), /width:100%;background:var\(--danger\)/)
  assert.equal(find(token, 'cap-figure')[0].className, 'cap-figure is-out')
})

test('a walled login with no percentage is not a meter: 100 would be a number nobody measured', () => {
  const a = acct({ agent: 'agy', limited_until: nowS() + 5 * HOUR })
  const track = find(B.capToken(a), 'cap-track')[0]
  assert.equal(track.getAttribute('role'), 'img')
  assert.equal(track.getAttribute('aria-valuenow'), null)
})

test('a payload with no buckets still renders the strip from the two legacy windows', () => {
  const a = acct({ five_hour: { pct: 38, resets_at: nowS() + 3 * HOUR }, seven_day: { pct: 95, resets_at: nowS() + 40 * HOUR } })
  const b = B.bindingOf(a)
  assert.deepEqual({ kind: b.kind, model: b.model, percent: b.percent, scope: b.scope }, { kind: 'seven_day', model: null, percent: 95, scope: 'account' })
  assert.equal(B.capFigure(a, b), '95% 7d')
  const track = find(B.capToken(a), 'cap-track')[0]
  assert.equal(track.getAttribute('role'), 'meter')
  assert.equal(track.getAttribute('aria-valuenow'), '95')
  assert.match(track.getAttribute('aria-valuetext'), /95 percent of its week used\. Resets at /)
})

test('the strip prints the bucket the endpoint marked active, not the account window above it', () => {
  const a = CLAUDE_LIVE()
  assert.equal(B.bindingOf(a).percent, 63, 'the active weekly_scoped bucket binds, not weekly_all at 95')
  // this record is deliberately stale, so the figure carries the clock it was
  // taken at rather than a bucket word
  assert.match(B.capFigure(a, B.bindingOf(a)), /^63% \d/)
  const fresh = acct({ ...CLAUDE_LIVE(), stale: false, observed_at: iso(30_000) })
  assert.equal(B.capFigure(fresh, B.bindingOf(fresh)), '63% fable week')
})

test('a guest sees which logins exist and no figure for any of them', () => {
  const a = { agent: 'claude', account: 'default', live: 2, shared: false }
  assert.equal(B.capFigure(a, B.bindingOf(a)), 'not shared')
  assert.equal(find(B.capToken(a), 'cap-track').length, 0)
})

test('the share clause is said once at the region, and only when two rows are on one login', () => {
  const one = [session()]
  const three = [session(), session({ session_id: 's-1-claude-aa11' }), session({ session_id: 's-2-claude-bb22' })]
  assert.equal(B.shareClause(one), '')
  assert.equal(B.shareClause(three), ', 3 share the claude login')
  assert.equal(B.shareClause([...three, session({ agent: 'codex', session_id: 's-3-codex-cc33' })]), ', 3 share the claude login')
  assert.equal(B.shareClause(three.map((s) => ({ ...s, active: false }))), '', 'a finished row shares nothing')
})

// ---------------------------------------------------------------------------
// the row: its register (A.4 rows 7 to 9), its capacity phrase (row 12) and
// the two ranks step 3 adds to `rankedNotes` (A.6). Driven through the same
// `module` seam as the verdict above, because the row's words are data before
// they are DOM and that is where they are worth pinning.
// ---------------------------------------------------------------------------
const tokens = (s) => B.registerTokens(s).map((t) => t.text)

test('the register prints what changed, which model answered, and how long it has been quiet', () => {
  const s = session({ model: 'fable', files_dirty: ['a.js', 'b.js', 'c.js'], ahead: 2, last_activity: iso(4 * 60_000) })
  assert.deepEqual(tokens(s), ['dirty 3', 'ahead 2', 'claude/fable', 'quiet 4m'])
})

test('the register never prints a model nobody chose, and never a count nobody measured', () => {
  assert.deepEqual(tokens(session({ last_activity: iso(0) })), ['claude'], 'no model, no dirty file, no ahead: the agent alone')
  assert.deepEqual(tokens(session({ model: 'sonnet', files_dirty: [], last_activity: iso(0) })), ['claude/sonnet'])
  // `ahead` is written by a newer runner; an older record has no such key
  assert.deepEqual(tokens(session({ model: 'sonnet', ahead: 0, last_activity: iso(0) })), ['claude/sonnet'])
})

test('quiet is an observation about a live row, and a row already waiting on you says that instead', () => {
  const quiet = (extra) => tokens(session({ last_activity: iso(9 * 60_000), ...extra })).filter((t) => t.startsWith('quiet'))
  assert.deepEqual(quiet({}), ['quiet 9m'])
  assert.deepEqual(quiet({ active: false }), [], 'a finished terminal has not gone quiet, it has stopped')
  assert.deepEqual(quiet({ last_activity: iso(90_000) }), [], 'under two minutes is not quiet')
  assert.deepEqual(quiet({ waiting: { type: 'permission_prompt', message: 'Bash(ls)', since: iso(40_000) } }), [])
})

test('the capacity phrase on a row is the bucket that will stop THAT terminal', () => {
  assert.equal(B.capacityPhrase(session({ capacity: { kind: 'weekly_scoped', model: 'fable', percent: 63, resets_at: nowS() + 40 * HOUR, scope: 'model' } })), '63% of the fable week')
  assert.equal(B.capacityPhrase(session({ capacity: { kind: 'weekly_all', model: null, percent: 97, resets_at: nowS() + 40 * HOUR, scope: 'account' } })), '97% of the claude week')
  assert.equal(B.capacityPhrase(session({ capacity: { kind: 'session', model: null, percent: 29, resets_at: nowS() + HOUR, scope: 'account' } })), '29% of the claude 5-hour window')
  assert.equal(B.capacityPhrase(session({ capacity: null })), null, 'no bucket, no phrase: never a zero')
})

test('rank 3: a Notification wait is a human being waited on, and it raises the row', () => {
  const asked = (extra) => B.rankedNotes(session(extra))[0]
  const perm = asked({ waiting: { type: 'permission_prompt', message: 'Bash(git push origin HEAD)', since: iso(40_000) } })
  assert.equal(perm.rank, 3)
  assert.equal(perm.text, 'waiting on you: permission to run Bash(git push origin HEAD), asked 40s ago')
  assert.match(asked({ waiting: { type: 'idle_prompt', message: null, since: iso(60_000) } }).text, /^waiting on you: idle since /)
  assert.equal(asked({ waiting: { type: 'agent_needs_input', message: 'Which branch should I cut from?', since: iso(60_000) } }).text, 'waiting on you: Which branch should I cut from?')
  assert.equal(asked({ waiting: { type: 'quota_auto_resume', message: 'Claude Code is waiting at the limit itself; Leg is not handing this one off.', since: iso(60_000) } }).rank, 3)
  for (const type of ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'quota_auto_resume']) {
    const s = session({ waiting: { type, message: 'x', since: iso(60_000) } })
    assert.equal(B.needsYou(s, B.rankedNotes(s)), true, `${type} needs a human`)
  }
})

test('rank 3 never fires on the all-out countdown, which keeps its own rank 5 sentence', () => {
  const s = session({ status: 'waiting', waiting: { type: 'reset', agent: 'codex', account: 'default', resets_at: nowS() + HOUR, since: iso(4 * 60_000) } })
  assert.equal(B.notifyWait(s), null)
  assert.ok(B.resetWait(s))
  const note = B.rankedNotes(s).find((n) => n.cat === 'waiting')
  assert.equal(note.rank, 5)
  assert.match(note.text, /^waiting for codex at /)
  assert.equal(B.rankedNotes(s).some((n) => n.rank === 3), false, 'nobody is being waited on in that terminal')
})

test('the question is printed verbatim, capped where the hook itself caps it', () => {
  const long = 'Bash('.concat('x'.repeat(400), ')')
  const note = B.waitingNote({ type: 'permission_prompt', message: long, since: iso(1000) })
  assert.equal(note.text.includes(long.slice(0, 160)), true)
  assert.equal(note.text.includes(long.slice(0, 161)), false, '160 characters, the same cap src/taps/claude.mjs stores')
})

test('rank 8.5: the bucket that binds this terminal is near its wall', () => {
  const account = acct({ buckets: [bucket('weekly_scoped', 92, { model: 'fable', is_active: true }), bucket('weekly_scoped', 12, { model: 'opus' })] })
  const model = B.capacityNote(session({ capacity: { kind: 'weekly_scoped', model: 'fable', percent: 92, scope: 'model' } }), account)
  assert.equal(model.rank, 8.5)
  assert.equal(model.text, 'fable at 92% of its week; Hand off > claude/opus keeps this terminal')
  const shared = B.capacityNote(session({ capacity: { kind: 'weekly_all', model: null, percent: 97, scope: 'account' }, chain: [{ agent: 'codex', account: 'default' }] }), account)
  assert.equal(shared.text, 'claude at 97%, shared by every model; next off claude: codex')
  assert.equal(B.capacityNote(session({ capacity: { kind: 'weekly_scoped', model: 'fable', percent: B.WARN_PCT - 1, scope: 'model' } }), account), null, 'under the warning line the row says nothing')
  assert.equal(B.capacityNote(session({ capacity: { kind: 'weekly_scoped', model: 'fable', percent: B.WARN_PCT, scope: 'model' } }), account).rank, 8.5, 'at the line, not past it')
})

test('rank 8.5 sorts under the login warning and over the activity fallback', () => {
  const s = session({ capacity: { kind: 'weekly_all', model: null, percent: 97, scope: 'account' }, warning: { window: '7d', pct: 97 }, chain: [{ agent: 'codex', account: 'default' }] })
  const ranks = B.rankedNotes(s).map((n) => n.rank)
  assert.deepEqual(ranks, [8, 8.5, 10])
})
