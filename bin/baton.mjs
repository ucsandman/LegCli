#!/usr/bin/env node
// baton — headless CLI. The board (phase 6) is the human surface; this is the
// agent/script surface and the test seam. Output via process.stdout only.
//   baton card add --repo <p> --task "<t>" --chain claude,codex [--pipeline preset|file] …
//   baton card ls [--json] | show <id> | run <id> | rm <id> [--delete-branch] | events <id>
//   baton card <pause|resume|kill|approve|handoff-now|rerun> <id> | reassign <id> --adapter a [--mode m]
//   baton scheduler start [--ticks N] [--interval-ms N] | status | stop
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { PRESET_NAMES } from '../src/presets.mjs'
import { readCard, listCards, readEvents, readRuns, cardDir } from '../src/store.mjs'
import { runCard, humanAction } from '../src/orchestrator.mjs'
import { createCard, CardInputError } from '../src/cards.mjs'
import { remove as removeWorktree } from '../src/worktree.mjs'
import { createScheduler, schedulerStatus, pidfile, MAX_CONCURRENT } from '../src/scheduler.mjs'
import { availableActions } from '../src/chain.mjs'
import { up, down, status, openBoard } from '../src/launcher.mjs'
import { attach } from '../src/attach.mjs'
import { AGENTS, listSessions, readSession, readEvents as readSessionEvents, requestControl, removeSession, isActive } from '../src/sessions.mjs'
import { addAccount, removeAccount, listAccountRows, LAYOUT } from '../src/accounts.mjs'
import { listUsage, fmtReset } from '../src/usage.mjs'
import { home } from '../src/store.mjs'

const out = (s) => process.stdout.write(s + '\n')
const die = (code, msg) => { process.stderr.write(msg + '\n'); process.exit(code) }

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { args[key] = true } else { args[key] = next; i++ }
    } else args._.push(a)
  }
  return args
}

async function cardAdd(args) {
  try {
    const card = await createCard({
      repo: args.repo, task: args.task, chain: args.chain, pipeline: args.pipeline,
      mode: args.mode, maxTurns: args['max-turns'], fakeMode: args['fake-mode'], fakeFixture: args['fake-fixture'],
      fakeTarget: args['fake-target'], fakeContent: args['fake-content'],
      approve: args.approve, leases: args.leases, trunk: args.trunk, landMode: args['land-mode'],
      testCommand: args['test-command'], title: args.title, slug: args.slug, queue: Boolean(args.queue),
    }, { type: 'human', id: args.actor || 'local' })
    out(card.card_id)
  } catch (err) {
    if (err instanceof CardInputError) die(2, err.message)
    throw err
  }
}

function fmtCard(c) {
  const st = c.pipeline?.find((s) => s.name === c.station)
  const leg = st?.kind === 'agent' ? ` leg ${c.leg}/${st.chain.length} (${st.chain[c.leg]?.adapter ?? '-'})` : ''
  return `${c.card_id}  [${c.status}]  ${c.station}${leg}  leases=${(c.leases?.length ? c.leases : ['**']).join(',')}  ${String(c.title ?? c.task).slice(0, 60)}`
}

const TERMS = `Terms check (fetched 2026-09-11): Anthropic Consumer Terms forbid sharing account credentials and "bypassing any of our systems or protective measures"; the Anthropic Usage Policy forbids coordinating across multiple accounts to circumvent product guardrails; OpenAI's Terms of Use forbid sharing credentials and "circumvent any rate limits or restrictions". Two paid logins you own are not banned by name, but rotating to a second account of the same vendor because the first is rate-limited is close to that wording. Baton's default chain switches vendors (claude -> codex -> agy); a second account of one vendor is your call.`

async function main() {
  const [group, cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (AGENTS.includes(group)) {
    // baton claude|codex|agy [agent args...]: everything after the agent name
    // goes straight through.
    const code = await attach(group, [cmd, ...rest].filter((x) => x !== undefined), { open: process.env.BATON_NO_OPEN !== '1' })
    process.exit(code)
  }
  if (group === 'sessions') {
    const list = listSessions()
    if (cmd === 'ls' || !cmd) {
      if (args.json) return out(JSON.stringify(list, null, 2))
      if (!list.length) return out('(no sessions)')
      for (const s of list) out(`${s.session_id}  [${s.status}]  ${s.agent}${s.account !== 'default' ? '/' + s.account : ''}  ${s.repo_name ?? s.cwd}${s.branch ? '@' + s.branch : ''}  turns=${s.turns}  ${s.limits ? `5h ${s.limits.five_hour?.pct ?? '-'}% 7d ${s.limits.seven_day?.pct ?? '-'}%` : ''}  ${String(s.task ?? '').slice(0, 50)}`)
      return
    }
    const id = args._[0] || die(2, `usage: baton sessions ${cmd} <session-id>`)
    const s = readSession(id) || die(3, `session not found: ${id}`)
    if (cmd === 'show') return out(JSON.stringify({ session: s, events: readSessionEvents(id) }, null, 2))
    if (cmd === 'events') { for (const e of readSessionEvents(id)) out(`${e.ts}  ${String(e.type).padEnd(18)}  ${e.summary}`); return }
    if (cmd === 'handoff') { if (!isActive(s)) die(3, `session ${id} is not active`); requestControl(id, { handoff: true }); return out(`handoff requested for ${id}`) }
    if (cmd === 'end') { if (!isActive(s)) die(3, `session ${id} is not active`); requestControl(id, { end: true }); return out(`end requested for ${id}`) }
    if (cmd === 'rm') { if (isActive(s)) die(3, `session ${id} is still active; end it first`); removeSession(id); return out(`removed ${id}`) }
    die(2, `unknown sessions command "${cmd}" (ls|show|events|handoff|end|rm)`)
  }
  if (group === 'accounts') {
    if (cmd === 'add') {
      const [agent, name] = args._
      if (!agent || !name) die(2, 'usage: baton accounts add <claude|codex> <name>')
      try {
        const r = addAccount(agent, name)
        out(`${agent} account "${name}" at ${r.dir}`)
        out(`shared from your real home (junctions): ${r.shared.join(', ') || '(nothing yet)'}; settings copied fresh before every launch`)
        out('')
        out(TERMS)
        out('')
        out('Log in once (paste in PowerShell):')
        out(`  ${r.login}`)
        out(`Then: $env:BATON_ACCOUNT='${name}'; baton ${agent}   (or let a limit hand off to it)`)
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'rm') {
      const [agent, name] = args._
      if (!agent || !name || name === 'default') die(2, 'usage: baton accounts rm <claude|codex> <name>')
      removeAccount(agent, name)
      return out(`removed ${agent} account "${name}" (your real ${LAYOUT[agent]?.home() ?? 'home'} was not touched)`)
    }
    if (cmd === 'ls' || !cmd) {
      const usage = Object.fromEntries(listUsage().map((u) => [`${u.agent}--${u.account}`, u]))
      for (const r of listAccountRows()) {
        const u = usage[`${r.agent}--${r.name}`]
        const lim = u?.limited_until && u.limited_until * 1000 > Date.now() ? `LIMITED until ${fmtReset(u.limited_until)}` : u ? `5h ${u.five_hour?.pct ?? '-'}%  7d ${u.seven_day?.pct ?? '-'}%` : 'no usage seen yet'
        out(`${r.agent.padEnd(7)} ${r.name.padEnd(12)} ${lim.padEnd(40)} ${r.dir}${r.env ? `  (${r.env})` : ''}`)
      }
      return
    }
    if (cmd === 'terms') return out(TERMS)
    die(2, `unknown accounts command "${cmd}" (ls|add|rm|terms)`)
  }
  if (group === 'uninstall') {
    // Baton never edits ~/.claude or ~/.codex; everything it added lives under
    // $BATON_HOME (sessions, usage, extra-account dirs, cards).
    const dir = home()
    if (!args.yes) {
      out(`baton uninstall removes ${dir} (sessions, usage, extra-account dirs, cards, board pidfile) and nothing else.`)
      out('Your real ~/.claude, ~/.codex and agy homes are never touched. Re-run with --yes to do it.')
      return
    }
    for (const r of listAccountRows()) if (r.name !== 'default') removeAccount(r.agent, r.name)
    down()
    rmSync(dir, { recursive: true, force: true })
    return out(`removed ${dir}; now: npm rm -g baton-agents`)
  }
  if (group === 'card') {
    if (cmd === 'add') return cardAdd(args)
    if (cmd === 'ls') {
      const cards = listCards()
      if (args.json) return out(JSON.stringify(cards, null, 2))
      if (!cards.length) return out('(no cards)')
      for (const c of cards) out(fmtCard(c))
      return
    }
    const id = args._[0] || die(2, `usage: baton card ${cmd} <card-id>`)
    const card = readCard(id) || die(3, `card not found: ${id}`)
    if (cmd === 'show') {
      if (args.json) return out(JSON.stringify({ card, runs: readRuns(id) }, null, 2))
      out(fmtCard(card))
      out(`  repo: ${card.repo}`)
      out(`  worktree: ${card.worktree ?? '(none yet)'}`)
      out(`  pipeline: ${card.pipeline.map((s) => `${s.name}(${s.kind}${s.kind === 'agent' ? ': ' + s.chain.map((e) => e.adapter + (e.mode ? '/' + e.mode : '')).join(' > ') : ''})`).join(' → ')}`)
      out(`  trunk: ${card.trunk}  land_mode: ${card.land_mode}  test_command: ${card.test_command ?? '-'}  land_attempts: ${card.land_attempts}`)
      out(`  actions: ${availableActions(card).join(', ') || '-'}`)
      for (const r of readRuns(id)) out(`  run ${r.run}: ${r.adapter} ${r.status} outcome=${r.outcome ?? '-'} signal=${r.signal ?? '-'} exit=${r.exit_code ?? '-'}`)
      return
    }
    if (cmd === 'events') {
      for (const e of readEvents(id)) out(`${e.ts}  ${e.type.padEnd(16)}  ${e.actor.type}${e.actor.adapter ? ':' + e.actor.adapter : e.actor.id ? ':' + e.actor.id : ''}  ${e.station}/${e.leg}  ${e.summary}`)
      return
    }
    if (cmd === 'run') {
      const final = await runCard(id)
      out(`${final.card_id} ${final.status} at ${final.station}`)
      process.exit(final.status === 'done' ? 0 : 1)
    }
    if (cmd === 'rm') {
      try { removeWorktree(card.repo, id, { deleteBranch: Boolean(args['delete-branch']) }) } catch (err) { process.stderr.write(`worktree: ${err.message}\n`) }
      rmSync(cardDir(id), { recursive: true, force: true })
      return out(`removed ${id}`)
    }
    const human = { queue: 'enqueue', pause: 'pause', resume: 'resume', kill: 'kill', approve: 'approve', 'handoff-now': 'handoff_now', rerun: 'rerun', reassign: 'reassign' }[cmd]
    if (human) {
      const payload = human === 'reassign' ? { adapter: args.adapter || die(2, 'reassign needs --adapter'), mode: args.mode } : {}
      const next = humanAction(id, human, payload, { type: 'human', id: args.actor || 'local' })
      return out(`${next.card_id} ${next.status} at ${next.station} leg ${next.leg}`)
    }
    die(2, `unknown card command "${cmd}" (add|ls|show|run|rm|events|queue|pause|resume|kill|approve|handoff-now|rerun|reassign)`)
  }
  if (group === 'scheduler') {
    if (cmd === 'start') {
      const ticks = args.ticks ? parseInt(args.ticks, 10) : Infinity
      const s = createScheduler({ intervalMs: args['interval-ms'] ? parseInt(args['interval-ms'], 10) : 1000 })
      process.on('SIGINT', () => { s.stop() })
      out(`scheduler: max ${MAX_CONCURRENT} concurrent, pidfile ${pidfile()}${Number.isFinite(ticks) ? `, ${ticks} tick(s)` : ''}`)
      await s.run({ ticks })
      return out('scheduler: stopped')
    }
    if (cmd === 'status') {
      const st = schedulerStatus()
      return out(st.running ? `scheduler running (pid ${st.pid})` : st.pid ? `scheduler not running (stale pidfile pid ${st.pid})` : 'scheduler not running')
    }
    if (cmd === 'stop') {
      const st = schedulerStatus()
      if (!st.running) return out('scheduler not running')
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
      else process.kill(st.pid, 'SIGTERM')
      try { rmSync(pidfile(), { force: true }) } catch {}
      return out(`scheduler stopped (pid ${st.pid})`)
    }
    die(2, `unknown scheduler command "${cmd}" (start|status|stop)`)
  }
  if (group === 'up') {
    const a = parseArgs([cmd, ...rest].filter((x) => x !== undefined))
    const code = await up({ dry: Boolean(a.dry), open: !a['no-open'], port: a.port !== undefined ? parseInt(a.port, 10) : undefined, bind: a.bind })
    process.exit(code)
  }
  if (group === 'down') process.exit(down())
  if (group === 'status') process.exit(status())
  if (group === 'open') {
    const port = process.env.BATON_PORT || 4747
    const url = `http://127.0.0.1:${port}`
    out(openBoard(url) ? `opened ${url}` : `could not open a browser; visit ${url}`)
    return
  }
  if (group && group !== '--help' && group !== 'help') die(2, `unknown command "${group}" (claude|codex|agy|sessions|accounts|up|down|status|open|card|scheduler|uninstall)`)
  out(`baton 0.2.0 — your coding agents, with a board alongside and a handoff when one hits its limit
  claude|codex|agy [args...]   the normal interactive agent in this terminal; args pass straight through
                               the board opens once, the session shows as a card, usage is tracked, a limit hands off
  sessions ls|show|events|handoff|end|rm <id>
  accounts ls|add <agent> <name>|rm|terms        optional second login for claude or codex
  down | status | open          the board
  uninstall [--yes]             removes only what Baton added (~/.baton)
  extras (v0.1 pipelines): up, card ..., scheduler ...   presets: ${PRESET_NAMES.join(', ')}`)
}

await main()
