#!/usr/bin/env node
// baton — headless CLI. The board (phase 6) is the human surface; this is the
// agent/script surface and the test seam. Output via process.stdout only.
//   baton card add --repo <p> --task "<t>" --chain claude,codex [--pipeline preset|file] …
//   baton card ls [--json] | show <id> | run <id> | rm <id> [--delete-branch] | events <id>
//   baton card <pause|resume|kill|approve|handoff-now|rerun> <id> | reassign <id> --adapter a [--mode m]
//   baton scheduler start [--ticks N] [--interval-ms N] | status | stop
import { rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { buildPipeline, validatePipeline, loadAdapterModes, parseChain } from '../src/pipeline.mjs'
import { PRESET_NAMES } from '../src/presets.mjs'
import { readCard, listCards, readEvents, readRuns, ledgerCreate, cardDir } from '../src/store.mjs'
import { runCard, humanAction } from '../src/orchestrator.mjs'
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

// "adapter=value,adapter=value" → { adapter: value }
function kv(raw) {
  const m = {}
  for (const part of String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (!k || v === undefined) die(2, `expected adapter=value, got "${part}"`)
    m[k] = v
  }
  return m
}

async function cardAdd(args) {
  const repo = args.repo ? resolve(args.repo) : die(2, 'missing --repo')
  const task = args.task || die(2, 'missing --task')
  if (!existsSync(repo)) die(2, `repo not found: ${repo}`)
  const chainRaw = args.chain || die(2, 'missing --chain (e.g. claude,codex)')
  const modes = kv(args.mode)
  const turns = kv(args['max-turns'])
  const fakeModes = kv(args['fake-mode'])
  const fakeFixtures = kv(args['fake-fixture'])
  const approve = String(args.approve ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const chain = parseChain(chainRaw).map((e) => ({
    ...e,
    ...(modes[e.adapter] ? { mode: modes[e.adapter] } : {}),
    ...(turns[e.adapter] ? { maxTurns: parseInt(turns[e.adapter], 10) } : {}),
    ...(fakeModes[e.adapter] ? { fakeMode: fakeModes[e.adapter] } : {}),
    ...(fakeFixtures[e.adapter] ? { fakeFixture: fakeFixtures[e.adapter] } : {}),
    ...(approve.includes(e.adapter) ? { approve: true } : {}),
  }))
  const pipelineArg = args.pipeline || 'build'
  let pipeline
  try {
    pipeline = PRESET_NAMES.includes(pipelineArg)
      ? buildPipeline({ preset: pipelineArg, chain })
      : buildPipeline({ file: pipelineArg, chain })
    validatePipeline(pipeline, await loadAdapterModes())
  } catch (err) {
    die(2, `invalid pipeline: ${err.message}`)
  }
  const leases = String(args.leases ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const slug = (args.slug || task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)) || 'card'
  const id = ledgerCreate({
    slug, task, repo, chain: chain.map((e) => ({ adapter: e.adapter, mode: e.mode ?? null, max_turns: e.maxTurns ?? null })),
    pipeline, leases, trunk: args.trunk || 'main', 'land-mode': args['land-mode'] || 'ff',
    'test-command': args['test-command'] || null, title: args.title || null,
    actor: JSON.stringify({ type: 'human', id: args.actor || 'local' }),
  })
  // --queue: put it on the floor right away (the scheduler only picks queued cards)
  if (args.queue) humanAction(id, 'enqueue', {}, { type: 'human', id: args.actor || 'local' })
  out(id)
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
