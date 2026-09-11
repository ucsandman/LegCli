// launcher — the one command. `baton up` runs preflight, spawns the board
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

const SRC = dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.BATON_SERVER_SCRIPT || join(SRC, 'server.mjs')
const VERSION = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')).version
const HEALTH_TIMEOUT_MS = Number(process.env.BATON_HEALTH_TIMEOUT_MS || 20000)

// Every launcher line goes through here: one prefix, one redaction pass.
export function out(prefix, line, stream = process.stdout) {
  stream.write(`[${prefix}] ${redact(String(line)).replace(/\r?\n$/, '')}\n`)
}

export function pidfile() { return join(home(), 'baton.pid') }

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
  gemini: 'npm i -g @google/gemini-cli (then `gemini` to log in)',
  agy: 'Antigravity CLI (`agy`), log in once interactively',
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
  rows.push(['fake adapters', 'ok', 'fake, fake-claude, fake-codex, fake-gemini, fake-agy (tests and demo)'])
  return { rows, adapters_present: present }
}

export function printPreflight({ rows }) {
  const w = Math.max(...rows.map((r) => r[0].length))
  for (const [name, status, detail] of rows) out('preflight', `${name.padEnd(w)}  ${status.padEnd(7)}  ${detail}`)
}

export function plannedProcesses({ port = Number(process.env.BATON_PORT || 4747), bind = process.env.BATON_BIND || '127.0.0.1' } = {}) {
  const procs = [{
    prefix: 'server', bin: process.execPath, argv: [SERVER], env: { BATON_PORT: String(port), BATON_BIND: bind },
    note: 'board + API + scheduler + merge queue',
  }]
  const syncs = [
    { prefix: 'sync:workboard', enabled: process.env.BATON_SYNC_WORKBOARD === '1', note: 'OpenClaw Workboard mirror (BATON_SYNC_WORKBOARD=1)' },
    { prefix: 'sync:dashclaw', enabled: Boolean(process.env.DASHCLAW_URL && process.env.DASHCLAW_API_KEY), note: 'DashClaw action recording (DASHCLAW_URL + DASHCLAW_API_KEY)' },
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

export async function up({ dry = false, open = true, port = Number(process.env.BATON_PORT || 4747), bind = process.env.BATON_BIND || '127.0.0.1' } = {}) {
  out('baton', `baton ${VERSION} — home ${home()}`)
  const pf = await preflight()
  printPreflight(pf)
  if (pf.adapters_present === 0) out('baton', 'no real coding-agent CLI found; fake adapters still work for the demo', process.stderr)
  const plan = plannedProcesses({ port, bind })
  for (const s of plan.syncs) out('baton', `${s.prefix}: ${s.enabled ? 'on' : 'off'} (${s.note})`)
  if (dry) {
    out('baton', 'dry run: nothing spawned. Would run:')
    for (const p of plan.procs) out('baton', `${p.prefix}: ${JSON.stringify([p.bin, ...p.argv])} env ${JSON.stringify(p.env)}`)
    out('baton', `then poll http://${bind}:${port}/api/health, ${open ? 'open the board' : 'not open the board'}, write ${pidfile()}`)
    return 0
  }
  const existing = readPidfile()
  if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
    out('baton', `already running (pid ${existing.pid}, port ${existing.port}); use \`baton down\` first`, process.stderr)
    return 1
  }
  mkdirSync(home(), { recursive: true })
  const [p] = plan.procs
  const child = spawn(p.bin, p.argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...p.env, BATON_QUIET: '0' } })
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
    out('baton', `server not healthy after ${Math.round((Date.now() - t0) / 1000)} s${exited !== null ? ` (exited ${exited})` : ''}; last lines:`, process.stderr)
    for (const l of lastLines) out(p.prefix, l, process.stderr)
    killTree(child.pid)
    return 1
  }
  const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`
  writeFileSync(pidfile(), JSON.stringify({ pid: process.pid, port: actualPort, bind, children: [child.pid], started_at: new Date().toISOString() }, null, 2) + '\n')
  out('baton', `ready ${url}  (scheduler max ${MAX_CONCURRENT}, ${ok.cards} card${ok.cards === 1 ? '' : 's'})`)
  if (open) out('baton', openBoard(url) ? `opened ${url}` : `could not open a browser; visit ${url}`)
  out('baton', 'Ctrl-C stops everything')

  return await new Promise((resolvePromise) => {
    let stopping = false
    const stop = (why) => {
      if (stopping) return
      stopping = true
      out('baton', `stopping (${why})`)
      const agents = killActiveAgents()
      if (agents) out('baton', `killed ${agents} running agent/supervisor process(es)`)
      killTree(child.pid)
      try { rmSync(pidfile(), { force: true }) } catch {}
      out('baton', 'stopped')
      resolvePromise(0)
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGBREAK', () => stop('SIGBREAK'))
    child.on('exit', (code) => { if (!stopping) { out('baton', `server exited ${code}`, process.stderr); try { rmSync(pidfile(), { force: true }) } catch {} resolvePromise(code === 0 ? 0 : 1) } })
  })
}

export function down() {
  const pf = readPidfile()
  if (!pf) { out('baton', 'not running'); return 0 }
  const agents = killActiveAgents()
  for (const pid of [...(pf.children ?? []), pf.pid]) killTree(pid)
  try { rmSync(pidfile(), { force: true }) } catch {}
  out('baton', `stopped (pid ${pf.pid}, port ${pf.port}${agents ? `, ${agents} agent process(es) killed` : ''})`)
  return 0
}

export function status() {
  const pf = readPidfile()
  const running = Boolean(pf && pidAlive(pf.pid))
  const cards = listCards()
  const by = (key) => Object.entries(cards.reduce((m, c) => { m[c[key]] = (m[c[key]] ?? 0) + 1; return m }, {})).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'
  if (running) {
    const up = Math.round((Date.now() - Date.parse(pf.started_at)) / 1000)
    out('baton', `running  pid ${pf.pid}  port ${pf.port}  up ${Math.floor(up / 60)}m${up % 60}s  http://127.0.0.1:${pf.port}`)
  } else {
    out('baton', pf ? `stopped (stale pidfile pid ${pf.pid})` : 'stopped')
  }
  const s = schedulerStatus()
  out('baton', `scheduler ${s.running ? `running (pid ${s.pid})` : 'stopped'}  max concurrent ${MAX_CONCURRENT}`)
  out('baton', `cards ${cards.length}  by status: ${by('status')}`)
  out('baton', `by station: ${by('station')}`)
  return running ? 0 : 3
}

export function listHomeRuns() {
  const root = join(home(), 'cards')
  return existsSync(root) ? readdirSync(root).length : 0
}
