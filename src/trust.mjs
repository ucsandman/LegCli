// trust — records the folder-trust answer each agent CLI asks for on its first
// run in a directory, before Leg spawns that agent.
//
// Why this exists: the handoff is the product. When claude hits its 5-hour
// limit at 3am, Leg writes the bundle and starts codex in the same terminal
// with nobody there. If the incoming agent has never run in that folder it
// stops on a full-screen "Is this a project you trust?" prompt and waits for a
// keypress that is not coming, and the handoff the user paid for silently
// becomes a stalled terminal they find in the morning.
//
// Each CLI already stores that answer in a file, so the fix is to write the
// same answer the user would have clicked, for the repository they already
// chose by typing `leg claude` in it:
//
//   claude  ~/.claude.json            projects["<repo>"].hasTrustDialogAccepted
//           (or $CLAUDE_CONFIG_DIR/.claude.json)
//   codex   ~/.codex/config.toml      [projects."<repo>"] trust_level = "trusted"
//   agy     ~/.gemini/config/projects/default-cli-project.json   projectResources.resources[{ gitFolder: { folderUri: ... } }]
//
// For claude this is the documented remedy: its own permissions docs say to
// "set projects[<path>].hasTrustDialogAccepted to true in ~/.claude.json, where
// <path> is the repository root", and its error text prints the same sentence.
//
// Three rules this module holds to, because it writes files Leg does not own:
//   1. Never create a config file that is not already there. A missing file
//      means that CLI has never run here, so its own first-run flow (login,
//      onboarding) is about to happen with the user present anyway. Skip.
//   2. Never rewrite a file to say what it already says. No write, no risk.
//   3. Never lose what is already in the file. Read, add, write atomically,
//      under the same cross-process lock the rest of Leg uses.
//
// BATON_TRUST=never turns all of it off; the prompts come back.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, parse, isAbsolute } from 'node:path'
import { realPath, withFileLock, writeJsonAtomic } from './fsx.mjs'

// The repository root is the unit of trust: claude walks up from the working
// directory to the repo root looking for the flag, so one record covers every
// worktree Leg creates under <repo>/.baton-worktrees/ as well.
export function repoRootOf(dir) {
  let at = realPath(dir)
  const stop = parse(at).root
  while (true) {
    if (existsSync(join(at, '.git'))) return at
    const up = dirname(at)
    if (up === at || at === stop) return realPath(dir)
    at = up
  }
}

export function trustPolicy(env = process.env) {
  const raw = String(env.LEG_TRUST ?? env.BATON_TRUST ?? 'auto').trim().toLowerCase()
  return raw === 'never' || raw === 'off' || raw === '0' ? 'never' : 'auto'
}

// ---- claude ----

// A path like `C:\cfg` is absolute on Windows and a plain relative filename
// everywhere else, so `resolve()` on a POSIX host prepends the process's own
// cwd and invents a directory that was never named. These functions describe a
// Windows agent's config, and they have to say the same thing whatever host
// they are asked on, so a drive-letter path is taken as already absolute.
const DRIVE_ABS = /^[A-Za-z]:[\\/]/

function absolutely(p) { return DRIVE_ABS.test(p) ? p : resolve(p) }

export function claudeConfigFile(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR ? absolutely(env.CLAUDE_CONFIG_DIR) : homedir()
  return join(dir, '.claude.json')
}

// Claude Code stores a project under a normalized spelling of its path, and on
// Windows that spelling is forward slashes with an upper-case drive letter and
// no trailing separator: 100 of the 104 entries in a real ~/.claude.json are in
// that form, and the four that are not are older duplicates of projects that
// also appear in the new form. Write the wrong spelling and the entry is simply
// ignored: the flag is on file, the prompt still appears, and nothing says why.
export function claudeProjectKey(repo) {
  // realPath() resolves symlinks and 8.3 names against the host filesystem,
  // which is the right thing for a path that lives on it and meaningless for a
  // drive-letter path on a POSIX host: there it silently becomes cwd + the
  // literal. A drive-letter path is already the canonical spelling, so it is
  // normalized directly.
  const raw = String(repo)
  let p = (DRIVE_ABS.test(raw) ? raw : realPath(raw)).replace(/\\/g, '/')
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  return p.length > 3 ? p.replace(/\/+$/, '') : p
}

// The canonical key, plus the spellings Claude Code used in older versions.
// Older spellings are updated when they are already in the file and never
// created, so Leg corrects a stale entry without littering the config.
export function projectKeys(repo, existing = {}) {
  const key = claudeProjectKey(repo)
  const out = [key]
  for (const v of [key.normalize('NFC'), realPath(repo), resolve(repo)]) {
    if (!out.includes(v) && Object.prototype.hasOwnProperty.call(existing, v)) out.push(v)
  }
  // The older spelling is the same path written with Windows separators, so it
  // is recognised by its spelling rather than by asking the host to resolve it:
  // matching on the exact string only worked on a host where a backslash is a
  // separator, and the entry Leg was meant to correct was left stale
  // anywhere else. Nothing is created here — an entry is only ever brought up
  // to date when it is already in the file.
  for (const k of Object.keys(existing)) {
    if (!out.includes(k) && k.includes('\\') && claudeProjectKey(k.replace(/\\/g, '/')) === key) out.push(k)
  }
  return out
}

// A project-level CLAUDE.md that imports a file outside the working directory
// is what triggers the second prompt ("Allow external CLAUDE.md file imports?").
// Claude Code reads a CLAUDE.md from every ancestor directory of the working
// directory, so an import in C:\Projects\CLAUDE.md is external to a session in
// C:\Projects\some-repo. Returns the resolved paths, so Leg can print exactly
// what it approved instead of approving something invisible.
export function externalImports(cwd) {
  const start = realPath(cwd)
  const stop = parse(start).root
  const dirs = []
  for (let at = start; ; at = dirname(at)) {
    dirs.push(at)
    if (at === stop || dirname(at) === at) break
  }
  const home = realPath(homedir())
  const out = []
  for (const dir of dirs) {
    // ~/.claude/CLAUDE.md is user memory, not project memory: its imports never
    // raise the dialog, so they are not ours to approve either.
    if (dir === home) continue
    const file = join(dir, 'CLAUDE.md')
    if (!existsSync(file)) continue
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*@(\S+)\s*$/)
      if (!m) continue
      const target = isAbsolute(m[1]) ? resolve(m[1]) : resolve(dir, m[1])
      if (inside(target, start) || out.includes(target)) continue
      out.push(target)
    }
  }
  return out
}

function inside(target, root) {
  const a = process.platform === 'win32' ? target.toLowerCase() : target
  const b = process.platform === 'win32' ? root.toLowerCase() : root
  return a === b || a.startsWith(b.endsWith('\\') || b.endsWith('/') ? b : b + (b.includes('\\') ? '\\' : '/'))
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

export function ensureClaudeTrust(repo, { env = process.env, cwd = repo } = {}) {
  const file = claudeConfigFile(env)
  const root = repoRootOf(repo)
  // Rule 1: a config that is not there means claude has never run as this
  // user. Its own onboarding is next, with a person at the keyboard.
  if (!existsSync(file)) return { agent: 'claude', file, wrote: [], imports: [], skipped: 'no claude config yet' }
  const imports = externalImports(cwd)
  let wrote = []
  withFileLock(`${file}.baton-lock`, () => {
    const cfg = readJson(file)
    // Rule 3: an unreadable or non-object config is not ours to repair.
    if (!cfg || typeof cfg !== 'object') { wrote = null; return }
    const projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}
    const keys = projectKeys(root, projects)
    // Rule 4, and the one that matters most: an answer already on file is the
    // user's, including "no". Only an ABSENT key is an unanswered question.
    // Treating "not true" as "not asked yet" would flip a deliberate refusal
    // to trust a folder into trust, silently, on every run in that repo.
    const said = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
    if (keys.some((k) => projects[k] && said(projects[k], 'hasTrustDialogAccepted') && projects[k].hasTrustDialogAccepted !== true)) {
      wrote = 'declined'
      return
    }
    const changed = []
    for (const key of keys) {
      const was = projects[key] && typeof projects[key] === 'object' ? projects[key] : {}
      const next = { ...was }
      const here = []
      if (!said(was, 'hasTrustDialogAccepted')) { next.hasTrustDialogAccepted = true; here.push('hasTrustDialogAccepted') }
      // The imports question is answered separately, and declining it is also
      // an answer: WarningShown true with Approved false is a recorded "no".
      if (imports.length && !said(was, 'hasClaudeMdExternalIncludesWarningShown') && !said(was, 'hasClaudeMdExternalIncludesApproved')) {
        next.hasClaudeMdExternalIncludesApproved = true
        next.hasClaudeMdExternalIncludesWarningShown = true
        here.push('hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown')
      }
      if (!here.length) continue
      projects[key] = next
      changed.push(...here)
    }
    // Rule 2: nothing to say that the file does not already say.
    if (!changed.length) return
    writeJsonAtomic(file, { ...cfg, projects })
    wrote = [...new Set(changed)]
  })
  if (wrote === null) return { agent: 'claude', file, wrote: [], imports, skipped: 'claude config is not readable json' }
  if (wrote === 'declined') return { agent: 'claude', file, root, wrote: [], imports, skipped: 'you answered no for this folder; Leg leaves that answer alone' }
  return { agent: 'claude', file, root, wrote, imports, skipped: null }
}

// ---- codex ----

export function codexConfigFile(env = process.env) {
  const dir = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex')
  return join(dir, 'config.toml')
}

// TOML basic strings escape a backslash, which is every separator on Windows.
const tomlPath = (p) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export function ensureCodexTrust(repo, { env = process.env } = {}) {
  const file = codexConfigFile(env)
  const root = repoRootOf(repo)
  if (!existsSync(file)) return { agent: 'codex', file, wrote: [], imports: [], skipped: 'no codex config yet' }
  let wrote = []
  withFileLock(`${file}.baton-lock`, () => {
    let text
    try { text = readFileSync(file, 'utf8') } catch { wrote = null; return }
    if (codexTrustedPaths(text).some((p) => samePath(p, root))) return
    const block = `\n[projects."${tomlPath(root)}"]\ntrust_level = "trusted"\n`
    // Append only: a TOML table added at the end cannot change the meaning of
    // a table above it, and Leg never reformats a file it did not write.
    writeTextAtomic(file, text.endsWith('\n') ? text + block : text + '\n' + block)
    wrote = ['trust_level']
  })
  if (wrote === null) return { agent: 'codex', file, wrote: [], imports: [], skipped: 'codex config is not readable' }
  return { agent: 'codex', file, root, wrote, imports: [], skipped: null }
}

// Every folder config.toml already names. Codex writes the same folder two
// ways, plain and in the \\?\ extended-length form, so both unescape to the
// path we are about to compare against.
export function codexTrustedPaths(text) {
  const out = []
  for (const m of text.matchAll(/^\s*\[projects\."((?:[^"\\]|\\.)*)"\]/gm)) {
    const raw = m[1].replace(/\\(.)/g, '$1')
    out.push(raw.replace(/^\\\\\?\\/, ''))
  }
  return out
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text)
  for (let i = 0; i < 20; i++) {
    try { renameSync(tmp, file); return } catch (err) {
      // Windows holds a brief lock on a file another process has open; the
      // same retry the rest of Leg uses rather than lose the config.
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(err.code)) { try { unlinkSync(tmp) } catch {} throw err }
      const until = Date.now() + 25
      while (Date.now() < until) { /* spin */ }
    }
  }
  try { unlinkSync(tmp) } catch {}
  writeFileSync(file, text)
}

// ---- agy ----

export function agyTrustFile(env = process.env) {
  const base = env.GEMINI_CONFIG_DIR ? resolve(env.GEMINI_CONFIG_DIR) : join(homedir(), '.gemini')
  if (base.endsWith('default-cli-project.json')) return base
  if (base.endsWith('projects')) return join(base, 'default-cli-project.json')
  if (base.endsWith('config')) return join(base, 'projects', 'default-cli-project.json')
  return join(base, 'config', 'projects', 'default-cli-project.json')
}

export function agyFolderUri(repo) {
  const root = repoRootOf(repo)
  let p = root.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  return `file://${p}`
}

export function agyUriMatches(uri, root) {
  if (typeof uri !== 'string') return false
  let p = uri.replace(/^file:\/\//, '').replace(/%3A/gi, ':')
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  p = p.replace(/\//g, '\\')
  return samePath(p, root)
}

export function ensureAgyTrust(repo, { env = process.env } = {}) {
  const file = agyTrustFile(env)
  const root = repoRootOf(repo)
  if (!existsSync(dirname(file))) return { agent: 'agy', file, wrote: [], imports: [], skipped: 'no agy config yet' }
  let wrote = []
  withFileLock(`${file}.baton-lock`, () => {
    const project = existsSync(file)
      ? readJson(file)
      : { id: 'default-cli-project', name: 'CLI Project', projectResources: { resources: [] } }
    if (!project || typeof project !== 'object') { wrote = null; return }

    if (!project.projectResources || typeof project.projectResources !== 'object') {
      project.projectResources = {}
    }
    if (!Array.isArray(project.projectResources.resources)) {
      project.projectResources.resources = []
    }

    const declined = project.projectResources.resources.some((res) => {
      const uri = res.gitFolder?.folderUri ?? res.folderUri
      return agyUriMatches(uri, root) && res.gitFolder?.allowWrite === false
    })
    if (declined) { wrote = 'declined'; return }

    const alreadyTrusted = project.projectResources.resources.some((res) => {
      const uri = res.gitFolder?.folderUri ?? res.folderUri
      return agyUriMatches(uri, root)
    })
    if (alreadyTrusted) return

    project.projectResources.resources.push({
      gitFolder: {
        folderUri: agyFolderUri(root),
        defaultBranch: 'main',
        allowWrite: true,
      },
    })
    writeJsonAtomic(file, project)
    wrote = ['gitFolder']
  })
  if (wrote === null) return { agent: 'agy', file, wrote: [], imports: [], skipped: 'agy trust file is not readable json' }
  if (wrote === 'declined') return { agent: 'agy', file, root, wrote: [], imports: [], skipped: 'you answered no for this folder; Leg leaves that answer alone' }
  return { agent: 'agy', file, root, wrote, imports: [], skipped: null }
}

// ---- the one entry point ----

const ENSURE = { claude: ensureClaudeTrust, codex: ensureCodexTrust, agy: ensureAgyTrust }

// Returns a result even when nothing was written, so the caller can say why.
export function ensureTrust(agent, repo, { env = process.env, cwd = repo } = {}) {
  if (trustPolicy(env) === 'never') return { agent, wrote: [], imports: [], skipped: 'BATON_TRUST=never' }
  const fn = ENSURE[agent]
  if (!fn) return { agent, wrote: [], imports: [], skipped: `no trust record for ${agent}` }
  try {
    return fn(repo, { env, cwd })
  } catch (err) {
    // A trust record Leg could not write is a prompt the user will answer
    // themselves. It is never a reason to fail the session.
    return { agent, wrote: [], imports: [], skipped: `could not write the trust record: ${err.message}` }
  }
}

// The line Leg prints. Null when there is nothing worth saying.
export function trustLine(result) {
  if (!result || !result.wrote?.length) return null
  const what = result.agent === 'claude' && result.imports?.length
    ? `trusted ${result.root} for claude, and allowed ${result.imports.length} external CLAUDE.md import${result.imports.length === 1 ? '' : 's'}: ${result.imports.join(', ')}`
    : `trusted ${result.root} for ${result.agent}`
  return `${what} (recorded in ${result.file}; BATON_TRUST=never turns this off)`
}

