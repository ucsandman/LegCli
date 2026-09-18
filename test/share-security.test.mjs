// The security pass on `leg share`: every route, every way in.
//
// Four ways a stranger can knock (no token from a non-loopback address, a
// wrong token, another human's token, a token that was rotated or removed),
// against every route src/server.mjs handle() answers, plus SSE. Each answer
// is checked twice: the status code, and that the bytes carry none of the
// owner's canaries (prompt, cwd, file names, limit text, bundle path, event
// summaries, the land detail, a run log's secret and path, $BATON_HOME, or
// the token that was presented).
//
// Also: per-human identity on a hand-off, no token in the board's own stdout
// or in what the CLI prints, the rate limit and the guess lockout, and that
// share off is airtight.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo, testEnv, baton, sleep } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
delete process.env.BATON_QUIET // the board logs; the last test reads every byte of it back
delete process.env.BATON_TOKEN
delete process.env.BATON_BIND
delete process.env.BATON_PERSON
// the sweeps send hundreds of requests and hundreds of bad tokens on purpose:
// the rate-limit tests build their own servers with the small numbers.
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

// every byte this process prints, kept for the "no token in the logs" test
const PRINTED = []
const realOut = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)
process.stdout.write = (chunk, ...rest) => { PRINTED.push(String(chunk)); return realOut(chunk, ...rest) }
process.stderr.write = (chunk, ...rest) => { PRINTED.push(String(chunk)); return realErr(chunk, ...rest) }

const share = await import('../src/share.mjs')
const { createBoardServer } = await import('../src/server.mjs')
const { createSession, updateSession, appendEvent, readRequests, sessionDir } = await import('../src/sessions.mjs')
const { createCard } = await import('../src/cards.mjs')
const { ledgerAppend } = await import('../src/store.mjs')

// ---- the machine's own non-loopback address -------------------------------
// A guest reaches the board from somewhere else. Binding the Tailscale address
// is the only way to get a remote address that is not 127.0.0.1, which is what
// auth.mjs keys "the machine's own browser is the owner" off.
// A non-loopback address STRING for the checkBind / default-off tests and for
// share.json's bind field. It is never bound to a socket: a request cannot be
// given a non-loopback SOURCE address on a single host (connecting to any
// 127/8 or local address still reports a loopback source), so "a stranger is
// refused with no token" is proven with share.loopback_owner=false (strictBase),
// not a real remote peer.
const WAN = '100.64.0.1'

// ---- canaries: one distinctive string per thing a guest must never see -----
const wesRepo = initRepo('sec-wes-')
const samRepo = initRepo('sec-sam-')
const C = {
  task: 'CANARY-TASK-9f2b the owner private prompt',
  cwd: join(wesRepo, 'CANARY-CWD-dir'),
  repo: wesRepo,
  file: 'CANARY-FILE-7a1c.md',
  limit: 'CANARY-LIMIT-4d8e what the assistant said when it hit the cap',
  waiting: 'CANARY-WAITING-9e4d permission to run Bash(git push origin HEAD)',
  bundle: join(wesRepo, '.context-handoffs', 'CANARY-BUNDLE-11ff.md'),
  event: 'CANARY-EVENT-5c3a something this terminal did',
  landDetail: 'CANARY-LANDDETAIL-2e6b the rebase left a conflict',
  runlog: 'CANARY-RUNLOG-SECRET-8b4d',
  runlogPath: join(wesRepo, 'CANARY-RUNLOG-PATH-dir', 'notes.txt'),
  cardTask: 'CANARY-CARDTASK-6d90 the pipeline work',
  cardTitle: 'CANARY-CARDTITLE-3b7e',
  landedBody: 'CANARY-LANDED-BODY-8c21 what the card put on trunk',
  home: HOME,
  worktree: join(wesRepo, '..', 'CANARY-WORKTREE-dir'),
}
// assembled at runtime so this file never carries a key-shaped literal
const SCRUBBED_KEY = ['sk', 'ant', 'api03', 'CANARYKEYAAAAAAAAAAAAAAAA'].join('-')

const OWNED = 's-sec-wes'
const OTHER = 's-sec-sam'
let CARD = null

const TOKENS = { wes: share.newToken(), sam: share.newToken(), kim: share.newToken() }
const STALE = { sam: null, kim: null } // filled in when sam is rotated and kim is removed

// one share object, handed to every server: rotating and removing later is a
// mutation the running boards must see, exactly as the CLI would leave it.
const SHARE = {
  version: 1, on: true, bind: WAN, bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: true,
  people: [['wes', 'owner'], ['sam', 'guest'], ['kim', 'guest']].map(([name, role]) => ({
    name, role, token_sha256: share.hashToken(TOKENS[name]), created_at: new Date().toISOString(), last_seen: null,
  })),
}
const strictShare = () => ({ ...SHARE, loopback_owner: false })

// ---- http ------------------------------------------------------------------
function request(base, path, { method = 'GET', token = null, query = false, body = null } = {}) {
  const url = new URL(base + path)
  if (token && query) url.searchParams.set('token', token)
  return new Promise((resolvePromise, reject) => {
    const headers = token && !query ? { authorization: `Bearer ${token}` } : {}
    if (body) headers['content-type'] = 'application/json'
    const req = http.request(url, { method, headers }, (r) => {
      let data = ''
      r.on('data', (c) => { data += c })
      r.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { /* not json: static pages, plain text */ }
        resolvePromise({ status: r.statusCode, text: data, json, headers: r.headers })
      })
    })
    // never let a token reach a failure message: this file asserts on its own stdout
    req.on('error', (err) => reject(new Error(`${method} ${path}: ${err.code ?? err.message}`)))
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Open an SSE stream, do something while it is open, keep every frame.
function sseCollect(base, token, { ms = 1500, whileOpen = async () => {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(`${base}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`, (r) => {
      if (r.statusCode !== 200) { r.resume(); req.destroy(); return resolvePromise({ status: r.statusCode, frames: [] }) }
      let buf = ''
      const frames = []
      r.on('data', (c) => {
        buf += c
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const lines = chunk.split('\n')
          const event = (lines.find((l) => l.startsWith('event: ')) ?? 'event: message').slice(7)
          const dataLine = lines.find((l) => l.startsWith('data: '))
          frames.push({ event, text: dataLine ? dataLine.slice(6) : '' })
        }
      })
      Promise.resolve()
        .then(whileOpen)
        .then(() => sleep(ms))
        .then(() => { req.destroy(); resolvePromise({ status: 200, frames }) })
        .catch((err) => { req.destroy(); reject(err) })
    })
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(new Error(`sse: ${err.code ?? err.message}`)) })
  })
}

// ---- the canary detector ---------------------------------------------------
// A JSON body carries a Windows path as C:\\Users\\..., so a raw substring
// search would miss it. Check the escaped form too, and case-insensitively.
function carries(text, needle) {
  if (!needle) return false
  const hay = String(text).toLowerCase()
  const raw = String(needle).toLowerCase()
  const escaped = JSON.stringify(String(needle)).slice(1, -1).toLowerCase()
  return hay.includes(raw) || hay.includes(escaped)
}

const SECRETS = () => [
  ['task', C.task], ['cwd', C.cwd], ['repo path', C.repo], ['file name', C.file], ['limit text', C.limit],
  ['waiting question', C.waiting],
  ['bundle path', C.bundle], ['event summary', C.event], ['land detail', C.landDetail],
  ['run log secret', C.runlog], ['run log path', C.runlogPath], ['card task', C.cardTask],
  ['card title', C.cardTitle], ['landed body', C.landedBody], ['worktree path', C.worktree], ['BATON_HOME', C.home],
]

function assertClean(res, label, { presented = null } = {}) {
  for (const [what, needle] of SECRETS()) {
    assert.equal(carries(res.text, needle), false, `${label}: leaked the ${what} (${needle})\nbody: ${String(res.text).slice(0, 400)}`)
  }
  for (const [name, tok] of Object.entries({ ...TOKENS, ...STALE })) {
    if (tok) assert.equal(carries(res.text, tok), false, `${label}: echoed ${name}'s token back`)
  }
  if (presented) assert.equal(carries(res.text, share.hashToken(presented)), false, `${label}: echoed a token hash`)
}

// ---- the routes handle() answers ------------------------------------------
const apiRoutes = () => [
  ['GET', '/api/health'], ['GET', '/api/adapters'], ['GET', '/api/presets'],
  ['GET', '/api/cards'], ['POST', '/api/cards'],
  ['GET', '/api/sessions'], ['GET', `/api/sessions/${OWNED}`],
  ['POST', `/api/sessions/${OWNED}/request-handoff`],
  ['POST', `/api/sessions/${OWNED}/requests/sam/approve`], ['POST', `/api/sessions/${OWNED}/requests/sam/dismiss`],
  ['POST', `/api/sessions/${OWNED}/land`], ['POST', `/api/sessions/${OWNED}/handoff`], ['POST', `/api/sessions/${OWNED}/end`],
  // step 6: a terminal becomes a card, a card hands back a command. Both move
  // real work, so both are in the sweep from the day they exist.
  ['POST', `/api/sessions/${OWNED}/end-as-card`],
  ['DELETE', `/api/sessions/${OWNED}`],
  ['GET', `/api/sessions/${OTHER}`], ['POST', `/api/sessions/${OTHER}/handoff`], ['DELETE', `/api/sessions/${OTHER}`],
  ['GET', '/api/floor'], ['GET', '/api/trunk'], ['GET', '/api/leases'],
  ['GET', `/api/cards/${CARD}`], ['GET', `/api/cards/${CARD}/events`], ['GET', `/api/cards/${CARD}/log`],
  ['POST', `/api/cards/${CARD}/run`], ['POST', `/api/cards/${CARD}/take-over`], ['DELETE', `/api/cards/${CARD}`],
  ['GET', '/api/history'], ['GET', `/api/history/claude:${OWNED}`], ['GET', '/api/history/providers'], ['POST', '/api/history/refresh'],
  ['GET', '/api/worktrees'],
  ['GET', '/api/nope'],
]
const STATIC = ['/', '/floor', '/board.js', '/sessions.js', '/index.html', '/nope.html']

// ---- servers ---------------------------------------------------------------
let wanBase // the real thing: bound to a non-loopback address, share on
let strictBase // loopback, share.loopback_owner = false (a token even here)
let openBase // loopback, the owner's own browser
let floodBase // BATON_RATE_MAX=30, BATON_RATE_MAX_FAILURES=5
let guessesBase // same small numbers, used for "no token is not a guess"
const started = []

async function boot(opts) {
  const srv = createBoardServer({ port: 0, token: '', scheduler: false, ...opts })
  const { port } = await srv.start()
  started.push(srv)
  return `http://${opts.bind}:${port}`
}

before(async () => {
  // wes: a terminal with everything a guest must not see
  createSession({ id: OWNED, agent: 'claude', cwd: C.cwd, repo: wesRepo, branch: 'main', runner_pid: process.pid, owner: 'wes' })
  updateSession(OWNED, {
    status: 'running', task: C.task, files_touched: [C.file], files_dirty: [C.file],
    bundle: C.bundle, transcript_path: join(C.cwd, 'transcript.jsonl'), argv: ['claude', '--dangerously-skip-permissions'],
    limits: { five_hour: { pct: 62 }, seven_day: { pct: 30 } },
    limit: { reason: 'rate_limit', detail: C.limit, resets_at: 1900000000, at: new Date().toISOString() },
    // the Notification hook's question is the owner's prompt text by another
    // route, and the model says which of this machine's buckets is being spent
    model: 'fable',
    // the commit count the register prints beside the dirty count
    ahead: 2,
    waiting: { type: 'permission_prompt', message: C.waiting, since: new Date().toISOString() },
    // a worktree whose path is gone: landBlocker stops before any git runs
    worktree: { path: C.worktree, branch: 'baton/s-sec-wes', base: 'main' },
  })
  appendEvent(OWNED, { type: 'turn', summary: C.event, body: C.task })
  // land.json is the board's to write; a bounced landing carries the detail
  writeFileSync(join(sessionDir(OWNED), 'land.json'), JSON.stringify({
    state: 'bounced', at: new Date().toISOString(), by: 'wes', branch: 'baton/s-sec-wes', base: 'main',
    reason: 'rebase conflict', detail: C.landDetail, files: [C.file],
  }))
  // sam: their own terminal, in their own checkout
  createSession({ id: OTHER, agent: 'codex', cwd: samRepo, repo: samRepo, branch: 'main', runner_pid: process.pid, owner: 'sam' })
  updateSession(OTHER, { status: 'running', task: "sam's own prompt" })

  // one pipeline card with a run log
  const card = await createCard({ repo: wesRepo, task: C.cardTask, title: C.cardTitle, chain: 'claude' }, { type: 'human', id: 'wes' })
  CARD = card.card_id
  const runDir = join(HOME, 'cards', CARD, 'runs', '1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: 1, adapter: 'claude', status: 'done', outcome: 'ok', started_at: new Date().toISOString(), exit_code: 0 }))
  writeFileSync(join(runDir, 'out.log'), `${C.runlog} is in this log\nreading ${C.runlogPath}\nANTHROPIC_API_KEY=${SCRUBBED_KEY}\n`)
  writeFileSync(join(runDir, 'err.log'), `stderr also saw ${C.runlog}\n`)
  ledgerAppend(CARD, { type: 'landed', station: 'land', leg: 0, summary: `landed ${C.cardTitle}`, body: C.landedBody })

  // wanBase serves the token-presenting sweeps (wrong / guest / valid / stale
  // token); those don't depend on the source address, so a loopback SHARE-backed
  // board is portable and correct. The no-token refusal is strictBase's job.
  wanBase = await boot({ bind: '127.0.0.1', share: SHARE })
  strictBase = await boot({ bind: '127.0.0.1', share: strictShare() })
  openBase = await boot({ bind: '127.0.0.1', share: SHARE })
  process.env.BATON_RATE_MAX = '30'
  process.env.BATON_RATE_MAX_FAILURES = '5'
  floodBase = await boot({ bind: '127.0.0.1', share: SHARE })
  guessesBase = await boot({ bind: '127.0.0.1', share: strictShare() })
  process.env.BATON_RATE_MAX = '5000'
  process.env.BATON_RATE_MAX_FAILURES = '5000'
})

after(async () => {
  for (const srv of started) { try { await srv.stop() } catch { /* already down */ } }
  process.stdout.write = realOut
  process.stderr.write = realErr
})

// ---- 0. the detector itself ------------------------------------------------
test('the canary detector actually fires: the owner\'s own board carries every one of them', async () => {
  const mine = await request(openBase, '/api/sessions')
  assert.equal(mine.status, 200)
  assert.equal(mine.json.you.name, 'wes')
  const found = SECRETS().filter(([, needle]) => carries(mine.text, needle)).map(([what]) => what)
  for (const what of ['task', 'cwd', 'repo path', 'file name', 'limit text', 'bundle path', 'waiting question']) {
    assert.ok(found.includes(what), `the owner's own /api/sessions should carry the ${what}; detector found [${found}]`)
  }
  // the owner's own row carries the commit count, so the guest assertion that
  // it is absent is measuring a field that is really there to lose
  assert.equal(mine.json.sessions.find((s) => s.session_id === OWNED).ahead, 2)
  const log = await request(openBase, `/api/cards/${CARD}/log`)
  assert.equal(log.status, 200)
  assert.ok(carries(log.text, C.runlog), 'the owner can read the run log')
  assert.equal(carries(log.text, SCRUBBED_KEY), false, 'an API key in a run log is scrubbed even for the owner')
  assert.ok(log.text.includes('[REDACTED]'), 'scrub() replaced the key')
  assert.equal(apiRoutes().length, 33, 'every route handle() answers is in the sweep')
})

// ---- 1. no token from a non-loopback address -------------------------------
test('no token, from a non-owner address: every route refuses and says nothing', async () => {
  // loopback_owner=false (strictBase) is the portable "not the machine's own
  // browser" case: no token presented and not the tokenless loopback owner is
  // the same authorize refusal a real remote peer hits, with no dependency on a
  // real non-loopback interface, so it runs on CI.
  let swept = 0
  for (const [method, path] of apiRoutes()) {
    const r = await request(strictBase, path, { method })
    assert.equal(r.status, 401, `${method} ${path} with no token`)
    assert.match(r.json.error, /unauthorized/)
    assertClean(r, `${method} ${path} (no token)`)
    swept++
  }
  assert.equal((await sseCollect(strictBase, null, { ms: 50 })).status, 401, 'SSE with no token')
  assert.equal(swept, 33, `swept ${swept} routes`)
})

test('no token on loopback when share asks for one: every route refuses', async () => {
  for (const [method, path] of apiRoutes()) {
    const r = await request(strictBase, path, { method })
    assert.equal(r.status, 401, `${method} ${path} with no token (loopback_owner=false)`)
    assertClean(r, `${method} ${path} (no token, strict loopback)`)
  }
  assert.equal((await sseCollect(strictBase, null, { ms: 50 })).status, 401)
})

// ---- 2. a wrong token ------------------------------------------------------
test('a wrong token: every route refuses, in the header and in the query string', async () => {
  const wrong = share.newToken()
  for (const [method, path] of apiRoutes()) {
    const r = await request(wanBase, path, { method, token: wrong })
    assert.equal(r.status, 401, `${method} ${path} with a wrong token`)
    assertClean(r, `${method} ${path} (wrong token)`, { presented: wrong })
    const q = await request(wanBase, path, { method, token: wrong, query: true })
    assert.equal(q.status, 401, `${method} ${path}?token=<wrong>`)
    assertClean(q, `${method} ${path} (wrong token, query)`, { presented: wrong })
  }
  assert.equal((await sseCollect(wanBase, wrong, { ms: 50 })).status, 401, 'SSE with a wrong token')
  // a blank token, the owner's name, and the stored hash are not a way in
  for (const [label, bad] of [['blank', ' '], ['a name', 'wes'], ['the word Bearer', 'Bearer'], ['the stored hash', share.hashToken(TOKENS.wes)]]) {
    const r = await request(wanBase, '/api/sessions', { token: bad, query: true })
    assert.equal(r.status, 401, `presenting ${label} as a token`)
  }
})

// ---- 3. another human's token ---------------------------------------------
const PIPELINE = ['/api/cards', '/api/floor', '/api/presets', '/api/adapters', '/api/leases']
const isPipeline = (path) => PIPELINE.includes(path) || path.startsWith('/api/cards/')

test('sam on wes\'s terminal, kim on sam\'s: read-only, and nothing of the other human comes back', async () => {
  const snapshot = readFileSync(join(sessionDir(OWNED), 'session.json'), 'utf8')
  for (const [who, token] of [['sam', TOKENS.sam], ['kim', TOKENS.kim]]) {
    for (const [method, path] of apiRoutes()) {
      const r = await request(wanBase, path, { method, token })
      const ownTerminal = who === 'sam' && path.includes(OTHER)
      if (isPipeline(path)) assert.equal(r.status, 403, `${who}: ${method} ${path} is the owner's pipeline`)
      else if (path.endsWith('/request-handoff')) assert.equal(r.status, 202, `${who}: ${method} ${path}`)
      else if (path.includes(OWNED) || (path.includes(OTHER) && !ownTerminal)) assert.equal(r.status, 403, `${who}: ${method} ${path} is another human's terminal`)
      if (r.status === 403) assert.match(r.json.error, /read-only|belongs to/, `${who}: ${method} ${path}`)
      // /api/trunk answers a guest with the owner's pipeline: its own test below
      // owns that finding, so the rest of the sweep still gets checked.
      if (path !== '/api/trunk') assertClean(r, `${who}: ${method} ${path}`, { presented: token })
    }
  }
  // nothing the sweep sent moved the owner's terminal
  assert.equal(existsSync(join(sessionDir(OWNED), 'control.json')), false, 'no hand-off or end reached the runner')
  assert.equal(readFileSync(join(sessionDir(OWNED), 'session.json'), 'utf8'), snapshot, 'session.json is untouched')
  assert.ok(existsSync(join(HOME, 'cards', CARD, 'card.json')), 'the card is still there')
  assert.equal(JSON.parse(readFileSync(join(sessionDir(OWNED), 'land.json'), 'utf8')).state, 'bounced', 'no landing was started')
})

test('a guest\'s own board: their terminal, and of the owner\'s only that it exists', async () => {
  const v = (await request(wanBase, '/api/sessions', { token: TOKENS.sam })).json
  const theirs = v.sessions.find((s) => s.session_id === OWNED)
  assert.equal(theirs.hidden, true)
  assert.equal(theirs.task, null)
  assert.equal(theirs.cwd, null)
  assert.deepEqual(theirs.files, [])
  // how far someone else's branch has moved is a fact about their work, beside
  // the dirty count that is already withheld (redesign A.4 row 8)
  assert.equal(theirs.ahead, undefined, 'no commit count from the owner\'s branch')
  assert.equal(theirs.bundle, undefined)
  assert.equal(theirs.transcript_path, undefined)
  assert.equal(theirs.argv, undefined)
  assert.equal(theirs.worktree.path, undefined, 'no path to the owner\'s worktree')
  assert.equal(theirs.land.detail, undefined, 'no land detail')
  assert.equal(theirs.land.files, undefined, 'no file names from the landing')
  assert.equal(theirs.limit.detail, undefined, 'no limit text')
  const own = v.sessions.find((s) => s.session_id === OTHER)
  assert.equal(own.hidden, undefined)
  assert.equal(own.task, "sam's own prompt")
})

// The usage canary. The board head prints the 5-hour percentage as a 30px
// numeral (.design/BOARD-DESIGN.md 6.1.5), so a slot a guest can read is the
// loudest object on their page. sessionsView() used to send `accounts` whole
// (percentages, wall, reset times, the reading source), which rendered as a
// 56x6px bar nobody noticed. Write one usage file with all four, then fail if
// any of them reaches a guest. A bare percentage is not substring-searchable
// (96 occurs inside timestamps), so the numbers are checked by field name and
// the strings and reset epochs are checked as canaries.
test('a guest\'s board carries no usage percentage, no reset time and no reading source', async () => {
  const fiveHourResets = 1900000096
  const sevenDayResets = 1900000063
  const usageSource = 'CANARY-USAGE-SOURCE-2f7a claude statusline'
  const usageReason = 'CANARY-USAGE-REASON-6b18 usage limit reached'
  const wallEvidence = 'CANARY-WALL-EVIDENCE-4a52 you have reached your Fable limit'
  const factPlan = 'CANARY-PLAN-7e30-prolite'
  const observed = new Date().toISOString()
  const usageFile = join(HOME, 'usage', 'claude--default.json')
  mkdirSync(join(HOME, 'usage'), { recursive: true })
  writeFileSync(usageFile, JSON.stringify({
    agent: 'claude', account: 'default',
    five_hour: { pct: 96, resets_at: fiveHourResets }, seven_day: { pct: 63, resets_at: sevenDayResets },
    limited_until: fiveHourResets, limited_reason: usageReason, limited_at: observed,
    source: usageSource, observed_at: observed, updated_at: observed,
    // the per-model keys are the same secret as the percentages: how much of
    // this machine's login is gone, and which model is out
    buckets: [{ kind: 'weekly_scoped', group: 'weekly', model: 'fable', percent: 63, resets_at: sevenDayResets, is_active: true, severity: 'normal' }],
    walls: { fable: { limited_until: sevenDayResets, limited_reason: 'model_limit', limited_at: observed, source: usageSource, evidence: wallEvidence } },
    history: { 'weekly_scoped:fable': [{ percent: 61, at: 1789660000 }] },
    extra_usage: { enabled: false, reason: 'out_of_credits', can_toggle: false, limit_minor: 12500 },
    facts: { plan_type: factPlan },
  }))
  const ACCOUNT_FIELDS = ['five_hour', 'seven_day', 'limited_until', 'limited_reason', 'source', 'observed_at', 'updated_at', 'stale', 'pct', 'resets_at', 'buckets', 'walls', 'extra_usage', 'facts', 'capacity']
  try {
    // the owner's own board still gets every field: this is the guest's redaction alone
    const owner = await request(openBase, '/api/sessions')
    assert.equal(owner.status, 200)
    assert.equal(owner.json.you.name, 'wes')
    const mine = owner.json.accounts.find((a) => a.agent === 'claude' && a.account === 'default')
    assert.deepEqual(Object.keys(mine).sort(), ['account', 'agent', 'buckets', 'extra_usage', 'facts', 'five_hour', 'limited_reason', 'limited_until', 'live', 'observed_at', 'seven_day', 'source', 'stale', 'updated_at', 'walls'])
    // the owner reads the per-model record: the bucket that binds, the model
    // that is walled, the credits sentence and the measured facts
    assert.equal(mine.buckets[0].model, 'fable')
    assert.equal(mine.buckets[0].percent, 63)
    assert.equal(mine.walls.fable.evidence, wallEvidence)
    assert.equal(mine.extra_usage.reason, 'out_of_credits')
    assert.equal(mine.facts.plan_type, factPlan)
    const ownRow = owner.json.sessions.find((s) => s.session_id === OWNED)
    assert.equal(ownRow.capacity.kind, 'weekly_scoped', 'the owner\'s row carries the bucket that binds it')
    assert.equal(ownRow.capacity.scope, 'model')
    assert.equal(ownRow.capacity.percent, 63)
    assert.equal(mine.five_hour.pct, 96, 'the owner reads their own 5-hour percentage')
    assert.equal(mine.five_hour.resets_at, fiveHourResets)
    assert.equal(mine.seven_day.pct, 63)
    assert.equal(mine.seven_day.resets_at, sevenDayResets)
    assert.equal(mine.limited_until, fiveHourResets)
    assert.equal(mine.limited_reason, usageReason)
    assert.equal(mine.source, usageSource)
    assert.equal(mine.observed_at, observed)
    assert.equal(mine.stale, false, 'a reading taken this second is not stale')
    assert.equal(mine.live, 1, 'one claude terminal is running')

    // the guest gets the slot and nothing inside it
    const guest = await request(wanBase, '/api/sessions', { token: TOKENS.sam })
    assert.equal(guest.status, 200)
    assert.equal(guest.json.you.name, 'sam')
    assert.deepEqual(
      guest.json.accounts.map((a) => `${a.agent}/${a.account}`),
      owner.json.accounts.map((a) => `${a.agent}/${a.account}`),
      'a guest still sees which accounts exist, so the head prints one slot each',
    )
    for (const a of guest.json.accounts) {
      assert.deepEqual(Object.keys(a).sort(), ['account', 'agent', 'live', 'shared'], `guest account ${a.agent}/${a.account} carries more than agent, account, live and shared`)
      assert.equal(a.shared, false, `guest account ${a.agent}/${a.account} says its usage is shared`)
    }
    const theirClaude = guest.json.accounts.find((a) => a.agent === 'claude' && a.account === 'default')
    assert.equal(theirClaude.live, mine.live, 'how many terminals are running is already on the guest\'s session list')
    const slots = JSON.stringify(guest.json.accounts)
    for (const field of ACCOUNT_FIELDS) assert.equal(slots.includes(field), false, `a guest board carries accounts.${field}: ${slots.slice(0, 300)}`)
    // a guest owns their own terminal, so its row is not redacted: the new
    // per-model keys still must not ride on it. `capacity` is a percentage of
    // this machine's login, computed per request, and it is owner-only.
    const theirOwnRow = guest.json.sessions.find((s) => s.session_id === OTHER)
    assert.ok(theirOwnRow, 'sam still sees sam\'s own terminal')
    for (const field of ['capacity', 'buckets', 'walls', 'extra_usage', 'facts']) {
      assert.equal(field in theirOwnRow, false, `a guest's own session row carries ${field}`)
    }
    // The hand-off picker on a guest's own terminal names rungs and what they
    // cost, which is theirs to act on. A rung's reason can quote this machine's
    // usage ("at 63%, not below 80%", "past your 10% reserve") and a reset time
    // is the same secret as the percentage: neither crosses.
    for (const row of theirOwnRow.handoff_targets ?? []) {
      assert.equal(row.resets_at, null, `a guest's picker row carries a reset time (${row.agent}/${row.model ?? '-'})`)
      assert.equal(/\d/.test(String(row.reason ?? '')), false, `a guest's picker row carries a number in its reason: ${row.reason}`)
      // `cost` is owner-only: `credits` on a claude/fable rung is the owner's
      // extra_usage flag by another name (see the picker canary below)
      assert.deepEqual(Object.keys(row).sort(), ['account', 'agent', 'available', 'keeps_conversation', 'model', 'reason', 'resets_at'])
    }
    // `waiting` and `model` are the guest's to see on their OWN terminal: they
    // are sitting at it, and a terminal that has stopped for a permission
    // prompt is useless to its own human when the board will not say so.
    assert.equal('waiting' in theirOwnRow, true, 'a guest owns their own terminal, so its own wait reaches them')
    assert.equal('model' in theirOwnRow, true, 'and the model it is running')
    const rows = JSON.stringify(guest.json.sessions)
    for (const field of ['capacity', 'buckets', 'walls', 'extra_usage']) {
      assert.equal(rows.includes(`"${field}"`), false, `a guest board carries sessions[].${field}`)
    }
    // someone else's row: neither. `waiting` is either the verbatim question an
    // agent asked (the owner's prompt text by another route) or a reset time,
    // and `model` is which of this machine's buckets that work is spending.
    const notTheirs = guest.json.sessions.find((s) => s.session_id === OWNED)
    assert.equal(notTheirs.hidden, true, 'wes\'s terminal is redacted for sam')
    const ownerRow = owner.json.sessions.find((s) => s.session_id === OWNED)
    assert.equal(ownerRow.waiting.message, C.waiting, 'the owner reads the question their own terminal asked')
    assert.equal(ownerRow.model, 'fable')
    for (const field of ['waiting', 'model']) {
      assert.equal(notTheirs[field] ?? null, null, `a guest board carries sessions[].${field} on someone else's row`)
    }
    for (const [what, needle] of [['the reading source', usageSource], ['the wall reason', usageReason], ['the wall evidence', wallEvidence], ['the measured plan', factPlan], ['the 5h reset time', String(fiveHourResets)], ['the 7d reset time', String(sevenDayResets)]]) {
      assert.equal(carries(guest.text, needle), false, `a guest board carries ${what} (${needle})`)
    }

    // SSE is the other way onto a guest board: the hello frame is the same view
    const stream = await sseCollect(wanBase, TOKENS.sam, { ms: 400 })
    assert.equal(stream.status, 200)
    assert.ok(stream.frames.length >= 1, 'the guest stream opened with a hello frame')
    assert.equal(stream.frames[0].event, 'hello')
    const helloAccounts = JSON.parse(stream.frames[0].text).sessions.accounts
    assert.equal(helloAccounts.length, guest.json.accounts.length, `the hello frame carries ${helloAccounts.length} account slots`)
    for (const a of helloAccounts) assert.deepEqual(Object.keys(a).sort(), ['account', 'agent', 'live', 'shared'], `the SSE hello frame carries a whole ${a.agent} account`)
    for (const f of stream.frames) {
      for (const [what, needle] of [['the reading source', usageSource], ['the wall reason', usageReason], ['the 5h reset time', String(fiveHourResets)]]) {
        assert.equal(carries(f.text, needle), false, `SSE frame ${f.event} carried ${what}`)
      }
    }
  } finally {
    // put the board back the way the rest of this file found it: no usage read at all
    rmSync(usageFile, { force: true })
  }
})

// The same secret by three other routes, none of which the accounts canary
// above can see: the session RECORD carries the two window percentages and the
// near-wall clock on every row (the poller and every claude status line write
// them), a guest's own row carries the same figures for this machine's login,
// and a picker row's cost word is computed from the owner's extra_usage flag.
test('a guest reads no usage off a redacted row, off their own row, or off a picker row', async (t) => {
  const warnResets = 1900000077
  const allOutResets = 1900000088
  const limitResets = 1900000099
  const usageFile = join(HOME, 'usage', 'claude--default.json')
  const prefsFile = join(HOME, 'preferences.json')
  const hadPrefs = existsSync(prefsFile) ? readFileSync(prefsFile, 'utf8') : null
  mkdirSync(join(HOME, 'usage'), { recursive: true })
  // this machine's claude login: nearly out, with usage credits switched on
  writeFileSync(usageFile, JSON.stringify({
    agent: 'claude', account: 'default',
    five_hour: { pct: 95, resets_at: warnResets }, seven_day: { pct: 44, resets_at: warnResets },
    source: 'claude usage endpoint', observed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    extra_usage: { enabled: true, reason: null, can_toggle: true, limit_minor: 12500 },
  }))
  // the owner's floor under that login, which makes the claude rungs a note
  // rather than a refusal for a human press (B.3)
  writeFileSync(prefsFile, JSON.stringify({ version: 1, reserve: { claude: 20 }, may_spend: false }))
  // wes's terminal, carrying every usage-bearing field a record can carry
  updateSession(OWNED, {
    limits: { five_hour: { pct: 62, resets_at: warnResets }, seven_day: { pct: 30, resets_at: warnResets } },
    warning: { window: '5h', pct: 87.5, resets_at: warnResets },
    all_out: [{ agent: 'claude', account: 'default', resets_at: allOutResets }],
    limit: { reason: 'rate_limit', detail: C.limit, resets_at: limitResets, at: new Date().toISOString() },
  })
  // sam's own terminal: the same figures, measured from the same login, plus a
  // ladder whose claude rungs are the ones the reserve and the credits word bite
  updateSession(OTHER, {
    limits: { five_hour: { pct: 95, resets_at: warnResets }, seven_day: { pct: 44, resets_at: warnResets } },
    warning: { window: '5h', pct: 95, resets_at: warnResets },
    usage_source: 'claude usage endpoint',
    waiting: { type: 'reset', agent: 'claude', account: 'default', resets_at: allOutResets, since: new Date().toISOString() },
    handoff_order: ['codex', 'claude', 'agy'],
    handoff_ladder: [
      { agent: 'codex', account: 'default', model: null, when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'fable', when: 'always', cost: 'plan' },
      { agent: 'claude', account: 'default', model: 'opus', when: 'always', cost: 'plan' },
    ],
  })
  try {
    const owner = (await request(openBase, '/api/sessions')).json
    const ownerRow = owner.sessions.find((s) => s.session_id === OWNED)
    // the detector: the owner really does read all of it, so the guest
    // assertions below are measuring fields that exist to lose
    assert.equal(ownerRow.limits.five_hour.pct, 62, 'the owner reads their own window percentages')
    assert.equal(ownerRow.warning.pct, 87.5)
    assert.equal(ownerRow.all_out[0].resets_at, allOutResets)
    assert.equal(ownerRow.limit.resets_at, limitResets)
    const ownerPick = (owner.sessions.find((s) => s.session_id === OTHER).handoff_targets ?? []).find((t) => t.agent === 'claude' && t.model === 'fable')
    assert.ok(ownerPick, 'the owner sees the claude/fable rung')
    assert.equal(ownerPick.cost, 'credits', 'and reads that it spends usage credits')

    const guest = await request(wanBase, '/api/sessions', { token: TOKENS.sam })
    assert.equal(guest.status, 200)
    const notTheirs = guest.json.sessions.find((s) => s.session_id === OWNED)
    const own = guest.json.sessions.find((s) => s.session_id === OTHER)
    // three separate leaks, so three separate verdicts
    await t.test('someone else\'s row: no percentage, no window clock, no wall clock', () => {
      assert.equal(notTheirs.hidden, true)
      assert.equal(notTheirs.limits ?? null, null, 'a redacted row carries the owner\'s window percentages')
      assert.equal(notTheirs.warning?.pct ?? null, null, 'a redacted row carries the owner\'s near-wall percentage')
      assert.equal(notTheirs.warning?.resets_at ?? null, null, 'a redacted row carries the owner\'s reset clock')
      assert.equal(notTheirs.limit?.resets_at ?? null, null, 'a redacted row carries the owner\'s wall clock')
      assert.equal(notTheirs.all_out ?? null, null, 'a redacted row carries the owner\'s all-out reset list')
    })
    await t.test('the guest\'s own row: theirs to read, but the login is this machine\'s', () => {
      for (const field of ['limits', 'all_out', 'usage_source']) {
        assert.equal(field in own, false, `a guest's own row carries ${field}, measured from this machine's login`)
      }
      // the band, never the figure or the clock
      assert.deepEqual(own.warning, { window: '5h' }, `a guest's own row carries ${JSON.stringify(own.warning)}`)
      assert.equal(own.waiting.type, 'reset', 'the guest still learns their terminal is waiting for a reset')
      assert.equal(own.waiting.resets_at ?? null, null, 'but not the clock it is waiting on')
    })
    await t.test('a picker row that can be pressed says nothing against itself', () => {
      // the reserve is a note for a human press, not a refusal, and
      // generalising that note contradicts the button beside it
      for (const row of own.handoff_targets ?? []) {
        if (row.available) assert.equal(row.reason, null, `a guest's picker row is available and says "${row.reason}"`)
      }
      const claudeRow = (own.handoff_targets ?? []).find((x) => x.agent === 'claude' && x.model === 'opus')
      assert.ok(claudeRow, 'the claude/opus rung is on sam\'s picker')
      assert.equal(claudeRow.available, true, 'a human press ignores the reserve, so the row is pickable')
    })
    await t.test('a picker row carries no cost word', () => {
      for (const row of own.handoff_targets ?? []) {
        assert.equal('cost' in row, false, `a guest's picker row carries a cost word (${row.agent}/${row.model ?? '-'}), which is computed from the owner's extra_usage`)
      }
    })
    await t.test('and none of the clocks anywhere in the bytes', () => {
      for (const [what, epoch] of [['the near-wall reset', warnResets], ['the all-out reset', allOutResets], ['the wall reset', limitResets]]) {
        assert.equal(carries(guest.text, String(epoch)), false, `a guest board carries ${what} (${epoch})`)
      }
      assertClean(guest, 'guest GET /api/sessions with usage on the record', { presented: TOKENS.sam })
    })
  } finally {
    rmSync(usageFile, { force: true })
    if (hadPrefs === null) rmSync(prefsFile, { force: true })
    else writeFileSync(prefsFile, hadPrefs)
    updateSession(OTHER, { handoff_ladder: null, handoff_order: null, waiting: null, limits: null, warning: null, usage_source: null })
    updateSession(OWNED, { all_out: null, warning: null })
  }
})

test('the pipeline trunk is pipeline data: a guest is refused there too', async () => {
  // /api/trunk is the landed events of the owner's cards. The guard above it
  // lists cards, floor, presets, adapters and leases — not trunk.
  const r = await request(wanBase, '/api/trunk', { token: TOKENS.sam })
  assert.equal(r.status, 403, `a guest reached /api/trunk (${r.status}): ${String(r.text).slice(0, 300)}`)
  assertClean(r, 'guest GET /api/trunk', { presented: TOKENS.sam })
})

// ---- 4. a rotated token and a removed one ---------------------------------
test('a rotated link and a removed human: the old token stops working everywhere', async () => {
  STALE.sam = TOKENS.sam
  const rotated = share.rotate('sam', SHARE)
  TOKENS.sam = rotated.token
  STALE.kim = TOKENS.kim
  share.removePerson('kim', SHARE)
  assert.equal(share.identify(SHARE, STALE.sam), null)
  assert.equal(share.identify(SHARE, STALE.kim), null)
  // wanBase and openBase both hold the live SHARE object (not a snapshot), so
  // they see the rotate (in place) and the remove (people reassigned); a stale
  // token is always presented, so loopback_owner never grants and the refusal
  // is real.
  for (const [who, token] of [['sam (rotated)', STALE.sam], ['kim (removed)', STALE.kim]]) {
    for (const [method, path] of apiRoutes()) {
      const r = await request(wanBase, path, { method, token })
      assert.equal(r.status, 401, `${who}: ${method} ${path}`)
      assertClean(r, `${who}: ${method} ${path}`, { presented: token })
    }
    assert.equal((await sseCollect(wanBase, token, { ms: 50 })).status, 401, `${who}: SSE`)
  }
  // the new link works, on the board that was already running
  assert.equal((await request(wanBase, '/api/sessions', { token: TOKENS.sam })).status, 200)
  assert.notEqual(share.hashToken(STALE.sam), share.hashToken(TOKENS.sam))
})

// ---- 5. static pages -------------------------------------------------------
test('the board page itself carries no data, and no path escapes the board directory', async () => {
  for (const path of STATIC) {
    const r = await request(wanBase, path)
    assert.ok([200, 404].includes(r.status), `${path} → ${r.status}`)
    assertClean(r, `static ${path}`)
  }
  for (const path of ['/../share.json', '/..%2f..%2fshare.json', '/%2e%2e/%2e%2e/share.json', '/board/../../share.json', '/../../package.json']) {
    const r = await request(wanBase, path)
    assert.equal(r.status, 404, `${path} should not be served`)
    assert.equal(carries(r.text, 'token_sha256'), false, `${path} served share.json`)
  }
})

// ---- 6. SSE ----------------------------------------------------------------
test('SSE: a guest\'s stream carries their own board on the hello frame and on every push', async () => {
  const guest = await sseCollect(wanBase, TOKENS.sam, {
    ms: 1600,
    whileOpen: async () => {
      updateSession(OWNED, { turns: 4, files_touched: [C.file, 'CANARY-FILE-second.md'] })
      await sleep(400)
      appendEvent(OWNED, { type: 'turn', summary: C.event })
    },
  })
  assert.equal(guest.status, 200)
  assert.ok(guest.frames.length >= 2, `expected a hello and at least one push, got [${guest.frames.map((f) => f.event).join(',')}]`)
  const hello = guest.frames[0]
  assert.equal(hello.event, 'hello')
  assert.deepEqual(JSON.parse(hello.text).cards, [], 'no pipeline cards in a guest hello')
  for (const f of guest.frames) assertClean({ text: f.text }, `SSE frame ${f.event}`, { presented: TOKENS.sam })
  const owner = await sseCollect(openBase, null, { ms: 200 })
  assert.ok(carries(owner.frames[0].text, C.task), 'the owner\'s own stream still carries their terminal')
})

// the guest and the owner are on the same board here: a broadcast only reaches
// the clients of the server that made it.
test('SSE: a card the owner creates is not pushed down a guest\'s stream', async () => {
  let created = null
  const guest = await sseCollect(openBase, TOKENS.sam, {
    ms: 1200,
    whileOpen: async () => {
      // its own slug: a card id is <date>-<minute>-<slug>, so two cards from one
      // task in the same minute collide
      created = await request(openBase, '/api/cards', { method: 'POST', body: { repo: wesRepo, slug: 'canary-second', task: `${C.cardTask}, second card`, title: C.cardTitle, chain: 'claude' } })
    },
  })
  assert.equal(created.status, 201, `the owner created a card: ${String(created.text).slice(0, 300)}`)
  const cardFrames = guest.frames.filter((f) => ['card', 'event', 'removed'].includes(f.event))
  for (const f of cardFrames) assertClean({ text: f.text }, `SSE ${f.event} frame pushed to a guest`, { presented: TOKENS.sam })
  assert.deepEqual(cardFrames.map((f) => f.event), [], `a guest's stream carried ${cardFrames.length} pipeline frame(s): ${cardFrames.map((f) => f.text.slice(0, 200)).join(' | ')}`)
})

// ---- 7. per-human identity on a hand-off -----------------------------------
test('a hand-off a guest asked for and the owner approved names both humans, and never "local"', async () => {
  const asked = await request(wanBase, `/api/sessions/${OWNED}/request-handoff`, { method: 'POST', token: TOKENS.sam })
  assert.equal(asked.status, 202)
  const pending = readRequests(OWNED).filter((r) => r.state === 'pending').map((r) => r.by)
  assert.ok(pending.includes('sam'), `sam's ask is pending (pending: ${pending})`)
  // observed here: kim asked during the sweep and was then taken off the board,
  // and kim's request is still pending — requests.json is not pruned when a
  // human loses their link. Reported as a finding, not asserted away.
  assert.ok(pending.length >= 1)
  const ok = await request(wanBase, `/api/sessions/${OWNED}/requests/sam/approve`, { method: 'POST', token: TOKENS.wes })
  assert.equal(ok.status, 200, String(ok.text).slice(0, 200))

  const control = JSON.parse(readFileSync(join(sessionDir(OWNED), 'control.json'), 'utf8'))
  assert.equal(control.handoff, true)
  assert.equal(control.by, 'wes for sam', 'the runner is told who approved and who for')
  // src/attach.mjs:280 writes `hand off requested from the board by ${ctl.by}`
  const runnerLine = `hand off requested from the board by ${control.by}`
  assert.match(runnerLine, /wes/)
  assert.match(runnerLine, /sam/)

  const evs = readFileSync(join(sessionDir(OWNED), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const named = evs.filter((e) => e.by)
  assert.ok(named.some((e) => e.type === 'handoff_requested' && e.by === 'sam'), 'the ask is on the trail under sam')
  assert.ok(named.some((e) => e.by === 'wes' && /sam/.test(e.summary)), 'the approval is on the trail under wes and names sam')
  for (const e of named) assert.notEqual(e.by, 'local', `event ${e.type} was filed as "local" while share is on`)
  const answered = readRequests(OWNED).find((r) => r.by === 'sam' && r.state === 'approved')
  assert.equal(answered.answered_by, 'wes')
})

// ---- 8. the rate limit and the guess lockout -------------------------------
test('one client cannot flood the board: 429 with a Retry-After past 30 a minute', async () => {
  let first429 = -1
  let last = null
  for (let i = 0; i < 40; i++) {
    last = await request(floodBase, '/api/health', { token: TOKENS.sam })
    if (last.status === 429) { first429 = i; break }
  }
  assert.equal(first429, 30, `the 31st request in the window is the first 429 (got the ${first429 + 1}th)`)
  assert.match(last.json.error, /rate limit/)
  assert.ok(Number(last.headers['retry-after']) >= 1, 'Retry-After in seconds')
  assertClean(last, 'rate limited', { presented: TOKENS.sam })
})

test('a token cannot be guessed at speed: six bad ones lock the address out, right token included', async () => {
  for (let i = 0; i < 6; i++) {
    const r = await request(floodBase, '/api/sessions', { token: `guess-${i}-${share.newToken()}` })
    assert.equal(r.status, 401, `guess ${i}`)
  }
  const right = await request(floodBase, '/api/sessions', { token: TOKENS.wes })
  assert.equal(right.status, 429, 'the right token waits out the lockout too')
  assert.match(right.json.error, /too many bad tokens/)
  assert.ok(Number(right.headers['retry-after']) >= 1)
  assertClean(right, 'locked out', { presented: TOKENS.wes })
})

test('a board page that has not been given a token yet is not an attacker', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await request(guessesBase, '/api/sessions')
    assert.equal(r.status, 401, `no-token request ${i}`)
  }
  const right = await request(guessesBase, '/api/sessions', { token: TOKENS.wes })
  assert.equal(right.status, 200, 'ten requests with no token at all did not count as ten guesses')
})

// ---- 9. no token in anything that gets written down ------------------------
test('baton share prints a token for on, add and rotate, and never for status, rm or off', () => {
  const home = makeHome()
  const env = testEnv(home, { BATON_NO_BOARD: '1', BATON_NO_OPEN: '1', BATON_PORT: '4999' })
  const shareFile = () => readFileSync(join(home, 'share.json'), 'utf8')
  const tokenIn = (text) => /token=([\w-]+)/.exec(text)?.[1] ?? null

  const off = baton(['share'], env)
  assert.equal(tokenIn(off), null, 'share status with share off prints no token')
  const on = baton(['share', 'on', '--bind', '127.0.0.1', '--port', '4999', '--owner', 'wes'], env)
  const wesTok = tokenIn(on)
  assert.ok(wesTok, 'share on prints the owner link once')
  const added = baton(['share', 'add', 'sam'], env)
  const samTok = tokenIn(added)
  assert.ok(samTok)
  assert.equal(added.includes(wesTok), false, 'add never reprints another link')

  const status = baton(['share'], env)
  assert.equal(tokenIn(status), null, 'status prints no link')
  for (const [who, tok] of [['wes', wesTok], ['sam', samTok]]) {
    assert.equal(status.includes(tok), false, `status reprinted ${who}'s token`)
    assert.equal(shareFile().includes(tok), false, `share.json stored ${who}'s token instead of its hash`)
    assert.equal(shareFile().includes(share.hashToken(tok)), true, `share.json keeps ${who}'s hash`)
  }
  const rotated = baton(['share', 'rotate', 'sam'], env)
  const newTok = tokenIn(rotated)
  assert.ok(newTok && newTok !== samTok)
  assert.equal(rotated.includes(samTok), false, 'rotate never reprints the token it replaced')

  const removed = baton(['share', 'rm', 'sam'], env)
  assert.equal(tokenIn(removed), null, 'rm prints no token')
  for (const tok of [newTok, samTok, wesTok]) assert.equal(removed.includes(tok), false, 'rm reprinted a token')
  const offAgain = baton(['share', 'off'], env)
  assert.equal(tokenIn(offAgain), null, 'off prints no token')
  assert.equal(offAgain.includes(wesTok), false, 'off reprinted the owner token')
})

// ---- 10. share off is the default and it is airtight -----------------------
test('with no share.json the board is loopback-only and refuses any other address', async () => {
  const fresh = makeHome()
  const prev = process.env.BATON_HOME
  process.env.BATON_HOME = fresh
  delete process.env.BATON_BIND
  delete process.env.BATON_TOKEN
  try {
    assert.equal(existsSync(join(fresh, 'share.json')), false, 'share is off until someone turns it on')
    assert.equal(share.isOn(share.readShare()), false)
    const local = createBoardServer({ scheduler: false })
    assert.equal(local.bind, '127.0.0.1', 'the default bind is loopback')

    process.env.BATON_BIND = WAN
    assert.throws(() => createBoardServer({ scheduler: false }), (err) => err.name === 'BindRefused' && err.exitCode === 3, 'a non-loopback bind with no token is refused')

    // share.json written but off, with people and an address still in it
    writeFileSync(join(fresh, 'share.json'), JSON.stringify({ ...SHARE, on: false, bind: WAN }))
    assert.equal(share.isOn(share.readShare()), false, 'off with people in the file is still off')
    assert.throws(() => createBoardServer({ scheduler: false }), (err) => err.name === 'BindRefused', 'off does not guard a shared bind')
    delete process.env.BATON_BIND
    const afterOff = createBoardServer({ scheduler: false })
    assert.equal(afterOff.bind, '127.0.0.1', 'off puts the board back on loopback whatever share.json says')

    // on, but with nobody to let in, or nowhere to bind, is not on
    process.env.BATON_BIND = WAN
    writeFileSync(join(fresh, 'share.json'), JSON.stringify({ ...SHARE, on: true, bind: WAN, people: [] }))
    assert.throws(() => createBoardServer({ scheduler: false }), (err) => err.name === 'BindRefused', 'on with nobody to let in is refused')
    writeFileSync(join(fresh, 'share.json'), JSON.stringify({ ...SHARE, on: true, bind: null }))
    assert.throws(() => createBoardServer({ scheduler: false }), (err) => err.name === 'BindRefused', 'on with nowhere to bind is refused')
    delete process.env.BATON_BIND

    // and a board that is off is a single-player board: loopback, no names
    const srv = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: { ...share.OFF } })
    const { port } = await srv.start()
    try {
      const base = `http://127.0.0.1:${port}`
      const r = await request(base, '/api/sessions')
      assert.equal(r.status, 200, 'loopback with share off needs no token')
      assert.equal(r.json.share.on, false)
      assert.equal(r.json.you.name, 'local')
      const stale = await request(base, '/api/sessions', { token: STALE.sam ?? 'anything' })
      assert.equal(stale.json.you.name, 'local', 'with share off a personal token is simply ignored')
    } finally { await srv.stop() }
  } finally {
    delete process.env.BATON_BIND
    process.env.BATON_HOME = prev
  }
})

// ---- 11. the logs ----------------------------------------------------------
test('no token, and no token hash, reaches the board\'s own output', () => {
  const printed = PRINTED.join('')
  assert.ok(printed.includes('[board]'), `the board logged nothing to check (BATON_QUIET=${process.env.BATON_QUIET ?? 'unset'})`)
  const boardLines = printed.split('\n').filter((l) => l.includes('[board]'))
  assert.ok(boardLines.length >= 5, `only ${boardLines.length} board lines were captured`)
  for (const [name, tok] of Object.entries({ ...TOKENS, ...STALE })) {
    if (!tok) continue
    assert.equal(printed.includes(tok), false, `${name}'s token was printed`)
    assert.equal(printed.includes(share.hashToken(tok)), false, `${name}'s token hash was printed`)
  }
  assert.equal(/token=[\w-]{10,}/.test(printed), false, 'a link with a token was printed')
  // the sweep sent hundreds of tokens: the count is the proof the check had work to do
  assert.ok(printed.length > 1000, `only ${printed.length} bytes of output were captured`)
})
