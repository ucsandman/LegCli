// attach — `leg claude|codex|agy [args…]`: the normal interactive agent in
// this terminal, with Leg alongside it. Leg (1) makes sure the board is
// up and opens it once, (2) registers the session so it shows on the board,
// (3) taps the agent for usage (claude: hooks + status line via --settings;
// codex: its rollout file; agy: its log), (4) polls git for the files the
// session touches, (5) keeps the handoff bundle current, and (6) on a usage
// limit saves the bundle, stops the agent, and starts the next option in the
// same terminal from that bundle. Subscription logins only: API keys are
// stripped from the child environment (src/env.mjs).
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from './env.mjs'
import { home } from './store.mjs'
import { get as getAdapter } from './adapters/index.mjs'
import { SUPERVISED_AGENTS, HANDOFF_ORDER_CAPABILITY, newSessionId, createSession, readSession, updateSession, appendEvent, takeControl, sessionDir, listSessions, reapLost, isActive, workRoot } from './sessions.mjs'
import { ensure as ensureWorktree, remove as removeWorktree } from './worktree.mjs'
import { canonPath, realPath } from './fsx.mjs'
import { whoami, readShare, isOn as shareIsOn } from './share.mjs'
import { readAccounts, envFor, refreshAccount } from './accounts.mjs'
import { recordUsage, markLimited, chooseNext, candidates, fmtReset, WARN_PCT, readUsage, isAvailable } from './usage.mjs'
import { entitlement, allows, describe as describeLicense } from './license.mjs'
import { writeSettings, userStatusLine, transcriptTail as claudeTail } from './taps/claude.mjs'
import { ensureTrust, trustLine } from './trust.mjs'
import { findRollout, createTail, parseLines, readCodexUsage, transcriptTail as codexTail } from './taps/codex.mjs'
import { scanLog, promptsSince, logSize } from './taps/agy.mjs'
import { fetchGrokUsage, scanLog as scanGrokLog, promptsSince as grokPromptsSince } from './taps/grok.mjs'
import { fetchClaudeUsage } from './taps/claude-usage.mjs'
import { saveSessionBundle, resumePrompt, sessionCommitDelta } from './bundle.mjs'
import { endSessionPointer } from './resume.mjs'
import { openBoard, pidfile } from './launcher.mjs'
import { LAYOUT } from './accounts.mjs'
import { captureLive } from './live-capture.mjs'
import { waitForReset, fmtCountdown } from './wait.mjs'
import { readPreferences, normalizeHandoffOrder, resolveAutoApprove } from './preferences.mjs'
import { prepareHarnessForHandoff, harnessLine } from './harness/index.mjs'
import { insideKnownStore } from './history/index.mjs'

const SRC = dirname(fileURLToPath(import.meta.url))
function resolveServer() {
  const wtMatch = /[\\/]\.(?:leg|baton)-worktrees(?:[\\/].*)?$/.exec(SRC)
  if (wtMatch) {
    const root = SRC.slice(0, wtMatch.index)
    const mainServer = join(root, 'src', 'server.mjs')
    if (existsSync(mainServer)) return mainServer
  }
  return join(SRC, 'server.mjs')
}
const SERVER = resolveServer()
const POLL_MS = Number(process.env.LEG_ATTACH_POLL_MS || process.env.BATON_ATTACH_POLL_MS || 2000)
const GIT_EVERY = 3 // polls
const USAGE_MS = Number(process.env.LEG_USAGE_POLL_MS || process.env.BATON_USAGE_POLL_MS || 60000)
const say = (line) => process.stderr.write(`[leg] ${line}\n`)

async function refreshCodexUsage(account, codexHome, { timeoutMs = 8000, signal = null } = {}) {
  const r = await readCodexUsage({ codexHome, timeoutMs, signal })
  if (!r.ok) return r
  const u = recordUsage('codex', account, { ...r.limits, facts: r.facts }, 'codex app-server account/rateLimits/read', { observed_at: r.observed_at, available: r.available })
  return { ...r, usage: u }
}

export function isCurrentLeg(session, { pid, agent, account }) {
  return Boolean(session && session.pid === pid && session.agent === agent && session.account === account)
}

// ---- board ----
function health(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const req = http.get({ host, port, path: '/api/health', timeout: 4000 }, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        // 401 is a board: with share on, even health asks for a token
        if (r.statusCode === 401) return res({ ok: true, guarded: true })
        try { res(r.statusCode === 200 ? JSON.parse(d) : null) } catch { res(null) }
      })
    })
    req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null) })
  })
}

// Does anything own this port? A completed TCP connect is the question, so a
// board too busy to answer /api/health still counts as one. Nothing is sent.
function portTaken(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const sock = net.connect({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port })
    const done = (v) => { sock.destroy(); res(v) }
    sock.setTimeout(2000)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    sock.on('timeout', () => done(false))
  })
}

export async function ensureBoard({ open = true } = {}) {
  // with share on the board lives on the shared address, not loopback
  const share = readShare()
  const shared = shareIsOn(share)
  const port = shared ? share.port : Number(process.env.LEG_PORT || process.env.BATON_PORT || 4747)
  const host = shared ? share.bind : '127.0.0.1'
  const url = `http://${host}:${port}`
  if ((process.env.LEG_NO_BOARD || process.env.BATON_NO_BOARD) === '1') return { url: null, started: false, skipped: true }
  // the board is opened whether or not this terminal is the one that started
  // it: `leg claude` in a second terminal still means "show me the board"
  if (await health(port, host)) { if (open) openBoard(url); return { url, started: false } }
  // A board that is merely busy misses the health deadline while still owning
  // the port. Treating that as "no board" spawned a second server that could
  // only die of EADDRINUSE, and the poll below then waited the full fifteen
  // seconds for a child already gone — the whole delay before the agent
  // starts, and the reason no browser ever opened. A listener on the port is
  // a board: attach to it and open it.
  if (await portTaken(port, host)) {
    say(`the board on ${url} is busy; attaching to it`)
    if (open) openBoard(url)
    return { url, started: false, busy: true }
  }
  mkdirSync(home(), { recursive: true })
  const logFd = (await import('node:fs')).openSync(join(home(), 'board.log'), 'a')
  const child = spawn(process.execPath, [SERVER], { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, LEG_PORT: String(port), LEG_BIND: host, LEG_QUIET: '0', BATON_PORT: String(port), BATON_BIND: host, BATON_QUIET: '0' } })
  child.unref()
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    const h = await health(port, host)
    if (h) {
      // only claim the pidfile for a child we actually started: under a race,
      // another `leg` won the port and ours died on EADDRINUSE — writing our
      // dead pid would make `leg down` kill nothing and report "not running"
      const ours = h.pid ? h.pid === child.pid : (child.exitCode === null && Boolean(child.pid))
      if (ours) writeFileSync(pidfile(), JSON.stringify({ pid: child.pid, port, bind: host, children: [child.pid], detached: true, started_by: 'attach', started_at: new Date().toISOString() }, null, 2) + '\n')
      if (open) openBoard(url)
      return { url, started: ours }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  say(`board did not come up on ${url} (see ${join(home(), 'board.log')}); continuing without it`)
  return { url, started: false, failed: true }
}

// ---- git ----
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  // trimEnd only: a porcelain line starts with a space (" M README.md")
  return r.status === 0 ? r.stdout.trimEnd() : null
}
export function gitInfo(cwd) {
  const repo = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!repo) return { repo: null, branch: null, head: null, dirty: [] }
  return {
    repo: repo.replace(/\//g, process.platform === 'win32' ? '\\' : '/'),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: (git(cwd, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => !/^(\.leg|\.baton|\.context-handoffs|\.dashclaw-local)\//.test(f)),
  }
}

// ---- collisions ----
// Two agents in one working tree write over each other's files. When another
// live session already works in this checkout, this one gets its own:
// <repo>/.baton-worktrees/<sid> on branch baton/<sid>, cut from the branch the
// checkout has out, and it comes back through the merge queue (Land on its card).
export function isolate({ g, cwd, sid, sessions = reapLost(listSessions()) }) {
  const here = canonPath(g.repo)
  // exclude this session itself: its record now exists before isolate runs, and
  // a session must never be isolated from its own checkout
  const live = sessions.filter((s) => s.session_id !== sid && isActive(s) && workRoot(s) && canonPath(workRoot(s)) === here)
  if (!live.length) return null
  const base = g.branch && g.branch !== 'HEAD' ? g.branch : null
  const wt = ensureWorktree(g.repo, sid, { trunk: base ?? 'HEAD' })
  const sub = relative(realPath(g.repo), realPath(cwd))
  const inTree = sub && !sub.startsWith('..') ? join(wt.path, sub) : wt.path
  return { path: wt.path, branch: wt.branch, base, cwd: existsSync(inTree) ? inTree : wt.path, live }
}

// Which agents are actually on this machine, so the chooser never hands off to
// a binary that is not installed (that spawned ENOENT and killed the session
// with exit 127 instead of waiting for a reset). Resolves each adapter the way
// the runner would spawn it (native exe, npm entry, or BATON_<AGENT>_BIN).
async function loadAdapter(name) {
  if (name === 'grok') return (await import('./adapters/grok.mjs')).default
  return getAdapter(name)
}

let installedCache = null
async function installedAgents() {
  if (installedCache) return installedCache
  const out = {}
  for (const name of SUPERVISED_AGENTS) {
    try {
      const { bin, viaNode, entry } = (await loadAdapter(name)).resolve()
      const target = viaNode ? (entry ?? bin) : bin
      if (/[\\/]/.test(target)) out[name] = existsSync(target)
      else { const r = spawnSync(target, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 8000 }); out[name] = !r.error && r.status === 0 }
    } catch { out[name] = false }
  }
  installedCache = out
  return out
}

// ---- process control ----
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  else { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} } }
}
// A killed agent never runs its own cleanup, so every mode it set outlives it:
// mouse reporting (the wheel then prints `[<65;40;24M` runs into the shell),
// bracketed paste, application keys, autowrap off, and a scrolling region that
// makes the next leg's output land on top of the lines already on screen.
// DECSTBM homes the cursor, so the margin reset is wrapped in DECSC/DECRC, and
// the erase clears only the dead agent's half-drawn frame below the cursor.
export const TERMINAL_RESET =
  '\x1b[?1049l' +                                                          // leave any alternate screen
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +   // every mouse reporting mode
  '\x1b[?1004l\x1b[?2004l' +                                               // focus events, bracketed paste
  '\x1b[?1l\x1b>' +                                                        // normal cursor keys, numeric keypad
  '\x1b[?7h' +                                                             // autowrap
  '\x1b7\x1b[r\x1b8' +                                                     // full-height scrolling region, cursor kept
  '\x1b[?25h\x1b[0m' +                                                     // cursor visible, default attributes
  '\r\x1b[J\n'                                                             // a clean line to continue on

function restoreTerminal() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch {}
  try { process.stdout.write(TERMINAL_RESET) } catch {}
}

// ---- spawn spec per agent ----
export async function spawnSpec(agent, { account, args, sessionId, prompt, cwd, autoApprove = resolveAutoApprove() }) {
  const adapter = await loadAdapter(agent)
  const { bin, viaNode, entry } = adapter.resolve()
  const argv = []
  // viaNode: either an npm entry (codex bin/codex.js) or a BATON_<AGENT>_BIN that names a .mjs (tests)
  if (viaNode) argv.push(entry ?? bin)
  // a leg Leg starts on its own (after a hand-off) takes BATON_<AGENT>_ARGS,
  // e.g. BATON_CODEX_ARGS="-m gpt-5-mini" to keep a test chain on cheap models
  if (prompt) args = [...(process.env[`LEG_${agent.toUpperCase()}_ARGS`] ?? process.env[`BATON_${agent.toUpperCase()}_ARGS`] ?? '').split(/\s+/).filter(Boolean), ...args]
  if (agent === 'claude') {
    const settings = writeSettings(sessionId, { statusLine: userStatusLine(process.env.CLAUDE_CONFIG_DIR || (account !== 'default' ? envFor('claude', account).CLAUDE_CONFIG_DIR : undefined)) })
    const autoFlags = autoApprove && !args.includes('--dangerously-skip-permissions') ? ['--dangerously-skip-permissions'] : [] // auto-approve: not forbidden for interactive sessions
    argv.push(...args, ...autoFlags, '--settings', settings)
    if (prompt) argv.push(prompt)
  } else if (agent === 'codex') {
    const hasApproval = args.includes('--ask-for-approval') || args.includes('-a') || args.some((x) => typeof x === 'string' && x.startsWith('--ask-for-approval='))
    const autoFlags = autoApprove && !hasApproval ? ['--ask-for-approval', 'never'] : []
    argv.push(...args, ...autoFlags)
    if (prompt) argv.push(prompt)
  } else if (agent === 'agy') {
    const log = join(sessionDir(sessionId), 'agy.log')
    const autoFlags = autoApprove && !args.includes('--dangerously-skip-permissions') ? ['--dangerously-skip-permissions'] : [] // auto-approve: not forbidden for interactive sessions
    argv.push(...args, ...autoFlags, '--log-file', log)
    if (prompt) argv.push('-i', prompt)
  } else if (agent === 'grok') {
    const log = join(sessionDir(sessionId), 'grok.log')
    const hasApprove = args.includes('--always-approve') || args.includes('--yolo') || args.includes('--approval-mode=yolo') // auto-approve check: not forbidden for interactive sessions
    const autoFlags = autoApprove && !hasApprove ? ['--always-approve'] : [] // auto-approve: not forbidden for interactive sessions
    argv.push(...args, ...autoFlags, '--debug-file', log)
    if (prompt) argv.push(prompt)
  }
  const env = { ...sanitizeEnv(process.env, { interactive: true }), ...envFor(agent, account), LEG_SESSION: sessionId, BATON_SESSION: sessionId }
  return { bin: viaNode ? process.execPath : bin, args: argv, env, cwd }
}

// ---- one agent leg ----
// Returns { reason: 'exit'|'limit'|'handoff', code, target } — `target` is the
// destination a human picked on the board ("Hand off now to codex"), carried
// out to the loop below, which is what chooses the next leg.

async function runLeg({ agent, account, args, session, prompt, boardUrl, autoApprove = resolveAutoApprove() }) {
  const sid = session.session_id
  refreshAccount(agent, account)
  // A handoff happens when the limit hits, which is usually when nobody is
  // watching. An agent that has never run in this folder would stop on its
  // first-run trust prompt and wait for a keypress that is not coming, so the
  // answer goes on file before the agent starts. BATON_TRUST=never opts out.
  const trust = ensureTrust(agent, session.cwd, { cwd: session.cwd })
  const trusted = trustLine(trust)
  if (trusted) { say(trusted); appendEvent(sid, { type: 'trust', summary: trusted }) }
  const spec = await spawnSpec(agent, { account, args, sessionId: sid, prompt, cwd: session.cwd, autoApprove })
  appendEvent(sid, { type: 'leg', summary: `${agent} (${account}) starting${prompt ? ' from the handoff bundle' : ''}` })
  const startedMs = Date.now()
  const turnsAtLegStart = session.turns ?? 0
  // agy appends to one log for the whole session: a second agy leg reads from
  // the end of what the first one wrote, or it walls itself on that leg's line
  const agyLog = agent === 'agy' ? join(sessionDir(sid), 'agy.log') : null
  const agyTail = agyLog ? createTail(agyLog, { from: logSize(agyLog) }) : null
  const grokLog = agent === 'grok' ? join(sessionDir(sid), 'grok.log') : null
  const grokTail = grokLog ? createTail(grokLog, { from: logSize(grokLog) }) : null
  let child
  try {
    child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit', windowsHide: false })
  } catch (err) {
    updateSession(sid, { status: 'ended', ended_at: new Date().toISOString() }, { event: { type: 'error', summary: `${agent} failed to start: ${err.message}` } })
    return { reason: 'exit', code: 127 }
  }
  // every leg starts on its own card: the agent that just left takes its
  // percentages, its warning and its usage source with it
  updateSession(sid, { pid: child.pid, agent, account, status: agent === 'claude' ? 'starting' : 'running', limit: null, warning: null, limits: null, usage_source: null, usage_error: null })

  // taps
  let rollout = null; let tail = null
  // a continued codex thread appends to its old rollout, which findRollout
  // (newest file since this leg started) would never pick: bind it up front
  // and read only what the thread writes from here on
  if (agent === 'codex' && !prompt && session.transcript_path && session.agent_session_id && existsSync(session.transcript_path)) {
    rollout = { path: session.transcript_path, meta: { id: session.agent_session_id } }
    tail = createTail(rollout.path, { from: logSize(rollout.path) })
  }
  let polls = 0; let warned = false
  let stop = null
  const done = new Promise((res) => { stop = res })
  child.on('error', (err) => { appendEvent(sid, { type: 'error', summary: `${agent} spawn error: ${err.message}` }); stop({ reason: 'exit', code: 127 }) })
  child.on('exit', (code) => stop({ reason: 'exit', code: code ?? -1 }))

  // claude: the 5h/7d percentages come from Claude Code's usage endpoint
  // (src/taps/claude-usage.mjs); the wall itself arrives through the
  // StopFailure hook.
  let usageTimer = null
  const usageAbort = new AbortController()
  if (agent === 'claude') {
    const pollUsage = async () => {
      const r = await fetchClaudeUsage({ configDir: spec.env.CLAUDE_CONFIG_DIR || LAYOUT.claude.home() })
      const s = readSession(sid)
      if (!isCurrentLeg(s, { pid: child.pid, agent, account })) return
      // a 404, a body that is not JSON, or a shape with no window at all: the
      // card says usage unknown and the StopFailure hook still owns the limit
      const usable = r.ok && r.limits && (r.limits.five_hour || r.limits.seven_day)
      if (usable) {
        recordUsage('claude', account, r.limits, 'claude usage endpoint')
        // the session record keeps the two windows it always had: the buckets
        // live on the usage record, which is per login and not per terminal
        updateSession(sid, { limits: { five_hour: r.limits.five_hour, seven_day: r.limits.seven_day }, usage_source: 'claude usage endpoint', usage_error: null })
      } else if (!s.usage_error) {
        const why = r.error ?? 'the usage endpoint answered with no window'
        updateSession(sid, { usage_error: why }, { event: { type: 'status', summary: `claude usage unavailable: ${why}` } })
      }
    }
    pollUsage().catch(() => {})
    usageTimer = setInterval(() => pollUsage().catch(() => {}), USAGE_MS)
    usageTimer.unref?.()
  } else if (agent === 'codex' && !(process.env.LEG_CODEX_BIN || process.env.BATON_CODEX_BIN)) {
    const pollUsage = async () => {
      const r = await refreshCodexUsage(account, spec.env.CODEX_HOME || LAYOUT.codex.home(), { signal: usageAbort.signal })
      const s = readSession(sid)
      if (!isCurrentLeg(s, { pid: child.pid, agent, account })) return
      if (r.ok) {
        const patch = { limits: r.limits, usage_source: 'codex app-server account/rateLimits/read', usage_error: null }
        if (r.available === false) {
          patch.status = 'limit'
          patch.limit = { reason: 'usage_limit_exceeded', detail: 'Codex reports ordinary usage is unavailable', resets_at: r.usage.limited_until, at: r.observed_at }
        }
        updateSession(sid, patch)
      } else if (!s.usage_error) {
        updateSession(sid, { usage_error: r.error }, { event: { type: 'status', summary: `codex usage unavailable: ${r.error}` } })
      }
    }
    pollUsage().catch(() => {})
    usageTimer = setInterval(() => pollUsage().catch(() => {}), USAGE_MS)
    usageTimer.unref?.()
  } else if (agent === 'grok') {
    const pollUsage = async () => {
      const configDir = spec.env.GROK_HOME || LAYOUT.grok.home()
      const r = await fetchGrokUsage({ configDir })
      const s = readSession(sid)
      if (!isCurrentLeg(s, { pid: child.pid, agent, account })) return
      const usable = r.ok && r.limits && (r.limits.five_hour || r.limits.seven_day)
      if (usable) {
        recordUsage('grok', account, r.limits, 'grok billing proxy')
        updateSession(sid, { limits: r.limits, usage_source: 'grok billing proxy', usage_error: null })
      } else if (!s.usage_error) {
        const why = r.error ?? 'the usage endpoint answered with no window'
        updateSession(sid, { usage_error: why }, { event: { type: 'status', summary: `grok usage unavailable: ${why}` } })
      }
    }
    pollUsage().catch(() => {})
    usageTimer = setInterval(() => pollUsage().catch(() => {}), USAGE_MS)
    usageTimer.unref?.()
  }

  const timer = setInterval(() => {
    try {
      const s = readSession(sid)
      if (!s) return
      polls += 1
      const patch = {}
      // git: which files this session is touching, where trunk is
      if (polls % GIT_EVERY === 1) {
        const g = gitInfo(s.cwd)
        if (g.repo) { patch.files_dirty = g.dirty; patch.head = g.head; patch.branch = g.branch }
      }
      // codex: find + tail the rollout
      if (agent === 'codex') {
        if (!rollout) {
          const codexHome = spec.env.CODEX_HOME || LAYOUT.codex.home()
          rollout = findRollout({ codexHome, cwd: s.cwd, sinceMs: startedMs })
          if (rollout) { tail = createTail(rollout.path); patch.transcript_path = rollout.path; patch.agent_session_id = rollout.meta.id ?? null; appendEvent(sid, { type: 'agent_ready', summary: `codex thread ${rollout.meta.id ?? '?'}` }) }
        }
        if (tail) {
          const r = parseLines(tail.read())
          if (r.limits) {
            const u = recordUsage('codex', account, { ...r.limits, facts: r.facts }, 'codex rollout token_count', { observed_at: r.limits_at })
            if (u.usage_applied) { patch.limits = r.limits; patch.last_activity = new Date().toISOString() }
          }
          const firstUser = r.messages.find((m) => m.role === 'user')
          if (!s.task && firstUser) patch.task = firstUser.text.slice(0, 500)
          if (r.taskStarted) patch.turns = (s.turns ?? 0) + r.taskStarted
          if (r.files.length) patch.files_touched = [...new Set([...(s.files_touched ?? []), ...r.files])].slice(-200)
          for (const m of r.messages.filter((x) => x.role === 'assistant').slice(-1)) appendEvent(sid, { type: 'turn_done', summary: m.text.slice(0, 160) })
          if (r.limit) {
            const u = markLimited('codex', account, { resets_at: r.limit.resets_at, reason: r.limit.reason, source: 'codex rollout task_complete.error', observed_at: r.limit.observed_at })
            if (u.wall_applied) {
              const { raw, ...lim } = r.limit
              patch.status = 'limit'; patch.limit = { ...lim, resets_at: r.limit.resets_at ?? u.limited_until, at: new Date().toISOString() }
              appendEvent(sid, { type: 'limit', summary: `codex usage limit: ${r.limit.detail}` })
              try { captureLive('codex', 'usage_limit_exceeded', raw ?? lim, { sessionId: sid }) } catch {}
            }
          }
        }
      }
      // agy: log text + history prompts
      if (agent === 'agy') {
        const text = agyTail.read().join('\n')
        const hit = text ? scanLog(text) : null
        if (hit && s.status !== 'limit') {
          const u = markLimited('agy', account, { resets_at: hit.resets_at, reason: hit.signal, source: 'agy log' })
          patch.status = 'limit'; patch.limit = { reason: hit.signal, detail: hit.detail, resets_at: hit.resets_at ?? u.limited_until, at: new Date().toISOString() }
          appendEvent(sid, { type: 'limit', summary: `agy limit (${hit.signal}): ${hit.detail.slice(0, 160)}` })
          try { captureLive('agy', hit.signal, { log_excerpt: hit.detail, resets_at: hit.resets_at }, { sessionId: sid }) } catch {}
        }
        const prompts = promptsSince({ cwd: s.cwd, sinceMs: startedMs })
        // the prompts are this leg's; the count on the card is the session's
        const turns = turnsAtLegStart + prompts.length
        if (prompts.length && turns !== (s.turns ?? 0)) {
          patch.turns = turns; patch.last_activity = new Date().toISOString()
          if (!s.task) patch.task = prompts[0].text.slice(0, 500)
          if (!s.agent_session_id && prompts[0].conversationId) patch.agent_session_id = prompts[0].conversationId
          if (s.status === 'starting') patch.status = 'running'
        }
      }
      // grok: log text + prompts
      if (agent === 'grok') {
        const text = grokTail ? grokTail.read().join('\n') : ''
        const hit = text ? scanGrokLog(text) : null
        if (hit && s.status !== 'limit') {
          const u = markLimited('grok', account, { resets_at: hit.resets_at, reason: hit.signal, source: 'grok log' })
          patch.status = 'limit'; patch.limit = { reason: hit.signal, detail: hit.detail, resets_at: hit.resets_at ?? u.limited_until, at: new Date().toISOString() }
          appendEvent(sid, { type: 'limit', summary: `grok limit (${hit.signal}): ${hit.detail.slice(0, 160)}` })
          try { captureLive('grok', hit.signal, { log_excerpt: hit.detail, resets_at: hit.resets_at }, { sessionId: sid }) } catch {}
        }
        const prompts = grokPromptsSince({ grokHome: spec.env.GROK_HOME || LAYOUT.grok.home(), cwd: s.cwd, sinceMs: startedMs })
        const turns = turnsAtLegStart + prompts.length
        if (prompts.length && turns !== (s.turns ?? 0)) {
          patch.turns = turns; patch.last_activity = new Date().toISOString()
          if (!s.task) patch.task = prompts[0].text.slice(0, 500)
          if (!s.agent_session_id && prompts[0].sessionId) patch.agent_session_id = prompts[0].sessionId
          if (s.status === 'starting') patch.status = 'running'
        }
      }
      // warning threshold (every agent; claude's limits arrive via the usage poller)
      {
        const lim = patch.limits ?? s.limits
        const hot = lim ? [['5h', lim.five_hour], ['7d', lim.seven_day]].filter(([, w]) => w).sort((a, b) => b[1].pct - a[1].pct)[0] : null
        if (hot && hot[1].pct >= WARN_PCT && !warned) {
          warned = true
          patch.warning = { window: hot[0], pct: hot[1].pct, resets_at: hot[1].resets_at, at: new Date().toISOString() }
          if ((patch.status ?? s.status) === 'running') patch.status = 'warning'
          appendEvent(sid, { type: 'warning', summary: `${agent} ${hot[0]} window at ${Math.round(hot[1].pct)}%; next option ${s.chain?.[0] ? s.chain[0].agent : 'none'}` })
          process.stderr.write('\x07')
        }
      }
      // periodic checkpoint of the bundle (every ~2 min while active)
      if (polls % Math.max(1, Math.round(120000 / POLL_MS)) === 0 && (s.turns ?? 0) > 0) {
        try { saveSessionBundle({ ...s, ...patch }, { messages: messagesFor(agent, { ...s, ...patch }), why: 'checkpoint' }) } catch (err) { appendEvent(sid, { type: 'error', summary: `bundle checkpoint failed: ${err.message.slice(0, 160)}` }) }
      }
      const next = Object.keys(patch).length ? updateSession(sid, patch) : s
      const ctl = takeControl(sid)
      // end wins over a merged handoff: control.json now merges writes, so a
      // record can carry both; End (stop entirely) is the stronger, latest intent
      if (ctl?.end) { if (ctl.by) appendEvent(sid, { type: 'status', by: ctl.by, summary: `end requested from the board by ${ctl.by}` }); clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'exit', code: null, ended: true }); return }
      if (ctl?.handoff) {
        const picked = ctl.target && typeof ctl.target === 'object' && ctl.target.agent
          ? { agent: String(ctl.target.agent), account: String(ctl.target.account ?? 'default') }
          : null
        const toWhom = picked ? ` to ${picked.agent}${picked.account !== 'default' ? '/' + picked.account : ''}` : ''
        updateSession(sid, { status: 'handing_off', handoff: { reason: `requested from the board${ctl.by ? ` by ${ctl.by}` : ''}`, at: new Date().toISOString(), by: ctl.by ?? null, requested_to: picked } }, { event: { type: 'handoff_requested', by: ctl.by ?? null, summary: `hand off${toWhom} requested from the board${ctl.by ? ` by ${ctl.by}` : ''}` } })
        clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'handoff', code: null, target: picked }); return
      }
      // a stale warning patch can overwrite status:'limit' from the hook, but the
      // limit OBJECT survives the clobber — hand off on either signal
      if ((next.status === 'limit' || next.limit) && (process.env.LEG_NO_HANDOFF || process.env.BATON_NO_HANDOFF) !== '1') {
        clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'limit', code: null })
      }
    } catch (err) {
      try { appendEvent(sid, { type: 'error', summary: `tap error: ${String(err.message).slice(0, 160)}` }) } catch {}
    }
  }, POLL_MS)
  timer.unref?.()
  const result = await done
  clearInterval(timer)
  usageAbort.abort()
  if (usageTimer) clearInterval(usageTimer)
  void boardUrl
  return result
}

// The countdown: one line rewritten in place on a TTY, one line a minute
// otherwise. Ends 'ready' at the reset, 'cancelled' on Ctrl-C or a board End.
async function waitInTerminal({ sid, label, resetsAt }) {
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.once('SIGINT', onSigint)
  const tty = Boolean(process.stderr.isTTY)
  let lastLine = 0
  const r = await waitForReset({
    resetsAt, signal: ac.signal, tickMs: Number(process.env.LEG_WAIT_TICK_MS || process.env.BATON_WAIT_TICK_MS || 1000),
    isCancelled: () => { const c = takeControl(sid); if (c?.end) return true; if (c?.handoff) appendEvent(sid, { type: 'status', summary: 'hand-off requested while waiting; every option is still out' }); return false },
    onTick: (remaining) => {
      const line = `[leg] waiting for ${label} · ${fmtCountdown(remaining)} to the reset (${new Date(resetsAt * 1000).toLocaleTimeString()}) · Ctrl-C to quit`
      if (tty) process.stderr.write(`\r\x1b[2K${line}`)
      else if (Date.now() - lastLine >= 60000) { lastLine = Date.now(); process.stderr.write(line + '\n') }
    },
  })
  process.removeListener('SIGINT', onSigint)
  if (tty) process.stderr.write('\r\x1b[2K')
  if (r === 'ready') say(`${label} is back; starting it from the bundle`)
  return r
}

function messagesFor(agent, s) {
  if (agent === 'claude') return claudeTail(s.transcript_path)
  if (agent === 'codex') return codexTail(s.transcript_path)
  return []
}

// Choose and commit the next provider under the same session-file lock used by
// the board's order editor. Whichever writer acquires the lock first wins:
// an order save is consumed here, or the editor sees handing_off and refuses.
// No eligible choice leaves the session unclaimed so all-out waiting can keep
// accepting order edits.
export function claimHandoffChoice({ sid, agent, account, installed, bundle = null, reason = 'limit', nowS = Math.floor(Date.now() / 1000), exclude = [], prefer = null }) {
  let choice = { next: null, out: [] }
  let claimed = false
  const session = updateSession(sid, (current) => {
    const accounts = readAccounts()
    const order = normalizeHandoffOrder(current.handoff_order)
    choice = chooseNext({ agent, account, accounts, installed, order, nowS, exclude, prefer })
    if (!choice.next && isAvailable(readUsage(agent, account), nowS) && !exclude.some((x) => x.agent === agent && x.account === account)) choice = { next: { agent, account }, out: [], preferred_taken: false }
    if (!choice.next) return {}
    claimed = true
    return {
      status: 'handing_off',
      waiting: null,
      all_out: null,
      handoff: {
        from: { agent, account },
        to: choice.next,
        bundle_id: bundle?.id ?? null,
        reason: reason === 'limit' ? 'usage limit' : 'requested',
        // what was asked for, beside what was chosen: when a picked
        // destination walled between the click and the hand-off, the card
        // must say so rather than look like the pick was ignored
        requested_to: prefer ?? null,
        at: new Date().toISOString(),
      },
    }
  })
  return { choice, claimed, session }
}

// The portable harness, decided before a leg starts (src/harness/index.mjs).
// Off by default: then this records nothing and changes nothing. On, it
// carries the source agent's working environment to the agent about to run,
// per the saved policy, and the session keeps the outcome so the board can say
// what transferred and what did not. Never throws into the session.
function prepareLegHarness({ sid, from, to }) {
  let outcome
  try { outcome = prepareHarnessForHandoff({ from, to, sessionId: sid }) } catch (err) { outcome = { state: 'error', policy: 'unknown', proceed: true, to, target: to, reason: String(err.message).slice(0, 200), summary: `harness error: ${String(err.message).slice(0, 120)}` } }
  if (outcome.state === 'off') return outcome
  updateSession(sid, { harness: outcome })
  const line = harnessLine(outcome)
  if (line) { say(line); appendEvent(sid, { type: outcome.proceed ? 'harness' : 'harness_blocked', summary: line, body: outcome.dropped?.length || outcome.attention?.length ? [...(outcome.attention ?? []).map((a) => `attention ${a.component}: ${a.reason}`), ...(outcome.dropped ?? []).map((d) => `dropped ${d.component}: ${d.item}: ${d.reason}`)].join('\n') : undefined }) }
  return outcome
}

// ---- the command ----
// `cwd` and `continued` are how `leg history continue` starts a leg on a
// conversation the agent's own store holds (src/history/cli.mjs): the leg runs
// in that conversation's folder, shares the checkout (its files are already
// there), and the session record carries the agent's id from the start.
export async function attach(agent, args = [], { open = true, cwd: cwdOpt = null, continued = null } = {}) {
  if (!SUPERVISED_AGENTS.includes(agent)) throw new Error(`unknown agent "${agent}" (claude|codex|agy|grok)`)
  // the paid gate: a valid key, or no session (exit 4). The bare agent is never
  // affected; only what Leg adds is licensed.
  const ent = entitlement()
  if (!allows(ent, 'run')) { say(describeLicense(ent)); return 4 }
  // --no-worktree is Leg's flag, not the agent's: it never passes through
  const shareCheckout = args.includes('--no-worktree') || Boolean(continued)
  args = args.filter((a) => a !== '--no-worktree')
  let autoApproveCli = null
  if (args.includes('--no-auto-approve')) {
    autoApproveCli = false
    args = args.filter((a) => a !== '--no-auto-approve')
  } else if (args.includes('--auto-approve')) {
    autoApproveCli = true
    args = args.filter((a) => a !== '--auto-approve')
  }
  const autoApprove = resolveAutoApprove({ cliFlag: autoApproveCli })
  const cwd = cwdOpt ? realPath(cwdOpt) : process.cwd()
  const board = await ensureBoard({ open })
  let accounts = readAccounts()
  const installed = await installedAgents()
  const handoffOrder = readPreferences().handoff_order
  let account = process.env.LEG_ACCOUNT || process.env.BATON_ACCOUNT || 'default'
  if (!(accounts[agent] ?? ['default']).includes(account)) { say(`no ${agent} account "${account}"; using default`); account = 'default' }
  // A persisted wall is only a cache. Ask Codex's read-only account endpoint
  // before using it to skip this login; an explicit true can clear an older
  // wall, false refreshes it, and unknown preserves it.
  if (agent === 'codex' && installed.codex && !process.env.BATON_CODEX_BIN) {
    const codexHome = envFor('codex', account).CODEX_HOME || LAYOUT.codex.home()
    await refreshCodexUsage(account, codexHome).catch(() => {})
  }
  if (agent === 'grok' && installed.grok && !process.env.BATON_GROK_BIN) {
    const grokHome = envFor('grok', account).GROK_HOME || LAYOUT.grok.home()
    await fetchGrokUsage({ configDir: grokHome }).catch(() => {})
  }
  // Start on an account that is not at its wall, if we already know one is.
  const nowS = Math.floor(Date.now() / 1000)
  const u0 = readUsage(agent, account)
  if (u0.limited_until && u0.limited_until > nowS) {
    const alt = chooseNext({ agent, account, accounts, installed, order: handoffOrder, nowS })
    if (alt.next) { say(`${agent} (${account}) is at its limit until ${fmtReset(u0.limited_until)}; starting ${alt.next.agent} (${alt.next.account}) instead`); agent = alt.next.agent; account = alt.next.account }
    else say(`${agent} (${account}) is at its limit until ${fmtReset(u0.limited_until)}; starting anyway (every option is out)`)
  }
  const g = gitInfo(cwd)
  const sid = newSessionId(agent)
  const chain = candidates({ agent, account, accounts, order: handoffOrder })
  // record the session BEFORE cutting a worktree, so a crash or Ctrl-C during
  // `git worktree add` still leaves a card (with a Remove button), never a
  // silent orphan under .baton-worktrees with no record and no button
  createSession({ id: sid, agent, account, cwd, repo: g.repo, branch: g.branch, argv: args, chain, worktree: null, owner: whoami(), handoffOrder, installed, runtimeCapabilities: [HANDOFF_ORDER_CAPABILITY] })
  if (continued) {
    // the agent's own id and transcript are known before the first turn, so
    // history dedups this leg against the conversation it continues at once
    const safeTranscript = (continued.transcript_path && insideKnownStore(continued.transcript_path)) ? continued.transcript_path : null
    updateSession(sid, { agent_session_id: continued.native_id ?? null, transcript_path: safeTranscript, task: continued.title ?? null, continued_from: { id: continued.id, provider: continued.provider, native_id: continued.native_id ?? null } },
      { event: { type: 'continued', summary: `continuing ${continued.id}${continued.title ? `: ${String(continued.title).slice(0, 120)}` : ''}` } })
  }
  let iso = null
  if (g.repo && !shareCheckout) {
    try { iso = isolate({ g, cwd, sid }) } catch (err) { say(`could not make a worktree (${String(err.message).split('\n')[0].slice(0, 200)}); sharing the checkout`); try { removeWorktree(g.repo, sid) } catch {} }
  }
  if (iso) updateSession(sid, { cwd: iso.cwd, branch: iso.branch, worktree: { path: iso.path, branch: iso.branch, base: iso.base } })
  updateSession(sid, { head_at_start: g.head, head: g.head, files_dirty: iso ? [] : g.dirty, board_url: board.url })
  say(`session ${sid} · ${agent}${account !== 'default' ? '/' + account : ''} · board ${board.url ?? 'off'}${board.started ? ' (started)' : ''} · next: ${chain.map((c) => c.agent + (c.account !== 'default' ? '/' + c.account : '')).join(' → ') || 'none'}`)
  if (iso) {
    const others = iso.live.map((s) => `${s.agent} ${s.session_id.split('-').pop()}`).join(', ')
    say(`another session is live in this checkout (${others}): this one works in ${iso.cwd} on ${iso.branch}; Land on its card brings it to ${iso.base ?? 'nothing (detached HEAD)'} · --no-worktree to share`)
    appendEvent(sid, { type: 'worktree', summary: `own worktree ${iso.path} on ${iso.branch} from ${iso.base ?? 'a detached HEAD'}; live in the checkout: ${others}` })
  }

  let prompt = null
  let legArgs = args
  let exit = 0
  // the first leg is the agent the human chose: its harness is prepared per
  // policy and recorded, never refused (strict applies to hand-offs)
  prepareLegHarness({ sid, from: null, to: agent })
  // unbounded: the 12-leg cap below stops a runaway chain, and the all-out wait
  // bounds a wait; a normal session runs one leg and exits
  for (let leg = 0; ; leg++) {
    const s = readSession(sid)
    const r = await runLeg({ agent, account, args: legArgs, session: s, prompt, boardUrl: board.url, autoApprove })
    if (r.reason === 'exit') { exit = r.code ?? 0; break }
    // limit or handoff: bundle, choose next, go again in this terminal
    const cur = readSession(sid)
    say(r.reason === 'limit' ? `${agent} hit its usage limit${cur.limit?.detail ? `: ${cur.limit.detail.slice(0, 140)}` : ''}` : 'handing off as requested')
    const whyStopped = r.reason === 'limit' ? `${agent} usage limit` : 'handoff requested (the agent was stopped mid-turn; edits in the worktree may be half-applied)'
    let bundle = null
    try { bundle = saveSessionBundle(cur, { messages: messagesFor(agent, cur), why: whyStopped }); say(`bundle saved: ${bundle.path}`) } catch (err) { say(`bundle save failed: ${err.message}`) }
    // saveSessionBundle writes the notes file before it shells out to chb, so
    // even when chb is missing and the save throws, the context is on disk
    const notesFile = join(workRoot(cur) ?? cur.cwd, '.leg', `session-${sid}.md`)
    // destinations the strict harness policy refused during this hand-off
    const excluded = []
    // the destination a human picked on the board, if they picked one
    const prefer = r.target ?? null
    let claim = claimHandoffChoice({ sid, agent, account, installed, bundle, reason: r.reason, exclude: excluded, prefer })
    let choice = claim.choice
    let cancelled = false
    let blocked = false
    while (!choice.next) {
      if (excluded.length && !choice.out.length) { blocked = true; break }
      // every option is out: keep the terminal, count down to the SOONEST reset
      // (the current agent's own wall included — it may be the first back), then
      // start that option from the bundle. Ctrl-C (or End) quits with exit 3.
      const own = readUsage(agent, account)
      const all = [...choice.out]
      if (Number.isFinite(own.limited_until)) all.push({ agent, account, resets_at: own.limited_until, reason: own.limited_reason ?? 'limit' })
      all.sort((a, b) => (a.resets_at ?? Infinity) - (b.resets_at ?? Infinity))
      const first = all[0]
      const label = first ? `${first.agent}${first.account !== 'default' ? '/' + first.account : ''}` : 'unknown'
      say(`every option is out. First back: ${label} at ${first ? fmtReset(first.resets_at) : 'unknown'}`)
      for (const o of all) say(`  ${o.agent}${o.account !== 'default' ? '/' + o.account : ''}: resets ${fmtReset(o.resets_at)}`)
      say(`waiting for ${label}; Ctrl-C to quit`)
      updateSession(sid, { status: 'waiting', all_out: all, waiting: first ? { agent: first.agent, account: first.account, resets_at: first.resets_at, since: new Date().toISOString() } : null }, { event: { type: 'all_out', summary: `every option is out; waiting for ${label} at ${first ? fmtReset(first.resets_at) : 'unknown'}` } })
      const r2 = await waitInTerminal({ sid, label, resetsAt: first?.resets_at ?? null })
      if (r2 === 'cancelled') { cancelled = true; break }
      claim = claimHandoffChoice({ sid, agent, account, installed, bundle, reason: r.reason, exclude: excluded, prefer })
      choice = claim.choice
    }
    if (cancelled) {
      updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), waiting: null }, { event: { type: 'ended', summary: 'quit while waiting for a reset (exit 3)' } })
      exit = 3
      break
    }
    // strict harness policy: a destination whose harness cannot be made safe is
    // refused and the next option is tried; when none is left the session ends
    // with exit 5 rather than launching an agent without its environment
    while (!blocked && choice.next) {
      const prepared = prepareLegHarness({ sid, from: agent, to: choice.next.agent })
      if (prepared.proceed) break
      excluded.push(choice.next)
      say(`${choice.next.agent} refused by the strict harness policy: ${prepared.reason ?? prepared.state}`)
      claim = claimHandoffChoice({ sid, agent, account, installed, bundle, reason: r.reason, exclude: excluded, prefer })
      choice = claim.choice
      if (!choice.next) blocked = true
    }
    if (blocked) {
      say('every remaining option was refused by the strict harness policy; stopping (exit 5). Fix what needs attention (leg harness status) or relax the policy (leg harness policy sync), then run leg again in this directory.')
      updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), exit_code: 5, waiting: null }, { event: { type: 'ended', summary: 'strict harness policy refused every destination; stopped (exit 5)' } })
      exit = 5
      break
    }
    const next = choice.next
    // A pick that could not be taken is never silent: between the click and
    // this moment that account can wall, or the strict harness policy can
    // refuse it, and a terminal that quietly went somewhere else is the kind
    // of surprise this board exists to remove.
    if (prefer && !choice.preferred_taken) {
      const asked = `${prefer.agent}${prefer.account !== 'default' ? '/' + prefer.account : ''}`
      const got = `${next.agent}${next.account !== 'default' ? '/' + next.account : ''}`
      const why = excluded.some((x) => x.agent === prefer.agent && x.account === prefer.account)
        ? 'the strict harness policy refused it'
        : `it is at its limit until ${fmtReset(readUsage(prefer.agent, prefer.account).limited_until)}`
      say(`${asked} was picked but ${why}; handing off to ${got} instead`)
      appendEvent(sid, { type: 'status', summary: `${asked} was picked for this hand-off but ${why}; ${got} took it instead` })
    }
    // bound the number of hand-offs in one terminal so a chain that limits
    // instantly can never loop forever; stopping is explicit, not a silent exit 0
    if (leg >= 11) {
      say(`reached the 12-leg hand-off limit for one session; stopping. Run leg again in this directory to continue from the bundle.`)
      updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), exit_code: 3 }, { event: { type: 'ended', summary: 'reached the 12-leg hand-off limit; stopped (exit 3)' } })
      exit = 3
      break
    }
    appendEvent(sid, { type: 'handoff', summary: `${agent}${account !== 'default' ? '/' + account : ''} → ${next.agent}${next.account !== 'default' ? '/' + next.account : ''}${bundle ? ` (bundle ${bundle.id})` : ''}` })
    if (bundle) {
      prompt = resumePrompt(cur, bundle, next)
    } else {
      const delta = sessionCommitDelta(workRoot(cur) ?? cur.cwd, cur)
      const fallbackAction = delta.isClean && delta.newCommits.length > 0
        ? `The previous agent committed changes (${delta.newCommits.length} commit(s)) and left a clean working tree. Check git log and verify whether the task is already complete before doing redundant work; continue only if work remains.`
        : 'Check git status and git diff, then continue the work.'
      prompt = `You are taking over an interactive coding session from ${agent}.${existsSync(notesFile) ? ` Read ${notesFile} in this directory first (the previous agent's notes: task, last messages, dirty files).` : ''} ${fallbackAction} The task: ${cur.task ?? 'see the recent changes'}`
    }
    say(`starting ${next.agent}${next.account !== 'default' ? '/' + next.account : ''} in this terminal from the bundle`)
    agent = next.agent; account = next.account; legArgs = []
    // the chain is what comes after the agent now taking over, not after the
    // one that started the session: the card's "next" names a live option
    updateSession(sid, (fresh) => {
      const freshOrder = normalizeHandoffOrder(fresh.handoff_order)
      return { lineage: { from: cur.agent, to: next.agent }, chain: candidates({ agent: next.agent, account: next.account, accounts: readAccounts(), order: freshOrder }) }
    })
  }
  const fin = readSession(sid)
  if (fin && fin.status !== 'ended') updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), exit_code: exit }, { event: { type: 'ended', summary: `session ended (exit ${exit})` } })
  // Every way out of the loop arrives here: a clean exit, a cancelled wait, the
  // 12-leg cap, an agent that never started. The terminal is gone, so RESUME.md
  // must stop describing it as live — Leg owns that file, and leaving the last
  // hand-off sitting there is exactly the lie this rewrite exists to stop.
  try { endSessionPointer(readSession(sid)) } catch (err) { appendEvent(sid, { type: 'error', summary: `resume pointer not rewritten: ${err.message.slice(0, 160)}` }) }
  try { rmSync(join(sessionDir(sid), 'control.json'), { force: true }) } catch {}
  return exit
}

export function resolveArgs(argv) {
  const [agent, ...rest] = argv
  return { agent, args: rest }
}

void existsSync; void resolve
