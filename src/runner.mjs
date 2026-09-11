#!/usr/bin/env node
// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
// runner — detached, supervised execution of one agent leg on a card.
// Subcommands: launch | supervise | sweep.
// State: $BATON_HOME/cards/<id>/runs/<n>/ (run.json, prompt.txt, out.log, err.log,
// supervisor.log). Ledger writes go through src/ledger.mjs. Exports sanitizeEnv.
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, openSync, copyFileSync, readdirSync,
} from 'node:fs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { get as getAdapter } from './adapters/index.mjs'

const SELF = fileURLToPath(import.meta.url)
const LEDGER = join(dirname(SELF), 'ledger.mjs')
const ROOT = process.env.BATON_HOME || join(homedir(), '.baton')
const [NOTIFY_MS, KILL_MS, KILL_VERIFY_RAW] = (process.env.BATON_TIMERS_MS || '1800000,5400000')
  .split(',').map(Number)
const KILL_VERIFY_MS = Number.isFinite(KILL_VERIFY_RAW) ? KILL_VERIFY_RAW : 30000
const BATON_ACTOR = JSON.stringify({ type: 'baton' })
const ACTIVE = ['launching', 'running']

// Every adapter's env() calls sanitizeEnv; it lives in src/env.mjs (see there)
// and is re-exported here so callers have one import.
export { sanitizeEnv } from './env.mjs'

function die(code, msg) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      die(2, `bad argument pair near "${argv[i]}"`)
    }
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

function need(args, key) {
  const v = args[key]
  if (!v) die(2, `missing --${key}`)
  return v
}

const now = () => new Date().toISOString()

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function cardDir(id) { return join(ROOT, 'cards', id) }
function runsDir(id) { return join(cardDir(id), 'runs') }
function runDir(id, n) { return join(runsDir(id), String(n)) }

function listRuns(id) {
  const dir = runsDir(id)
  if (!existsSync(dir)) return []
  return readdirSync(dir).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
}

function readRun(id, n) {
  const f = join(runDir(id, n), 'run.json')
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

function writeRun(id, n, r) {
  writeFileSync(join(runDir(id, n), 'run.json'),
    JSON.stringify({ ...r, updated_at: now() }, null, 2) + '\n')
}

// Ledger writes must never crash the supervisor; failures go to its log.
function ledgerSafe(argsArr, log) {
  try {
    execFileSync(process.execPath, [LEDGER, ...argsArr],
      { encoding: 'utf8', env: process.env })
    return true
  } catch (err) {
    log(`ledger write failed: ${String(err.message).slice(0, 300)}`)
    return false
  }
}

function ledgerAppend(id, type, summary, body, log) {
  const argsArr = ['append', '--card', id, '--actor', BATON_ACTOR, '--type', type, '--summary', summary]
  if (body) argsArr.push('--body', body)
  return ledgerSafe(argsArr, log)
}

// The ledger's assertNoSecrets dies on matches; scrub BEFORE logging.
// Patterns mirror ledger.mjs SECRET_PATTERNS (kept in both files on
// purpose: this one rewrites, that one refuses).
const SECRET_RES = [
  /sk-[A-Za-z0-9]{8,}/g, /oc_live_[a-f0-9]\w*/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g, /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g, /xox[bp]-\S*/g,
  /api[_-]?key\s*[=:]\s*\S+/gi,
]
export function scrub(s) {
  let out = s
  for (const re of SECRET_RES) out = out.replace(re, '[REDACTED]')
  return out
}

function errTail(path, lines = 10) {
  if (!existsSync(path)) return '(no stderr)'
  const all = readFileSync(path, 'utf8').trim().split('\n')
  return scrub(all.slice(-lines).join(' | ')).slice(0, 1500)
}

function killTree(pid, log) {
  if (process.env.BATON_SKIP_KILL === '1') { // test seam: unkillable agent
    log('BATON_SKIP_KILL=1: killTree skipped')
    return
  }
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    if (r.status !== 0) log(`taskkill failed: ${String(r.stderr ?? '').slice(0, 300)}`)
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
}

function legOpts(args) {
  const opts = {}
  if (args.mode) opts.mode = args.mode
  if (args['max-turns']) {
    opts.maxTurns = parseInt(args['max-turns'], 10)
    if (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1) die(2, `invalid --max-turns "${args['max-turns']}"`)
  }
  if (args.resume) opts.resume = args.resume
  return opts
}

function legArgv(opts) {
  const out = []
  if (opts.mode) out.push('--mode', opts.mode)
  if (opts.maxTurns) out.push('--max-turns', String(opts.maxTurns))
  if (opts.resume) out.push('--resume', opts.resume)
  return out
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (cmd === 'launch') {
    const id = need(args, 'card')
    if (!existsSync(join(cardDir(id), 'card.json'))) die(3, `card not found: ${id}`)
    const adapterName = need(args, 'adapter')
    try { await getAdapter(adapterName) } catch (err) { die(2, err.message) }
    const promptFile = need(args, 'prompt-file')
    if (!existsSync(promptFile)) die(2, `prompt file not found: ${promptFile}`)
    const cwd = resolve(args.cwd || process.cwd())
    const opts = legOpts(args)
    mkdirSync(runsDir(id), { recursive: true })
    let last = 0
    for (const n of listRuns(id)) {
      last = n
      const r = readRun(id, n)
      if (!r || !ACTIVE.includes(r.status)) continue
      if (pidAlive(r.supervisor_pid)) {
        process.stdout.write(JSON.stringify({
          ok: false, error: 'run_already_active', run: n, supervisor_pid: r.supervisor_pid,
        }) + '\n')
        process.exit(11)
      }
      writeRun(id, n, { ...r, status: 'orphaned' })
    }
    const n = last + 1
    const dir = runDir(id, n)
    mkdirSync(dir, { recursive: true })
    copyFileSync(promptFile, join(dir, 'prompt.txt'))
    const logFd = openSync(join(dir, 'supervisor.log'), 'a')
    const child = spawn(process.execPath,
      [SELF, 'supervise', '--card', id, '--adapter', adapterName, '--run', String(n),
       '--cwd', cwd, ...legArgv(opts)],
      { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd], env: process.env })
    child.unref()
    writeRun(id, n, {
      card_id: id, run: n, adapter: adapterName, mode: opts.mode ?? null,
      max_turns: opts.maxTurns ?? null, resume: opts.resume ?? null, cwd,
      status: 'launching', supervisor_pid: child.pid, agent_pid: null,
      started_at: now(), outcome: null,
    })
    process.stdout.write(JSON.stringify({
      ok: true, run: n, supervisor_pid: child.pid, run_dir: dir,
    }) + '\n')
    process.exit(0)
  } else if (cmd === 'supervise') {
    const id = need(args, 'card')
    const adapterName = need(args, 'adapter')
    const n = parseInt(need(args, 'run'), 10)
    if (!Number.isInteger(n) || n < 1) die(2, `invalid --run "${args.run}"`)
    const cwd = resolve(args.cwd || process.cwd())
    const opts = legOpts(args)
    if (!Number.isFinite(NOTIFY_MS) || !Number.isFinite(KILL_MS)) {
      die(2, `bad BATON_TIMERS_MS "${process.env.BATON_TIMERS_MS}"`)
    }
    const dir = runDir(id, n)
    // stdout IS supervisor.log when launched detached; timestamps make it a log.
    const log = (msg) => process.stdout.write(`${now()} ${msg}\n`)
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
    const outPath = join(dir, 'out.log')
    const errPath = join(dir, 'err.log')
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')
    let adapter
    try { adapter = await getAdapter(adapterName) } catch (err) { die(2, err.message) }
    const spec = adapter.argv({ ...opts, cwd, prompt, promptFile: join(dir, 'prompt.txt') })
    const childEnv = adapter.env(process.env)
    log(`spawning leg: adapter=${adapterName} run=${n} mode=${opts.mode ?? 'default'} cwd=${cwd}`)
    ledgerAppend(id, 'leg_started', `leg started: adapter=${adapterName} run=${n} mode=${opts.mode ?? 'default'}`, null, log)
    const child = spawn(spec.bin, spec.args, {
      cwd, stdio: [adapter.stdin === 'pipe' ? 'pipe' : 'ignore', outFd, errFd], env: childEnv,
    })
    if (adapter.stdin === 'pipe') {
      child.stdin.on('error', () => {})
      child.stdin.write(prompt)
      child.stdin.end()
    }

    child.on('error', (err) => {
      log(`agent spawn error: ${err.message}`)
      ledgerAppend(id, 'error', `[supervisor] agent spawn failed: ${scrub(err.message).slice(0, 200)}`, null, log)
      writeRun(id, n, { ...readRun(id, n), status: 'failed', exit_code: null, ended_at: now() })
      process.exit(13)
    })

    writeRun(id, n, { ...readRun(id, n), status: 'running', agent_pid: child.pid })
    let killedByTimer = false
    const notifyTimer = setTimeout(() => {
      ledgerAppend(id, 'status',
        `[supervisor] leg still running after ${Math.round(NOTIFY_MS / 60000)}m`,
        `log: ${errPath}`, log)
    }, NOTIFY_MS)
    const killTimer = setTimeout(() => {
      killedByTimer = true
      log(`kill timer fired after ${KILL_MS}ms; killing pid ${child.pid}`)
      killTree(child.pid, log)
      // Kill-verify fallback: taskkill can fail and leave the agent burning
      // tokens with the supervisor blocked on the child handle forever.
      // Retry once, then surface the unkillable pid and exit anyway.
      setTimeout(() => {
        if (child.exitCode !== null || !pidAlive(child.pid)) return
        log(`agent pid ${child.pid} survived kill; retrying once`)
        killTree(child.pid, log)
        setTimeout(() => {
          if (child.exitCode !== null || !pidAlive(child.pid)) return
          ledgerAppend(id, 'error',
            `[supervisor] agent UNKILLABLE (pid ${child.pid}); manual kill required`, null, log)
          writeRun(id, n, { ...readRun(id, n), status: 'killed', exit_code: null, ended_at: now() })
          process.exit(12)
        }, KILL_VERIFY_MS)
      }, KILL_VERIFY_MS)
    }, KILL_MS)

    child.on('exit', (code) => {
      clearTimeout(notifyTimer)
      clearTimeout(killTimer)
      let sessionId = null
      try { sessionId = adapter.parseResult(readFileSync(outPath, 'utf8'))?.session_id ?? null } catch {}
      if (sessionId) {
        ledgerSafe(['update', '--card', id, '--session-id', sessionId], log)
      }
      const base = { ...readRun(id, n), exit_code: code, session_id: sessionId, ended_at: now() }
      if (killedByTimer) {
        ledgerAppend(id, 'killed',
          `[supervisor] agent killed after ${Math.round(KILL_MS / 60000)}m`, null, log)
        writeRun(id, n, { ...base, status: 'killed' })
        process.exit(12)
      }
      // Classification (completed / incomplete / limit / …) is the chain's job;
      // the supervisor only records that the leg exited and how.
      ledgerAppend(id, 'leg_exited',
        `[supervisor] agent exited code ${code}${sessionId ? ` session ${sessionId}` : ''}`,
        code === 0 ? null : errTail(errPath), log)
      writeRun(id, n, { ...base, status: 'exited', outcome: null })
      log(`leg exited code ${code}, session ${sessionId}`)
      process.exit(code === 0 ? 0 : 13)
    })
  } else if (cmd === 'sweep') {
    const log = (msg) => process.stdout.write(`${msg}\n`)
    const cardsRoot = join(ROOT, 'cards')
    const ids = existsSync(cardsRoot) ? readdirSync(cardsRoot).sort() : []
    let active = 0
    const orphanLines = []
    for (const id of ids) {
      for (const n of listRuns(id)) {
        const r = readRun(id, n)
        if (!r || !ACTIVE.includes(r.status)) continue
        if (pidAlive(r.supervisor_pid)) { active += 1; continue }
        writeRun(id, n, { ...r, status: 'orphaned' })
        ledgerAppend(id, 'error',
          `[sweep] supervisor pid ${r.supervisor_pid} dead; run ${n} orphaned`, null, log)
        const agentAlive = pidAlive(r.agent_pid)
        orphanLines.push(`ORPHANED ${id} run ${n}: supervisor ${r.supervisor_pid} dead; ` +
          (agentAlive
            ? `agent pid ${r.agent_pid} STILL ALIVE — consider: taskkill /PID ${r.agent_pid} /T /F`
            : `agent pid ${r.agent_pid ?? 'unknown'} dead`))
      }
    }
    for (const line of orphanLines) log(line)
    if (!orphanLines.length) {
      log(active ? `OK: ${active} active run(s), no orphans` : 'OK: no active runs')
    }
    process.exit(0)
  } else {
    die(2, `unknown command "${cmd ?? ''}" (expected launch|supervise|sweep)`)
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()
if (isMain) await main()
