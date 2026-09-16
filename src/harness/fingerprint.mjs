// fingerprint — "did the source client's harness change since the last
// capture", answered from file metadata alone. A hand-off must not re-read a
// whole client home to find out that nothing moved: this stats the handful of
// surfaces a capture reads (rules and their imports, settings, MCP, agents,
// commands, skills) and hashes their paths, sizes and mtimes. A miss costs one
// capture; a hit costs a few dozen stat calls.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

function stat(p) {
  try { const s = statSync(p); return `${s.size}:${Math.round(s.mtimeMs)}` } catch { return 'absent' }
}

function dirEntries(dir, inner = null) {
  let names
  try { names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort() } catch { return [`${dir}=absent`] }
  return names.map((n) => `${dir}/${n}=${stat(inner ? join(dir, n, inner) : join(dir, n))}`)
}

// The files a Claude Code rules file pulls in (`@path` lines), one level deep,
// the same way the capture inlines them.
function claudeImports(rulesFile, home) {
  const out = []
  let text
  try { text = readFileSync(rulesFile, 'utf8') } catch { return out }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^@(\S+)[ \t]*$/)
    if (!m) continue
    const spec = m[1]
    const p = spec === '~' ? home : spec.startsWith('~/') || spec.startsWith('~\\') ? join(home, spec.slice(2)) : isAbsolute(spec) ? resolve(spec) : resolve(dirname(rulesFile), spec)
    out.push(p)
  }
  return out
}

// Every path a capture of `source` reads, with its metadata.
export function sourceSurfaces(source, target, home) {
  const lines = []
  if (source === 'claude') {
    const rules = join(target.home, 'CLAUDE.md')
    lines.push(`${rules}=${stat(rules)}`)
    for (const imp of claudeImports(rules, home)) lines.push(`${imp}=${stat(imp)}`)
    for (const f of [target.hooksConfigFile, target.traitsFile, target.mcpConfigFile, join(target.home, '.mcp.json')]) if (f) lines.push(`${f}=${stat(f)}`)
    lines.push(...dirEntries(target.agentsDir))
    lines.push(...dirEntries(target.commandsDir))
    lines.push(...dirEntries(target.skillsDir, 'SKILL.md'))
  } else if (source === 'codex') {
    for (const f of [target.rulesFile, target.hooksConfigFile]) if (f) lines.push(`${f}=${stat(f)}`)
    lines.push(...dirEntries(target.agentsDir))
    lines.push(...dirEntries(target.commandsDir))
    lines.push(...dirEntries(target.skillsDir, 'SKILL.md'))
    if (target.permissionsFile) lines.push(...dirEntries(dirname(target.permissionsFile)))
  } else {
    throw new Error(`no capture adapter for source "${source}"`)
  }
  return lines
}

export function sourceFingerprint(source, target, home) {
  const lines = sourceSurfaces(source, target, home)
  return { hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 24), surfaces: lines.length }
}

export function sourcePresent(source, target) {
  const rules = source === 'claude' ? join(target.home, 'CLAUDE.md') : target.rulesFile
  return existsSync(rules)
}
