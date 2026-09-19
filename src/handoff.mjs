// handoff — the context-handoff-bundle seam. Leg never re-implements the
// bundle format: it writes a structured notes file, calls the CLI as an argv
// subprocess (`save --repo-local` inside the worktree so the next agent finds
// the bundle in its cwd), validates the bundle, and later `load`s the resume.
import { spawnSync, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { scrub } from './redact.mjs'

const MIN_VERSION = [0, 4, 0]

let resolved = null

// `context-handoff-bundle` on PATH (a real exe from pip's Scripts dir on
// Windows, a script elsewhere), else `python -m context_handoff_bundle`.
export function resolveChb() {
  if (resolved) return resolved
  const chbEnv = process.env.LEG_CHB_BIN || process.env.BATON_CHB_BIN;
  if (chbEnv) {
    resolved = { bin: chbEnv, prefix: [] }
    return resolved
  }
  const direct = spawnSync('context-handoff-bundle', ['--help'], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
  if (!direct.error && direct.status === 0) {
    resolved = { bin: 'context-handoff-bundle', prefix: [] }
    return resolved
  }
  for (const py of ['python', 'python3', 'py']) {
    const r = spawnSync(py, ['-m', 'context_handoff_bundle', '--help'], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
    if (!r.error && r.status === 0) {
      resolved = { bin: py, prefix: ['-m', 'context_handoff_bundle'] }
      return resolved
    }
  }
  throw new Error('context-handoff-bundle not found: pip install -U context-handoff-bundle')
}

export function chb(args, { cwd, timeout = 120000 } = {}) {
  const { bin, prefix } = resolveChb()
  const r = spawnSync(bin, [...prefix, ...args], { cwd, windowsHide: true, encoding: 'utf8', timeout, env: process.env })
  if (r.error) throw new Error(`context-handoff-bundle ${args[0]} failed to start: ${r.error.message}`)
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// The same call off the caller's event loop: same argv, same env, same timeout.
// Used by the periodic bundle checkpoint only (src/bundle.mjs
// saveSessionBundleAsync) - a synchronous save inside the terminal's poll tick
// froze limit detection and every board control for as long as the python CLI
// took, up to its whole 120 s timeout. Same answer shape as chb(), and the same
// throw when the CLI could not be started at all.
export function chbAsync(args, { cwd, timeout = 120000 } = {}) {
  const { bin, prefix } = resolveChb()
  return new Promise((res, rej) => {
    execFile(bin, [...prefix, ...args], { cwd, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      // a numeric code is an exit status (the CLI ran and refused); anything
      // else - ENOENT, a kill on timeout - is a failure to start
      if (err && typeof err.code !== 'number') return rej(new Error(`context-handoff-bundle ${args[0]} failed to start: ${err.message}`))
      res({ status: err ? err.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

// Version from package metadata (works on releases without --version).
export function chbVersion() {
  const v = chb(['--version'])
  let text = v.status === 0 ? v.stdout.trim().split(/\s+/).pop() : null
  if (!text) {
    const r = spawnSync('python', ['-c', "from importlib.metadata import version; print(version('context-handoff-bundle'))"], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
    text = r.status === 0 ? r.stdout.trim() : null
  }
  return text
}

export function versionOk(v = chbVersion()) {
  if (!v) return false
  const parts = v.split('.').map((x) => parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > MIN_VERSION[i]) return true
    if ((parts[i] ?? 0) < MIN_VERSION[i]) return false
  }
  return true
}

function bullets(items) {
  return items.filter(Boolean).map((x) => `- ${String(x).replace(/\r?\n/g, ' ').trim()}`)
}

// Notes in the CLI's own section vocabulary (Scope / Findings / Opportunities /
// Open questions / Evidence anchors) carrying Leg's four parts: Task, Done so
// far, Diff, Open findings. Anything not under a known heading is dropped by
// the parser, so every Leg line lives under one of those five.
export function buildNotes({ card, station, leg, entry, run, progress = '', lastMessage = null, diff = null, diffStat = '', changedFiles = [], extra = [] }) {
  const outcome = run?.outcome ?? 'handoff'
  const signal = run?.signal && run.signal !== 'none' ? ` (${run.signal})` : ''
  const progressLines = progress.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-40)
  const diffLine = diff
    ? `Diff since leg start: ${diff.files ?? 0} file(s) changed${diff.head_at_start && diff.head && diff.head !== diff.head_at_start ? `, HEAD moved ${diff.head_at_start.slice(0, 7)} → ${diff.head.slice(0, 7)}` : ''}${diffStat ? `; ${diffStat.trim().split(/\r?\n/).pop()}` : ''}`
    : 'Diff since leg start: (no git evidence)'
  const lines = [
    '## Scope',
    '',
    `Task: ${card.task}`,
    `Card ${card.card_id}, station ${station.name}, leg ${leg} (${entry?.adapter ?? run?.adapter ?? 'agent'}) stopped with outcome ${outcome}${signal}. The next agent resumes in the same worktree.`,
    '',
    '## Projects mentioned',
    '',
    `- ${card.card_id}`,
    '',
    '## Findings',
    '',
    ...bullets(progressLines.length ? progressLines.map((l, i) => `Done so far ${i + 1}: ${l}`) : ['Done so far: (no PROGRESS.md entries from the previous agent)']),
    ...bullets([lastMessage ? `Last message from the previous agent: ${scrub(String(lastMessage)).slice(0, 600)}` : null]),
    ...bullets([diffLine]),
    ...bullets(changedFiles.slice(0, 50).map((f) => `Diff touches ${f}`)),
    '',
    '## Opportunities',
    '',
    ...bullets([
      'Next agent: read .leg/PROGRESS.md and .leg/CONTRACT.md, continue from the last done step, then write .leg/DONE.',
      progressLines.length ? null : 'Next agent: the previous run left no progress notes; check the diff first.',
    ]),
    '',
    '## Open questions',
    '',
    ...bullets([
      `Open findings: previous leg ended ${outcome}${signal}: ${run?.reason ?? 'no reason recorded'}`,
      run?.exit_code !== undefined && run?.exit_code !== null ? `Open findings: exit code ${run.exit_code}` : null,
      ...extra.map((e) => `Open findings: ${e}`),
    ]),
    '',
    '## Evidence anchors',
    '',
    ...bullets(changedFiles.slice(0, 50)),
    ...bullets(['.leg/PROGRESS.md', '.leg/CONTRACT.md']),
    '',
  ]
  return scrub(lines.join('\n'))
}

function tailFile(path, lines = 15) {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join(' | ')
}

export function ensureExcluded(repo, pattern) {
  const f = join(repo, '.git', 'info', 'exclude')
  try {
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
    if (!cur.split(/\r?\n/).includes(pattern)) appendFileSync(f, `${cur.endsWith('\n') || !cur ? '' : '\n'}${pattern}\n`)
  } catch {}
}

// Writes the notes, saves the bundle repo-local in the worktree, validates it.
// Returns { bundle_id, path, notes_path, quality, score } (throws on failure).
export function writeHandoff({ card, station, leg, entry, run, worktree, runDir, extra = [], changedFiles = [], diffStat = '' }) {
  const pPath = existsSync(join(worktree, '.leg', 'PROGRESS.md')) ? join(worktree, '.leg', 'PROGRESS.md') : join(worktree, '.baton', 'PROGRESS.md');
  const progress = existsSync(pPath) ? readFileSync(pPath, 'utf8') : '';
  let lastMessage = null
  if (runDir && existsSync(join(runDir, 'last.md'))) lastMessage = readFileSync(join(runDir, 'last.md'), 'utf8')
  if (!lastMessage && run?.last_message) lastMessage = run.last_message
  const stderrTail = runDir ? tailFile(join(runDir, 'err.log')) : ''
  const notes = buildNotes({
    card, station, leg, entry, run, progress, lastMessage, diff: run?.diff ?? null, diffStat, changedFiles,
    extra: [...extra, stderrTail && run?.exit_code !== 0 ? `stderr tail: ${scrub(stderrTail).slice(0, 800)}` : null].filter(Boolean),
  })
  const legDir = join(worktree, '.leg')
  mkdirSync(legDir, { recursive: true })
  const notesPath = join(legDir, `handoff-${station.name}-leg${leg}.md`)
  writeFileSync(notesPath, notes)
  if (card.repo) ensureExcluded(card.repo, '.context-handoffs/')
  const slug = `leg-${card.card_id}-${station.name}-leg${leg}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80)
  const title = `leg ${card.card_id} ${station.name} leg ${leg} ${entry?.adapter ?? run?.adapter ?? 'agent'}`
  const save = chb(['save', '--repo-local', '--title', title, '--slug', slug, '--notes', notesPath, '--tag', 'leg'], { cwd: worktree })
  if (save.status !== 0) throw new Error(`context-handoff-bundle save failed (exit ${save.status}): ${scrub(save.stderr || save.stdout).slice(0, 500)}`)
  let out
  try { out = JSON.parse(save.stdout) } catch { throw new Error(`context-handoff-bundle save printed no JSON: ${scrub(save.stdout).slice(0, 300)}`) }
  const bundleId = out.bundle_id
  const bundlePath = join(worktree, '.context-handoffs', bundleId)
  const validate = chb(['validate', bundlePath], { cwd: worktree })
  if (validate.status !== 0) throw new Error(`context-handoff-bundle validate failed: ${scrub(validate.stderr || validate.stdout).slice(0, 500)}`)
  return { bundle_id: bundleId, path: bundlePath, notes_path: notesPath, quality: out.quality ?? null, score: out.score ?? null }
}

// The resume text the next leg's prompt starts with.
export function loadResume(worktree, query = 'latest') {
  const r = chb(['load', query], { cwd: worktree })
  if (r.status !== 0) throw new Error(`context-handoff-bundle load failed (exit ${r.status}): ${scrub(r.stderr || r.stdout).slice(0, 500)}`)
  return r.stdout
}
