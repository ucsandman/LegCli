// accounts — optional second (third…) subscription logins per agent.
// `default` is the CLI's own home (~/.claude, ~/.codex). An extra account is a
// directory under $BATON_HOME/accounts/<agent>/<name>/ that the CLI is pointed
// at with its config-dir variable (CLAUDE_CONFIG_DIR, CODEX_HOME); the
// harness (hooks, skills, agents, commands, plugins, rules, prompts…) is shared
// back into it with directory junctions, and the settings file is refreshed
// from the real home before every launch. Only the login lives in the
// account dir. agy 1.2.0 has no config-dir override, so it stays one account.
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, lstatSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
    share: ['hooks', 'skills', 'agents', 'commands', 'plugins', 'rules', 'scripts', 'output-styles', 'tools'],
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
}

export function accountsFile() { return join(home(), 'accounts.json') }
export function accountDir(agent, name) { return join(home(), 'accounts', agent, name) }

export function readAccounts() {
  const base = { claude: ['default'], codex: ['default'], agy: ['default'] }
  if (!existsSync(accountsFile())) return base
  try {
    const j = JSON.parse(readFileSync(accountsFile(), 'utf8'))
    for (const k of Object.keys(base)) if (Array.isArray(j[k])) base[k] = ['default', ...j[k].filter((n) => n !== 'default')]
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

function junction(target, link) {
  if (existsSync(link)) return false
  if (!existsSync(target)) return false
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

// Create the account dir, junction the shared harness in, copy the settings.
export function addAccount(agent, name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,29}$/i.test(name) || name === 'default') throw new Error(`invalid account name "${name}" (letters, digits, - and _; not "default")`)
  const l = LAYOUT[agent]
  if (!l) throw new Error(`unknown agent "${agent}" (claude|codex|agy)`)
  if (!l.env) throw new Error(`${agent} has no config-dir override in the installed version; extra accounts are not possible`)
  const dir = accountDir(agent, name)
  mkdirSync(dir, { recursive: true })
  const src = l.home()
  const shared = []
  for (const d of l.share) if (junction(join(src, d), join(dir, d))) shared.push(d)
  refreshAccount(agent, name)
  const acc = readAccounts()
  if (!acc[agent].includes(name)) { acc[agent].push(name); writeAccounts(acc) }
  return { dir, shared, login: l.login(dir), env: l.env }
}

// Before each launch: bring the copied files up to date with the real home.
export function refreshAccount(agent, name) {
  if (name === 'default') return []
  const l = LAYOUT[agent]
  const dir = accountDir(agent, name)
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
