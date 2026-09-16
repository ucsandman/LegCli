// launcher — the one command. `leg up` runs preflight, spawns the board
// server (scheduler + merge queue run inside it) as an argv child, waits for
// /api/health, opens the board, streams prefixed redacted logs, and tears
// everything down on Ctrl-C. `up --dry` prints what would run. `down`,
// `status`, `open` are the other three verbs. No shell anywhere.
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './redact.mjs'
import { home, listCards, readRuns } from './store.mjs'
import { names as adapterNames, get as getAdapter, isFake } from './adapters/index.mjs'
import { resolveChb, chbVersion } from './handoff.mjs'
import { schedulerStatus, MAX_CONCURRENT } from './scheduler.mjs'
import { enabledSyncs } from './sync/index.mjs'

const SRC = dirname(fileURLToPath(import.meta.url))
function resolveServer() {
  if (process.env.LEG_SERVER_SCRIPT || process.env.BATON_SERVER_SCRIPT) {
    return process.env.LEG_SERVER_SCRIPT || process.env.BATON_SERVER_SCRIPT
  }
  const wtMatch = /[\\/]\.(?:leg|baton)-worktrees(?:[\\/].*)?$/.exec(SRC)
  if (wtMatch) {
    const root = SRC.slice(0, wtMatch.index)
    const mainServer = join(root, 'src', 'server.mjs')
    if (existsSync(mainServer)) return mainServer
  }
  return join(SRC, 'server.mjs')
}
const SERVER = resolveServer()
const VERSION = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')).version
const HEALTH_TIMEOUT_MS = Number(process.env.LEG_HEALTH_TIMEOUT_MS || process.env.BATON_HEALTH_TIMEOUT_MS || 20000)

// Every launcher line goes through here: one prefix, one redaction pass.
export function out(prefix, line, stream = process.stdout) {
  stream.write(`[${prefix}] ${redact(String(line)).replace(/\r?\n$/, '')}\n`)
}

export function pidfile() { const leg = join(home(), 'leg.pid'); const baton = join(home(), 'baton.pid'); if (existsSync(leg)) return leg; if (existsSync(baton)) return baton; return leg; }

function readPidfile() {
  try { return JSON.parse(readFileSync(pidfile(), 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function version(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: 8000 })
  if (r.error || r.status !== 0) return null
  return (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 60)
}

const INSTALL_HINT = {
  claude: 'https://claude.com/claude-code (then `claude` to log in)',
  codex: 'npm i -g @openai/codex (then `codex login`)',
  agy: 'Antigravity CLI (`agy`), log in once interactively',
  grok: 'xAI Grok CLI (`grok`), log in once via `grok login`',
}

// Rows: [name, status, detail]. Nothing here is fatal except "no adapter at all".
export async function preflight() {
  const rows = []
  rows.push(['node', 'ok', process.version])
  rows.push(['git', version('git') ? 'ok' : 'missing', version('git') ?? 'install git'])
  try { resolveChb(); rows.push(['context-handoff-bundle', 'ok', chbVersion() ?? 'version unknown']) } catch { rows.push(['context-handoff-bundle', 'missing', 'pip install -U context-handoff-bundle']) }
  let present = 0
  for (const name of adapterNames()) {
    if (isFake(name)) continue
    const a = await getAdapter(name)
    const { bin, viaNode, entry } = a.resolve()
    const v = viaNode ? version(process.execPath, [entry, '--version']) : version(bin)
    if (v) { present += 1; rows.push([name, 'ok', `${v} (${viaNode ? entry : bin})`]) } else rows.push([name, 'missing', INSTALL_HINT[name] ?? 'not on PATH'])
  }
  rows.push(['fake adapters', 'ok', 'fake, fake-claude, fake-codex, fake-agy, fake-grok (tests and demo)'])
  return { rows, adapters_present: present }
}

export function printPreflight({ rows }) {
  const w = Math.max(...rows.map((r) => r[0].length))
  for (const [name, status, detail] of rows) out('preflight', `${name.padEnd(w)}  ${status.padEnd(7)}  ${detail}`)
}

export function plannedProcesses({ port = Number(process.env.LEG_PORT || process.env.BATON_PORT || 4747), bind = process.env.LEG_BIND || process.env.BATON_BIND || '127.0.0.1' } = {}) {
  const procs = [{
    prefix: 'server', bin: process.execPath, argv: [SERVER], env: { LEG_PORT: String(port), LEG_BIND: bind, BATON_PORT: String(port), BATON_BIND: bind },
    note: 'board + API + scheduler + merge queue',
  }]
  const on = enabledSyncs()
  const syncs = [
    { prefix: 'sync:workboard', enabled: on.includes('workboard'), note: 'OpenClaw Workboard mirror (LEG_SYNC_WORKBOARD=1); runs inside the ledger, no extra process' },
    { prefix: 'sync:dashclaw', enabled: on.includes('dashclaw'), note: 'DashClaw action recording (LEG_SYNC_DASHCLAW=1 + DASHCLAW_URL + DASHCLAW_API_KEY); runs inside the ledger' },
  ]
  return { procs, syncs }
}

export function openBoard(url) {
  const argv = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    const child = spawn(argv[0], argv[1], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}

function health(port, bind) {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: bind === '0.0.0.0' ? '127.0.0.1' : bind, port, path: '/api/health', timeout: 2000 }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { try { resolvePromise(res.statusCode === 200 ? JSON.parse(d) : null) } catch { resolvePromise(null) } })
    })
    req.on('error', () => resolvePromise(null))
    req.on('timeout', () => { req.destroy(); resolvePromise(null) })
  })
}

// A pid is not a board: nothing clears the pidfile when the board dies with it,
// and after a reboot that pid usually belongs to something else. Something has
// to answer on the port — a 401 from a guarded board counts, so does a slow one.
function listening(port, bind) {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: bind === '0.0.0.0' ? '127.0.0.1' : bind, port, path: '/api/health', timeout: 2000 }, (res) => { res.resume(); resolvePromise(true) })
    req.on('socket', (s) => s.on('connect', () => resolvePromise(true)))
    req.on('error', () => resolvePromise(false))
    req.on('timeout', () => { req.destroy(); resolvePromise(false) })
  })
}

async function boardAlive(pf) {
  if (!pf || !pidAlive(pf.pid)) return false
  return await listening(pf.port, pf.bind ?? '127.0.0.1')
}

function pipeLines(stream, prefix, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) { out(prefix, line); onLine?.(line) }
    }
  })
  stream.on('end', () => { if (buf.trim()) { out(prefix, buf); onLine?.(buf) } })
}

function killTree(pid) {
  if (!pidAlive(pid)) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  else { try { process.kill(pid, 'SIGTERM') } catch {} setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 2000).unref() }
}

// Agents started by the orchestrator run under their own detached supervisors;
// on teardown kill every run that is still active so nothing burns tokens.
function killActiveAgents() {
  let n = 0
  for (const card of listCards()) {
    for (const run of readRuns(card.card_id)) {
      if (!['launching', 'running'].includes(run.status)) continue
      for (const pid of [run.agent_pid, run.supervisor_pid]) if (pidAlive(pid)) { killTree(pid); n += 1 }
    }
  }
  return n
}

export async function up({ dry = false, open = true, port = Number(process.env.LEG_PORT || process.env.BATON_PORT || 4747), bind = process.env.LEG_BIND || process.env.BATON_BIND || '127.0.0.1' } = {}) {
  out('leg', `leg ${VERSION} — home ${home()}`)
  const pf = await preflight()
  printPreflight(pf)
  if (pf.adapters_present === 0) out('leg', 'no real coding-agent CLI found; fake adapters still work for the demo', process.stderr)
  const plan = plannedProcesses({ port, bind })
  for (const s of plan.syncs) out('leg', `${s.prefix}: ${s.enabled ? 'on' : 'off'} (${s.note})`)
  if (dry) {
    out('leg', 'dry run: nothing spawned. Would run:')
    for (const p of plan.procs) out('leg', `${p.prefix}: ${JSON.stringify([p.bin, ...p.argv])} env ${JSON.stringify(p.env)}`)
    out('leg', `then poll http://${bind}:${port}/api/health, ${open ? 'open the board' : 'not open the board'}, write ${pidfile()}`)
    return 0
  }
  const existing = readPidfile()
  if (existing && existing.pid !== process.pid && await boardAlive(existing)) {
    out('leg', `already running (pid ${existing.pid}, port ${existing.port}); use \`leg down\` first`, process.stderr)
    return 1
  }
  if (existing) { try { rmSync(pidfile(), { force: true }) } catch {} }
  mkdirSync(home(), { recursive: true })
  const [p] = plan.procs
  const child = spawn(p.bin, p.argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...p.env, LEG_QUIET: '0', BATON_QUIET: '0' } })
  let actualPort = port
  const lastLines = []
  const remember = (line) => { lastLines.push(line); if (lastLines.length > 12) lastLines.shift(); const m = /listening on http:\/\/[^:]+:(\d+)/.exec(line); if (m) actualPort = Number(m[1]) }
  pipeLines(child.stdout, p.prefix, remember)
  pipeLines(child.stderr, p.prefix, remember)
  let exited = null
  child.on('exit', (code) => { exited = code ?? -1 })

  const t0 = Date.now()
  let ok = null
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS && exited === null) {
    ok = await health(actualPort, bind)
    if (ok) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!ok) {
    out('leg', `server not healthy after ${Math.round((Date.now() - t0) / 1000)} s${exited !== null ? ` (exited ${exited})` : ''}; last lines:`, process.stderr)
    for (const l of lastLines) out(p.prefix, l, process.stderr)
    killTree(child.pid)
    return 1
  }
  const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`
  writeFileSync(pidfile(), JSON.stringify({ pid: process.pid, port: actualPort, bind, children: [child.pid], started_at: new Date().toISOString() }, null, 2) + '\n')
  out('leg', `ready ${url}  (scheduler max ${MAX_CONCURRENT}, ${ok.cards} card${ok.cards === 1 ? '' : 's'})`)
  if (open) out('leg', openBoard(url) ? `opened ${url}` : `could not open a browser; visit ${url}`)
  out('leg', 'Ctrl-C stops everything')

  return await new Promise((resolvePromise) => {
    let stopping = false
    const stop = (why) => {
      if (stopping) return
      stopping = true
      out('leg', `stopping (${why})`)
      const agents = killActiveAgents()
      if (agents) out('leg', `killed ${agents} running agent/supervisor process(es)`)
      killTree(child.pid)
      try { rmSync(pidfile(), { force: true }) } catch {}
      out('leg', 'stopped')
      resolvePromise(0)
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGBREAK', () => stop('SIGBREAK'))
    child.on('exit', (code) => { if (!stopping) { out('leg', `server exited ${code}`, process.stderr); try { rmSync(pidfile(), { force: true }) } catch {} resolvePromise(code === 0 ? 0 : 1) } })
  })
}

// Stop the board process and nothing else. Sharing the board with someone is a
// configuration change: it restarts the listener, it does not end the runs.
export async function stopBoard() {
  const pf = readPidfile()
  if (!pf) return { stopped: false, stale: false }
  const alive = await boardAlive(pf)
  if (alive) for (const pid of [...(pf.children ?? []), pf.pid]) killTree(pid)
  try { rmSync(pidfile(), { force: true }) } catch {}
  return { stopped: alive, stale: !alive, pid: pf.pid, port: pf.port }
}

export async function down() {
  const pf = readPidfile()
  if (!pf) { out('leg', 'not running'); return 0 }
  const agents = killActiveAgents()
  const board = await stopBoard()
  out('leg', `stopped (pid ${pf.pid}, port ${pf.port}${agents ? `, ${agents} agent process(es) killed` : ''}${board.stale ? ', stale pidfile' : ''})`)
  return 0
}

export async function status() {
  const pf = readPidfile()
  const running = await boardAlive(pf)
  if (pf && !running) { try { rmSync(pidfile(), { force: true }) } catch {} }
  const cards = listCards()
  const by = (key) => Object.entries(cards.reduce((m, c) => { m[c[key]] = (m[c[key]] ?? 0) + 1; return m }, {})).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'
  if (running) {
    const up = Math.round((Date.now() - Date.parse(pf.started_at)) / 1000)
    out('leg', `running  pid ${pf.pid}  port ${pf.port}  up ${Math.floor(up / 60)}m${up % 60}s  http://127.0.0.1:${pf.port}`)
  } else {
    out('leg', pf ? `stopped (pid ${pf.pid} is not answering on port ${pf.port}; cleared the stale pidfile)` : 'stopped')
  }
  const s = schedulerStatus()
  out('leg', `scheduler ${s.running ? `running (pid ${s.pid})` : 'stopped'}  max concurrent ${MAX_CONCURRENT}`)
  out('leg', `cards ${cards.length}  by status: ${by('status')}`)
  out('leg', `by station: ${by('station')}`)
  return running ? 0 : 3
}

export function listHomeRuns() {
  const root = join(home(), 'cards')
  return existsSync(root) ? readdirSync(root).length : 0
}
