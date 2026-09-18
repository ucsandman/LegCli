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
import { ROOT, mountSharedScripts } from './helpers.mjs'

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
  // src/board/strip.js draws the capacity strip for this page and for the
  // floor, and sessions.js delegates its bucket grammar to it, so the window
  // handed over carries it exactly as the <script> tag before it does
  const win = mountSharedScripts(doc, localStorage)
  win.addEventListener = () => {}
  new Function('module', 'document', 'window', 'localStorage', 'setInterval', 'setTimeout', SRC)(
    mod, doc, win, localStorage, () => 0, () => 0,
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
// A.4 row 12: the binding bucket as src/server.mjs puts it on a session, with
// the forecast burn() computed for that same bucket riding on it
const CAP = (extra = {}) => ({ kind: 'weekly_scoped', model: 'fable', percent: 63, resets_at: nowS() + 40 * HOUR, scope: 'model', forecast: null, ...extra })
const RATE = (secondsLeft, samples, spanS) => ({ seconds_left: secondsLeft, samples, span_s: spanS, rate_pct_per_h: 8 })
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
    // A.5 row 4 and E rule 6: the time is an INFERENCE and never appears
    // without the volume it was drawn from
    name: 'the burn rate is known, and the bucket belongs to one model',
    accounts: [acct({
      live: 1,
      buckets: [
        bucket('weekly_all', 47), bucket('weekly_scoped', 63, { model: 'fable', is_active: true }),
        bucket('weekly_scoped', 12, { model: 'opus' }), bucket('weekly_scoped', 30, { model: 'sonnet' }),
      ],
    })],
    sessions: [session({ model: 'fable', capacity: CAP({ forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })],
    line: 'About 2h 40m of Fable left.',
    sub: 'From 9 samples over 4h. Opus and Sonnet have their own buckets.',
  },
  {
    name: 'the burn rate is known and the bucket belongs to the whole login',
    accounts: [acct({ live: 1, buckets: [bucket('weekly_all', 88, { is_active: true })] })],
    sessions: [session({ capacity: CAP({ kind: 'weekly_all', model: null, percent: 88, scope: 'account', forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })],
    line: 'About 2h 40m of claude left.',
    sub: 'From 9 samples over 4h. Shared by every model.',
  },
  {
    // an hour-and-minute form for eight minutes reads as an instrument; eight
    // minutes is a sentence
    name: 'under ten minutes the forecast is spelled out in minutes',
    accounts: [acct({ live: 1, buckets: [bucket('weekly_scoped', 96, { model: 'fable', is_active: true }), bucket('weekly_scoped', 12, { model: 'opus' })] })],
    sessions: [session({ model: 'fable', capacity: CAP({ percent: 96, forecast: RATE(8 * 60, 3, 11 * 60) }) })],
    line: 'About 8 minutes of Fable left.',
    sub: 'From 3 samples over 11m. Opus has its own bucket.',
  },
  {
    name: 'past a day the forecast counts days and hours, not hours',
    accounts: [acct({ live: 1, buckets: [bucket('weekly_scoped', 20, { model: 'fable', is_active: true })] })],
    sessions: [session({ model: 'fable', capacity: CAP({ percent: 20, forecast: RATE(3 * 86400 + 5 * HOUR, 22, 9 * HOUR) }) })],
    line: 'About 3d 5h of Fable left.',
    sub: 'From 22 samples over 9h.',
  },
  {
    // the gate is the whole point: a capacity with no forecast leaves the
    // standing-percentage branches to do the talking
    name: 'no forecast, so the branch under it still prints the percentage',
    accounts: [CLAUDE_LIVE(), CODEX_WALLED()],
    sessions: [session({ model: 'fable', capacity: CAP({ forecast: null }) })],
    line: 'Fable is at 63% of its week, the only login open.',
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

const LONG_MODEL = 'an-unreasonably-long-model-name-for-this-test'

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
    // the forecast branch with a model name nobody would choose: the time is
    // the fact, so the name is what gets dropped
    [[acct({ label: long, live: 1, buckets: [bucket('weekly_scoped', 63, { model: LONG_MODEL, is_active: true })] })],
      [session({ model: LONG_MODEL, capacity: CAP({ model: LONG_MODEL, forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })]],
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

test('with a forecast the row prints the time and its volume, never the time alone', () => {
  const withRate = session({ model: 'fable', capacity: CAP({ forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })
  assert.equal(B.capacityPhrase(withRate), 'about 2h 40m of fable left, from 9 samples over 4h')
  const shared = session({ capacity: CAP({ kind: 'weekly_all', model: null, percent: 88, scope: 'account', forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })
  assert.equal(B.capacityPhrase(shared), 'about 2h 40m of claude left, from 9 samples over 4h')
  const thin = session({ model: 'fable', capacity: CAP({ forecast: RATE(11 * 60, 3, 11 * 60) }) })
  assert.equal(B.capacityPhrase(thin), 'about 11m of fable left, from 3 samples over 11m')
  // E rule 6: under the gate the row is the percentage and the clock again
  assert.equal(B.capacityPhrase(session({ model: 'fable', capacity: CAP({ forecast: null }) })), '63% of the fable week')
})

test('the strip token stays the measurement while the verdict carries the inference', () => {
  const a = acct({ live: 1, buckets: [bucket('weekly_scoped', 63, { model: 'fable', is_active: true }), bucket('weekly_scoped', 12, { model: 'opus' })] })
  const s = session({ model: 'fable', capacity: CAP({ forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })
  assert.equal(B.capFigure(a, B.bindingOf(a)), '63% fable week', 'the strip prints what was measured')
  assert.equal(B.verdictLines([a], [s]).line, 'About 2h 40m of Fable left.', 'the time lives where the sample count can sit beside it')
})

test('a long model name costs the name, never a third line of 52px type', () => {
  const a = acct({ live: 1, buckets: [bucket('weekly_scoped', 63, { model: LONG_MODEL, is_active: true })] })
  const s = session({ model: LONG_MODEL, capacity: CAP({ model: LONG_MODEL, forecast: RATE(2 * HOUR + 40 * 60, 9, 4 * HOUR) }) })
  assert.equal(B.verdictLines([a], [s]).line, 'About 2h 40m left.')
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

// ---------------------------------------------------------------------------
// B.6: the hand-off picker's rows, the ladder editor's round trip, and the
// Back to fable predicate. All three are pure functions in sessions.js, so
// they are asserted here rather than through a browser.
// ---------------------------------------------------------------------------
const target = (extra = {}) => ({ agent: 'claude', account: 'default', model: 'opus', available: true, reason: null, resets_at: null, keeps_conversation: false, cost: 'plan', ...extra })

test('a picker row names the rung, what it does to the conversation, and what it costs now', () => {
  assert.equal(
    B.handoffOptionText(target({ keeps_conversation: true })),
    'claude / opus · same terminal, keeps the conversation · ready',
  )
  assert.equal(
    B.handoffOptionText(target({ model: 'sonnet' })),
    'claude / sonnet · new agent, from the bundle · ready',
  )
  // a rung with no model is the agent alone: a model nobody chose is never printed
  assert.equal(
    B.handoffOptionText(target({ agent: 'codex', model: null })),
    'codex · new agent, from the bundle · ready',
  )
  // a login that is not `default` is part of the rung's name
  assert.equal(B.rungLabel({ agent: 'claude', account: 'work', model: 'haiku' }), 'claude/work / haiku')
})

test('an unavailable picker row carries the server reason and its clock, and is the one disabled', () => {
  const walled = target({ agent: 'codex', model: null, available: false, reason: 'at its usage limit', resets_at: nowS() + 29 * HOUR })
  assert.match(B.handoffOptionText(walled), /^codex · new agent, from the bundle · at its usage limit until /)
  // the wasted switch: every model shares the window that is out
  assert.equal(
    B.handoffOptionText(target({ available: false, reason: 'shares the window that is out, buys nothing' })),
    'claude / opus · new agent, from the bundle · shares the window that is out, buys nothing',
  )
  // an AVAILABLE row with a reason keeps it as text and stays pickable: the
  // reserve is a note to a human, not a refusal
  assert.equal(
    B.handoffOptionText(target({ reason: 'past your 10% reserve' })),
    'claude / opus · new agent, from the bundle · past your 10% reserve',
  )
  // what it costs is on the row before it is pressed
  assert.equal(
    B.handoffOptionText(target({ model: 'fable', cost: 'credits' })),
    'claude / fable · new agent, from the bundle · ready, spends usage credits',
  )
  assert.equal(
    B.handoffOptionText(target({ model: 'fable', cost: 'credits', available: false, reason: 'it spends usage credits and you have not allowed that' })),
    'claude / fable · new agent, from the bundle · it spends usage credits and you have not allowed that',
  )
})

test('the ladder editor round trips every rule a rung can carry', () => {
  for (const [when, kind, pct] of [['always', 'always', 50], ['walled-only', 'walled-only', 50], ['below:80', 'below', 80], ['below:1', 'below', 1]]) {
    assert.equal(B.whenKind(when), kind, when)
    assert.equal(B.whenPct(when), pct, when)
    assert.equal(B.whenString(B.whenKind(when), B.whenPct(when)), when, `${when} survives the round trip`)
  }
  // the number input is clamped where the server clamps it, so a save is never
  // refused for a number the editor itself produced. WHEN_RE in
  // src/preferences.mjs is `below:(100|[0-9]{1,2})`, so that range is 0 to 100:
  // clamping to 1 and 99 instead rewrote two values the record can legally hold
  // and made a stored `below:100` silently become `below:99`.
  assert.equal(B.whenString('below', 0), 'below:0')
  assert.equal(B.whenString('below', 140), 'below:100')
  assert.equal(B.whenString('below', 'nonsense'), 'below:0')
  assert.equal(B.whenKind(undefined), 'always', 'a rung with no rule is taken always')
  assert.equal(B.costWord('credits'), 'spends usage credits')
  assert.equal(B.costWord('free'), 'free')
  assert.equal(B.costWord(undefined), 'on the plan', 'the subscription already paid for is the default word')
})

test('Up and Down move one rung and refuse to fall off either end', () => {
  const ladder = [{ agent: 'claude', model: 'fable' }, { agent: 'claude', model: 'opus' }, { agent: 'codex', model: null }]
  assert.deepEqual(B.moveRung(ladder, 1, -1).map((r) => r.model), ['opus', 'fable', null])
  assert.deepEqual(B.moveRung(ladder, 1, 1).map((r) => r.model), ['fable', null, 'opus'])
  assert.deepEqual(B.moveRung(ladder, 0, -1).map((r) => r.model), ['fable', 'opus', null], 'the top rung has nowhere to go')
  assert.deepEqual(B.moveRung(ladder, 2, 1).map((r) => r.model), ['fable', 'opus', null], 'and neither has the last')
  // the draft line: what this terminal would try next, its own rung skipped
  const on = { agent: 'claude', account: 'default', model: 'opus' }
  assert.deepEqual(B.rungsAfter(on, ladder.map((r) => ({ ...r, account: 'default' }))).map(B.rungLabel), ['claude / fable', 'codex'])
})

test('the mirrored model list is the one src/buckets.mjs publishes', () => {
  // sessions.js runs in a browser and cannot import it, so the copy is checked
  // against the source of truth rather than trusted
  const src = readFileSync(join(ROOT, 'src', 'buckets.mjs'), 'utf8')
  const block = src.slice(src.indexOf('export const MODEL_ALIASES'))
  const claude = block.slice(block.indexOf('claude:'), block.indexOf(']', block.indexOf('claude:')))
  for (const m of B.MODEL_ALIASES.claude) assert.ok(claude.includes(`'${m}'`), `${m} is in the board's copy and not in src/buckets.mjs`)
  assert.equal(B.MODEL_ALIASES.claude.length, (claude.match(/'/g) || []).length / 2, 'the two lists are the same length')
  assert.deepEqual(B.LADDER_AGENTS, ['claude', 'codex', 'agy', 'grok'])
})

// Back to fable: present only when BOTH facts are known, because the whole
// point of the control is that it works when pressed.
const LADDER = [
  { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
  { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
  { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
]
const downshifted = (extra = {}) => session({ model: 'opus', handoff_ladder: LADDER, ...extra })

test('Back to fable appears on a downshifted row whose top rung is known open', () => {
  const open = [acct({ buckets: [bucket('weekly_scoped', 63, { model: 'fable', is_active: true })] })]
  assert.equal(B.climbTarget(downshifted(), open).model, 'fable')
  assert.equal(B.topRungFor(downshifted()).model, 'fable', 'the top rung is the first one on this row own login')
  // on the top rung already: nothing to climb to
  assert.equal(B.climbTarget(session({ model: 'fable', handoff_ladder: LADDER }), open), null)
  // a row with no model at all is not known to be below anything
  assert.equal(B.climbTarget(session({ handoff_ladder: LADDER }), open), null)
  // a finished row hands off nowhere
  assert.equal(B.climbTarget(downshifted({ active: false }), open), null)
})

test('Back to fable is absent whenever the top rung is not known open', () => {
  const walledModel = [acct({ walls: { fable: { limited_until: nowS() + 2 * HOUR, limited_reason: 'model_limit' } } })]
  assert.equal(B.climbTarget(downshifted(), walledModel), null, 'the model itself is walled')
  const walledLogin = [acct({ limited_until: nowS() + 2 * HOUR, buckets: [bucket('weekly_scoped', 10, { model: 'fable' })] })]
  assert.equal(B.climbTarget(downshifted(), walledLogin), null, 'the whole login is out')
  const spent = [acct({ buckets: [bucket('weekly_scoped', 100, { model: 'fable' })] })]
  assert.equal(B.climbTarget(downshifted(), spent), null, 'the bucket is spent')
  assert.equal(B.climbTarget(downshifted(), []), null, 'no record for the login is unknown, not open')
  // no bucket and no wall is open: the only way to learn a bucket exists is to try it
  assert.equal(B.climbTarget(downshifted(), [acct()]).model, 'fable')
})

test('the account-scoped verdict names the rung a hand-off would actually take', () => {
  const accounts = [
    acct({ live: 1, buckets: [bucket('weekly_all', 97, { is_active: true }), bucket('weekly_scoped', 20, { model: 'fable' })] }),
    acct({ agent: 'codex', seven_day: { pct: 10, resets_at: nowS() + 40 * HOUR } }),
  ]
  // with no eligibility answer on the row, the nearest open login is named
  assert.equal(B.verdictLines(accounts, [session()]).sub, 'Switching to fable buys nothing. Next off claude: codex.')
  // with one, the chooser's own answer wins, model and all: a login being open
  // is not the same fact as a rung being eligible
  const withNext = [session({ eligible_next: { agent: 'codex', account: 'default' } })]
  assert.equal(B.verdictLines(accounts, withNext).sub, 'Switching to fable buys nothing. Next off claude: codex.')
  const named = [session({ eligible_next: { agent: 'claude', account: 'work', model: 'haiku' } })]
  assert.equal(B.verdictLines(accounts, named).sub, 'Switching to fable buys nothing. Next off claude: claude/work / haiku.')
})

// ---- an ended terminal is not waiting on anybody (finding 27) -------------
test('an ended or lost terminal never says "waiting on you"', () => {
  const asked = { type: 'permission_prompt', message: 'Bash(rm -rf build)', since: iso(90 * 60_000) }
  for (const dead of [{ active: false, status: 'ended', ended_at: iso(60_000) }, { active: false, status: 'lost', ended_at: iso(60_000) }]) {
    const s = session({ ...dead, waiting: asked })
    assert.equal(B.notifyWait(s), null, `${dead.status}: nothing clears \`waiting\` on the way out, so the board must not read it as a live question`)
    const notes = B.rankedNotes(s)
    assert.equal(notes.some((n) => n.cat === 'waiting on you'), false, `${dead.status}: no rank 3 note`)
    assert.equal(B.needsYou(s, notes), false, `${dead.status}: it does not count in the region head, the badge or the sort`)
  }
  // and the live row it was copied from still does
  const live = session({ waiting: asked })
  assert.equal(B.needsYou(live, B.rankedNotes(live)), true)
})

// ---- the `below N%` box (finding 29) --------------------------------------
test('the below box shows what is stored and an empty box means always', () => {
  // the server's own range is 0 to 100 (WHEN_RE in src/preferences.mjs), so a
  // stored value inside it round trips instead of being rewritten on sight
  for (const when of ['below:0', 'below:100', 'below:50']) {
    assert.equal(B.whenString('below', B.whenPct(when)), when, `${when} survives the round trip`)
  }
  assert.equal(B.whenPct('below:0'), 0, 'a zero is a reading, not a missing number')
  assert.equal(B.whenPct('below:100'), 100)
  assert.equal(B.whenPct('below:'), 50, 'no number at all is the only case that takes the default')
  // an empty box is not a percentage: the rung goes back to always
  assert.equal(B.whenFromBox(''), 'always')
  assert.equal(B.whenFromBox('   '), 'always')
  assert.equal(B.whenFromBox('80'), 'below:80')
  // a stored number the editor cannot offer carries its consequence
  assert.equal(B.whenFlag('below:0'), 'below 0% is never true: this rung is never taken')
  assert.equal(B.whenFlag('below:100'), 'below 100% is always true: this rung is taken like always')
  assert.equal(B.whenFlag('below:80'), null)
})

// ---- + Add a rung on a duplicate (finding 28) -----------------------------
test('+ Add a rung on a rung that is already there says which one it is', () => {
  const ladder = [
    { agent: 'claude', account: 'default', model: 'fable' },
    { agent: 'claude', account: 'default', model: 'opus' },
    { agent: 'codex', account: 'default', model: null },
  ]
  assert.equal(B.duplicateRung(ladder, { agent: 'claude', account: 'default', model: 'opus' }), 'claude / opus is already rung 2.')
  assert.equal(B.duplicateRung(ladder, { agent: 'codex', account: 'default', model: null }), 'codex is already rung 3.')
  assert.equal(B.duplicateRung(ladder, { agent: 'claude', account: 'default', model: 'haiku' }), null, 'a new rung is added with no sentence')
})

// ---- the picker's pick survives the 3-second poll (finding 10) ------------
test('a chosen destination is held by its rung, not by its index', () => {
  const t = (agent, model) => ({ agent, account: 'default', model })
  const targets = [t('claude', 'opus'), t('claude', 'sonnet'), t('codex', null)]
  const key = B.pickKey(targets[1])
  assert.equal(B.pickIndex(targets, key), '1')
  // the poll rebuilds the select from a payload whose rows have moved: the same
  // destination, at a different index
  assert.equal(B.pickIndex([t('codex', null), t('claude', 'sonnet')], key), '1')
  assert.equal(B.pickIndex([t('claude', 'sonnet'), t('codex', null)], key), '0')
  // a destination that is no longer offered falls back to "the next option in
  // the order", which is what an empty value means
  assert.equal(B.pickIndex([t('codex', null)], key), '')
  assert.equal(B.pickIndex(targets, null), '')
  assert.match(SRC, /drawer\.pick/, 'the pick lives beside drawer.turnCap, which already survives a rebuild')
})

// ---- C.5: a card waiting on a human reaches the verdict -------------------
test('the verdict names a card that is waiting on a human', () => {
  const accounts = [acct({ live: 1, buckets: [bucket('weekly_scoped', 63, { model: 'fable', is_active: true })] })]
  const live = [session()]
  const cards = { count: 1, first: { id: 'card-20260917-2347-review-3e1c', title: 'add the audit csv export', station: 'review', since: iso(12 * 60_000) } }
  const v = B.verdictLines(accounts, live, cards)
  assert.equal(v.line, 'card 3e1c has waited on you for 12 minutes.')
  assert.equal(v.sub, 'It is at the review station. Approve or Reassign on its row.')
  // a blocked TERMINAL still outranks a blocked card: it is the thing in front
  // of the reader
  const blocked = [session({ waiting: { type: 'permission_prompt', message: 'Bash(git push origin HEAD)', since: iso(3 * 60_000) } })]
  assert.match(B.verdictLines(accounts, blocked, cards).line, /has waited on you for 3 minutes\.$/)
  assert.doesNotMatch(B.verdictLines(accounts, blocked, cards).line, /^card /)
  // the old numeric shape and no shape at all are both read without throwing,
  // and neither invents a card sentence
  assert.doesNotMatch(B.verdictLines(accounts, live, 1).line, /^card /)
  assert.doesNotMatch(B.verdictLines(accounts, live).line, /^card /)
  assert.doesNotMatch(B.verdictLines(accounts, live, { count: 0 }).line, /^card /)
  // and the headline stays inside its measured budget
  assert.ok(v.line.length <= B.VERDICT_CH, `${v.line.length} > ${B.VERDICT_CH}`)
  assert.ok(v.sub.length <= B.SUB_CH)
})
