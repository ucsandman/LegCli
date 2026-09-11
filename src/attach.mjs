// attach — `baton claude|codex|agy [args…]`: the normal interactive agent in
// this terminal, with Baton alongside it. Baton (1) makes sure the board is
// up and opens it once, (2) registers the session so it shows on the board,
// (3) taps the agent for usage (claude: hooks + status line via --settings;
// codex: its rollout file; agy: its log), (4) polls git for the files the
// session touches, (5) keeps the handoff bundle current, and (6) on a usage
// limit saves the bundle, stops the agent, and starts the next option in the
// same terminal from that bundle. Subscription logins only: API keys are
// stripped from the child environment (src/env.mjs).
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEnv } from './env.mjs'
import { home } from './store.mjs'
import { get as getAdapter } from './adapters/index.mjs'
import { AGENTS, newSessionId, createSession, readSession, updateSession, appendEvent, takeControl, sessionDir } from './sessions.mjs'
import { readAccounts, envFor, refreshAccount } from './accounts.mjs'
import { recordUsage, markLimited, chooseNext, candidates, fmtReset, WARN_PCT, readUsage } from './usage.mjs'
import { writeSettings, userStatusLine, transcriptTail as claudeTail } from './taps/claude.mjs'
import { findRollout, createTail, parseLines, transcriptTail as codexTail } from './taps/codex.mjs'
import { scanLog, promptsSince, logSize } from './taps/agy.mjs'
import { fetchClaudeUsage } from './taps/claude-usage.mjs'
import { saveSessionBundle, resumePrompt } from './bundle.mjs'
import { openBoard, pidfile } from './launcher.mjs'
import { LAYOUT } from './accounts.mjs'
import { captureLive } from './live-capture.mjs'

const SRC = dirname(fileURLToPath(import.meta.url))
const SERVER = join(SRC, 'server.mjs')
const POLL_MS = Number(process.env.BATON_ATTACH_POLL_MS || 2000)
const GIT_EVERY = 3 // polls
const USAGE_MS = Number(process.env.BATON_USAGE_POLL_MS || 60000)
const say = (line) => process.stderr.write(`[baton] ${line}\n`)

// ---- board ----
function health(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (r) => { let d = ''; r.on('data', (c) => { d += c }); r.on('end', () => { try { res(r.statusCode === 200 ? JSON.parse(d) : null) } catch { res(null) } }) })
    req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null) })
  })
}

export async function ensureBoard({ open = true } = {}) {
  const port = Number(process.env.BATON_PORT || 4747)
  const url = `http://127.0.0.1:${port}`
  if (await health(port)) return { url, started: false }
  mkdirSync(home(), { recursive: true })
  const logFd = (await import('node:fs')).openSync(join(home(), 'board.log'), 'a')
  const child = spawn(process.execPath, [SERVER], { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, BATON_PORT: String(port), BATON_BIND: '127.0.0.1', BATON_QUIET: '0' } })
  child.unref()
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    if (await health(port)) {
      writeFileSync(pidfile(), JSON.stringify({ pid: child.pid, port, bind: '127.0.0.1', children: [child.pid], detached: true, started_by: 'attach', started_at: new Date().toISOString() }, null, 2) + '\n')
      if (open) openBoard(url)
      return { url, started: true }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  say(`board did not come up on ${url} (see ${join(home(), 'board.log')}); continuing without it`)
  return { url, started: false, failed: true }
}

// ---- git ----
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return r.status === 0 ? r.stdout.trim() : null
}
function gitInfo(cwd) {
  const repo = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!repo) return { repo: null, branch: null, head: null, dirty: [] }
  return {
    repo: repo.replace(/\//g, process.platform === 'win32' ? '\\' : '/'),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(cwd, ['rev-parse', 'HEAD']),
    dirty: (git(cwd, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => !f.startsWith('.baton/') && !f.startsWith('.context-handoffs/')),
  }
}

// ---- process control ----
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  else { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} } }
}
function restoreTerminal() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch {}
  try { process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m\r\n') } catch {}
}

// ---- spawn spec per agent ----
export async function spawnSpec(agent, { account, args, sessionId, prompt, cwd }) {
  const adapter = await getAdapter(agent)
  const { bin, viaNode, entry } = adapter.resolve()
  const argv = []
  if (viaNode && entry) argv.push(entry)
  // a leg Baton starts on its own (after a hand-off) takes BATON_<AGENT>_ARGS,
  // e.g. BATON_CODEX_ARGS="-m gpt-5-mini" to keep a test chain on cheap models
  if (prompt) args = [...(process.env[`BATON_${agent.toUpperCase()}_ARGS`] ?? '').split(/\s+/).filter(Boolean), ...args]
  if (agent === 'claude') {
    const settings = writeSettings(sessionId, { statusLine: userStatusLine(process.env.CLAUDE_CONFIG_DIR || (account !== 'default' ? envFor('claude', account).CLAUDE_CONFIG_DIR : undefined)) })
    argv.push(...args, '--settings', settings)
    if (prompt) argv.push(prompt)
  } else if (agent === 'codex') {
    argv.push(...args)
    if (prompt) argv.push(prompt)
  } else if (agent === 'agy') {
    const log = join(sessionDir(sessionId), 'agy.log')
    argv.push(...args, '--log-file', log)
    if (prompt) argv.push('-i', prompt)
  }
  const env = { ...sanitizeEnv(process.env, { interactive: true }), ...envFor(agent, account), BATON_SESSION: sessionId }
  return { bin: viaNode ? process.execPath : bin, args: argv, env, cwd }
}

// ---- one agent leg ----
// Returns { reason: 'exit'|'limit'|'handoff', code }
async function runLeg({ agent, account, args, session, prompt, boardUrl }) {
  const sid = session.session_id
  refreshAccount(agent, account)
  const spec = await spawnSpec(agent, { account, args, sessionId: sid, prompt, cwd: session.cwd })
  appendEvent(sid, { type: 'leg', summary: `${agent} (${account}) starting${prompt ? ' from the handoff bundle' : ''}` })
  const startedMs = Date.now()
  let child
  try {
    child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit', windowsHide: false })
  } catch (err) {
    updateSession(sid, { status: 'ended', ended_at: new Date().toISOString() }, { event: { type: 'error', summary: `${agent} failed to start: ${err.message}` } })
    return { reason: 'exit', code: 127 }
  }
  updateSession(sid, { pid: child.pid, agent, account, status: agent === 'claude' ? 'starting' : 'running', limit: null, warning: null })

  // taps
  let rollout = null; let tail = null; let agyLogSeen = 0
  let polls = 0; let warned = Boolean(session.warning)
  let stop = null
  const done = new Promise((res) => { stop = res })
  child.on('error', (err) => { appendEvent(sid, { type: 'error', summary: `${agent} spawn error: ${err.message}` }); stop({ reason: 'exit', code: 127 }) })
  child.on('exit', (code) => stop({ reason: 'exit', code: code ?? -1 }))

  // claude: the 5h/7d percentages come from Claude Code's usage endpoint
  // (src/taps/claude-usage.mjs); the wall itself arrives through the
  // StopFailure hook.
  let usageTimer = null
  if (agent === 'claude') {
    const pollUsage = async () => {
      const r = await fetchClaudeUsage({ configDir: spec.env.CLAUDE_CONFIG_DIR || LAYOUT.claude.home() })
      const s = readSession(sid)
      if (!s) return
      if (r.ok && r.limits) {
        recordUsage('claude', account, r.limits, 'claude usage endpoint')
        updateSession(sid, { limits: r.limits, usage_source: 'claude usage endpoint' })
      } else if (!s.usage_error) {
        updateSession(sid, { usage_error: r.error ?? 'unknown' }, { event: { type: 'status', summary: `claude usage unavailable: ${r.error ?? 'unknown'}` } })
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
          if (r.limits) { recordUsage('codex', account, r.limits, 'codex rollout token_count'); patch.limits = r.limits; patch.last_activity = new Date().toISOString() }
          const firstUser = r.messages.find((m) => m.role === 'user')
          if (!s.task && firstUser) patch.task = firstUser.text.slice(0, 500)
          if (r.taskStarted) patch.turns = (s.turns ?? 0) + r.taskStarted
          if (r.files.length) patch.files_touched = [...new Set([...(s.files_touched ?? []), ...r.files])].slice(-200)
          for (const m of r.messages.filter((x) => x.role === 'assistant').slice(-1)) appendEvent(sid, { type: 'turn_done', summary: m.text.slice(0, 160) })
          if (r.limit) {
            const u = markLimited('codex', account, { resets_at: r.limit.resets_at, reason: r.limit.reason, source: 'codex rollout task_complete.error' })
            const { raw, ...lim } = r.limit
            patch.status = 'limit'; patch.limit = { ...lim, resets_at: r.limit.resets_at ?? u.limited_until, at: new Date().toISOString() }
            appendEvent(sid, { type: 'limit', summary: `codex usage limit: ${r.limit.detail}` })
            try { captureLive('codex', 'usage_limit_exceeded', raw ?? lim, { sessionId: sid }) } catch {}
          }
        }
      }
      // agy: log text + history prompts
      if (agent === 'agy') {
        const log = join(sessionDir(sid), 'agy.log')
        const size = logSize(log)
        if (size > agyLogSeen) {
          const text = readFileSync(log, 'utf8').slice(agyLogSeen)
          agyLogSeen = size
          const hit = scanLog(text)
          if (hit && s.status !== 'limit') {
            const u = markLimited('agy', account, { resets_at: hit.resets_at, reason: hit.signal, source: 'agy log' })
            patch.status = 'limit'; patch.limit = { reason: hit.signal, detail: hit.detail, resets_at: hit.resets_at ?? u.limited_until, at: new Date().toISOString() }
            appendEvent(sid, { type: 'limit', summary: `agy limit (${hit.signal}): ${hit.detail.slice(0, 160)}` })
            try { captureLive('agy', hit.signal, { log_excerpt: hit.detail, resets_at: hit.resets_at }, { sessionId: sid }) } catch {}
          }
        }
        const prompts = promptsSince({ cwd: s.cwd, sinceMs: startedMs })
        if (prompts.length && prompts.length !== (s.turns ?? 0)) {
          patch.turns = prompts.length; patch.last_activity = new Date().toISOString()
          if (!s.task) patch.task = prompts[0].text.slice(0, 500)
          if (!s.agent_session_id && prompts[0].conversationId) patch.agent_session_id = prompts[0].conversationId
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
      if (ctl?.handoff) {
        updateSession(sid, { status: 'handing_off', handoff: { reason: 'requested from the board', at: new Date().toISOString() } }, { event: { type: 'handoff_requested', summary: 'hand off requested from the board' } })
        clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'handoff', code: null }); return
      }
      if (ctl?.end) { clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'exit', code: null, ended: true }); return }
      if (next.status === 'limit' && process.env.BATON_NO_HANDOFF !== '1') {
        clearInterval(timer); killTree(child.pid); restoreTerminal(); stop({ reason: 'limit', code: null })
      }
    } catch (err) {
      try { appendEvent(sid, { type: 'error', summary: `tap error: ${String(err.message).slice(0, 160)}` }) } catch {}
    }
  }, POLL_MS)
  timer.unref?.()
  const result = await done
  clearInterval(timer)
  if (usageTimer) clearInterval(usageTimer)
  void boardUrl
  return result
}

function messagesFor(agent, s) {
  if (agent === 'claude') return claudeTail(s.transcript_path)
  if (agent === 'codex') return codexTail(s.transcript_path)
  return []
}

// ---- the command ----
export async function attach(agent, args = [], { open = true } = {}) {
  if (!AGENTS.includes(agent)) throw new Error(`unknown agent "${agent}" (claude|codex|agy)`)
  const cwd = process.cwd()
  const board = await ensureBoard({ open })
  const accounts = readAccounts()
  let account = process.env.BATON_ACCOUNT || 'default'
  if (!accounts[agent].includes(account)) { say(`no ${agent} account "${account}"; using default`); account = 'default' }
  // Start on an account that is not at its wall, if we already know one is.
  const nowS = Math.floor(Date.now() / 1000)
  const u0 = readUsage(agent, account)
  if (u0.limited_until && u0.limited_until > nowS) {
    const alt = chooseNext({ agent, account, accounts, nowS })
    if (alt.next) { say(`${agent} (${account}) is at its limit until ${fmtReset(u0.limited_until)}; starting ${alt.next.agent} (${alt.next.account}) instead`); agent = alt.next.agent; account = alt.next.account }
    else say(`${agent} (${account}) is at its limit until ${fmtReset(u0.limited_until)}; starting anyway (every option is out)`)
  }
  const g = gitInfo(cwd)
  const sid = newSessionId(agent)
  const chain = candidates({ agent, account, accounts })
  createSession({ id: sid, agent, account, cwd, repo: g.repo, branch: g.branch, argv: args, chain })
  updateSession(sid, { head_at_start: g.head, head: g.head, files_dirty: g.dirty, board_url: board.url })
  say(`session ${sid} · ${agent}${account !== 'default' ? '/' + account : ''} · board ${board.url}${board.started ? ' (started)' : ''} · next: ${chain.map((c) => c.agent + (c.account !== 'default' ? '/' + c.account : '')).join(' → ') || 'none'}`)

  let prompt = null
  let legArgs = args
  let exit = 0
  for (let leg = 0; leg < 6; leg++) {
    const s = readSession(sid)
    const r = await runLeg({ agent, account, args: legArgs, session: s, prompt, boardUrl: board.url })
    if (r.reason === 'exit') { exit = r.code ?? 0; break }
    // limit or handoff: bundle, choose next, go again in this terminal
    const cur = readSession(sid)
    say(r.reason === 'limit' ? `${agent} hit its usage limit${cur.limit?.detail ? `: ${cur.limit.detail.slice(0, 140)}` : ''}` : 'handing off as requested')
    let bundle = null
    try { bundle = saveSessionBundle(cur, { messages: messagesFor(agent, cur), why: r.reason === 'limit' ? `${agent} usage limit` : 'handoff requested' }); say(`bundle saved: ${bundle.path}`) } catch (err) { say(`bundle save failed: ${err.message}`) }
    const choice = chooseNext({ agent, account, accounts })
    if (!choice.next) {
      const lines = choice.out.map((o) => `  ${o.agent}${o.account !== 'default' ? '/' + o.account : ''}: resets ${fmtReset(o.resets_at)}`)
      const first = choice.out[0]
      say(`every option is out. First back: ${first ? `${first.agent}${first.account !== 'default' ? '/' + first.account : ''} at ${fmtReset(first.resets_at)}` : 'unknown'}`)
      for (const l of lines) say(l)
      updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), all_out: choice.out }, { event: { type: 'all_out', summary: `every option is out; first back ${first ? first.agent + ' ' + fmtReset(first.resets_at) : 'unknown'}` } })
      exit = 3
      break
    }
    const next = choice.next
    updateSession(sid, { status: 'handing_off', handoff: { from: { agent, account }, to: next, bundle_id: bundle?.id ?? null, reason: r.reason === 'limit' ? 'usage limit' : 'requested', at: new Date().toISOString() } }, { event: { type: 'handoff', summary: `${agent}${account !== 'default' ? '/' + account : ''} → ${next.agent}${next.account !== 'default' ? '/' + next.account : ''}${bundle ? ` (bundle ${bundle.id})` : ''}` } })
    prompt = bundle ? resumePrompt(cur, bundle, next) : `You are taking over an interactive coding session from ${agent}. Check git status and git diff in this directory and continue the work. The task: ${cur.task ?? 'see the recent changes'}`
    say(`starting ${next.agent}${next.account !== 'default' ? '/' + next.account : ''} in this terminal from the bundle`)
    agent = next.agent; account = next.account; legArgs = []
    updateSession(sid, { lineage: { from: cur.agent, to: next.agent } })
  }
  const fin = readSession(sid)
  if (fin && fin.status !== 'ended') updateSession(sid, { status: 'ended', ended_at: new Date().toISOString(), exit_code: exit }, { event: { type: 'ended', summary: `session ended (exit ${exit})` } })
  try { rmSync(join(sessionDir(sid), 'control.json'), { force: true }) } catch {}
  return exit
}

export function resolveArgs(argv) {
  const [agent, ...rest] = argv
  return { agent, args: rest }
}

void existsSync; void resolve
