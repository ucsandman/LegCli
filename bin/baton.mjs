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

async function main() {
  const [group, cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
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
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { encoding: 'utf8' })
      else process.kill(st.pid, 'SIGTERM')
      try { rmSync(pidfile(), { force: true }) } catch {}
      return out(`scheduler stopped (pid ${st.pid})`)
    }
    die(2, `unknown scheduler command "${cmd}" (start|status|stop)`)
  }
  if (group === 'up' || group === 'down' || group === 'status') {
    return out(`baton ${group}: the launcher lands in phase 8`)
  }
  out(`baton 0.1.0\n  card add|ls|show|run|rm|events|pause|resume|kill|approve|handoff-now|rerun|reassign\n  scheduler start|status|stop\n  presets: ${PRESET_NAMES.join(', ')}`)
}

await main()
