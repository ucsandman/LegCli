// `leg harness <verb>` — the human surface of the portable harness. Every
// verb prints for a person by default and JSON with --json; every write is
// explicit (enable, sync, capture, source, policy), and check/status/inspect/
// explain/diff/doctor write nothing. Exit codes follow the rest of the CLI:
// 0 fine, 1 stale or attention (check, sync), 2 usage, 3 not enabled / no
// bundle / declined.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  COMPONENTS, CLIENT_IDS, NO_ADAPTER, STATES, POLICIES,
  applyHarness, captureHarness, detectSources, explainHarnessDrops, getHarnessStatus, harnessConfig, harnessDir, harnessHome,
  inspectHarness, readHistory, registry, resolveSource, setHarnessConfig, bundleDir, captureFile,
} from './index.mjs'
import { HARNESS_POLICIES, HARNESS_SOURCES } from '../preferences.mjs'
import { check as checkVendor } from '../../scripts/sync-harness-engine.mjs'

const VERBS = ['status', 'inspect', 'enable', 'disable', 'capture', 'sync', 'check', 'explain', 'diff', 'source', 'policy', 'doctor', 'history']
const GLYPH = { synced: '✓', partial: '◐', stale: '✗', attention: '!', unsupported: '-', error: 'E', source: '=', blocked: '✗', off: '·' }
const ABBR = { rules: 'rules', identity: 'ident', hooks: 'hooks', skills: 'skills', agents: 'agents', commands: 'cmds', mcp: 'mcp', permissions: 'perms' }

export const HELP = `leg harness: carry the source agent's working environment to the agents a hand-off lands on
  status [--json]                 what is enabled, the source, when it was captured, each client's state
  inspect [--json]                what the captured harness holds: rules, hooks, skills, agents, commands, MCP servers, permissions
  enable [--source claude|codex] [--policy warn|sync|strict] [--to a,b] [--yes]
                                  first run: detect clients, capture, show what each client receives and drops, apply after confirmation
  disable                         stop carrying the harness; nothing already written is removed
  capture [claude|codex] [--force] re-read the source client (fingerprinted: a no-op when nothing changed)
  sync [--to a,b] [--force] [--dry-run] [--json]
                                  capture, then write every managed file that is out of date; --force replaces hand-edited files (backed up)
  check [--to a,b] [--json]       report only, write nothing; exit 1 when a client is stale or needs attention
  explain [--to a,b] [--json]     every item a client could not receive, and why
  diff <client>                   what a sync would write to that client, file by file, without writing it
  source claude|codex             which client's harness is the one carried
  policy warn|sync|strict         what an unattended hand-off may do (warn: report; sync: write when safe; strict: refuse an unsafe destination)
  doctor [--json]                 the engine, the source, the bundle, the state and every client, each with a verdict
  history [--json] [--limit n]    the evidence trail: every capture, sync and hand-off decision`

function table(targets, { source }) {
  const ids = Object.keys(targets)
  const w = Math.max(6, ...ids.map((id) => targets[id].name.length))
  const head = ['client'.padEnd(w), 'state'.padEnd(11), ...COMPONENTS.map((c) => ABBR[c].padEnd(6)), 'dropped'].join(' ')
  const lines = [head, '-'.repeat(head.length)]
  for (const id of ids) {
    const t = targets[id]
    const cells = COMPONENTS.map((c) => {
      const comp = t.components[c]
      if (t.state === 'source') return '='.padEnd(6)
      const g = GLYPH[comp?.state] ?? '?'
      const n = comp?.total !== null && comp?.total !== undefined ? `${g}${comp.carried}/${comp.total}` : g
      return n.padEnd(6)
    })
    const note = t.state === 'source' ? 'source of truth; never written' : !t.installed ? 'not installed' : t.attention.length ? `${t.attention.length} need attention` : ''
    lines.push(`${t.name.padEnd(w)} ${t.state.padEnd(11)} ${cells.join(' ')} ${String(t.dropped.length).padStart(7)}  ${note}`)
  }
  lines.push(`legend: ✓ synced  ◐ partial (some items dropped)  ✗ stale  ! attention (hand-edited or error)  - unsupported  = source${source ? ` (${source})` : ''}`)
  return lines.join('\n')
}

function dropLines(targets) {
  const out = []
  for (const t of Object.values(targets)) {
    if (!t.dropped.length && !t.attention.length) continue
    out.push(`  ${t.name}`)
    for (const d of t.dropped) out.push(`    ${d.component}: ${d.item}${d.excluded ? ' (excluded by policy)' : ''}: ${d.reason}`)
    for (const a of t.attention) out.push(`    ${a.component}: ${a.file ?? ''}${a.file ? ': ' : ''}${a.reason}`)
  }
  return out
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null)

export async function harnessCommand(cmd, args, { out, die, env = process.env }) {
  const json = Boolean(args.json)
  if (!cmd || cmd === 'help' || cmd === '--help') { out(HELP); return 0 }
  if (!VERBS.includes(cmd)) return die(2, `unknown harness command "${cmd}" (${VERBS.join('|')})`)
  const cfg = harnessConfig()

  if (cmd === 'status') {
    const s = getHarnessStatus({ env })
    if (json) { out(JSON.stringify(s, null, 2)); return 0 }
    out(`portable harness: ${s.enabled ? `on (policy ${s.policy})` : 'off'}${s.enabled ? '' : '  · leg harness enable'}`)
    out(`source: ${s.source ?? 'none detected'}${s.sources_detected.length ? ` (on this machine: ${s.sources_detected.join(', ')})` : ''}`)
    if (s.captured) out(`captured: ${s.captured_at} · fingerprint ${String(s.fingerprint).slice(0, 12)} · ${Object.entries(s.components ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}${s.source_changed ? ' · SOURCE CHANGED since (leg harness sync)' : ''}`)
    else out('captured: never')
    if (s.corrupt) out(`bundle: unreadable (${s.corrupt}); leg harness capture --force`)
    for (const w of s.warnings) out(`  ! ${w}`)
    if (Object.keys(s.targets).length) out(table(s.targets, { source: s.source }))
    for (const [agent, why] of Object.entries(s.unsupported)) out(`${agent}: unsupported. ${why}`)
    return 0
  }

  if (cmd === 'inspect') {
    const i = inspectHarness()
    if (json) { out(JSON.stringify(i, null, 2)); return i.captured ? 0 : 3 }
    if (!i.captured) { out('no harness captured yet: leg harness capture'); return 3 }
    if (i.corrupt) { out(`the captured harness is unreadable: ${i.corrupt}`); return 3 }
    out(`source ${i.source}, captured ${i.captured_at}, fingerprint ${i.fingerprint.slice(0, 12)}`)
    out(`rules: ${i.rules_bytes} bytes${i.identity ? ', identity present' : ', no identity file'}`)
    out(`hooks: ${Object.entries(i.hooks).map(([e, n]) => `${e} ${n}`).join(', ') || '(none)'}`)
    out(`skills (${i.skills.length}): ${i.skills.join(', ') || '(none)'}`)
    out(`agents (${i.agents.length}): ${i.agents.map((a) => `${a.name} [${a.model}${a.readonly ? ', read-only' : ''}]`).join(', ') || '(none)'}`)
    out(`commands (${i.commands.length}): ${i.commands.join(', ') || '(none)'}`)
    out(`mcp (${i.mcp.length}): ${i.mcp.map((m) => `${m.name} (${m.transport}${m.env_refs ? `, ${m.env_refs} env ref` : ''})`).join(', ') || '(none)'}`)
    out(`permissions: allow ${i.permissions.allow.length}, deny ${i.permissions.deny.length}, ask ${i.permissions.ask.length}`)
    for (const w of i.warnings) out(`  ! ${w}`)
    return 0
  }

  if (cmd === 'enable') {
    const found = detectSources({ env })
    const source = typeof args.source === 'string' ? args.source : cfg.source ?? found[0]?.id ?? null
    if (!source) return die(3, `no source client found: neither ~/.claude/CLAUDE.md nor ~/.codex/AGENTS.md exists under ${harnessHome(env)}`)
    if (!HARNESS_SOURCES.includes(source)) return die(2, `--source must be one of ${HARNESS_SOURCES.join(', ')}`)
    const policy = typeof args.policy === 'string' ? args.policy : 'sync'
    if (!HARNESS_POLICIES.includes(policy)) return die(2, `--policy must be one of ${HARNESS_POLICIES.join(', ')}`)
    const to = list(args.to)
    if (to) for (const id of to) if (!CLIENT_IDS.includes(id)) return die(2, `--to: unknown client "${id}" (${CLIENT_IDS.join(', ')})`)
    out(`source: ${source}${found.length > 1 ? ` (also on this machine: ${found.filter((s) => s.id !== source).map((s) => s.id).join(', ')}; --source to choose)` : ''}`)
    let cap
    try { cap = captureHarness({ source, force: true, env }) } catch (err) { return die(3, `capture failed: ${err.message}`) }
    const c = cap.bundle.manifest.components
    out(`captured ${source}: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    for (const w of cap.warnings) out(`  ! ${w}`)
    const plan = applyHarness({ to, dryRun: true, env, bundle: cap.bundle })
    const rows = Object.values(plan.targets)
    out('')
    out(table(plan.targets, { source }))
    const drops = dropLines(plan.targets)
    if (drops.length) { out(''); out('not carried:'); for (const l of drops) out(l) }
    const writable = rows.filter((t) => t.installed && t.state !== 'source')
    out('')
    out(`policy ${policy}: ${policy === 'warn' ? 'hand-offs report drift and never write' : policy === 'sync' ? 'hand-offs write managed files when that is safe' : 'a hand-off refuses a destination that cannot be made safe'}`)
    const go = args.yes ? true : await confirm(`write the managed files above into ${writable.map((t) => t.name).join(', ') || 'nothing (no client installed)'} and turn portable harness on?`)
    if (!go) { out('nothing written. Re-run with --yes to enable without a prompt.'); return 3 }
    const applied = writable.length ? applyHarness({ to, env, bundle: cap.bundle }) : { targets: {} }
    setHarnessConfig({ enabled: true, policy, source })
    out(`portable harness on: source ${source}, policy ${policy}${writable.length ? `; wrote ${Object.values(applied.targets).reduce((n, t) => n + t.files_written, 0)} file(s), ${Object.values(applied.targets).reduce((n, t) => n + t.backups.length, 0)} backup(s) under ${join(harnessDir(), 'backups')}` : ''}`)
    const attention = Object.values(applied.targets).flatMap((t) => t.attention)
    for (const a of attention) out(`  ! ${a.component}: ${a.file ?? ''} ${a.reason}`)
    return attention.length ? 1 : 0
  }

  if (cmd === 'disable') {
    setHarnessConfig({ enabled: false })
    out('portable harness off: hand-offs carry task context only. Files Leg wrote stay where they are (each carries "GENERATED by Leg harness"); leg harness enable turns it back on.')
    return 0
  }

  if (cmd === 'capture') {
    const source = args._[0] ?? cfg.source ?? resolveSource({ env, cfg })
    if (!source) return die(3, 'no source client found: leg harness source <claude|codex>')
    if (!HARNESS_SOURCES.includes(source)) return die(2, `source must be one of ${HARNESS_SOURCES.join(', ')}`)
    try {
      const cap = captureHarness({ source, force: Boolean(args.force), env })
      if (json) { out(JSON.stringify({ source, cached: cap.cached, fingerprint: cap.bundle.manifest.fingerprint, captured_at: cap.bundle.manifest.capturedAt, components: cap.bundle.manifest.components, warnings: cap.warnings, elapsed_ms: cap.elapsed_ms }, null, 2)); return 0 }
      out(`${cap.cached ? 'unchanged' : 'captured'} ${source} (${cap.elapsed_ms} ms): ${Object.entries(cap.bundle.manifest.components).map(([k, v]) => `${k} ${v}`).join(', ')} · fingerprint ${cap.bundle.manifest.fingerprint.slice(0, 12)}`)
      for (const w of cap.warnings) out(`  ! ${w}`)
      return 0
    } catch (err) { return die(3, `capture failed: ${err.message}`) }
  }

  if (cmd === 'sync' || cmd === 'check' || cmd === 'diff') {
    const to = cmd === 'diff' ? (args._[0] ? [args._[0]] : null) : list(args.to)
    if (cmd === 'diff' && !to) return die(2, 'usage: leg harness diff <client>')
    if (to) for (const id of to) if (!CLIENT_IDS.includes(id)) return die(2, `unknown client "${id}" (${CLIENT_IDS.join(', ')}${NO_ADAPTER[id] ? `; ${NO_ADAPTER[id]}` : ''})`)
    const source = cfg.source ?? resolveSource({ env, cfg })
    if (!source) return die(3, 'no source client found: leg harness source <claude|codex>')
    const dryRun = cmd !== 'sync' || Boolean(args['dry-run'])
    // the one consent is `enable`, which shows the plan first; a sync on an
    // install that never gave it writes nothing
    if (!dryRun && !cfg.enabled) return die(3, 'portable harness is off: leg harness enable shows what a sync would write and asks first (leg harness check reports without writing)')
    let cap
    try { cap = captureHarness({ source, env }) } catch (err) { return die(3, `capture failed: ${err.message}`) }
    let r
    try { r = applyHarness({ to, force: Boolean(args.force), dryRun, env, bundle: cap.bundle }) } catch (err) { return die(3, err.message) }
    const rows = Object.values(r.targets)
    const stale = rows.some((t) => t.state === 'stale' || t.state === 'attention' || t.state === 'error')
    if (json) { out(JSON.stringify({ ...r, cached_capture: cap.cached, warnings: cap.warnings }, null, 2)); return stale ? 1 : 0 }
    if (cmd === 'diff') {
      const raw = JSON.parse(readFileSync(join(harnessDir(), 'harness-report.json'), 'utf8'))
      const t = raw.targets[to[0]]
      out(`${source} → ${to[0]} (${t.installed ? 'installed' : 'not installed'}): what a sync would do`)
      for (const [c, res] of Object.entries(t.components ?? {})) {
        for (const f of res.files ?? []) if (f.action !== 'unchanged' && f.action !== 'inspected') out(`  ${c.padEnd(11)} ${f.action.padEnd(20)} ${f.path}`)
      }
      const same = Object.values(t.components ?? {}).every((res) => (res.files ?? []).every((f) => f.action === 'unchanged' || f.action === 'inspected' || f.action === 'skipped-real-directory'))
      if (same) out('  (nothing to write: already in sync)')
      for (const l of dropLines({ [to[0]]: r.targets[to[0]] })) out(l)
      return 0
    }
    out(`${cap.cached ? 'harness unchanged' : `captured ${source}`} · ${dryRun ? 'check only, nothing written' : `synced ${rows.filter((t) => t.state !== 'source').map((t) => t.id).join(', ')}`}`)
    for (const w of cap.warnings) out(`  ! ${w}`)
    out(table(r.targets, { source }))
    const drops = dropLines(r.targets)
    if (drops.length) { out('not carried:'); for (const l of drops) out(l) }
    if (!dryRun) {
      const written = rows.reduce((n, t) => n + t.files_written, 0)
      const backups = rows.reduce((n, t) => n + t.backups.length, 0)
      out(`${written} file(s) written, ${backups} backup(s)${backups ? ` under ${join(harnessDir(), 'backups')}` : ''}`)
    }
    return stale ? 1 : 0
  }

  if (cmd === 'explain') {
    const to = list(args.to)
    const e = explainHarnessDrops({ to, env })
    if (json) { out(JSON.stringify(e, null, 2)); return 0 }
    if (!e.source) { out('no harness captured yet: leg harness capture'); return 3 }
    out(`from the ${e.source} harness, ${e.dropped.length} item(s) not carried:`)
    for (const d of e.dropped) out(`  ${d.target.padEnd(7)} ${d.component.padEnd(11)} ${d.item}${d.excluded ? ' (excluded by policy)' : ''}: ${d.reason}`)
    for (const [agent, why] of Object.entries(e.unsupported)) out(`  ${agent.padEnd(7)} everything    ${why}`)
    return 0
  }

  if (cmd === 'source') {
    const source = args._[0]
    if (!source || !HARNESS_SOURCES.includes(source)) return die(2, `usage: leg harness source <${HARNESS_SOURCES.join('|')}>`)
    const found = detectSources({ env }).map((s) => s.id)
    if (!found.includes(source)) out(`note: no ${source} rules file under ${harnessHome(env)} right now; the setting is saved anyway`)
    setHarnessConfig({ source })
    out(`harness source: ${source}. Run leg harness sync to carry it.`)
    return 0
  }

  if (cmd === 'policy') {
    const policy = args._[0]
    if (!policy || !HARNESS_POLICIES.includes(policy)) return die(2, `usage: leg harness policy <${HARNESS_POLICIES.join('|')}>`)
    setHarnessConfig({ policy })
    out(`harness policy: ${policy}${cfg.enabled ? '' : ' (portable harness is off; leg harness enable turns it on)'}`)
    return 0
  }

  if (cmd === 'history') {
    const rows = readHistory(args.limit ? parseInt(args.limit, 10) : 30)
    if (json) { out(JSON.stringify(rows, null, 2)); return 0 }
    if (!rows.length) { out('(no harness activity yet)'); return 0 }
    for (const r of rows) out(`${r.ts}  ${String(r.op).padEnd(8)} ${r.op === 'capture' ? `${r.source} fp ${String(r.fingerprint).slice(0, 12)} ${JSON.stringify(r.components)}` : r.op === 'apply' ? `${r.source} → ${r.target}: ${r.state}, ${r.written ?? 0} written, ${r.backups?.length ?? 0} backup(s)${r.force ? ' (forced)' : ''}` : `${r.from ?? '?'} → ${r.to}: ${r.state}${r.proceed === false ? ' BLOCKED' : ''} (${r.policy}${r.reason ? `; ${r.reason}` : ''})`}${r.session_id ? `  [${r.session_id}]` : ''}  ${r.elapsed_ms ?? ''}ms`)
    return 0
  }

  if (cmd === 'doctor') {
    const rows = []
    const push = (name, ok, detail) => rows.push({ name, status: ok === true ? 'ok' : ok === false ? 'FAIL' : 'note', detail })
    try { const v = checkVendor(); push('engine', v.problems.length === 0, `vendored Agnostic AI engine at ${String(v.commit).slice(0, 12)}: ${v.checked} file(s) checked${v.problems.length ? `; ${v.problems.join('; ')}` : ''}`) } catch (err) { push('engine', false, err.message) }
    const homeDir = harnessHome(env)
    push('home', existsSync(homeDir), `client configs are read under ${homeDir}${env.LEG_HARNESS_HOME || env.BATON_HARNESS_HOME ? ' (LEG_HARNESS_HOME)' : ''}`)
    push('enabled', cfg.enabled ? true : null, cfg.enabled ? `on, policy ${cfg.policy}` : 'off (leg harness enable)')
    const found = detectSources({ env })
    const source = cfg.source ?? found[0]?.id ?? null
    push('source', Boolean(source), source ? `${source}${cfg.source ? ' (configured)' : ' (detected)'}` : 'none of ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md found')
    const cap = existsSync(captureFile()) ? JSON.parse(readFileSync(captureFile(), 'utf8')) : null
    push('bundle', cap ? (existsSync(join(bundleDir(), 'manifest.json')) ? true : false) : null, cap ? `captured ${cap.captured_at} from ${cap.source}; ${existsSync(join(bundleDir(), 'manifest.json')) ? 'manifest present' : 'manifest missing (leg harness capture --force)'}` : 'never captured')
    if (cap) {
      try { const i = inspectHarness(); push('bundle valid', !i.corrupt, i.corrupt ?? `fingerprint ${String(i.fingerprint).slice(0, 12)}`) } catch (err) { push('bundle valid', false, err.message) }
    }
    const stateFile = join(harnessDir(), 'harness-state.json')
    let state = null
    if (existsSync(stateFile)) { try { state = JSON.parse(readFileSync(stateFile, 'utf8')); push('state', true, `${Object.keys(state.targets ?? {}).length} client(s) with ownership records`) } catch (err) { push('state', false, `harness-state.json unreadable: ${err.message}`) } } else push('state', null, 'no ownership records yet (nothing written)')
    push('policy file', null, existsSync(join(harnessDir(), 'policy.json')) ? `${join(harnessDir(), 'policy.json')} merged over the defaults` : 'defaults (nothing excluded)')
    for (const t of registry({ env, home: homeDir })) push(`client ${t.id}`, t.installed ? true : null, t.installed ? `installed at ${t.home}` : `not installed (${t.home} absent)`)
    for (const [agent, why] of Object.entries(NO_ADAPTER)) push(`client ${agent}`, null, why)
    if (cap && source) {
      try { const s = getHarnessStatus({ env }); for (const t of Object.values(s.targets)) if (t.state !== 'source') push(`sync ${t.id}`, t.state === 'synced' || t.state === 'partial' ? true : t.state === 'unsupported' ? null : false, `${t.state}${t.attention.length ? `: ${t.attention.map((a) => a.reason).join('; ')}` : ''}`) } catch (err) { push('sync', false, err.message) }
    }
    if (json) { out(JSON.stringify({ rows, states: STATES, policies: POLICIES }, null, 2)); return rows.some((r) => r.status === 'FAIL') ? 1 : 0 }
    const w = Math.max(...rows.map((r) => r.name.length))
    for (const r of rows) out(`${r.name.padEnd(w)}  ${r.status.padEnd(4)}  ${r.detail}`)
    out(`doctor: ${rows.filter((r) => r.status === 'FAIL').length} failure(s) across ${rows.length} check(s)`)
    return rows.some((r) => r.status === 'FAIL') ? 1 : 0
  }
  return die(2, `unknown harness command "${cmd}"`)
}
