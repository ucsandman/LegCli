// `leg history <verb>` and `leg worktrees` — the human surface of discovery.
// Every verb prints for a person by default and JSON with --json; every one
// of them is read-only except `continue`, which starts a normal `leg <agent>`
// session on a conversation the agent's own store holds. Exit codes follow
// the rest of the CLI: 0 fine, 2 usage, 3 not found / not possible.
import { resolve } from 'node:path'
import { listHistory, findRecord, recordDetail, refreshIndex, resumeSpec, providerSupport, HistoryInputError, PROVIDER_NAMES, DEFAULT_LIMIT } from './index.mjs'
import { listWorktrees } from './worktrees.mjs'
import { ago } from '../resume.mjs'
import { attach } from '../attach.mjs'
import { entitlement, allows, describe as describeLicense } from '../license.mjs'

export const HELP = `leg history: every coding-agent conversation on this machine, Leg's own and the ones it only found
  [ls] [--provider claude,codex,grok,agy,copilot] [--repo <path|name>] [--search <text>] [--limit n] [--all] [--json]
       [--managed | --external] [--live] [--subagents] [--refresh]
                                  newest first; the index refreshes itself when it is older than a minute
  show <id> [--messages n] [--json]  one conversation: where it ran, its last messages, whether Leg can continue it
  continue <id> [agent args...]   start leg <agent> on that conversation, in its own folder, supervised like any other
  refresh [--full] [--json]       re-stat every store now; --full drops the index and re-reads everything
  providers [--json]              what Leg can do for each agent: list, read the transcript, continue
An id is <provider>:<native id>; a unique prefix of the native id (4+ characters) is enough.
Nothing in an agent's own store is moved or changed; Leg writes only ${'$LEG_HOME'}/history/index.json.`

export const WORKTREES_HELP = `leg worktrees [--repo <path>] [--no-dirty] [--json]
  every checkout git lists for the repositories Leg knows, Leg's own worktrees and the ones
  discovered conversations were working in; read only (leg card rm / the board's Remove still own removal)`

const short = (id) => { const [p, n] = String(id).split(':', 2); return n ? `${p}:${n.slice(0, 8)}` : String(id).slice(0, 24) }
const when = (iso) => (iso ? ago(Date.now() - Date.parse(iso)) : '-')
const flag = (args, k) => args[k] === true || (typeof args[k] === 'string' && args[k] !== 'false')

export function fmtRow(r) {
  const who = r.managed ? (r.live ? 'leg live' : 'leg') : (r.live ? 'external live' : 'external')
  const where = `${r.repo_name ?? r.cwd ?? '-'}${r.branch ? '@' + r.branch : ''}${r.worktree ? ' (worktree)' : ''}`
  return `${short(r.id).padEnd(16)}  ${r.provider.padEnd(6)}  ${who.padEnd(13)}  ${where.slice(0, 40).padEnd(40)}  ${when(r.updated_at).padEnd(20)}  ${String(r.title ?? '').slice(0, 60)}`
}

function printDetail(out, d) {
  out(`${d.id}  ${d.provider}${d.account !== 'default' ? '/' + d.account : ''}  ${d.managed ? `Leg session ${d.leg_session_id} (${d.leg_status})` : 'discovered, not started by Leg'}${d.live ? '  LIVE' : ''}`)
  out(`  title:      ${d.title ?? '-'}`)
  out(`  folder:     ${d.cwd ?? '-'}${d.cwd_exists === false ? '  (gone)' : ''}`)
  out(`  repo:       ${d.repo ?? '-'}${d.branch ? `  branch ${d.branch}` : ''}`)
  if (d.worktree) out(`  worktree:   ${d.worktree.path}`)
  out(`  started:    ${d.started_at ?? '-'}`)
  out(`  updated:    ${d.updated_at ?? '-'}  (${when(d.updated_at)})`)
  out(`  turns:      ${d.turns ?? 'unknown'}`)
  out(`  transcript: ${d.transcript_path ?? '-'}${d.transcript === 'unsupported' ? '  (Leg cannot read this provider\'s transcript)' : ''}`)
  out(`  continue:   ${d.resume.supported ? `leg history continue ${d.id}` : `not possible: ${d.resume.reason}`}`)
  if (d.messages === null) out('  messages:   not readable for this provider')
  else if (!d.messages.length) out('  messages:   none readable')
  else {
    out('  messages:')
    for (const m of d.messages) out(`    [${m.role === 'user' ? 'human' : 'agent'}${m.ts ? ' ' + String(m.ts).slice(0, 16).replace('T', ' ') : ''}] ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
}

export async function historyCommand(cmd, args, { out, die, raw = [] }) {
  const json = flag(args, 'json')
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flag(args, 'help') || flag(args, 'h')) { out(HELP); return 0 }
  if (!cmd || cmd === 'ls') {
    if (args.limit !== undefined) {
      const n = Number(args.limit)
      if (!Number.isInteger(n) || n < 0) return die(2, '--limit must be a non-negative integer')
    }
    if (args.provider && String(args.provider).split(',').some((p) => !PROVIDER_NAMES.includes(p.trim()))) return die(2, `unknown provider in "${args.provider}" (${PROVIDER_NAMES.join('|')})`)
    let r
    try {
      r = listHistory({
        provider: args.provider ?? null, repo: args.repo ? (/[\\/]/.test(args.repo) ? resolve(String(args.repo)) : args.repo) : null, search: args.search ?? null,
        limit: flag(args, 'all') ? 0 : (args.limit ? parseInt(args.limit, 10) : DEFAULT_LIMIT),
        includeSubagents: flag(args, 'subagents'), refresh: flag(args, 'refresh') ? true : null,
        managed: flag(args, 'managed') ? true : flag(args, 'external') ? false : null, live: flag(args, 'live') ? true : null,
      })
    } catch (err) { return die(1, `history: ${err.message}`) }
    if (json) { out(JSON.stringify(r, null, 2)); return 0 }
    if (!r.total) {
      out('no conversations found.')
      if (r.refresh_error) out(`refresh error: ${r.refresh_error}`)
      out('Leg looks in the Claude Code, Codex, Grok, Antigravity and Copilot homes on this machine, plus its own sessions. leg history providers lists them.')
      return 0
    }
    for (const x of r.records) out(fmtRow(x))
    if (r.total > r.records.length) out(`… ${r.total - r.records.length} more (--limit n, or --all)`)
    return 0
  }
  if (cmd === 'refresh') {
    const t = Date.now()
    const r = refreshIndex({ force: flag(args, 'full') })
    if (json) { out(JSON.stringify({ ms: Date.now() - t, refreshed_at: r.index.refreshed_at, stats: r.stats }, null, 2)); return 0 }
    for (const s of r.stats) out(`${s.provider.padEnd(6)} ${s.account === 'default' ? '' : s.account.padEnd(10)} ${s.missing ? 'no store here' : s.error ? `ERROR ${s.error}` : `${s.records} conversation${s.records === 1 ? '' : 's'} (${s.scanned} scanned, ${s.parsed} read)`}  ${s.root}`)
    out(`refreshed in ${Date.now() - t} ms`)
    return r.stats.some((s) => s.error) ? 1 : 0
  }
  if (cmd === 'providers') {
    const p = providerSupport()
    if (json) { out(JSON.stringify(p, null, 2)); return 0 }
    out('provider  list  transcript   continue     live marker')
    for (const x of p) out(`${x.name.padEnd(9)} yes   ${x.transcript.padEnd(12)} ${x.resume.padEnd(12)} ${x.live === 'marker' ? 'yes' : 'no'}`)
    return 0
  }
  if (cmd === 'show' || cmd === 'continue') {
    const id = args._[0]
    if (!id) return die(2, `usage: leg history ${cmd} <id>`)
    let rec
    try { rec = findRecord(id) } catch (err) { if (err instanceof HistoryInputError) return die(2, err.message); throw err }
    if (!rec) return die(3, `no conversation matches "${id}" (leg history ls)`)
    if (cmd === 'show') {
      if (args.messages !== undefined) {
        const n = Number(args.messages)
        if (!Number.isInteger(n) || n < 0) return die(2, '--messages must be a non-negative integer')
      }
      const d = recordDetail(rec, { messages: args.messages ? parseInt(args.messages, 10) : 8 })
      if (json) { out(JSON.stringify(d, null, 2)); return 0 }
      printDetail(out, d)
      return 0
    }
    const spec = resumeSpec(rec)
    if (!spec.supported) return die(3, `cannot continue ${rec.id}: ${spec.reason}`)
    const ent = entitlement()
    if (!allows(ent, 'run')) {
      out(describeLicense(ent))
      return 4
    }
    out(`continuing ${rec.id} with leg ${spec.agent} in ${spec.cwd}`)
    // everything after the id is the agent's (and Leg's own --no-worktree,
    // --no-auto-approve, which attach() strips as it does for leg <agent>)
    const at = raw.indexOf(id)
    const extra = at === -1 ? [] : raw.slice(at + 1)
    return attach(spec.agent, [...spec.args, ...extra], { open: (process.env.LEG_NO_OPEN || process.env.BATON_NO_OPEN) !== '1', cwd: spec.cwd, continued: { id: rec.id, provider: rec.provider, native_id: rec.native_id, transcript_path: rec.transcript_path, title: rec.title } })
  }
  return die(2, `unknown history command "${cmd}" (ls|show|continue|refresh|providers)`)
}

export function fmtWorktree(w) {
  const owner = w.owner.kind === 'checkout' ? 'checkout' : w.owner.kind === 'session' ? `session ${w.owner.id}${w.owner.live ? ' (live)' : ''}` : w.owner.kind === 'card' ? `card ${w.owner.id}` : 'external'
  const flags = [!w.exists ? 'MISSING' : null, w.orphaned ? 'orphaned' : null, w.stale ? 'stale' : null, w.dirty === null ? null : w.dirty ? `${w.dirty} dirty` : 'clean'].filter(Boolean).join(', ')
  return `${(w.repo_name ?? '-').padEnd(18)}  ${(w.branch ?? '(detached)').slice(0, 32).padEnd(32)}  ${owner.padEnd(36)}  ${String(w.conversations.count).padStart(3)} conv  ${flags.padEnd(22)}  ${w.path}`
}

export function worktreesCommand(cmd, args, { out, die }) {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flag(args, 'help') || flag(args, 'h')) { out(WORKTREES_HELP); return 0 }
  if (cmd && cmd !== 'ls') return die(2, `unknown worktrees command "${cmd}" (ls)`)
  const r = listWorktrees({ dirty: !flag(args, 'no-dirty'), repo: args.repo ? resolve(String(args.repo)) : null })
  if (flag(args, 'json')) { out(JSON.stringify(r, null, 2)); return 0 }
  if (!r.worktrees.length) { out('no worktrees: Leg knows no repository yet (a session, a card or a discovered conversation names one).'); return 0 }
  for (const w of r.worktrees) out(fmtWorktree(w))
  out(`${r.worktrees.length} checkout${r.worktrees.length === 1 ? '' : 's'} across ${r.repos} repositor${r.repos === 1 ? 'y' : 'ies'}; dirty checked on ${r.dirty_checked}. Read only: leg card rm / leg sessions rm / the board's Remove own removal.`)
  return 0
}
