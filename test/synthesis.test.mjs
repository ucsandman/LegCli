import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHome, testEnv, initRepo, leg, legSpawn } from './helpers.mjs'

const {
  synthesisFile,
  readSynthesis,
  validateSynthesis,
  validateSynthesisHeader,
  formatSynthesisSection,
  hasRecentSynthesis,
  synthesisDirective,
  SYNTHESIS_POINTER_PARAGRAPH,
  MAX_SYNTHESIS_BYTES,
  TRUNCATED_MARKER,
  INVALID_HEADER_PREFIX,
} = await import('../src/synthesis.mjs')
const { resumePrompt } = await import('../src/bundle.mjs')

// --------------------------------------------------------------------------
// 1. Schema check: a validator accepts a well-formed file and flags a bad header
//    without crashing (Spec section 10, verification 1)
// --------------------------------------------------------------------------

test('1. Schema check: validator accepts a well-formed file', () => {
  const good = [
    'synthesis_version: 1',
    'session: s-20260916-120000-claude-abcd  updated: 2026-09-16T12:00:00Z',
    '',
    '## Ruled out',
    '- Approach A: failed because of type error in lib',
    '',
    '## Decisions',
    '- Use direct SQLite table rather than in-memory cache for persistence',
    '',
    '## Next steps',
    '- 1. Add schema migration script',
    '- 2. Wire repository methods to new table',
    '',
    '## Open questions',
    '- Should stale entries expire after 24h or 7d?',
  ].join('\n')

  const r = validateSynthesis(good, { sessionId: 's-20260916-120000-claude-abcd' })
  assert.equal(r.valid, true)
  assert.equal(r.headerValid, true)
  assert.equal(r.errors.length, 0)
  assert.equal(r.session, 's-20260916-120000-claude-abcd')
  assert.equal(r.updated, '2026-09-16T12:00:00Z')
})

test('1. Schema check: validator flags a bad header without crashing', () => {
  const badHeaders = [
    null,
    undefined,
    12345,
    '',
    'synthesis_version: 1', // only 1 line
    'version: 1\nsession: s-1  updated: 2026-09-16T12:00:00Z', // wrong line 1
    'synthesis_version: 2\nsession: s-1  updated: 2026-09-16T12:00:00Z', // wrong version
    'synthesis_version: 1\nsession_id: s-1  updated: 2026-09-16T12:00:00Z', // wrong line 2 format
    'synthesis_version: 1\nsession: s-1  updated: not-a-date', // invalid date
    'synthesis_version: 1\nsession: s-1  updated: 2026-09-16T12:00:00', // non-UTC timestamp
    'synthesis_version: 1\nsession: s-wrong  updated: 2026-09-16T12:00:00Z', // session mismatch
  ]

  for (const bad of badHeaders) {
    assert.doesNotThrow(() => {
      const r = validateSynthesis(bad, { sessionId: 's-1' })
      assert.equal(r.valid, false, `expected invalid for: ${JSON.stringify(bad)}`)
      assert.equal(r.headerValid, false)
      assert.ok(r.errors.length > 0)
    })
  }
})

test('1. Schema check: validator enforces section order and 5 bullets cap', () => {
  // out of order sections
  const outOfOrder = [
    'synthesis_version: 1',
    'session: s-1  updated: 2026-09-16T12:00:00Z',
    '',
    '## Next steps',
    '- Step 1',
    '',
    '## Ruled out',
    '- Ruled out 1',
  ].join('\n')

  const rOrder = validateSynthesis(outOfOrder, { sessionId: 's-1' })
  assert.equal(rOrder.headerValid, true)
  assert.equal(rOrder.valid, false)
  assert.ok(rOrder.errors.some((e) => /section out of order/.test(e)))

  // > 5 bullets in a section
  const tooManyBullets = [
    'synthesis_version: 1',
    'session: s-1  updated: 2026-09-16T12:00:00Z',
    '',
    '## Next steps',
    '- Bullet 1',
    '- Bullet 2',
    '- Bullet 3',
    '- Bullet 4',
    '- Bullet 5',
    '- Bullet 6',
  ].join('\n')

  const rBullets = validateSynthesis(tooManyBullets, { sessionId: 's-1' })
  assert.equal(rBullets.headerValid, true)
  assert.equal(rBullets.valid, false)
  assert.ok(rBullets.errors.some((e) => /exceeds 5 bullets/.test(e)))
})

test('1. Schema check: synthesisFile, readSynthesis and validateSynthesisHeader helpers work directly', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'synthesis-helper-'))
  mkdirSync(join(cwd, '.leg'), { recursive: true })
  assert.equal(synthesisFile(cwd, 's-helper'), join(cwd, '.leg', 'SYNTHESIS-s-helper.md'))
  assert.equal(readSynthesis(cwd, 's-helper'), null)
  writeFileSync(join(cwd, '.leg', 'SYNTHESIS-s-helper.md'), 'test-content')
  assert.equal(readSynthesis(cwd, 's-helper'), 'test-content')

  const validHdr = validateSynthesisHeader('synthesis_version: 1\nsession: s-hdr  updated: 2026-09-16T12:00:00Z\n')
  assert.equal(validHdr.valid, true)
  assert.equal(validHdr.session, 's-hdr')
})

// --------------------------------------------------------------------------
// 2 & 3. Simulated handoff (with and without synthesis file)
// --------------------------------------------------------------------------

test('2. Simulated handoff: with synthesis file, RESUME.md contains ## Synthesis verbatim before bundle dump and pointer prompt has section 6 paragraph', async () => {
  const home = makeHome()
  const repo = initRepo('synthesis-sim-')
  const stubs = mkdtempSync(join(tmpdir(), 'synthesis-stubs-'))
  const stubDir = mkdtempSync(join(tmpdir(), 'synthesis-rec-'))
  mkdirSync(join(stubDir, 'live'), { recursive: true })
  mkdirSync(join(repo, '.leg'), { recursive: true })

  // claude stub: pauses until killed or simulates limit
  writeFileSync(join(stubs, 'claude.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync('${join(stubDir, 'claude.started').replace(/\\/g, '/')}', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), sid: process.env.LEG_SESSION || process.env.BATON_SESSION }))
setTimeout(() => {}, 60000)
`)

  // codex stub: captures the resume prompt received in argv, and the RESUME.md content at that moment
  writeFileSync(join(stubs, 'codex.mjs'), `
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const resumeFile = join(process.cwd(), '.leg', 'RESUME.md')
const resumeContent = existsSync(resumeFile) ? readFileSync(resumeFile, 'utf8') : null
writeFileSync('${join(stubDir, 'codex.started').replace(/\\/g, '/')}', JSON.stringify({ argv: process.argv.slice(2), resumeContent }))
process.exit(0)
`)

  const env = testEnv(home, {
    BATON_CLAUDE_BIN: join(stubs, 'claude.mjs'),
    BATON_CODEX_BIN: join(stubs, 'codex.mjs'),
    BATON_NO_BOARD: '1',
    BATON_NO_OPEN: '1',
    BATON_ATTACH_POLL_MS: '200',
    BATON_LIVE_DIR: join(stubDir, 'live'),
    STUB_DIR: stubDir,
  })

  // Start leg claude in background
  const child = legSpawn(['claude', '--model', 'haiku'], env, { cwd: repo })
  child.stdout.resume()
  child.stderr.resume()

  // Wait until claude stub starts
  let sid = null
  for (let i = 0; i < 50; i++) {
    if (existsSync(join(stubDir, 'claude.started'))) {
      const rec = JSON.parse(readFileSync(join(stubDir, 'claude.started'), 'utf8'))
      if (rec.sid) {
        sid = rec.sid
        break
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(sid, 'session started and found')

  // Seed synthesis file for this session
  const synthesisContent = [
    'synthesis_version: 1',
    `session: ${sid}  updated: 2026-09-16T12:00:00Z`,
    '',
    '## Ruled out',
    '- Tried rewriting parser: too risky, tests failed',
    '',
    '## Decisions',
    '- Keep existing tokenizer and wrap in stream decoder',
    '',
    '## Next steps',
    '- 1. Implement stream buffer wrapper',
    '- 2. Verify all edge cases pass',
  ].join('\n')

  const synFile = join(repo, '.leg', `SYNTHESIS-${sid}.md`)
  writeFileSync(synFile, synthesisContent)

  // Run leg sessions simulate-limit <id>
  const simOutput = leg(['sessions', 'simulate-limit', sid], env)
  assert.match(simOutput, /simulated: StopFailure rate_limit/)

  // Wait for child runner to finish the handoff and exit (since codex stub exits 0)
  const code = await new Promise((r) => child.on('exit', r))
  assert.equal(code, 0)

  // Verify that codex stub captured the handoff state
  assert.ok(existsSync(join(stubDir, 'codex.started')), 'codex was spawned from handoff')
  const codexRecord = JSON.parse(readFileSync(join(stubDir, 'codex.started'), 'utf8'))

  // 1. Assert RESUME.md contained ## Synthesis section verbatim before the bundle dump
  assert.ok(codexRecord.resumeContent, 'RESUME.md was read by codex upon startup')
  assert.ok(codexRecord.resumeContent.includes('## Synthesis'), 'RESUME.md includes ## Synthesis')
  assert.ok(codexRecord.resumeContent.includes(synthesisContent), 'RESUME.md contains synthesis content verbatim')

  const synIdx = codexRecord.resumeContent.indexOf('## Synthesis')
  const dumpIdx = codexRecord.resumeContent.indexOf('# Resume:') !== -1
    ? codexRecord.resumeContent.indexOf('# Resume:')
    : (codexRecord.resumeContent.indexOf('# Session ') !== -1
      ? codexRecord.resumeContent.indexOf('# Session ')
      : codexRecord.resumeContent.indexOf('## State'))
  assert.ok(synIdx !== -1 && dumpIdx !== -1, 'both synthesis and bundle dump exist in RESUME.md')
  assert.ok(synIdx < dumpIdx, '## Synthesis section appears BEFORE the raw bundle dump')

  // Also check per-session file .leg/RESUME-<id>.md
  const perSession = readFileSync(join(repo, '.leg', `RESUME-${sid}.md`), 'utf8')
  assert.ok(perSession.includes('## Synthesis'))
  assert.ok(perSession.includes(synthesisContent))

  // 2. Assert pointer prompt contains the exact paragraph from Section 6
  const promptArg = codexRecord.argv[codexRecord.argv.length - 1]
  assert.ok(promptArg.includes(SYNTHESIS_POINTER_PARAGRAPH), 'pointer prompt contains Section 6 paragraph')
})

test('3. Absence: with no synthesis file, RESUME.md matches today\'s format byte-for-byte apart from timestamps', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'synthesis-absence-'))
  mkdirSync(join(cwd, '.leg'), { recursive: true })
  const notesPath = join(cwd, '.leg', 'session-s-absence.md')
  const rawBundleDump = '## Scope\n\nTask: build the feature\n\n## Findings\n- clean working tree\n'
  writeFileSync(notesPath, rawBundleDump)

  const session = {
    session_id: 's-absence',
    agent: 'claude',
    account: 'default',
    cwd,
    repo: cwd,
    task: 'build the feature',
    limit: { reason: 'rate_limit', detail: 'rate limit reached' },
  }
  const bundle = { id: 'b-abs', path: join(cwd, '.context-handoffs', 'b-abs'), notes: notesPath }
  const next = { agent: 'codex', account: 'default' }

  // Generate resume prompt without synthesis file
  const prompt = resumePrompt(session, bundle, next)
  const resumeText = readFileSync(join(cwd, '.leg', 'RESUME.md'), 'utf8')

  // Expected legacy structure:
  // Stamp line + header + bundle dump (no ## Synthesis)
  assert.equal(resumeText.includes('## Synthesis'), false, 'no ## Synthesis section when file absent')
  assert.ok(resumeText.includes('# Leg handoff'))
  assert.ok(resumeText.includes('## Scope'))

  // Verify pointer prompt contains Section 6 paragraph
  assert.ok(prompt.includes(SYNTHESIS_POINTER_PARAGRAPH))

  // Verify body without stamp matches header + bundle dump exactly
  const { bodyOf } = await import('../src/resume.mjs')
  const body = bodyOf(resumeText)
  const expectedPrefix = `This file describes Leg terminal ${session.session_id} (${session.agent}); its own copy is .leg/RESUME-${session.session_id}.md.\n\n`
  const expectedHeader = `# Leg handoff\n\nPrevious agent: claude (default). Reason: rate_limit, rate limit reached.\nNext agent: codex (default).\nBundle: ${bundle.path}\n\n`
  assert.equal(body, expectedPrefix + expectedHeader + rawBundleDump, 'body matches legacy header + raw bundle dump byte-for-byte')
})

// --------------------------------------------------------------------------
// 4. Truncation: an 8 KB synthesis file renders as 4 KB plus [synthesis truncated]
// --------------------------------------------------------------------------

test('4. Truncation: an 8 KB synthesis file renders as 4 KB plus [synthesis truncated]', () => {
  const header = 'synthesis_version: 1\nsession: s-trunc  updated: 2026-09-16T12:00:00Z\n\n## Ruled out\n'
  const padding = 'x'.repeat(8192 - header.length)
  const bigFile = header + padding

  assert.equal(Buffer.byteLength(bigFile, 'utf8'), 8192, 'seed is 8 KB')

  const section = formatSynthesisSection(bigFile, { sessionId: 's-trunc' })
  assert.ok(section.startsWith('## Synthesis\n\n'))
  assert.ok(section.includes(TRUNCATED_MARKER), 'contains [synthesis truncated] marker')

  // Content before marker must be exactly MAX_SYNTHESIS_BYTES (4096 bytes)
  const bodyAfterH2 = section.replace(/^## Synthesis\n\n/, '')
  const markerIdx = bodyAfterH2.indexOf(TRUNCATED_MARKER)
  assert.ok(markerIdx !== -1)
  const truncatedContent = bodyAfterH2.slice(0, markerIdx).trimEnd()
  assert.equal(Buffer.byteLength(truncatedContent, 'utf8'), MAX_SYNTHESIS_BYTES, 'renders exactly 4 KB before marker')
})

// --------------------------------------------------------------------------
// 5. Resilience: delete synthesis file mid-handoff in a test and confirm bundle still completes
// --------------------------------------------------------------------------

test('5. Resilience: delete synthesis file mid-handoff; bundle and prompt still complete', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'synthesis-resilience-'))
  mkdirSync(join(cwd, '.leg'), { recursive: true })
  const notesPath = join(cwd, '.leg', 'session-s-resil.md')
  writeFileSync(notesPath, '## Scope\n\nTask: resilient handoff\n')

  const synFile = join(cwd, '.leg', 'SYNTHESIS-s-resil.md')
  writeFileSync(synFile, 'synthesis_version: 1\nsession: s-resil  updated: 2026-09-16T12:00:00Z\n')

  const session = {
    session_id: 's-resil',
    agent: 'claude',
    account: 'default',
    cwd,
    repo: cwd,
    task: 'resilient handoff',
  }
  const bundle = { id: 'b-resil', path: join(cwd, '.context-handoffs', 'b-resil'), notes: notesPath }
  const next = { agent: 'codex', account: 'default' }

  // Delete synthesis file right before resumePrompt executes (simulating mid-handoff deletion)
  rmSync(synFile, { force: true })
  assert.equal(existsSync(synFile), false)

  let prompt = null
  assert.doesNotThrow(() => {
    prompt = resumePrompt(session, bundle, next)
  })

  assert.ok(prompt, 'prompt returned successfully')
  assert.ok(existsSync(join(cwd, '.leg', 'RESUME.md')), 'RESUME.md was written')
  const text = readFileSync(join(cwd, '.leg', 'RESUME.md'), 'utf8')
  assert.equal(text.includes('## Synthesis'), false, 'gracefully degrades to absence when file was deleted')
  assert.ok(text.includes('# Leg handoff'))
})

// --------------------------------------------------------------------------
// 6. Malformed header: prefix [synthesis header invalid, rendering body as-is]
// --------------------------------------------------------------------------

test('6. Malformed header: inlines body with [synthesis header invalid, rendering body as-is] prefix', () => {
  const malformed = 'Not a valid header line 1\nStill not valid line 2\n\n## Ruled out\n- Something tried\n'
  const section = formatSynthesisSection(malformed, { sessionId: 's-any' })

  assert.ok(section.startsWith('## Synthesis\n\n'))
  assert.ok(section.includes(INVALID_HEADER_PREFIX), 'prefixes invalid header notice')
  assert.ok(section.includes('Not a valid header line 1'), 'still renders body as-is')
  assert.ok(section.includes('## Ruled out'), 'survives body content')
})

// --------------------------------------------------------------------------
// 7. Board indicator: hasRecentSynthesis
// --------------------------------------------------------------------------

test('7. Board indicator: hasRecentSynthesis reflects presence and modification within last 3 checkpoints', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'synthesis-board-'))
  mkdirSync(join(cwd, '.leg'), { recursive: true })
  const synFile = join(cwd, '.leg', 'SYNTHESIS-s-board.md')

  const session = {
    session_id: 's-board',
    agent: 'claude',
    cwd,
    repo: cwd,
    checkpoints: [],
  }

  // 1. Absent file -> false
  assert.equal(hasRecentSynthesis(session), false)

  // 2. Empty file -> false
  writeFileSync(synFile, '')
  assert.equal(hasRecentSynthesis(session), false)

  // 3. Present file, < 3 checkpoints -> true
  writeFileSync(synFile, 'synthesis_version: 1\nsession: s-board  updated: 2026-09-16T12:00:00Z\n')
  assert.equal(hasRecentSynthesis(session), true)

  // 4. 3 checkpoints taken AFTER the file was written -> false
  const now = Date.now()
  // File was written at `now`. Set checkpoints at now + 10s, now + 20s, now + 30s
  session.checkpoints = [
    new Date(now + 10000).toISOString(),
    new Date(now + 20000).toISOString(),
    new Date(now + 30000).toISOString(),
  ]
  // The 3rd from last checkpoint is now + 10s. The file's mtime is <= now.
  assert.equal(hasRecentSynthesis(session), false)

  // 5. Touch the file so its mtime is newer than the 3rd from last checkpoint -> true
  const futureTime = new Date(now + 15000)
  utimesSync(synFile, futureTime, futureTime)
  assert.equal(hasRecentSynthesis(session), true)
})

// --------------------------------------------------------------------------
// 8. Standing directive format
// --------------------------------------------------------------------------

test('8. Standing directive text matches Section 3 spec', () => {
  const d = synthesisDirective('s-1234')
  assert.equal(d, 'Maintain .leg/SYNTHESIS-s-1234.md using the schema in section 4. Update it whenever you rule out an approach, make a consequential decision, or change direction. Keep each section to 5 bullets max, one line per bullet.')
})
