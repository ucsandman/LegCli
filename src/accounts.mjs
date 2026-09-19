// accounts — optional second (third…) subscription logins per agent.
// `default` is the CLI's own home (~/.claude, ~/.codex). An extra account is a
// directory under $BATON_HOME/accounts/<agent>/<name>/ that the CLI is pointed
// at with its config-dir variable (CLAUDE_CONFIG_DIR, CODEX_HOME); the
// harness (hooks, skills, agents, commands, plugins, rules, prompts…) is shared
// back into it with directory junctions, and the settings file is refreshed
// from the real home before every launch. Only the login lives in the
// account dir. agy 1.2.0 has no config-dir override, so it stays one account.
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, lstatSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join, relative, dirname, basename, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { home } from './store.mjs'
import { writeJsonAtomic } from './fsx.mjs'

// What each CLI keeps in its home. `share` dirs are junctioned into the
// account dir; `copy` files are refreshed from the real home at launch;
// everything else (credentials, sessions, history, caches) stays per account.
export const LAYOUT = {
  claude: {
    env: 'CLAUDE_CONFIG_DIR',
    home: () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    // `projects` is the conversation store (projects/<encoded cwd>/<id>.jsonl,
    // and the auto-memory beside it). Shared, not copied, so a hand-off to the
    // second login can run `claude --resume <id>` on the transcript the first
    // login was writing, and the same human's memory follows them. Claude Code
    // does the writing; Leg reads that directory and never writes it.
    share: ['hooks', 'skills', 'agents', 'commands', 'plugins', 'rules', 'scripts', 'output-styles', 'tools', 'projects'],
    copy: ['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json', 'statusline.ps1', 'statusline-combined.ps1'],
    login: (dir) => `$env:CLAUDE_CONFIG_DIR='${dir}'; claude auth login`,
  },
  codex: {
    env: 'CODEX_HOME',
    home: () => process.env.CODEX_HOME || join(homedir(), '.codex'),
    share: ['skills', 'prompts', 'rules', 'plugins', 'agents', 'hooks', 'memories', 'superpowers'],
    copy: ['config.toml', 'AGENTS.md'],
    login: (dir) => `$env:CODEX_HOME='${dir}'; codex login`,
  },
  agy: { env: null, home: () => join(homedir(), '.gemini', 'antigravity-cli'), share: [], copy: [], login: null },
  grok: {
    env: 'GROK_HOME',
    home: () => process.env.GROK_HOME || join(homedir(), '.grok'),
    share: ['installed-plugins', 'skills', 'workflows'],
    copy: ['config.toml'],
    login: (dir) => `$env:GROK_HOME='${dir}'; grok login`,
  },
}

export function accountsFile() { return join(home(), 'accounts.json') }
export function accountDir(agent, name) { return join(home(), 'accounts', agent, name) }

// A name is a directory segment, never a path: it is joined into the CLI's
// config dir and into the usage record's file name. Exported so the one rule
// has one owner (src/preferences.mjs validates a rung's account with it, and
// src/usage.mjs refuses to write a record under anything else).
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/i
const NAME_RE = ACCOUNT_NAME_RE

export function readAccounts() {
  const base = { claude: ['default'], codex: ['default'], agy: ['default'], grok: ['default'] }
  if (!existsSync(accountsFile())) return base
  try {
    const j = JSON.parse(readFileSync(accountsFile(), 'utf8'))
    // the same shape addAccount accepts: a name is a directory segment, never a path
    for (const k of Object.keys(base)) if (Array.isArray(j[k])) base[k] = ['default', ...j[k].filter((n) => typeof n === 'string' && n !== 'default' && NAME_RE.test(n))]
  } catch {}
  return base
}

function writeAccounts(acc) {
  mkdirSync(home(), { recursive: true })
  writeJsonAtomic(accountsFile(), Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.filter((n) => n !== 'default')])))
}

export function envFor(agent, account) {
  if (account === 'default') return {}
  const l = LAYOUT[agent]
  if (!l?.env) return {}
  return { [l.env]: accountDir(agent, account) }
}

// The config directory a login runs from: the CLI's own home for `default`,
// the account directory for anything else. Null for an agent Leg does not know.
export function homeFor(agent, account = 'default') {
  const l = LAYOUT[agent]
  if (!l) return null
  return account === 'default' ? l.home() : accountDir(agent, account)
}

// Whether the conversation file one login was writing is visible to another
// login of the same agent: the transcript's path relative to the source home
// must exist under the destination home. True through the `projects` junction
// an account carries; false for an account made before that junction existed
// (until its next launch adds it), for a transcript outside the source home,
// and for an agent with no per-account home at all. A false answer means the
// bundle, never a `--resume` that would open an empty conversation.
export function transcriptReachable(agent, transcriptPath, { from = 'default', to = 'default' } = {}) {
  if (!transcriptPath || from === to || !LAYOUT[agent]?.env) return false
  const dst = homeFor(agent, to)
  if (!dst) return false
  const where = realDir(dirname(transcriptPath))
  // the transcript's place inside whichever home really holds it: the source
  // login's, the destination's, or the CLI's own. A path a CLI reported through
  // an account's junction resolves to the real home, and a record that kept
  // the first login's path while the terminal moved on is still one file.
  for (const account of new Set([from, to, 'default'])) {
    const h = homeFor(agent, account)
    if (!h) continue
    const rel = relative(realDir(h), where)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    return existsSync(join(dst, rel, basename(transcriptPath)))
  }
  return false
}

// A directory's real path, for comparing a transcript's location against a
// home that may itself be reached through a junction; the path as given when
// it does not exist.
function realDir(p) { try { return realpathSync.native(p) } catch { return resolve(p) } }

function junction(target, link) {
  if (existsSync(link)) return false
  if (!existsSync(target)) return false
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

// The shared directories, junctioned into the account dir when they are not
// there yet. Runs at creation and before every launch, so an account made by
// an older Leg picks up a directory added to `share` since (the `projects`
// store, for one) the next time it starts.
export function ensureShared(agent, name) {
  if (name === 'default') return []
  const l = LAYOUT[agent]
  if (!l?.env) return []
  const dir = accountDir(agent, name)
  if (!existsSync(dir)) return []
  const src = l.home()
  const shared = []
  for (const d of l.share) if (junction(join(src, d), join(dir, d))) shared.push(d)
  return shared
}

// Create the account dir, junction the shared harness in, copy the settings.
export function addAccount(agent, name) {
  if (!NAME_RE.test(name) || name === 'default') throw new Error(`invalid account name "${name}" (letters, digits, - and _; not "default")`)
  const l = LAYOUT[agent]
  if (!l) throw new Error(`unknown agent "${agent}" (claude|codex|agy|grok)`)
  if (!l.env) throw new Error(`${agent} has no config-dir override in the installed version; extra accounts are not possible`)
  const dir = accountDir(agent, name)
  mkdirSync(dir, { recursive: true })
  const shared = ensureShared(agent, name)
  refreshAccount(agent, name)
  const acc = readAccounts()
  if (!acc[agent]) acc[agent] = ['default']
  if (!acc[agent].includes(name)) { acc[agent].push(name); writeAccounts(acc) }
  return { dir, shared, login: l.login(dir), env: l.env }
}

// Before each launch: bring the copied files up to date with the real home,
// and add any shared directory the account is still missing.
export function refreshAccount(agent, name) {
  if (name === 'default') return []
  const l = LAYOUT[agent]
  const dir = accountDir(agent, name)
  ensureShared(agent, name)
  const copied = []
  for (const f of l.copy) {
    const s = join(l.home(), f)
    if (!existsSync(s)) continue
    try { copyFileSync(s, join(dir, f)); copied.push(f) } catch {}
  }
  return copied
}

export function removeAccount(agent, name) {
  const dir = accountDir(agent, name)
  if (existsSync(dir)) {
    // junctions are removed as links, never followed
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (lstatSync(p).isSymbolicLink()) rmSync(p, { force: true })
    }
    rmSync(dir, { recursive: true, force: true })
  }
  const acc = readAccounts()
  acc[agent] = acc[agent].filter((n) => n !== name)
  writeAccounts(acc)
}

export function listAccountRows() {
  const acc = readAccounts()
  const rows = []
  for (const agent of Object.keys(acc)) for (const name of acc[agent]) rows.push({ agent, name, dir: name === 'default' ? LAYOUT[agent].home() : accountDir(agent, name), env: name === 'default' ? null : LAYOUT[agent].env })
  return rows
}
