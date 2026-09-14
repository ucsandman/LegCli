// What a terminal card's drawer shows: the agent's last messages, the files it
// changed with one file's diff, and the events already recorded. Everything
// here is the operator's own terminal; another human's is refused upstream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, initRepo } from './helpers.mjs'

const HOME = makeHome()
process.env.BATON_HOME = HOME
process.env.BATON_QUIET = '1'
process.env.BATON_RATE_MAX = '5000'
process.env.BATON_RATE_MAX_FAILURES = '5000'

const sessions = await import('../src/sessions.mjs')
const share = await import('../src/share.mjs')
const detail = await import('../src/session-detail.mjs')
const { createBoardServer } = await import('../src/server.mjs')

// built, never written out: a literal key in a tracked file is the thing the
// scrubber exists to stop
const FAKE_KEY = 'sk-ant-' + 'api03-' + 'A'.repeat(48)

async function api(base, path, { token } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(base + path, { method: 'GET', headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolvePromise({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function claudeTranscript(path, lines) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

test('messages carry role, text and time, and a key the agent echoed never leaves the machine', () => {
  const repo = initRepo('detail-messages-')
  const transcript = join(repo, 'transcript.jsonl')
  claudeTranscript(transcript, [
    { type: 'user', timestamp: '2026-09-14T21:10:00.000Z', message: { role: 'user', content: '<system-reminder>ignored</system-reminder>' } },
    { type: 'user', timestamp: '2026-09-14T21:10:01.000Z', message: { role: 'user', content: 'ship everything' } },
    { type: 'assistant', timestamp: '2026-09-14T21:11:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `the key is ${FAKE_KEY}` }] } },
  ])
  const s = sessions.createSession({ id: 's-detail-msg', agent: 'claude', cwd: repo, repo, owner: 'wes' })
  sessions.updateSession(s.session_id, { transcript_path: transcript })

  const messages = detail.sessionMessages(sessions.readSession(s.session_id))
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'], 'injected reminders are not turns')
  assert.equal(messages[0].text, 'ship everything')
  assert.equal(messages[0].ts, '2026-09-14T21:10:01.000Z')
  assert.match(messages[1].text, /\[REDACTED\]/)
  assert.ok(!messages[1].text.includes(FAKE_KEY), 'the transcript is scrubbed before it leaves the server')

  sessions.updateSession(s.session_id, { transcript_path: join(repo, 'gone.jsonl') })
  assert.deepEqual(detail.sessionMessages(sessions.readSession(s.session_id)), [], 'a transcript that is gone is empty, not an error')

  const agy = sessions.createSession({ id: 's-detail-agy', agent: 'agy', cwd: repo, repo, owner: 'wes' })
  assert.deepEqual(detail.sessionMessages(sessions.readSession(agy.session_id)), [], 'agy exposes no transcript')
})

test('files carry their line counts, and a diff is only ever read from inside the session own tree', () => {
  const repo = initRepo('detail-files-')
  writeFileSync(join(repo, 'README.md'), '# toy\nsecond line\n')
  writeFileSync(join(repo, 'untracked.mjs'), 'export const x = 1\n')
  // an ignored file is one git will never mention; the agent still wrote it
  writeFileSync(join(repo, '.gitignore'), 'notes/\n')
  mkdirSync(join(repo, 'notes'), { recursive: true })
  writeFileSync(join(repo, 'notes', 'scratch.md'), '# scratch\n')
  const s = sessions.createSession({ id: 's-detail-files', agent: 'claude', cwd: repo, repo, owner: 'wes' })
  sessions.updateSession(s.session_id, { files_touched: ['README.md', 'untracked.mjs', 'notes/scratch.md'], files_dirty: ['README.md'] })

  const files = detail.sessionFiles(sessions.readSession(s.session_id))
  const readme = files.find((f) => f.path === 'README.md')
  assert.ok(readme, `README.md is listed: ${JSON.stringify(files)}`)
  assert.equal(readme.adds, 1, 'one line added against HEAD')
  assert.equal(readme.dels, 0)
  assert.equal(readme.dirty, true)
  assert.equal(readme.state, 'modified')
  const made = files.find((f) => f.path === 'untracked.mjs')
  assert.ok(made, 'a file the agent created is still listed')
  assert.equal(made.state, 'new', 'a created file is not the same as one already committed')
  assert.equal(made.adds, null, 'there is nothing to count it against')
  const ignored = files.find((f) => f.path === 'notes/scratch.md')
  assert.equal(ignored.state, 'new', 'git never mentions an ignored file, which does not make it committed')

  const d = detail.sessionDiff(sessions.readSession(s.session_id), 'README.md')
  assert.match(d.diff, /\+second line/)
  assert.equal(d.truncated, false)
  assert.equal(d.state, 'modified')

  // a file the agent created reads as one big addition; one that already
  // landed in a commit reads as empty, and the drawer says which
  const created = detail.sessionDiff(sessions.readSession(s.session_id), 'untracked.mjs')
  assert.equal(created.state, 'new')
  assert.match(created.diff, /\+export const x = 1/)
  writeFileSync(join(repo, 'README.md'), '# toy\n') // back to what HEAD has
  const unchanged = detail.sessionDiff(sessions.readSession(s.session_id), 'README.md')
  assert.equal(unchanged.state, 'committed')
  assert.equal(unchanged.diff.trim(), '', 'nothing to show, and the drawer says why')
  const gone = detail.sessionDiff(sessions.readSession(s.session_id), 'never-existed.mjs')
  assert.equal(gone.state, 'gone', 'a path that is not there at all is not "no changes"')

  // a drive-letter path is only absolute on Windows: on Linux it is a legal
  // file name that lands inside the repo, so it belongs in the windows case
  const outside = ['../outside.txt', '../../.env', '/etc/passwd', ...(process.platform === 'win32' ? ['C:\\Windows\\win.ini'] : [])]
  for (const bad of outside) {
    assert.throws(() => detail.sessionDiff(sessions.readSession(s.session_id), bad), detail.DiffInputError, bad)
  }
  assert.throws(() => detail.sessionDiff(sessions.readSession(s.session_id), ''), detail.DiffInputError)
})

test('a long diff is cut off and says so', () => {
  const repo = initRepo('detail-longdiff-')
  writeFileSync(join(repo, 'big.txt'), Array.from({ length: detail.DIFF_MAX_LINES + 200 }, (_, i) => `line ${i}`).join('\n') + '\n')
  const s = sessions.createSession({ id: 's-detail-long', agent: 'claude', cwd: repo, repo, owner: 'wes' })
  sessions.updateSession(s.session_id, { files_touched: ['big.txt'] })
  const d = detail.sessionDiff(sessions.readSession(s.session_id), 'big.txt')
  assert.equal(d.truncated, true)
  assert.ok(d.diff.split('\n').length <= detail.DIFF_MAX_LINES + 1, 'the cap holds')
})

test('the board serves the drawer for your own terminal and refuses someone else theirs', async () => {
  const ownerToken = share.newToken()
  const guestToken = share.newToken()
  const roster = {
    version: 1, on: true, bind: '127.0.0.1', bind_kind: 'address', port: 0, owner: 'wes', loopback_owner: true,
    people: [
      { name: 'wes', role: 'owner', token_sha256: share.hashToken(ownerToken) },
      { name: 'sam', role: 'guest', token_sha256: share.hashToken(guestToken) },
    ],
  }
  const repo = initRepo('detail-api-')
  const transcript = join(repo, 'transcript.jsonl')
  claudeTranscript(transcript, [
    { type: 'user', timestamp: '2026-09-14T22:00:00.000Z', message: { role: 'user', content: 'add the drawer' } },
    { type: 'assistant', timestamp: '2026-09-14T22:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done, tests pass' }] } },
  ])
  writeFileSync(join(repo, 'README.md'), '# toy\nedited by the agent\n')
  sessions.createSession({ id: 's-detail-api', agent: 'claude', cwd: repo, repo, owner: 'wes' })
  sessions.updateSession('s-detail-api', { status: 'running', transcript_path: transcript, files_touched: ['README.md'], files_dirty: ['README.md'], turns: 2 })
  sessions.appendEvent('s-detail-api', { type: 'turn_done', summary: 'wrote the endpoint' })

  const server = createBoardServer({ bind: '127.0.0.1', port: 0, token: '', scheduler: false, share: roster })
  const { port } = await server.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const mine = await api(base, '/api/sessions/s-detail-api/detail', { token: ownerToken })
    assert.equal(mine.status, 200)
    assert.equal(mine.json.session_id, 's-detail-api')
    assert.deepEqual(mine.json.messages.map((m) => m.text), ['add the drawer', 'done, tests pass'])
    assert.equal(mine.json.files.find((f) => f.path === 'README.md').adds, 1)
    assert.ok(mine.json.events.some((e) => e.summary === 'wrote the endpoint'), 'the timeline is the session own events')

    const theirs = await api(base, '/api/sessions/s-detail-api/detail', { token: guestToken })
    assert.equal(theirs.status, 403, 'a guest cannot read the owner terminal prompts')

    const diff = await api(base, '/api/sessions/s-detail-api/diff?file=README.md', { token: ownerToken })
    assert.equal(diff.status, 200)
    assert.match(diff.json.diff, /\+edited by the agent/)

    const traversal = await api(base, '/api/sessions/s-detail-api/diff?file=' + encodeURIComponent('../../.env'), { token: ownerToken })
    assert.equal(traversal.status, 400)
    assert.equal((await api(base, '/api/sessions/s-detail-api/diff', { token: ownerToken })).status, 400, 'a diff needs a file')
    assert.equal((await api(base, '/api/sessions/s-nope/detail', { token: ownerToken })).status, 404)
  } finally {
    await server.stop()
  }
})
