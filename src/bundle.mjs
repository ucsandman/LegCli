// bundle — keeps a context-handoff-bundle current for an interactive session
// and turns it into the prompt the next agent starts from. Reuses the v0.1
// seam (src/handoff.mjs: chb(), resolveChb) so the CLI is still the only
// writer of bundle files. One bundle per session (`save --update <slug>`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { chb, ensureExcluded } from './handoff.mjs'
import { scrub } from './redact.mjs'
import { updateSession, workRoot } from './sessions.mjs'
import { perSessionFile, writeHandoffPointer } from './resume.mjs'
import { readSynthesis, formatSynthesisSection, synthesisDirective, SYNTHESIS_POINTER_PARAGRAPH } from './synthesis.mjs'

const LEG_DIRS = /^(\.leg|\.baton|\.context-handoffs|\.dashclaw-local)[\\/]/
const bullets = (items) => items.filter(Boolean).map((x) => `- ${String(x).replace(/\r?\n/g, ' ').trim()}`)

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  // trimEnd only: a porcelain line starts with a space (" M README.md")
  return r.status === 0 ? r.stdout.trimEnd() : ''
}

export function slugFor(session) { return `leg-${session.session_id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) }

export function sessionCommitDelta(cwd, session) {
  if (!cwd) return { isClean: false, dirty: [], newCommits: [] }
  const dirty = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => !LEG_DIRS.test(f)).slice(0, 60)
  const isClean = dirty.length === 0
  let newCommits = []
  if (isClean && session?.head_at_start) {
    const head = git(cwd, ['rev-parse', 'HEAD']).trim()
    if (head && head !== session.head_at_start) {
      const raw = git(cwd, ['log', '--oneline', `${session.head_at_start}..${head}`])
      if (raw) newCommits = raw.split('\n').filter(Boolean)
    }
  }
  return { isClean, dirty, newCommits }
}

// Notes in the CLI's section vocabulary; see src/handoff.mjs buildNotes.
export function sessionNotes(session, { messages = [], why = 'handoff' } = {}) {
  const cwd = workRoot(session)
  const stat = git(cwd, ['diff', '--stat'])
  const delta = sessionCommitDelta(cwd, session)
  const dirty = delta.dirty
  const recent = git(cwd, ['log', '--oneline', '-5'])
  const opportunity = delta.isClean && delta.newCommits.length > 0
    ? `Next agent: read this bundle. The previous agent committed changes (${delta.newCommits.length} commit(s): ${delta.newCommits.slice(0, 3).join(' | ')}) and left a clean working tree. Check git log to verify whether the task is already satisfied before doing redundant work. Do not ask the human to restate the task.`
    : 'Next agent: read this bundle, inspect `git status` and `git diff`, continue the task from the last agent message, and do not ask the human to restate the task.'
  const lines = [
    '## Scope', '',
    `Task: ${session.task ?? '(no prompt recorded yet; read the transcript)'}`,
    `Interactive ${session.agent} session ${session.session_id} in ${session.cwd}${session.branch ? ` on branch ${session.branch}` : ''} stopped: ${why}. The next agent continues in the same directory.`,
    '', '## Projects mentioned', '', `- ${session.repo_name ?? session.cwd}`, '',
    '## Findings', '',
    ...bullets(messages.slice(-8).map((m, i) => `${m.role === 'user' ? 'Human said' : 'Agent said'} (${i + 1}): ${m.text.slice(0, 600)}`)),
    ...bullets([`Diff since session start: ${stat ? stat.split('\n').pop() : 'clean working tree'}`]),
    ...bullets(dirty.map((f) => `Dirty file: ${f}`)),
    ...bullets((session.files_touched ?? []).slice(0, 50).map((f) => `Edited this session: ${f}`)),
    ...bullets(recent ? [`Recent commits: ${recent.replace(/\n/g, ' | ')}`] : []),
    '', '## Opportunities', '',
    ...bullets([
      opportunity,
      synthesisDirective(session.session_id),
    ]),
    '', '## Open questions', '',
    ...bullets([`Why the previous agent stopped: ${why}`, session.limit?.detail ? `Limit text: ${session.limit.detail}` : null]),
    '', '## Evidence anchors', '',
    ...bullets([...dirty, ...(session.files_touched ?? [])].slice(0, 50)),
    ...bullets([session.transcript_path ? `transcript: ${session.transcript_path}` : null]),
    '',
  ]
  return scrub(lines.join('\n'))
}

// Save (or refresh) the session's bundle. Returns { bundle_id, path } or throws.
export function saveSessionBundle(session, { messages = [], why = 'checkpoint' } = {}) {
  // a session in its own worktree keeps its bundle and RESUME.md there, where the next agent starts
  const cwd = workRoot(session)
  const legDir = join(cwd, '.leg')
  mkdirSync(legDir, { recursive: true })
  if (session.repo) for (const pat of ['.leg/', '.baton/', '.context-handoffs/']) ensureExcluded(session.repo, pat)
  const notesPath = join(legDir, `session-${session.session_id}.md`)
  writeFileSync(notesPath, sessionNotes(session, { messages, why }))
  const slug = slugFor(session)
  const title = `leg ${session.agent} session ${session.session_id}`
  const base = ['save', '--repo-local', '--title', title, '--slug', slug, '--notes', notesPath, '--tag', 'leg', '--tag', session.agent]
  let r = session.bundle?.id ? chb([...base, '--update', slug], { cwd }) : { status: 1 }
  if (r.status !== 0) r = chb(base, { cwd })
  if (r.status !== 0) throw new Error(`context-handoff-bundle save failed (exit ${r.status}): ${scrub(r.stderr || r.stdout).slice(0, 400)}`)
  let out
  try { out = JSON.parse(r.stdout) } catch { throw new Error(`context-handoff-bundle save printed no JSON: ${scrub(r.stdout).slice(0, 200)}`) }
  const nowIso = new Date().toISOString()
  const bundle = { id: out.bundle_id, path: join(cwd, '.context-handoffs', out.bundle_id), notes: notesPath, quality: out.quality ?? null, updated_at: nowIso, why }
  if (why === 'checkpoint') {
    const checkpoints = [...(session.checkpoints ?? []), nowIso].slice(-20)
    session.checkpoints = checkpoints
    updateSession(session.session_id, (cur) => ({
      bundle,
      checkpoints: [...(cur?.checkpoints ?? []), nowIso].slice(-20),
    }))
  } else {
    updateSession(session.session_id, { bundle })
  }
  return bundle
}

// The resume text for the next agent: chb load into .baton/RESUME.md, plus a
// short pointer prompt (argv stays small; the bundle carries the context).
export function resumePrompt(session, bundle, next) {
  const cwd = workRoot(session)
  let loaded = ''
  try {
    const r = chb(['load', bundle.id], { cwd })
    if (r.status === 0) loaded = r.stdout
  } catch {}
  const header = `# Leg handoff\n\nPrevious agent: ${session.agent} (${session.account}). Reason: ${session.limit?.reason ?? session.handoff?.reason ?? 'handoff requested'}${session.limit?.detail ? `, ${session.limit.detail}` : ''}.\nNext agent: ${next.agent} (${next.account}).\nBundle: ${bundle.path}\n\n`
  const bundleDump = loaded || readFileSync(bundle.notes, 'utf8')
  let synthesisSection = ''
  try {
    const rawSyn = readSynthesis(cwd, session.session_id)
    if (rawSyn) {
      synthesisSection = formatSynthesisSection(rawSyn, { sessionId: session.session_id })
    }
  } catch {}
  const body = header + (synthesisSection ? `${synthesisSection}\n\n` : '') + bundleDump
  // src/resume.mjs owns both files: the per-session one so two sessions sharing
  // one checkout (--no-worktree, or two started in the same instant) never
  // overwrite each other's handoff, and RESUME.md, the copy everyone opens.
  // Both are stamped with the git state and the live terminals they describe,
  // so `leg resume --check` can tell a reader when they stopped being true.
  const why = session.limit?.reason ?? session.handoff?.reason ?? 'handoff requested'
  writeHandoffPointer(session, body, { bundle, why })
  const perSession = perSessionFile(cwd, session.session_id)
  const task = session.task ? `\n\nThe task, as the human first stated it: ${session.task.slice(0, 700)}` : ''
  const delta = sessionCommitDelta(cwd, session)
  const actionText = delta.isClean && delta.newCommits.length > 0
    ? `. The previous agent committed changes (${delta.newCommits.length} commit(s): ${delta.newCommits.slice(0, 2).join(' | ')}) and left a clean working tree. Check git log and verify whether the task is already complete before doing redundant work; continue only if work remains.`
    : ', check git status and git diff, then continue the work from where it stopped.'
  // the absolute path: the next agent is spawned in the session's cwd, which is
  // a subdirectory of the work root whenever Leg was started in one
  return `You are taking over an interactive coding session from ${session.agent}, which hit its usage limit. Read ${perSession} (the context handoff bundle is at ${bundle.path})${actionText} Do not ask the human to restate the task.${task}\n\n${SYNTHESIS_POINTER_PARAGRAPH}`
}

// Freshness, never existence: src/resume.mjs recomputes it from git at read
// time. `resumeFileExists` used to live here and answered "a file is on disk",
// which every caller then read as "the handoff it describes is still true".
export { resumeVerdict } from './resume.mjs'
export { synthesisFile, readSynthesis, validateSynthesis, validateSynthesisHeader, formatSynthesisSection, hasRecentSynthesis, synthesisDirective, SYNTHESIS_POINTER_PARAGRAPH } from './synthesis.mjs'
