#!/usr/bin/env node
// leg, headless CLI. The board (phase 6) is the human surface; this is the
// agent/script surface and the test seam. Output via process.stdout only.
//   leg card add --repo <p> --task "<t>" --chain claude,codex [--pipeline preset|file] …
//   leg card ls [--json] | show <id> | run <id> | rm <id> [--delete-branch] | events <id>
//   leg card <pause|resume|kill|approve|handoff-now|rerun> <id> | reassign <id> --adapter a [--mode m]
//   leg scheduler start [--ticks N] [--interval-ms N] | status | stop
//
// Startup cost matters here: every command, `--version` included, paid for
// loading the whole module graph (orchestrator, scheduler, board, attach…)
// before main() even ran. Each command group below imports only what it
// needs, inside its own branch, so `leg --version` and friends stay cheap.
import { rmSync, appendFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
// one source of truth for the version, so the help text cannot drift from the package
const VERSION = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')).version
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
  const { createCard, CardInputError } = await import('../src/cards.mjs')
  try {
    const card = await createCard({
      repo: args.repo, task: args.task, chain: args.chain, pipeline: args.pipeline,
      mode: args.mode, maxTurns: args['max-turns'], model: args.model, fakeMode: args['fake-mode'], fakeFixture: args['fake-fixture'],
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

// Drive the real limit path without a real wall: the same StopFailure payload
// Claude Code would send goes through src/hook.mjs (claude), or the
// RESOURCE_EXHAUSTED line lands in the session's own agy log (agy). The
// runner then does what it does for a real limit: bundle, stop the agent,
// start the next option in the same terminal. The payload is marked
// simulated: it is never kept as live evidence, and the wall it records
// clears after two minutes. codex has no Leg-owned input, so it is refused.
// `sessionsApi` is the already-imported src/sessions.mjs namespace: the
// `sessions` command group loads it once and passes it through.
function simulateLimit(sessionsApi, s, { message = null } = {}) {
  const { isActive, sessionDir, appendEvent, readSession } = sessionsApi
  if (!isActive(s)) die(3, `session ${s.session_id} is not active`)
  if (['limit', 'handing_off'].includes(s.status)) die(3, `session ${s.session_id} is already ${s.status}`)
  if (s.agent === 'claude') {
    const payload = {
      hook_event_name: 'StopFailure', error: 'rate_limit', session_id: s.agent_session_id ?? undefined, transcript_path: s.transcript_path ?? undefined,
      last_assistant_message: message ?? 'API Error: Rate limit reached (simulated by leg sessions simulate-limit)', leg_simulated: true, baton_simulated: true,
    }
    const r = spawnSync(process.execPath, [join(SRC, 'hook.mjs'), 'claude-hook', '--session', s.session_id], { input: JSON.stringify(payload), windowsHide: true, encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) die(1, `hook exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`)
    const after = readSession(s.session_id)
    if (after?.status !== 'limit') die(1, `hook ran but the session is ${after?.status ?? 'gone'}, not limit`)
    return out(`simulated: StopFailure rate_limit sent through src/hook.mjs; ${s.session_id} is at limit (wall clears in 2 min); the runner hands off within ${(process.env.LEG_ATTACH_POLL_MS || process.env.BATON_ATTACH_POLL_MS) || 2000} ms to ${after.chain?.[0]?.agent ?? 'nothing'}`)
  }
  if (s.agent === 'agy') {
    appendFileSync(join(sessionDir(s.session_id), 'agy.log'), '\nrpc error: code = ResourceExhausted desc = RESOURCE_EXHAUSTED quota (simulated by leg sessions simulate-limit)\n')
    appendEvent(s.session_id, { type: 'status', summary: 'simulated RESOURCE_EXHAUSTED appended to the session log' })
    return out(`simulated: RESOURCE_EXHAUSTED appended to ${join(sessionDir(s.session_id), 'agy.log')}; the runner reads it within ${(process.env.LEG_ATTACH_POLL_MS || process.env.BATON_ATTACH_POLL_MS) || 2000} ms and hands off to ${s.chain?.[0]?.agent ?? 'nothing'}`)
  }
  if (s.agent === 'grok') {
    appendFileSync(join(sessionDir(s.session_id), 'grok.log'), "\nRate limited (429): You've hit the rate limit for your plan. Try again later. (simulated by leg sessions simulate-limit)\n")
    appendEvent(s.session_id, { type: 'status', summary: 'simulated rate limit appended to the grok log' })
    return out(`simulated: rate limit appended to ${join(sessionDir(s.session_id), 'grok.log')}; the runner reads it within ${(process.env.LEG_ATTACH_POLL_MS || process.env.BATON_ATTACH_POLL_MS) || 2000} ms and hands off to ${s.chain?.[0]?.agent ?? 'nothing'}`)
  }
  die(2, `simulate-limit drives the claude hook path (and the agy/grok log); codex's wall comes from its own rollout file, which Leg never writes. Use "leg sessions handoff ${s.session_id}" to force the switch.`)
}

// `claude`, `claude/work`, `claude/opus`, `claude/work/opus`. Three parts are
// unambiguous. Two are not, so the second is read as an account when that
// account exists and as a model when the agent has one by that name; a word
// that is neither is refused by name rather than guessed at.
// Async so the agent/account lookups (buckets.mjs, accounts.mjs) load only
// when a two-part target is actually given, not on every CLI invocation.
export async function parseTarget(value, { die: fail = (code, msg) => { throw new Error(msg) } } = {}) {
  const parts = String(value).split('/').filter(Boolean)
  const agent = parts[0]
  if (!agent) fail(2, 'usage: --to <agent>[/<account>[/<model>]]')
  if (parts.length >= 3) return { agent, account: parts[1], model: parts[2].toLowerCase() }
  if (parts.length === 2) {
    const [{ MODEL_ALIASES }, { readAccounts }] = await Promise.all([import('../src/buckets.mjs'), import('../src/accounts.mjs')])
    const models = MODEL_ALIASES[agent] ?? []
    const second = parts[1]
    const accounts = readAccounts()[agent] ?? ['default']
    if (accounts.includes(second)) return { agent, account: second, model: null }
    if (models.includes(second.toLowerCase())) return { agent, account: 'default', model: second.toLowerCase() }
    fail(2, `"${second}" is neither a ${agent} account (${accounts.join(', ')}) nor a ${agent} model (${models.join(', ') || 'none known'})`)
  }
  return { agent, account: 'default', model: null }
}

// What a rung is doing right now, in the words the board uses: the wall and its
// clock, else the percentage of the bucket that binds it, else "no figure".
// Never a guess: an agent that publishes no number says so.
// `usage` is the already-imported src/usage.mjs namespace.
function rungState(rung, usage) {
  const u = usage.readUsage(rung.agent, rung.account)
  const wall = rung.model ? u.walls?.[rung.model] : null
  if (wall && usage.wallActive(wall)) return `${rung.model} out until ${usage.fmtReset(wall.limited_until)}`
  if (!usage.isAvailable(u)) return `at its limit until ${usage.fmtReset(u.limited_until)}`
  const b = usage.binding(u, rung.model ?? null)
  if (b && Number.isFinite(b.percent)) return `${Math.round(b.percent)}% of the ${b.model ? b.model + ' ' : ''}${b.kind === 'session' || b.kind === 'five_hour' ? '5h' : 'week'} window`
  return 'no figure'
}

// `prefsApi`/`usage` are the already-imported src/preferences.mjs and
// src/usage.mjs namespaces (the `ladder` command group loads them once).
function printLadder(prefsApi, usage) {
  const prefs = prefsApi.readPreferences()
  const ladder = prefs.handoff_ladder
  const rows = usage.evaluateLadder({ from: null, list: ladder, maySpend: prefs.may_spend, reserve: prefs.reserve, automatic: true, climbBack: prefs.climb_back, ladder })
  out('The ladder a terminal falls down when its login stops. Rung 1 first, every time.')
  ladder.forEach((rung, i) => {
    const r = rows[i]
    const when = rung.when === 'always' ? '' : `  when ${rung.when}`
    out(`  ${String(i + 1).padEnd(2)} ${usage.rungLabel(rung).padEnd(20)} ${rungState(rung, usage).padEnd(34)} ${r.ok ? 'ready' : r.reason}${when}`)
  })
  out('')
  out(`spending: ${prefs.may_spend ? 'on (a credits or metered rung may be taken unattended)' : 'off (a credits or metered rung is skipped unattended)'} · leg ladder spend on|off`)
  out(`climb back: ${prefs.climb_back === 'never' ? 'never (stay on the lower rung until you press Back)' : 'at the next hand-off'}`)
  const reserve = Object.entries(prefs.reserve ?? {})
  out(`reserve: ${reserve.length ? reserve.map(([a, p]) => `${a} ${p}%`).join(', ') : 'none'}`)
  out(`order (what older readers see): ${prefs.handoff_order.join(' → ')}`)
}

async function ladderCommand(cmd, args) {
  const [prefsApi, usage] = await Promise.all([import('../src/preferences.mjs'), import('../src/usage.mjs')])
  if (!cmd || cmd === 'ls' || cmd === 'show') return printLadder(prefsApi, usage)
  const prefs = prefsApi.readPreferences()
  const ladder = prefs.handoff_ladder.map((r) => ({ ...r }))
  if (cmd === 'set') {
    const [nRaw, target] = args._
    const n = parseInt(nRaw, 10)
    if (!Number.isFinite(n) || n < 1) die(2, 'usage: leg ladder set <n> <agent>[/<account>[/<model>]] [--when always|below:N|walled-only]')
    if (!target) die(2, 'usage: leg ladder set <n> <agent>[/<account>[/<model>]] [--when always|below:N|walled-only]')
    const want = await parseTarget(target, { die })
    const rung = { ...want, when: typeof args.when === 'string' ? args.when : 'always' }
    const at = Math.min(n, ladder.length + 1) - 1
    ladder[at] = rung
    try {
      const saved = prefsApi.writePreferences({ handoff_ladder: ladder })
      out(`rung ${at + 1} is ${usage.rungLabel(saved.handoff_ladder[at])}${rung.when !== 'always' ? `, when ${rung.when}` : ''}`)
    } catch (err) { die(2, err.message) }
    return printLadder(prefsApi, usage)
  }
  if (cmd === 'rm') {
    const n = parseInt(args._[0], 10)
    if (!Number.isFinite(n) || n < 1 || n > ladder.length) die(2, `usage: leg ladder rm <n> (1..${ladder.length})`)
    if (ladder.length === 1) die(2, 'that is the only rung left: a ladder with no rungs has nowhere to hand off to')
    const [gone] = ladder.splice(n - 1, 1)
    try { prefsApi.writePreferences({ handoff_ladder: ladder }) } catch (err) { die(2, err.message) }
    out(`removed rung ${n}: ${usage.rungLabel(gone)}`)
    return printLadder(prefsApi, usage)
  }
  if (cmd === 'spend') {
    const v = args._[0]
    if (!['on', 'off'].includes(v)) die(2, 'usage: leg ladder spend on|off')
    const saved = prefsApi.writePreferences({ may_spend: v === 'on' })
    return out(saved.may_spend
      ? 'spending is ON: an unattended hand-off may take a rung that bills credits.'
      : 'spending is OFF: an unattended hand-off skips any rung that bills credits, and says so in the ledger.')
  }
  die(2, `unknown ladder command "${cmd}" (ls|set <n> <agent>[/<account>[/<model>]]|rm <n>|spend on|off)`)
}

function fmtCard(c) {
  const st = c.pipeline?.find((s) => s.name === c.station)
  const leg = st?.kind === 'agent' ? ` leg ${c.leg}/${st.chain.length} (${st.chain[c.leg]?.adapter ?? '-'})` : ''
  return `${c.card_id}  [${c.status}]  ${c.station}${leg}  leases=${(c.leases?.length ? c.leases : ['**']).join(',')}  ${String(c.title ?? c.task).slice(0, 60)}`
}

const TERMS = `Terms check (fetched 2026-09-11): Anthropic Consumer Terms forbid sharing account credentials and "bypassing any of our systems or protective measures"; the Anthropic Usage Policy forbids coordinating across multiple accounts to circumvent product guardrails; OpenAI's Terms of Use forbid sharing credentials and "circumvent any rate limits or restrictions". Two paid logins you own are not banned by name, but rotating to a second account of the same vendor because the first is rate-limited is close to that wording. Leg's default chain switches vendors (claude -> codex -> agy -> grok); a second account of one vendor is your call.`

async function main() {
  const [group, cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (group === '--version' || group === '-v') return out(VERSION)
  if (group === '🦿' || group === 'prosthetic' || group === 'easter-egg') {
    const ORANGE = '\x1b[38;5;208m'
    const RESET = '\x1b[0m'
    const LEG_ART = [
      '         ███████',
      '           ███████',
      '             ███████',
      '               ███████',
      '                 ███████',
      '                   ███████',
      '                     ███████',
      '                       ███████',
      '                         ███████',
      '                           ███████',
      '                              ███████',
      '                            ███████████',
      '                           █████████████',
      `                           ██████(${ORANGE}00${RESET})███  ← knee servo`,
      '                           █████████████',
      '                            ███████████',
      '                              ███████',
      '                             █████',
      '                           █████',
      '                         █████',
      '                       █████',
      '                     █████',
      '                    █████',
      '            ██████████████████████████',
      '            ████ ████ ████ ████ ████ ████',
    ].join('\n')
    out('🦿 Leg: the mechanical relay runner for coding agents.\n')
    out(LEG_ART)
    out('\nPassing the leg to the next runner when limits hit.')
    return
  }
  if (group === 'sessions') {
    const sessionsApi = await import('../src/sessions.mjs')
    const { listSessions, readSession, isActive, removeSession, readLand, requestControl } = sessionsApi
    const readSessionEvents = sessionsApi.readEvents
    const list = listSessions()
    if (cmd === 'ls' || !cmd) {
      if (args.json) return out(JSON.stringify(list, null, 2))
      if (!list.length) return out('(no sessions)')
      for (const s of list) out(`${s.session_id}  [${s.status}]  ${s.agent}${s.account !== 'default' ? '/' + s.account : ''}  ${s.repo_name ?? s.cwd}${s.branch ? '@' + s.branch : ''}  turns=${s.turns}  ${s.limits ? `5h ${s.limits.five_hour?.pct ?? '-'}% 7d ${s.limits.seven_day?.pct ?? '-'}%` : ''}  ${String(s.task ?? '').slice(0, 50)}`)
      return
    }
    const id = args._[0] || die(2, `usage: leg sessions ${cmd} <session-id>${cmd === 'handoff' ? ' [--to <agent>[/<account>]]' : ''}`)
    const s = readSession(id) || die(3, `session not found: ${id}`)
    if (cmd === 'show') return out(JSON.stringify({ session: s, events: readSessionEvents(id) }, null, 2))
    if (cmd === 'events') { for (const e of readSessionEvents(id)) out(`${e.ts}  ${String(e.type).padEnd(18)}  ${e.summary}`); return }
    if (cmd === 'handoff') {
      if (!isActive(s)) die(3, `session ${id} is not active`)
      // --to names the destination, the same choice the board's picker makes.
      // Validated here for the same reason it is validated there: a pick that
      // is not a destination, is not installed, or is at its wall must be
      // refused now, not silently turn into "whatever is next".
      if (typeof args.to === 'string') {
        const [{ normalizeHandoffOrder, ladderFor }, usage, { readAccounts }] = await Promise.all([
          import('../src/preferences.mjs'), import('../src/usage.mjs'), import('../src/accounts.mjs'),
        ])
        const want = await parseTarget(args.to, { die })
        const order = normalizeHandoffOrder(s.handoff_order)
        const ladder = ladderFor(s)
        const chain = usage.candidates({ agent: s.agent, account: s.account, model: s.model ?? null, accounts: readAccounts(), order, ladder })
        const hit = chain.find((c) => c.agent === want.agent && c.account === want.account && (want.model ? (c.model ?? null) === want.model : true))
        const label = usage.rungLabel(want)
        if (!hit) die(2, `${label} is not a destination for this terminal (${chain.map((c) => usage.rungLabel(c)).join(', ') || 'none'})`)
        if (s.installed && s.installed[want.agent] === false) die(3, `${label} is not installed on this machine`)
        const u = usage.readUsage(want.agent, want.account)
        if (!usage.isAvailable(u)) die(3, `${label} is at its usage limit until ${usage.fmtReset(u.limited_until)}; pick another, or drop --to to take the next option in the order`)
        if (hit.model && usage.wallActive(u.walls?.[hit.model])) die(3, `${label} is out until ${usage.fmtReset(u.walls[hit.model].limited_until)}; pick another rung, or drop --to to take the next open one`)
        const target = { agent: hit.agent, account: hit.account, ...(hit.model ? { model: hit.model } : {}) }
        requestControl(id, { handoff: true, target })
        return out(`handoff to ${label} requested for ${id}`)
      }
      requestControl(id, { handoff: true })
      return out(`handoff requested for ${id}`)
    }
    if (cmd === 'end') { if (!isActive(s)) die(3, `session ${id} is not active`); requestControl(id, { end: true }); return out(`end requested for ${id}`) }
    if (cmd === 'rm') {
      if (isActive(s)) die(3, `session ${id} is still active; end it first`)
      // a land runs in the board's process: land.json is the only place this
      // terminal can see it, and removing the record drops the result
      if (readLand(id)?.state === 'landing') die(3, `session ${id} is landing right now; wait for it to finish`)
      // prune the worktree and branch too, the way the board's Remove does, so
      // the CLI twin never orphans a worktree the board can no longer reach
      if (s.worktree) {
        try {
          const { pruneSessionWorktree } = await import('../src/land.mjs')
          const r = pruneSessionWorktree(s)
          out(r.removed
            ? `removed worktree ${s.worktree.path}${r.branchDeleted ? ` and branch ${s.worktree.branch}` : `; kept branch ${s.worktree.branch}`}`
            : `kept the worktree (${r.reason}); Land it or delete it by hand`)
        } catch (e) { out(`worktree not pruned: ${e.message}`) }
      }
      removeSession(id); return out(`removed ${id}`)
    }
    // --message drives a particular wording through the real classifier, which
    // is the only way to reach a per-model wall without waiting for one:
    // --message "You've reached your Fable limit." walls fable and leaves the
    // rest of the login open (src/buckets.mjs).
    if (cmd === 'simulate-limit') return simulateLimit(sessionsApi, s, { message: typeof args.message === 'string' ? args.message : null })
    die(2, `unknown sessions command "${cmd}" (ls|show|events|handoff|end|rm|simulate-limit)`)
  }
  if (group === 'ladder') {
    // The fallback ladder, in the terminal: the same rungs, the same live
    // state and the same skip reasons the board's picker shows.
    return ladderCommand(cmd, args)
  }
  if (group === 'digest') {
    // What happened while you were away: terminals, cards, landings and walls
    // in a window, grouped by repository, what needs you first. Read only.
    // Loaded here and not at the top: a command most sessions never run.
    const a = parseArgs([cmd, ...rest].filter((x) => x !== undefined))
    const { buildDigest, renderDigest, DEFAULT_SINCE } = await import('../src/digest.mjs')
    let d
    try { d = buildDigest({ since: typeof a.since === 'string' ? a.since : DEFAULT_SINCE }) } catch (err) { die(2, err.message) }
    return out(a.json ? JSON.stringify(d, null, 2) : renderDigest(d))
  }
  if (group === 'resume') {
    // The read side of the pointer. Freshness is never read out of the file:
    // it is recomputed from git here, now, so a resume file cannot describe a
    // picture that is no longer true to whoever is standing in the repo.
    const { resumeVerdict, bodyOf, ago } = await import('../src/resume.mjs')
    const a = parseArgs([cmd, ...rest].filter((x) => x !== undefined))
    const where = typeof a.path === 'string' ? resolve(a.path) : process.cwd()
    const v = resumeVerdict(where)
    if (a.json) { out(JSON.stringify(v, null, 2)); process.exit(v.exit_code) }
    if (v.state === 'missing') {
      out(`no resume pointer in this checkout (looked for .leg/RESUME.md from ${where} upward).`)
      out('Leg writes one when a terminal hands off; `leg claude` in this directory starts one.')
      process.exit(v.exit_code)
    }
    const head = v.head?.now ? `${v.head.now.slice(0, 7)}${v.head.branch ? ` on ${v.head.branch}` : ''}` : 'no commit'
    const line = v.state === 'fresh'
      ? `${v.file} is current: written ${v.written_at ? ago(v.age_ms) : 'at an unrecorded time'}, and the repository is still at ${head}.`
      : v.state === 'unstamped'
        ? `${v.file} is UNSTAMPED: ${v.reasons[0]}. Leg did not write it, or an older version did.`
        : `${v.file} is STALE: ${v.reasons.join('; ')}.`
    if (a.check) {
      out(line)
      if (v.state !== 'fresh') out('Read it as history, not as the current picture: check `git status` and `git diff` before acting on it.')
      process.exit(v.exit_code)
    }
    // Printed even when stale: a stale hand-off still beats nothing when the
    // human chooses to read it. The banner and the exit code are what say so.
    out(v.state === 'fresh' ? `# ${line}` : `# !!! ${line}`)
    out('')
    out(bodyOf(readFileSync(v.file, 'utf8')).trimEnd())
    process.exit(v.exit_code)
  }
  if (group === 'share') {
    // Multiplayer, off by default: the board binds a shared address only once
    // at least one person has a token, and every human has their own.
    const { readShare, addPerson, removePerson, rotate: rotateToken, turnOn, turnOff, linkFor, personNamed, scheme, tlsConfigured, ROLES } = await import('../src/share.mjs')
    const { stopBoard } = await import('../src/launcher.mjs')
    const { ensureBoard } = await import('../src/attach.mjs')
    const share = readShare()
    // only the listener moves: the agents running under it are not part of who
    // may look at the board
    const restartBoard = async () => { await stopBoard(); const b = await ensureBoard({ open: false }); return b }
    const showLink = (person, token, s) => {
      out(`${person.name} is on the board (${person.role}). Their link, shown once:`)
      out(`  ${linkFor(s, token)}`)
      out(person.role === 'owner' ? 'Open it on this machine, or any machine that can reach that address.'
        : person.role === 'operator' ? 'They get the pipeline board — cards, the floor, the adapters — and their own terminals. Not this machine’s settings, not its history index, not anyone else’s terminal.'
        : 'They see the terminals lane read-only: no prompts, no file names, no logs, no bundles. They can ask for a hand-off; you approve it on the card.')
    }
    if (!cmd || cmd === 'ls' || cmd === 'status') {
      if (!share.on || !share.people.length) {
        out('share is off: the board is on 127.0.0.1 and only this machine can reach it.')
        out('Turn it on: leg share on            (the Tailscale address; --bind lan, or --bind <address>)')
        return
      }
      out(`share is on: ${scheme(share)}://${share.bind}:${share.port} (${share.bind_kind})`)
      for (const p of share.people) out(`  ${p.name.padEnd(16)} ${p.role.padEnd(9)} added ${String(p.created_at).slice(0, 10)}${p.last_seen ? `  last seen ${String(p.last_seen).slice(0, 16).replace('T', ' ')}` : ''}`)
      out('')
      out(tlsConfigured(share)
        ? `TLS: certificate ${share.tls?.cert ?? '(from the environment)'}. The board on 127.0.0.1 stays plain http for this machine's own browser.`
        : 'No TLS: keep this on Tailscale or a network you trust. Add one with leg share on --tls-cert <file> --tls-key <file> (tailscale cert <machine>.<tailnet>.ts.net issues a trusted pair).')
      out('A token is shown once. Lost one? leg share rotate <name>. Everyone out: leg share off')
      return
    }
    if (cmd === 'on') {
      const a = parseArgs(rest)
      // more than one human is the Team plan
      const { entitlement, allows, describe: describeLicense, BUY_URL } = await import('../src/license.mjs')
      const ent = entitlement()
      if (!allows(ent, 'share')) die(2, ent.ok ? `leg share is part of the Team plan (per seat); this machine has a ${ent.plan} license. ${BUY_URL}` : describeLicense(ent))
      try {
        const r = await turnOn({
          bind: a.bind ?? 'tailscale', port: a.port ? parseInt(a.port, 10) : undefined, owner: a.owner,
          tlsCert: typeof a['tls-cert'] === 'string' ? a['tls-cert'] : null,
          tlsKey: typeof a['tls-key'] === 'string' ? a['tls-key'] : null,
        })
        await restartBoard()
        out(`share is on: the board is at ${scheme(r.share)}://${r.share.bind}:${r.share.port} (${r.share.bind_kind})`)
        if (r.token) showLink(r.owner, r.token, r.share)
        out('Add someone: leg share add <name> [--role operator|guest]')
        out(tlsConfigured(r.share)
          ? `TLS is on, from ${r.share.tls?.cert ?? 'the environment'}. Renew the pair and run leg down && leg up to pick up a new one.`
          : 'No TLS: keep this on Tailscale or a network you trust. Anyone with a link sees that your terminals exist and how much usage is left. leg share on --tls-cert <file> --tls-key <file> turns it on; tailscale cert <machine>.<tailnet>.ts.net issues a trusted pair.')
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'add') {
      const name = args._[0] || die(2, `usage: leg share add <name> [--role ${ROLES.join('|')}]`)
      try {
        if (args.role !== undefined && !ROLES.includes(String(args.role))) die(2, `bad role "${args.role}" (${ROLES.join('|')})`)
      const r = addPerson(name, { role: typeof args.role === 'string' ? args.role : 'guest', share })
        showLink(r.person, r.token, r.share)
        if (!r.share.on) out('share is still off: leg share on')
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'rotate') {
      const name = args._[0] || die(2, 'usage: leg share rotate <name>')
      try {
        const r = rotateToken(name, share)
        out(`${name}'s old link stopped working.`)
        showLink(r.person, r.token, r.share)
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'rm') {
      const name = args._[0] || die(2, 'usage: leg share rm <name>')
      if (!personNamed(share, name)) die(3, `no one called "${name}" on this board`)
      try { removePerson(name, share) } catch (err) { die(2, err.message) }
      return out(`${name} is off the board; their link stopped working.`)
    }
    if (cmd === 'off') {
      // the shared listener goes first: while it is up and share.json reads off
      // there is nobody for it to check a stranger against
      await stopBoard()
      turnOff()
      await ensureBoard({ open: false })
      return out('share is off: the board is back on 127.0.0.1 and the links stopped working.')
    }
    die(2, `unknown share command "${cmd}" (status|on|add|rotate|rm|off)`)
  }
  if (group === 'accounts') {
    const { addAccount, removeAccount, listAccountRows, LAYOUT } = await import('../src/accounts.mjs')
    if (cmd === 'add') {
      const [agent, name] = args._
      if (!agent || !name) die(2, 'usage: leg accounts add <claude|codex> <name>')
      try {
        const r = addAccount(agent, name)
        out(`${agent} account "${name}" at ${r.dir}`)
        out(`shared from your real home (junctions): ${r.shared.join(', ') || '(nothing yet)'}; settings copied fresh before every launch`)
        out('')
        out(TERMS)
        out('')
        out('Log in once (paste in PowerShell):')
        out(`  ${r.login}`)
        out(`Then: $env:LEG_ACCOUNT='${name}'; leg ${agent}   (or let a limit hand off to it)`)
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'rm') {
      const [agent, name] = args._
      if (!agent || !name || name === 'default') die(2, 'usage: leg accounts rm <claude|codex> <name>')
      removeAccount(agent, name)
      return out(`removed ${agent} account "${name}" (your real ${LAYOUT[agent]?.home() ?? 'home'} was not touched)`)
    }
    if (cmd === 'ls' || !cmd) {
      const { listUsage, fmtReset } = await import('../src/usage.mjs')
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
  if (group === 'harness') {
    // The portable harness: the working environment a hand-off carries with
    // the task. Off until `leg harness enable` (src/harness/index.mjs).
    const { harnessCommand } = await import('../src/harness/cli.mjs')
    const code = await harnessCommand(cmd, args, { out, die })
    process.exit(code)
  }
  if (group === 'adapter' || group === 'adapters') {
    // Custom adapters: any CLI as a card agent, from a JSON spec on disk
    // (src/adapters/custom.mjs). The built-ins need none of this.
    const { adapterCommand } = await import('../src/adapters/cli.mjs')
    const code = await adapterCommand(cmd, args, { out, die })
    process.exit(code)
  }
  if (group === 'history' || group === 'worktrees') {
    // Every conversation on this machine, Leg's own and the ones the agents'
    // stores hold: a read-only index (src/history/index.mjs). `continue`
    // starts a normal supervised leg on one of them. `leg history --json` is
    // `leg history ls --json`: a leading flag names no verb.
    const { historyCommand, worktreesCommand } = await import('../src/history/cli.mjs')
    const isHelp = cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help || args.h
    const bare = typeof cmd === 'string' && cmd.startsWith('--')
    const verb = isHelp ? 'help' : (bare ? 'ls' : cmd)
    const a = bare ? parseArgs([cmd, ...rest]) : args
    // `continue <id> [agent args...]`: what follows the id goes to the agent
    // untouched, the way `leg claude [args...]` passes its argv straight through
    const raw = bare ? [cmd, ...rest] : rest
    const code = group === 'history' ? await historyCommand(verb, a, { out, die, raw }) : worktreesCommand(verb, a, { out, die })
    process.exit(code)
  }
  if (group === 'license') {
    // The paid gate. Keys verify offline against the public key in
    // src/license.mjs; nothing here talks to the network except refresh.
    const { entitlement, describe: describeLicense, activate: activateLicense, deactivate: deactivateLicense, refresh: refreshLicense, licensePath, BUY_URL } = await import('../src/license.mjs')
    if (!cmd || cmd === 'status') {
      // looking does not start the trial clock; the first session does
      const ent = entitlement({ startTrial: false })
      out(describeLicense(ent))
      if (ent.source === 'license') out(`stored at ${licensePath()}`)
      if (!ent.ok || ent.source === 'trial') out(`Buy: ${BUY_URL}   then: leg license activate <key>`)
      return
    }
    if (cmd === 'activate') {
      const key = args._[0] || die(2, 'usage: leg license activate <key>')
      try {
        const p = activateLicense(key)
        out(describeLicense(entitlement()))
        out(`activated ${p.plan} license ${p.id}; stored at ${licensePath()}`)
      } catch (err) { die(2, err.message) }
      return
    }
    if (cmd === 'deactivate') return out(deactivateLicense() ? `removed ${licensePath()}; Leg is back on the trial if it has days left, otherwise it needs a key` : 'no license was stored')
    if (cmd === 'refresh') {
      try { const p = await refreshLicense(); out(`renewed ${p.plan} license ${p.id}, valid through ${p.expires}`) } catch (err) { die(2, err.message) }
      return
    }
    die(2, `unknown license command "${cmd}" (status|activate <key>|deactivate|refresh)`)
  }
  if (group === 'uninstall') {
    // Leg never edits ~/.claude or ~/.codex; everything it added lives under
    // $LEG_HOME (sessions, usage, extra-account dirs, cards).
    const { home } = await import('../src/store.mjs')
    const dir = home()
    if (!args.yes) {
      out(`leg uninstall removes ${dir} (sessions, usage, extra-account dirs, cards, board pidfile) and nothing else.`)
      out('Your real ~/.claude, ~/.codex and agy homes are never touched. Re-run with --yes to do it.')
      return
    }
    const { listAccountRows, removeAccount } = await import('../src/accounts.mjs')
    const { down } = await import('../src/launcher.mjs')
    for (const r of listAccountRows()) if (r.name !== 'default') removeAccount(r.agent, r.name)
    await down()
    rmSync(dir, { recursive: true, force: true })
    return out(`removed ${dir}; now: npm rm -g @ucsandman/legcli`)
  }
  if (group === 'card') {
    const { readCard, listCards, readEvents, readRuns, cardDir } = await import('../src/store.mjs')
    if (cmd === 'add') return cardAdd(args)
    if (cmd === 'ls') {
      const cards = listCards()
      if (args.json) return out(JSON.stringify(cards, null, 2))
      if (!cards.length) return out('(no cards)')
      for (const c of cards) out(fmtCard(c))
      return
    }
    const id = args._[0] || die(2, `usage: leg card ${cmd} <card-id>`)
    const card = readCard(id) || die(3, `card not found: ${id}`)
    if (cmd === 'show') {
      if (args.json) return out(JSON.stringify({ card, runs: readRuns(id) }, null, 2))
      const { availableActions } = await import('../src/chain.mjs')
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
      const { runCard } = await import('../src/orchestrator.mjs')
      const final = await runCard(id)
      out(`${final.card_id} ${final.status} at ${final.station}`)
      process.exit(final.status === 'done' ? 0 : 1)
    }
    if (cmd === 'rm') {
      try {
        const { remove: removeWorktree } = await import('../src/worktree.mjs')
        const r = removeWorktree(card.repo, id, { deleteBranch: Boolean(args['delete-branch']), force: Boolean(args.force) })
        if (args['delete-branch'] && r.branchUnmerged && !r.branchDeleted) out(`kept branch leg/${id}: it has commits not on its base (rerun with --force to discard them)`)
      } catch (err) { die(3, `worktree: ${err.message}`) }
      rmSync(cardDir(id), { recursive: true, force: true })
      return out(`removed ${id}`)
    }
    const human = { queue: 'enqueue', pause: 'pause', resume: 'resume', kill: 'kill', approve: 'approve', 'handoff-now': 'handoff_now', rerun: 'rerun', reassign: 'reassign' }[cmd]
    if (human) {
      const { humanAction } = await import('../src/orchestrator.mjs')
      const payload = human === 'reassign' ? { adapter: args.adapter || die(2, 'reassign needs --adapter'), mode: args.mode } : {}
      const next = humanAction(id, human, payload, { type: 'human', id: args.actor || 'local' })
      return out(`${next.card_id} ${next.status} at ${next.station} leg ${next.leg}`)
    }
    die(2, `unknown card command "${cmd}" (add|ls|show|run|rm|events|queue|pause|resume|kill|approve|handoff-now|rerun|reassign)`)
  }
  if (group === 'scheduler') {
    const { createScheduler, schedulerStatus, pidfile, MAX_CONCURRENT } = await import('../src/scheduler.mjs')
    if (cmd === 'start') {
      const ticks = args.ticks ? parseInt(args.ticks, 10) : Infinity
      const running = schedulerStatus()
      if (running.running) die(3, `scheduler already running (pid ${running.pid}); two schedulers would drive the same cards. leg scheduler stop first`)
      const s = createScheduler({ intervalMs: args['interval-ms'] ? parseInt(args['interval-ms'], 10) : 1000 })
      process.on('SIGINT', () => { s.stop() })
      out(`scheduler: max ${MAX_CONCURRENT} concurrent, pidfile ${pidfile()}${Number.isFinite(ticks) ? `, ${ticks} tick(s)` : ''}`)
      try { await s.run({ ticks }) } catch (err) { die(3, err.message) }
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
    const { up } = await import('../src/launcher.mjs')
    const a = parseArgs([cmd, ...rest].filter((x) => x !== undefined))
    const code = await up({ dry: Boolean(a.dry), open: !a['no-open'], port: a.port !== undefined ? parseInt(a.port, 10) : undefined, bind: a.bind })
    process.exit(code)
  }
  if (group === 'down') { const { down } = await import('../src/launcher.mjs'); process.exit(await down()) }
  if (group === 'status') { const { status } = await import('../src/launcher.mjs'); process.exit(await status()) }
  if (group === 'open') {
    const { openBoard } = await import('../src/launcher.mjs')
    const port = (process.env.LEG_PORT || process.env.BATON_PORT) || 4747
    const url = `http://127.0.0.1:${port}`
    out(openBoard(url) ? `opened ${url}` : `could not open a browser; visit ${url}`)
    return
  }
  // Everything above is a named command group. What is left is either a
  // supervised agent (`leg claude|codex|agy|grok [args...]`, everything after
  // the agent name goes straight through) or unknown. SUPERVISED_AGENTS and
  // attach() are loaded here, last, so no other command pays for them.
  if (group && group !== '--help' && group !== 'help') {
    const { SUPERVISED_AGENTS } = await import('../src/sessions.mjs')
    if (SUPERVISED_AGENTS.includes(group)) {
      const { attach } = await import('../src/attach.mjs')
      const code = await attach(group, [cmd, ...rest].filter((x) => x !== undefined), { open: (process.env.LEG_NO_OPEN || process.env.BATON_NO_OPEN) !== '1' })
      process.exit(code)
    }
    die(2, `unknown command "${group}" (claude|codex|agy|grok|sessions|ladder|history|worktrees|digest|resume|accounts|harness|license|share|up|down|status|open|card|scheduler|uninstall)`)
  }
  const { PRESET_NAMES } = await import('../src/presets.mjs')
  out(`leg ${VERSION}, your coding agents, with a board alongside and a handoff when one hits its limit
  claude|codex|agy|grok [args...]   the normal interactive agent in this terminal; args pass straight through
                                the board opens once, the session shows as a card, usage is tracked, a limit hands off
                                a second live session in one checkout gets its own worktree (--no-worktree to share)
                                auto-approve mode (--no-auto-approve to opt out)
                                --resume-card <id> takes over a background card: this terminal opens in that card's
                                worktree, primed from its bundle (Take over on the board pauses it and prints this)
  sessions ls|show|events|handoff|end|rm|simulate-limit <id>
                                handoff --to <agent>[/<account>[/<model>]] names the rung; simulate-limit --message "<text>"
  ladder [ls]                   the fallback ladder: every rung, what it costs, and what it is doing right now
  ladder set <n> <agent>[/<account>[/<model>]] [--when always|below:N|walled-only]
  ladder rm <n> | ladder spend on|off
  history [ls] [--provider p] [--repo r] [--search q] [--json]
                                every conversation on this machine: Leg's own, and the ones Claude Code, Codex,
                                Grok, Antigravity and Copilot keep in their own stores (read only, nothing moved)
  history show|continue <id> | refresh | providers
                                one conversation, or start leg <agent> on it where the agent can resume by id
  worktrees [--repo r] [--json]  every checkout Leg can see: git's, its own, the ones conversations worked in
  digest [--since 8h|2d|<iso>] [--json]        what happened while you were away: what needs you, then every
                                terminal, card, landing and wall in the window, grouped by repository
  resume [--check] [--json] [--path <dir>]      the hand-off waiting in this checkout, and whether it is still true
                               freshness is recomputed from git at read time; --check prints only the verdict
                               exit 0 current, 1 stale or unstamped, 3 no pointer here
  accounts ls|add <agent> <name>|rm|terms        optional second login for claude or codex
  harness status|enable|sync|check|explain|...   carry the source agent's rules, hooks, skills, agents, commands and MCP
                                servers to the agent a hand-off lands on; off until enabled (leg harness help)
  license [status|activate <key>|deactivate|refresh]
                                personal or team license status and management
  share status|on|add <name>|rotate <name>|rm <name>|off
                                more than one human on the board, off by default
  down | status | open          the board
  uninstall [--yes]             removes only what Leg added (~/.leg, and legacy ~/.baton)
  extras (v0.1 pipelines): up, card ..., scheduler ...   presets: ${PRESET_NAMES.join(', ')}`)
}

await main()
