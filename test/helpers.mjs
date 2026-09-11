// Shared test helpers: a throwaway BATON_HOME, a toy git repo, and the CLI.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BATON = join(ROOT, 'bin', 'baton.mjs')

export function makeHome() {
  return mkdtempSync(join(tmpdir(), 'baton-home-'))
}

export function testEnv(home, extra = {}) {
  const env = { ...process.env, BATON_HOME: home, BATON_TIMERS_MS: '60000,120000', BATON_POLL_MS: '250', BATON_QUIET: '1', ...extra }
  delete env.DASHCLAW_URL
  delete env.DASHCLAW_API_KEY
  delete env.FAKE_MODE
  return env
}

export function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initRepo(prefix = 'toy-') {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), '# toy\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

export function baton(args, env) {
  return execFileSync(process.execPath, [BATON, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function batonFail(args, env) {
  try {
    return { status: 0, stdout: baton(args, env), stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

export function batonSpawn(args, env) {
  return spawn(process.execPath, [BATON, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function readCard(home, id) {
  return JSON.parse(readFileSync(join(home, 'cards', id, 'card.json'), 'utf8'))
}

export function events(home, id) {
  const dir = join(home, 'cards', id)
  const out = []
  for (const f of ['events-human-local.jsonl', 'events-baton.jsonl']) {
    if (existsSync(join(dir, f))) out.push(...readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
