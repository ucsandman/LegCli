// bundle — keeps a context-handoff-bundle current for an interactive session
// and turns it into the prompt the next agent starts from. Reuses the v0.1
// seam (src/handoff.mjs: chb(), resolveChb) so the CLI is still the only
// writer of bundle files. One bundle per session (`save --update <slug>`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { chb, ensureExcluded } from './handoff.mjs'
import { scrub } from './redact.mjs'
import { updateSession, workRoot } from './sessions.mjs'

const BATON_DIRS = /^(\.baton|\.context-handoffs|\.dashclaw-local)[\\/]/
const bullets = (items) => items.filter(Boolean).map((x) => `- ${String(x).replace(/\r?\n/g, ' ').trim()}`)

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  // trimEnd only: a porcelain line starts with a space (" M README.md")
  return r.status === 0 ? r.stdout.trimEnd() : ''
}

export function slugFor(session) { return `baton-${session.session_id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80) }

// Notes in the CLI's section vocabulary; see src/handoff.mjs buildNotes.
export function sessionNotes(session, { messages = [], why = 'handoff' } = {}) {
  const cwd = workRoot(session)
  const stat = git(cwd, ['diff', '--stat'])
  const dirty = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => !BATON_DIRS.test(f)).slice(0, 60)
  const recent = git(cwd, ['log', '--oneline', '-5'])
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
    ...bullets(['Next agent: read this bundle, inspect `git status` and `git diff`, continue the task from the last agent message, and do not ask the human to restate the task.']),
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
  const batonDir = join(cwd, '.baton')
  mkdirSync(batonDir, { recursive: true })
  if (session.repo) for (const pat of ['.baton/', '.context-handoffs/']) ensureExcluded(session.repo, pat)
  const notesPath = join(batonDir, `session-${session.session_id}.md`)
  writeFileSync(notesPath, sessionNotes(session, { messages, why }))
  const slug = slugFor(session)
  const title = `baton ${session.agent} session ${session.session_id}`
  const base = ['save', '--repo-local', '--title', title, '--slug', slug, '--notes', notesPath, '--tag', 'baton', '--tag', session.agent]
  let r = session.bundle?.id ? chb([...base, '--update', slug], { cwd }) : { status: 1 }
  if (r.status !== 0) r = chb(base, { cwd })
  if (r.status !== 0) throw new Error(`context-handoff-bundle save failed (exit ${r.status}): ${scrub(r.stderr || r.stdout).slice(0, 400)}`)
  let out
  try { out = JSON.parse(r.stdout) } catch { throw new Error(`context-handoff-bundle save printed no JSON: ${scrub(r.stdout).slice(0, 200)}`) }
  const bundle = { id: out.bundle_id, path: join(cwd, '.context-handoffs', out.bundle_id), notes: notesPath, quality: out.quality ?? null, updated_at: new Date().toISOString(), why }
  updateSession(session.session_id, { bundle })
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
  const header = `# Baton handoff\n\nPrevious agent: ${session.agent} (${session.account}). Reason: ${session.limit?.reason ?? session.handoff?.reason ?? 'handoff requested'}${session.limit?.detail ? ` — ${session.limit.detail}` : ''}.\nNext agent: ${next.agent} (${next.account}).\nBundle: ${bundle.path}\n\n`
  const body = header + (loaded || readFileSync(bundle.notes, 'utf8'))
  // per-session file so two sessions sharing one checkout (--no-worktree, or two
  // started in the same instant) never overwrite each other's handoff; RESUME.md
  // stays as a convenience copy for the common single-session case
  const perSession = join(cwd, '.baton', `RESUME-${session.session_id}.md`)
  writeFileSync(perSession, body)
  try { writeFileSync(join(cwd, '.baton', 'RESUME.md'), body) } catch {}
  const task = session.task ? `\n\nThe task, as the human first stated it: ${session.task.slice(0, 700)}` : ''
  return `You are taking over an interactive coding session from ${session.agent}, which hit its usage limit. Read .baton/RESUME-${session.session_id}.md in this directory (the context handoff bundle is at ${bundle.path}), check git status and git diff, then continue the work from where it stopped. Do not ask the human to restate the task.${task}`
}

export function resumeFileExists(cwd) { return existsSync(join(cwd, '.baton', 'RESUME.md')) }
