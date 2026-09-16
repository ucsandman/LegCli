// The resume pointer cannot describe a picture that is no longer true.
// Every resume file carries a stamp of the git state it was written against;
// freshness is recomputed from git at READ time, never remembered at write
// time, so a file cannot lie about HEAD to a reader who re-asks git.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, git, BATON, ROOT } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'

const sessions = await import('../src/sessions.mjs')
const resume = await import('../src/resume.mjs')
const detail = await import('../src/session-detail.mjs')

// `leg <args>` from inside a checkout, never throwing: the exit code is the
// thing under test.
function batonIn(cwd, args, extra = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BATON, ...args], { cwd, env: testEnv(HOME, extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

function commit(repo, name, body) {
  writeFileSync(join(repo, name), body)
  git(repo, ['add', name])
  git(repo, ['commit', '-q', '-m', `add ${name}`])
}

// a live session record in `repo`, with the fields the pointer reads
function liveSession(id, repo, { agent = 'claude', status = 'running', task = 'ship the thing' } = {}) {
  sessions.createSession({ id, agent, cwd: repo, repo, owner: 'wes' })
  sessions.updateSession(id, { status, task })
  return sessions.readSession(id)
}

// ---- part 1: the stamp ----

test('every resume file carries a stamp of the git state it was written against', () => {
  const repo = initRepo('resume-stamp-')
  const s = liveSession('s-stamp-1', repo)
  const body = resume.writeHandoffPointer(s, '# Leg handoff\n\nthe previous agent said things.\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })

  const file = resume.resumeFile(repo)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith(resume.STAMP_PREFIX), `RESUME.md starts with the stamp, got: ${text.slice(0, 60)}`)
  assert.ok(text.includes('the previous agent said things.'), 'the body survives the stamp')
  assert.equal(body, text, 'writeHandoffPointer returns exactly what it wrote')

  const perSession = resume.perSessionFile(repo, 's-stamp-1')
  assert.ok(existsSync(perSession), 'the per-session file is written too')
  assert.ok(readFileSync(perSession, 'utf8').startsWith(resume.STAMP_PREFIX), 'and it is stamped as well')

  const stamp = resume.readStamp(text)
  assert.equal(stamp.v, 1)
  assert.equal(stamp.kind, 'handoff')
  assert.equal(stamp.session, 's-stamp-1')
  assert.equal(stamp.bundle, 'b-1')
  assert.equal(stamp.branch, 'main')
  assert.equal(stamp.head, git(repo, ['rev-parse', 'HEAD']).trim(), 'the stamp records the commit it was written at')
  assert.match(stamp.written_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('the stamp carries a dirty count and a hash, never the file names', () => {
  const repo = initRepo('resume-dirty-')
  writeFileSync(join(repo, 'SECRET-PLAN.md'), 'do not leak my name\n')
  writeFileSync(join(repo, 'another-private-file.txt'), 'nor mine\n')
  const s = liveSession('s-stamp-2', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: null, why: 'handoff requested' })

  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  const line = text.split('\n')[0]
  const stamp = resume.readStamp(text)
  assert.equal(stamp.dirty.count, 2, 'two untracked files counted')
  assert.match(stamp.dirty.hash, /^[0-9a-f]{12}$/, 'a short hex fingerprint, not a list')
  assert.ok(!line.includes('SECRET-PLAN'), 'the stamp never names a file')
  assert.ok(!line.includes('another-private-file'), 'not even the second one')
})

test('re-stamping replaces the old stamp instead of stacking a second one', () => {
  const repo = initRepo('resume-restamp-')
  const s = liveSession('s-stamp-3', repo)
  resume.writeHandoffPointer(s, 'first\n', { bundle: null, why: 'one' })
  resume.writeHandoffPointer(s, 'second\n', { bundle: null, why: 'two' })
  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.equal(text.split(resume.STAMP_PREFIX).length - 1, 1, 'exactly one stamp')
  assert.equal(resume.readStamp(text).why, 'two')
})

// ---- part 3's engine: the verdict, recomputed from git at read time ----

test('a stamped pointer on the tree it was written against reads fresh', () => {
  const repo = initRepo('resume-fresh-')
  const s = liveSession('s-fresh-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })

  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'fresh', v.reasons.join('; '))
  assert.equal(v.exit_code, 0)
  assert.equal(v.kind, 'handoff')
  assert.equal(v.head.moved, false)
  assert.equal(v.dirty.changed, false)
  assert.equal(v.session.active, true)
})

test('a stamped pointer whose HEAD moved reads stale and says how many commits landed', () => {
  const repo = initRepo('resume-headmoved-')
  const s = liveSession('s-stale-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })
  const at = resume.resumeVerdict(repo).head.then

  commit(repo, 'one.txt', '1\n')
  commit(repo, 'two.txt', '2\n')

  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'stale')
  assert.equal(v.exit_code, 1)
  assert.equal(v.head.moved, true)
  assert.equal(v.head.then, at, 'the stamp still remembers where it was written')
  assert.notEqual(v.head.now, at)
  assert.equal(v.head.commits_since, 2)
  assert.ok(v.reasons.some((r) => /2 commits/.test(r)), `a reason names the commits: ${v.reasons.join('; ')}`)
})

test('the working tree changing since the write makes the pointer stale', () => {
  const repo = initRepo('resume-treemoved-')
  const s = liveSession('s-stale-2', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })
  assert.equal(resume.resumeVerdict(repo).state, 'fresh')

  writeFileSync(join(repo, 'edited.txt'), 'changed after the handoff\n')

  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'stale')
  assert.equal(v.dirty.changed, true)
  assert.equal(v.head.moved, false, 'no commit landed; only the tree moved')
  assert.ok(v.reasons.some((r) => /working tree/i.test(r)), v.reasons.join('; '))
})

test('Leg\'s own files moving does not make a pointer stale', () => {
  const repo = initRepo('resume-selfdirty-')
  const s = liveSession('s-self-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })
  // writing the pointer itself dirties .leg/ or .baton/; a reader must not see that as drift
  const legDir = existsSync(join(repo, '.leg')) ? join(repo, '.leg') : join(repo, '.baton')
  writeFileSync(join(legDir, 'session-s-self-1.md'), 'notes\n')
  assert.equal(resume.resumeVerdict(repo).state, 'fresh', 'the .leg/.baton directory is excluded from the fingerprint')
})

test('a handoff pointer whose terminal is no longer live reads stale', () => {
  const repo = initRepo('resume-dead-')
  const s = liveSession('s-dead-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-1' }, why: 'claude usage limit' })
  assert.equal(resume.resumeVerdict(repo).state, 'fresh')

  sessions.updateSession('s-dead-1', { status: 'lost' })

  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'stale')
  assert.equal(v.session.active, false)
  assert.ok(v.reasons.some((r) => /no longer live|is lost/i.test(r)), v.reasons.join('; '))
})

test('an unstamped RESUME.md is never reported fresh', () => {
  const repo = initRepo('resume-unstamped-')
  mkdirSync(join(repo, '.baton'), { recursive: true })
  writeFileSync(resume.resumeFile(repo), '# Baton handoff\n\nwritten by an older Baton, or by hand.\n')

  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'unstamped')
  assert.equal(v.exit_code, 1)
  assert.equal(v.stamp, null)
  assert.ok(v.reasons.some((r) => /cannot be checked|no stamp/i.test(r)), v.reasons.join('; '))
})

test('no pointer at all is missing, not stale', () => {
  const repo = initRepo('resume-none-')
  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'missing')
  assert.equal(v.exit_code, 3)
  assert.equal(v.stamp, null)
})

// ---- part 2: Leg owns RESUME.md ----

test('a session that ends rewrites RESUME.md to "nothing in flight", naming the last handoff and its date', () => {
  const repo = initRepo('resume-ended-')
  const s = liveSession('s-end-1', repo)
  resume.writeHandoffPointer(s, '# Leg handoff\n\nclaude ran out; codex took over.\n', { bundle: { id: 'b-end-1' }, why: 'claude usage limit' })
  sessions.updateSession('s-end-1', { lineage: { from: 'claude', to: 'codex' }, bundle: { id: 'b-end-1', updated_at: '2026-09-14T23:20:11.000Z' }, handoff: { reason: 'claude usage limit', at: '2026-09-14T23:20:11.000Z' } })

  resume.endSessionPointer(sessions.readSession('s-end-1'))

  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(/nothing in flight/i.test(text), `the pointer says nothing is in flight:\n${text}`)
  assert.ok(!/claude ran out; codex took over/.test(text), 'the old handoff body is gone, not left sitting there')
  assert.ok(text.includes('claude'), 'it still names the agents of the last handoff')
  assert.ok(text.includes('codex'))
  assert.ok(text.includes('2026-09-14'), 'and the date of that handoff')
  assert.ok(text.includes('RESUME-s-end-1.md'), 'and where the full text still lives')

  const stamp = resume.readStamp(text)
  assert.equal(stamp.kind, 'idle')
  assert.equal(stamp.session, null, 'an idle pointer names no live session')
})

test('an idle pointer survives a commit but goes stale the moment a terminal starts', () => {
  const repo = initRepo('resume-idle-')
  resume.writeIdlePointer(repo)
  assert.equal(resume.resumeVerdict(repo).state, 'fresh')

  commit(repo, 'later.txt', 'the human kept working\n')
  const afterCommit = resume.resumeVerdict(repo)
  assert.equal(afterCommit.state, 'fresh', 'it claims nothing about the tree, so the tree moving cannot falsify it')
  assert.equal(afterCommit.kind, 'idle')

  liveSession('s-idle-1', repo)
  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'stale')
  assert.ok(v.reasons.some((r) => /s-idle-1/.test(r)), `the reason names the terminal: ${v.reasons.join('; ')}`)
})

test('a checkout that never had a session gets a pointer that says so, not an old handoff', () => {
  const repo = initRepo('resume-never-')
  resume.writeIdlePointer(repo)
  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(/nothing in flight/i.test(text))
  assert.ok(/no hand-off/i.test(text), `it says there was never a handoff here:\n${text}`)
  assert.equal(resume.readStamp(text).kind, 'idle')
})

test('a checkpoint bundle is not called a hand-off, and a file that was never written is not named', () => {
  const repo = initRepo('resume-checkpoint-')
  liveSession('s-ckpt-1', repo)
  // a bundle with no lineage.to: the session checkpointed, it never handed off
  sessions.updateSession('s-ckpt-1', { bundle: { id: 'b-ckpt', updated_at: '2026-09-14T23:36:00.000Z' }, status: 'ended' })

  resume.writeIdlePointer(repo)

  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(/no agent handed off/.test(text), `a checkpoint is not a hand-off:
${text}`)
  assert.ok(/checkpoint from terminal s-ckpt-1/.test(text), 'it says what it actually was')
  assert.ok(text.includes('b-ckpt'), 'and names the bundle')
  assert.ok(!/RESUME-s-ckpt-1\.md/.test(text), 'no per-session file was written, so none is named')
})

test('two live sessions in one checkout: RESUME.md names which one it describes and points at the other', () => {
  const repo = initRepo('resume-two-')
  const a = liveSession('s-two-a', repo, { agent: 'claude' })
  liveSession('s-two-b', repo, { agent: 'codex' })

  resume.writeHandoffPointer(sessions.readSession('s-two-a'), '# Leg handoff\n\nbody\n', { bundle: { id: 'b-two' }, why: 'claude usage limit' })

  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(text.includes('s-two-a'), `RESUME.md names the session it describes:\n${text.slice(0, 900)}`)
  assert.ok(text.includes('s-two-b'), 'and says the other terminal is live here too')
  assert.ok(text.includes('RESUME-s-two-b.md'), 'and where that one\'s own handoff would be')
  assert.equal(resume.readStamp(text).session, a.session_id)
})

test('board start rewrites a pointer left behind by a terminal that is no longer live', () => {
  const repo = initRepo('resume-refresh-')
  const s = liveSession('s-refresh-1', repo)
  resume.writeHandoffPointer(s, '# Leg handoff\n\nlooks live, is not.\n', { bundle: { id: 'b-r' }, why: 'claude usage limit' })
  sessions.updateSession('s-refresh-1', { status: 'lost', lineage: { from: 'claude', to: 'codex' } })
  assert.equal(resume.resumeVerdict(repo).state, 'stale', 'before the board starts, the pointer still describes a dead terminal')

  const touched = resume.refreshPointers()

  assert.ok(touched.some((t) => t.toLowerCase() === repo.toLowerCase()), `the refresh touched ${repo}, got ${touched.join(', ')}`)
  const v = resume.resumeVerdict(repo)
  assert.equal(v.state, 'fresh')
  assert.equal(v.kind, 'idle')
  assert.ok(/nothing in flight/i.test(readFileSync(resume.resumeFile(repo), 'utf8')))
})

test('board start replaces an unstamped pointer even while another terminal is live', () => {
  // the case that started this: RESUME.md was three days old and hand-written,
  // a different terminal was live in the checkout, and nothing rewrote it
  const repo = initRepo('resume-refresh-other-')
  mkdirSync(join(repo, '.baton'), { recursive: true })
  writeFileSync(resume.resumeFile(repo), '# Leg resume pointer\n\nwritten by hand three days ago.\n')
  liveSession('s-refresh-3', repo, { agent: 'codex' })

  const touched = resume.refreshPointers()

  assert.ok(touched.some((t) => t.toLowerCase() === repo.toLowerCase()), `the refresh touched ${repo}`)
  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(!/three days ago/.test(text), 'the hand-written text is gone')
  assert.ok(text.includes('s-refresh-3'), `and the new pointer names the terminal that IS live:
${text}`)
  assert.equal(resume.resumeVerdict(repo).state, 'fresh')
})

test('board start leaves a live terminal\'s pointer alone', () => {
  const repo = initRepo('resume-refresh-live-')
  const s = liveSession('s-refresh-2', repo)
  resume.writeHandoffPointer(s, '# Leg handoff\n\nreally live.\n', { bundle: { id: 'b-r2' }, why: 'claude usage limit' })

  resume.refreshPointers()

  const text = readFileSync(resume.resumeFile(repo), 'utf8')
  assert.ok(text.includes('really live.'), 'the live handoff body is not clobbered')
  assert.equal(resume.readStamp(text).kind, 'handoff')
})

test('a pointer is found from a subdirectory, the way an agent starting deeper in the tree would', () => {
  const repo = initRepo('resume-sub-')
  const s = liveSession('s-sub-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: null, why: 'handoff requested' })
  const deep = join(repo, 'src', 'board')
  mkdirSync(deep, { recursive: true })

  const found = resume.findResume(deep)
  assert.ok(found, 'walked up to the checkout')
  assert.equal(found.root.toLowerCase(), repo.toLowerCase())
  assert.equal(resume.resumeVerdict(deep).state, 'fresh', 'and the verdict works from there too')
})

// ---- part 3: the CLI ----

test('baton resume --check exits 0 on a fresh pointer and 1 on a stale one', () => {
  const repo = initRepo('resume-cli-check-')
  const s = liveSession('s-cli-1', repo)
  resume.writeHandoffPointer(s, '# Leg handoff\n\nbody\n', { bundle: { id: 'b-cli' }, why: 'claude usage limit' })

  const fresh = batonIn(repo, ['resume', '--check'])
  assert.equal(fresh.status, 0, `${fresh.stdout}${fresh.stderr}`)
  assert.match(fresh.stdout, /current/i)

  commit(repo, 'moved.txt', 'the tree moved on\n')

  const stale = batonIn(repo, ['resume', '--check'])
  assert.equal(stale.status, 1, `stale must exit non-zero: ${stale.stdout}${stale.stderr}`)
  assert.match(stale.stdout + stale.stderr, /stale/i)
  assert.match(stale.stdout + stale.stderr, /1 commit/)
})

test('baton resume prints the pointer, with a loud banner and a non-zero exit when it is stale', () => {
  const repo = initRepo('resume-cli-print-')
  const s = liveSession('s-cli-2', repo)
  resume.writeHandoffPointer(s, '# Leg handoff\n\nTHE-BODY-MARKER\n', { bundle: { id: 'b-cli2' }, why: 'claude usage limit' })

  const ok = batonIn(repo, ['resume'])
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /THE-BODY-MARKER/, 'a fresh pointer prints its body')
  assert.ok(!ok.stdout.startsWith(resume.STAMP_PREFIX), 'the stamp is not printed at the human')

  commit(repo, 'moved.txt', 'moved\n')

  const stale = batonIn(repo, ['resume'])
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /STALE/, 'the banner is loud')
  assert.match(stale.stdout, /THE-BODY-MARKER/, 'but a stale pointer is still better than nothing, so it still prints')
})

test('baton resume --json carries the verdict a script can key on', () => {
  const repo = initRepo('resume-cli-json-')
  const s = liveSession('s-cli-3', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-cli3' }, why: 'claude usage limit' })
  commit(repo, 'moved.txt', 'moved\n')

  const r = batonIn(repo, ['resume', '--check', '--json'])
  assert.equal(r.status, 1)
  const v = JSON.parse(r.stdout)
  assert.equal(v.state, 'stale')
  assert.equal(v.head.moved, true)
  assert.equal(v.kind, 'handoff')
  assert.ok(Array.isArray(v.reasons) && v.reasons.length)
})

test('baton resume in a checkout with no pointer says so and exits 3', () => {
  const repo = initRepo('resume-cli-none-')
  const r = batonIn(repo, ['resume', '--check'])
  assert.equal(r.status, 3)
  assert.match(r.stdout + r.stderr, /no resume pointer/i)
})

test('baton resume --path checks a checkout other than the one you are standing in', () => {
  const repo = initRepo('resume-cli-path-')
  const s = liveSession('s-cli-4', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: null, why: 'handoff requested' })
  const elsewhere = initRepo('resume-cli-elsewhere-')

  const r = batonIn(elsewhere, ['resume', '--check', '--path', repo])
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})

// ---- part 4: the board drawer ----

test('the drawer payload carries the same verdict the CLI prints', () => {
  const repo = initRepo('resume-drawer-')
  const s = liveSession('s-drawer-1', repo)
  resume.writeHandoffPointer(s, 'body\n', { bundle: { id: 'b-drawer' }, why: 'claude usage limit' })

  const fresh = detail.sessionDetail(sessions.readSession('s-drawer-1'))
  assert.equal(fresh.resume.state, 'fresh')
  assert.equal(fresh.resume.kind, 'handoff')
  assert.equal(typeof fresh.resume.summary, 'string')
  assert.ok(fresh.resume.summary.length, 'the drawer gets one line it can render as-is')

  commit(repo, 'moved.txt', 'moved\n')

  const stale = detail.sessionDetail(sessions.readSession('s-drawer-1'))
  assert.equal(stale.resume.state, 'stale')
  assert.match(stale.resume.summary, /1 commit/)
  assert.equal(stale.resume.file, undefined, 'the drawer payload carries no local paths')
})

test('the drawer renders the verdict beside the bundle line (source-level)', () => {
  const body = readFileSync(join(ROOT, 'src', 'board', 'sessions.js'), 'utf8')
  assert.match(body, /function resumeLine\(v\)/, 'the drawer has a verdict renderer')
  assert.match(body, /if \(d && d\.resume\) next\.appendChild\(resumeLine\(d\.resume\)\)/, 'and it is appended inside "What happens next"')
  assert.match(body, /RESUME\.md is stale/, 'the stale wording reaches the human, not just the exit code')
})
