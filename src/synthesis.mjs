// synthesis — the agent-maintained judgment record included in the handoff bundle.
// Spec: Leg Handoff Synthesis Layer — build spec v1
// File: .leg/SYNTHESIS-<session-id>.md
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_SYNTHESIS_BYTES = 4096
export const TRUNCATED_MARKER = '[synthesis truncated]'
export const INVALID_HEADER_PREFIX = '[synthesis header invalid, rendering body as-is]'
export const SYNTHESIS_POINTER_PARAGRAPH = "Read the Synthesis section first if present. Treat 'Ruled out' as settled: do not retry a ruled-out approach unless you have new evidence it was wrong. Start from the top-ranked Next step unless the repo state contradicts it."

export const SYNTHESIS_SECTIONS = [
  '## Ruled out',
  '## Decisions',
  '## Next steps',
  '## Open questions',
]

// The synthesis file path for a session in its checkout/worktree root
export function synthesisFile(cwd, id) {
  if (!cwd || !id) return null
  const leg = join(cwd, '.leg', `SYNTHESIS-${id}.md`)
  const baton = join(cwd, '.baton', `SYNTHESIS-${id}.md`)
  if (existsSync(leg)) return leg
  if (existsSync(baton)) return baton
  if (existsSync(join(cwd, '.baton')) && !existsSync(join(cwd, '.leg'))) return baton
  return leg
}

// Safely read the synthesis file; returns null if absent, empty, or unreadable
export function readSynthesis(cwd, id) {
  if (!cwd || !id) return null
  const file = synthesisFile(cwd, id)
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    if (!text || !text.trim()) return null
    return text
  } catch {
    return null
  }
}

// The standing directive for Leg per-session instructions
export function synthesisDirective(sessionId = '<session-id>') {
  return `Maintain .leg/SYNTHESIS-${sessionId}.md using the schema in section 4. Update it whenever you rule out an approach, make a consequential decision, or change direction. Keep each section to 5 bullets max, one line per bullet.`
}

// Validates the 2-line header per schema v1:
//   synthesis_version: 1
//   session: <session-id>  updated: <ISO-8601 UTC>
export function validateSynthesisHeader(text, { sessionId = null } = {}) {
  if (typeof text !== 'string') return { valid: false, reason: 'content is not a string' }
  const lines = text.split(/\r?\n/)
  if (lines.length < 2) return { valid: false, reason: 'fewer than 2 lines' }

  const l0 = lines[0].trim()
  if (!/^synthesis_version:\s*1$/.test(l0)) {
    return { valid: false, reason: 'missing or invalid synthesis_version: 1' }
  }

  const l1 = lines[1].trim()
  const m = /^session:\s*(\S+)\s+updated:\s*(\S+)$/.exec(l1)
  if (!m) {
    return { valid: false, reason: 'missing or invalid session/updated header line' }
  }

  const [, sessId, updated] = m
  if (sessionId && sessId !== sessionId) {
    return { valid: false, reason: `session mismatch: expected ${sessionId}, got ${sessId}` }
  }

  const parsed = Date.parse(updated)
  if (Number.isNaN(parsed) || !/(?:Z|[+-]00:?00)$/i.test(updated)) {
    return { valid: false, reason: 'updated timestamp is not valid ISO-8601 UTC' }
  }

  return { valid: true, version: 1, session: sessId, updated }
}

// Validates the full schema v1: header + optional sections in fixed order with max 5 bullets each
export function validateSynthesis(text, { sessionId = null } = {}) {
  const header = validateSynthesisHeader(text, { sessionId })
  const errors = []
  if (!header.valid) {
    errors.push(header.reason)
  }

  if (typeof text !== 'string') {
    return { valid: false, headerValid: false, errors: ['content is not a string'] }
  }

  const lines = text.split(/\r?\n/)
  let lastSectionIdx = -1
  let currentSection = null
  let currentBullets = 0

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('## ')) {
      const idx = SYNTHESIS_SECTIONS.indexOf(line)
      if (idx === -1) {
        errors.push(`unknown section: ${line}`)
      } else if (idx <= lastSectionIdx) {
        errors.push(`section out of order: ${line}`)
      } else {
        lastSectionIdx = idx
      }
      currentSection = line
      currentBullets = 0
    } else if (line.startsWith('- ')) {
      currentBullets++
      if (currentBullets > 5) {
        errors.push(`section ${currentSection || 'unknown'} exceeds 5 bullets`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    headerValid: header.valid,
    errors,
    session: header.session ?? null,
    updated: header.updated ?? null,
  }
}

// Inlines synthesis into the ## Synthesis section with size cap (4 KB) and malformed header handling
export function formatSynthesisSection(rawText, { sessionId = null } = {}) {
  if (!rawText || !rawText.trim()) return ''

  let content = rawText
  const buf = Buffer.from(content, 'utf8')
  if (buf.length > MAX_SYNTHESIS_BYTES) {
    const sliced = buf.subarray(0, MAX_SYNTHESIS_BYTES).toString('utf8')
    const sep = sliced.endsWith('\n') ? '' : '\n'
    content = `${sliced}${sep}${TRUNCATED_MARKER}`
  }

  const header = validateSynthesisHeader(content, { sessionId })
  if (!header.valid) {
    content = `${INVALID_HEADER_PREFIX}\n${content}`
  }

  return `## Synthesis\n\n${content.trim()}`
}

// Every per-session file one checkout keeps, name → path, `.leg` winning over
// the legacy `.baton` for a name both hold (the same order synthesisFile
// probes in). One readdir per directory answers the question for every
// terminal in that checkout at once, where a path-by-path probe cost three
// existsSync per terminal — 172 of the 512 fs calls in one sessions view, for
// files that mostly are not there. `cache` is per view: a Map the caller owns,
// so nothing here outlives the request that asked.
export function sessionFileIndex(cwd, cache = null) {
  if (cache && cache.has(cwd)) return cache.get(cwd)
  const names = new Map()
  for (const dir of ['.leg', '.baton']) {
    let entries
    try { entries = readdirSync(join(cwd, dir)) } catch { continue }
    for (const n of entries) if (!names.has(n)) names.set(n, join(cwd, dir, n))
  }
  cache?.set(cwd, names)
  return names
}

// True if .leg/SYNTHESIS-<session-id>.md exists, is non-empty, and was modified within the last 3 checkpoints
export function hasRecentSynthesis(session, { index = null } = {}) {
  if (!session) return false
  const root = session.worktree?.path ?? session.repo ?? session.cwd ?? null
  if (!root || !session.session_id) return false
  const file = sessionFileIndex(root, index).get(`SYNTHESIS-${session.session_id}.md`)
  if (!file) return false
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size === 0) return false
    const checkpoints = session.checkpoints ?? []
    if (checkpoints.length < 3) return true
    const threshold = new Date(checkpoints[checkpoints.length - 3]).getTime()
    return st.mtimeMs >= threshold
  } catch {
    return false
  }
}
