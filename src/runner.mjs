#!/usr/bin/env node
// Ported 2026-09-10 from private ucsandman team tooling; see NOTICE and docs/REUSE.md.
// runner — detached, supervised execution of one agent leg on a card.
// Subcommands: launch | supervise | sweep.
// State: $BATON_HOME/cards/<id>/runs/<n>/ (run.json, prompt.txt, out.log, err.log,
// supervisor.log). Ledger writes go through src/ledger.mjs. Exports sanitizeEnv.
import {
  mkdirSync, readFileSync, existsSync, openSync, copyFileSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { writeJsonAtomic, withFileLock } from './fsx.mjs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { get as getAdapter } from './adapters/index.mjs'
import { classify } from './limits.mjs'

const SELF = fileURLToPath(import.meta.url)
const LEDGER = join(dirname(SELF), 'ledger.mjs')
const ROOT = process.env.LEG_HOME || process.env.BATON_HOME || (existsSync(join(homedir(), '.leg')) ? join(homedir(), '.leg') : existsSync(join(homedir(), '.baton')) ? join(homedir(), '.baton') : join(homedir(), '.leg'))
const [NOTIFY_MS, KILL_MS, KILL_VERIFY_RAW] = ((process.env.LEG_TIMERS_MS || process.env.BATON_TIMERS_MS) || '1800000,5400000')
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
  // atomic: the orchestrator and the board poll this file (src/fsx.mjs)
  writeJsonAtomic(join(runDir(id, n), 'run.json'), { ...r, updated_at: now() })
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Read-modify-write of run.json under its lock. The supervisor (status,
// agent_pid, the verdict), the driving orchestrator (driver_pid, settled_at)
// and a human Kill (kill_requested) all patch this file from different
// processes; without the lock the last writer silently dropped the others'
// fields. A read that finds the file torn (the atomic write's direct-write
// fallback on Windows) is retried before fn sees a null.
export function updateRun(id, n, fn) {
  // a longer budget than the hook default: nobody's turn is waiting on this,
  // and a patch that runs unlocked is a patch that can be lost
  return withFileLock(join(runDir(id, n), 'run.json.lock'), () => {
    let cur = readRun(id, n)
    for (let i = 0; cur === null && i < 5 && existsSync(join(runDir(id, n), 'run.json')); i++) { pause(20); cur = readRun(id, n) }
    const next = fn(cur)
    if (next) writeRun(id, n, next)
    return next
  }, { retries: 250, waitMs: 20, staleMs: 10000 })
}

// Ledger writes must never crash the supervisor; failures go to its log.
function ledgerSafe(argsArr, log) {
  try {
    execFileSync(process.execPath, [LEDGER, ...argsArr],
      { windowsHide: true, encoding: 'utf8', env: process.env })
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
// One pattern list for the whole project lives in src/redact.mjs.
import { scrub } from './redact.mjs'
export { scrub }

function errTail(path, lines = 10) {
  if (!existsSync(path)) return '(no stderr)'
  const all = readFileSync(path, 'utf8').trim().split('\n')
  return scrub(all.slice(-lines).join(' | ')).slice(0, 1500)
}

function killTree(pid, log) {
  if ((process.env.LEG_SKIP_KILL || process.env.BATON_SKIP_KILL) === '1') { // test seam: unkillable agent
    log('BATON_SKIP_KILL=1: killTree skipped')
    return
  }
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0) log(`taskkill failed: ${String(r.stderr ?? '').slice(0, 300)}`)
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
}

// Work evidence for the classifier: did the leg change anything in its cwd?
// Cheap and worktree-agnostic: porcelain status plus HEAD movement. Not a git
// repo → null (the classifier then trusts only the DONE marker).
function gitHead(cwd) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return r.status === 0 ? r.stdout.trim() : null
}

function gitDiff(cwd, headAtStart) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0) return null
  const files = r.stdout.split(/\r?\n/).filter(Boolean).filter((l) => !/\.baton[\\/]/.test(l)).length
  const head = gitHead(cwd)
  return { changed: files > 0 || (headAtStart !== null && head !== headAtStart), files, head_at_start: headAtStart, head }
}

// Fallback when the cwd is not a git repo (tests, ad-hoc dirs): a shallow
// mtime snapshot, so "wrote a file but no DONE" still reads as incomplete.
const SNAP_SKIP = new Set(['.git', 'node_modules', '.baton', '.baton-worktrees', '.leg', '.leg-worktrees'])
function fsSnapshot(cwd, depth = 3) {
  const out = new Map()
  const walk = (dir, rel, d) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (SNAP_SKIP.has(name) || out.size > 5000) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { if (d > 0) walk(full, `${rel}${name}/`, d - 1) } else out.set(`${rel}${name}`, st.mtimeMs)
    }
  }
  walk(cwd, '', depth)
  return out
}

function fsDiff(cwd, before) {
  const after = fsSnapshot(cwd)
  let files = 0
  for (const [k, v] of after) if (!before.has(k) || before.get(k) !== v) files += 1
  for (const k of before.keys()) if (!after.has(k)) files += 1
  return { changed: files > 0, files, head_at_start: null, head: null, source: 'fs' }
}

function legOpts(args) {
  const opts = {}
  if (args.mode) opts.mode = args.mode
  if (args['env-json']) {
    // Extra child variables (e.g. FAKE_MODE for the fake adapter); the adapter's
    // env() still sanitizes the result, so auth keys cannot be smuggled in.
    try { opts.extraEnv = JSON.parse(args['env-json']) } catch { die(2, 'invalid --env-json') }
    if (!opts.extraEnv || typeof opts.extraEnv !== 'object') die(2, 'invalid --env-json')
  }
  if (args['max-turns']) {
    opts.maxTurns = parseInt(args['max-turns'], 10)
    if (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1) die(2, `invalid --max-turns "${args['max-turns']}"`)
  }
  if (args.resume) opts.resume = args.resume
  if (args.model) opts.model = args.model
  if (args.network === '1' || args.network === 'true') opts.network = true
  return opts
}

function legArgv(opts) {
  const out = []
  if (opts.mode) out.push('--mode', opts.mode)
  if (opts.maxTurns) out.push('--max-turns', String(opts.maxTurns))
  if (opts.resume) out.push('--resume', opts.resume)
  if (opts.model) out.push('--model', opts.model)
  if (opts.network) out.push('--network', '1')
  if (opts.extraEnv) out.push('--env-json', JSON.stringify(opts.extraEnv))
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
    // run.json exists, naming its driver, before the supervisor is spawned: a
    // second driver or a scheduler tick landing here sees a claimed run, never
    // an empty directory it could launch into.
    const driverPid = args['driver-pid'] ? parseInt(args['driver-pid'], 10) : null
    writeRun(id, n, {
      card_id: id, run: n, adapter: adapterName, mode: opts.mode ?? null,
      max_turns: opts.maxTurns ?? null, model: opts.model ?? null, resume: opts.resume ?? null, cwd,
      status: 'launching', supervisor_pid: null, agent_pid: null,
      driver_pid: Number.isInteger(driverPid) ? driverPid : null,
      started_at: now(), outcome: null,
    })
    const child = spawn(process.execPath,
      [SELF, 'supervise', '--card', id, '--adapter', adapterName, '--run', String(n),
       '--cwd', cwd, ...legArgv(opts)],
      { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd], env: process.env })
    child.unref()
    updateRun(id, n, (cur) => ({ ...cur, supervisor_pid: child.pid }))
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
    // what a run.json patch falls back to if the file cannot be read (torn)
    const base = { card_id: id, run: n, adapter: adapterName, cwd, supervisor_pid: process.pid, started_at: now() }
    // stdout IS supervisor.log when launched detached; timestamps make it a log.
    const log = (msg) => process.stdout.write(`${now()} ${msg}\n`)
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
    const outPath = join(dir, 'out.log')
    const errPath = join(dir, 'err.log')
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')
    let adapter
    try { adapter = await getAdapter(adapterName) } catch (err) { die(2, err.message) }
    let spec
    try {
      spec = adapter.argv({ ...opts, cwd, prompt, promptFile: join(dir, 'prompt.txt'), runDir: dir, killMs: KILL_MS })
    } catch (err) {
      // A forbidden mode/flag never spawns: record it and fail the leg.
      log(`refusing to launch: ${err.message}`)
      ledgerAppend(id, 'error', `[supervisor] refused to launch: ${scrub(err.message).slice(0, 200)}`, null, log)
      updateRun(id, n, (cur) => ({ ...(cur ?? base), status: 'failed', exit_code: null, ended_at: now(), refusal: err.message }))
      process.exit(13)
    }
    const childEnv = adapter.env({ ...process.env, ...(opts.extraEnv ?? {}) })
    // A stale DONE marker from an earlier leg must not count for this one.
    rmSync(join(cwd, '.leg', 'DONE'), { force: true })
    rmSync(join(cwd, '.baton', 'DONE'), { force: true })
    const headAtStart = gitHead(cwd)
    const fsAtStart = headAtStart === null ? fsSnapshot(cwd) : null
    log(`spawning leg: adapter=${adapterName} run=${n} mode=${opts.mode ?? 'default'} cwd=${cwd}`)
    ledgerAppend(id, 'leg_started', `leg started: adapter=${adapterName} run=${n} mode=${opts.mode ?? 'default'}`, null, log)
    const child = spawn(spec.bin, spec.args, {
      cwd, windowsHide: true, stdio: [adapter.stdin === 'pipe' ? 'pipe' : 'ignore', outFd, errFd], env: childEnv,
    })
    if (adapter.stdin === 'pipe') {
      child.stdin.on('error', () => {})
      child.stdin.write(prompt)
      child.stdin.end()
    }

    child.on('error', (err) => {
      log(`agent spawn error: ${err.message}`)
      ledgerAppend(id, 'error', `[supervisor] agent spawn failed: ${scrub(err.message).slice(0, 200)}`, null, log)
      // A run that never started still needs a verdict, or the orchestrator
      // has nothing to transition on and the card sits in `running` forever.
      const verdict = classify({
        adapter: adapter.emulates ?? adapterName, exitCode: null, stdout: '', stderr: '', result: null,
        doneMarker: false, diff: null, killedByTimer: false, killedByHuman: false, spawnError: err.message,
      })
      updateRun(id, n, (cur) => ({
        ...(cur ?? base), status: 'failed', exit_code: null, ended_at: now(),
        outcome: verdict.outcome, signal: verdict.signal, handoff: verdict.handoff, reason: verdict.reason,
      }))
      process.exit(13)
    })

    updateRun(id, n, (cur) => ({ ...(cur ?? base), status: 'running', agent_pid: child.pid }))
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
          updateRun(id, n, (cur) => ({ ...(cur ?? base), status: 'killed', exit_code: null, ended_at: now() }))
          process.exit(12)
        }, KILL_VERIFY_MS)
      }, KILL_VERIFY_MS)
    }, KILL_MS)

    child.on('exit', (code) => {
      clearTimeout(notifyTimer)
      clearTimeout(killTimer)
      // JSON-only-at-end: the result file is read here, after the exit event,
      // and nowhere else (LESSONS 07-10).
      let stdout = ''
      let stderr = ''
      try { stdout = readFileSync(outPath, 'utf8') } catch {}
      try { stderr = readFileSync(errPath, 'utf8') } catch {}
      let parsed = null
      try { parsed = adapter.parseResult(stdout) } catch {}
      const sessionId = parsed?.session_id ?? null
      if (sessionId) {
        ledgerSafe(['update', '--card', id, '--session-id', sessionId], log)
      }
      const current = readRun(id, n)
      const doneMarker = existsSync(join(cwd, '.leg', 'DONE')) || existsSync(join(cwd, '.baton', 'DONE'))
      const diff = fsAtStart ? fsDiff(cwd, fsAtStart) : gitDiff(cwd, headAtStart)
      const verdict = classify({
        adapter: adapter.emulates ?? adapterName, exitCode: code, stdout, stderr, result: parsed?.raw ?? null,
        doneMarker, diff, killedByTimer, killedByHuman: current?.kill_requested === true, spawnError: null,
      })
      const final = {
        exit_code: code, session_id: sessionId, ended_at: now(),
        outcome: verdict.outcome, signal: verdict.signal, handoff: verdict.handoff, reason: verdict.reason,
        done_marker: doneMarker, diff,
      }
      const summary = `[supervisor] leg ${verdict.outcome} (exit ${code}${sessionId ? `, session ${sessionId}` : ''}${verdict.signal !== 'none' ? `, signal ${verdict.signal}` : ''})`
      if (killedByTimer || verdict.outcome === 'killed') {
        ledgerAppend(id, 'killed', summary, verdict.reason, log)
        updateRun(id, n, (cur) => ({ ...(cur ?? current ?? base), ...final, status: 'killed' }))
        process.exit(12)
      }
      const eventType = verdict.outcome === 'limit' ? 'limit_detected'
        : (verdict.outcome === 'auth_failed' || verdict.outcome === 'launch_failed') ? 'error'
          : 'leg_exited'
      ledgerAppend(id, eventType, summary,
        verdict.outcome === 'completed' ? null : `${verdict.reason}${code === 0 ? '' : ` | stderr: ${errTail(errPath)}`}`, log)
      updateRun(id, n, (cur) => ({ ...(cur ?? current ?? base), ...final, status: 'exited' }))
      log(`leg exited code ${code}: ${verdict.outcome} (${verdict.reason})`)
      process.exit(verdict.outcome === 'completed' ? 0 : 13)
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
