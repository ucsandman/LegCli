// Synthetic native stores for history discovery tests. Every shape here
// mirrors what the real CLIs write (observed 2026-09-16, see the header of
// each src/history/providers/*.mjs); nothing reads the developer's own
// ~/.claude, ~/.codex, ~/.grok, ~/.gemini or ~/.copilot.
import { mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
export const id = uuid

function write(file, text, { mtime = null } = {}) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  if (mtime) utimesSync(file, new Date(mtime), new Date(mtime))
}

const jl = (objs) => objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n'

// Claude Code: projects/<encoded cwd>/<sessionId>.jsonl (+ history.jsonl, sessions/<pid>.json)
export function claudeStore(home, sessions = []) {
  mkdirSync(join(home, 'projects'), { recursive: true })
  const out = []
  for (const s of sessions) {
    const sid = s.id ?? uuid(out.length + 1)
    const cwd = s.cwd ?? 'C:\\Projects\\toy'
    const dir = join(home, 'projects', s.projectDir ?? cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    const started = s.started ?? '2026-09-10T10:00:00.000Z'
    const updated = s.updated ?? '2026-09-10T10:30:00.000Z'
    const lines = []
    if (s.bom) lines.push('\uFEFF' + JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: sid }))
    else lines.push({ type: 'last-prompt', leafUuid: 'x', sessionId: sid })
    lines.push({ type: 'permission-mode', permissionMode: 'default', sessionId: sid })
    lines.push({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: s.prompt ?? 'first prompt of the conversation' }, uuid: 'u1', timestamp: started, cwd, sessionId: sid, version: s.version ?? '2.1.273', gitBranch: s.branch ?? 'main' })
    if (s.title) lines.push({ type: 'ai-title', aiTitle: s.title, sessionId: sid })
    if (s.customTitle) lines.push({ type: 'custom-title', customTitle: s.customTitle, sessionId: sid })
    if (s.worktree) lines.push({ type: 'worktree-state', sessionId: sid, worktreeSession: { originalCwd: s.worktree.originalCwd ?? cwd, worktreePath: s.worktree.path, worktreeName: 'wt', worktreeBranch: s.worktree.branch ?? 'worktree-wt', originalBranch: s.branch ?? 'main', originalHeadCommit: 'abc', sessionId: sid } })
    if (s.hidden) lines.push({ type: 'history-suppression', sessionId: sid, cause: 'chokepoint_veto', ts: Date.parse(updated) })
    lines.push({ parentUuid: 'u1', isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: s.reply ?? 'the agent answered' }] }, uuid: 'a1', timestamp: updated, cwd, sessionId: sid, version: s.version ?? '2.1.273', gitBranch: s.branch ?? 'main' })
    // bulk in the middle, so the head and the tail are both real
    if (s.padTo) for (let n = 0; n < Math.ceil(s.padTo / 4100); n++) lines.push({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: 'x'.repeat(4000) }, timestamp: updated, cwd, sessionId: sid, version: '2.1.273', gitBranch: 'main' })
    for (const extra of s.extraMessages ?? []) lines.push({ parentUuid: 'a1', isSidechain: false, type: extra.role === 'user' ? 'user' : 'assistant', message: { role: extra.role, content: extra.text }, uuid: 'x', timestamp: updated, cwd, sessionId: sid, version: '2.1.273', gitBranch: s.branch ?? 'main' })
    if (s.sidechain) lines.push({ parentUuid: 'a1', isSidechain: true, type: 'user', message: { role: 'user', content: s.sidechain }, uuid: 'sc', timestamp: updated, cwd, sessionId: sid, version: '2.1.273', gitBranch: 'main', agentId: 'agent-1' })
    if (s.malformedLine) lines.push(s.malformedLine)
    if (s.unknownType) lines.push({ type: 'some-future-type', sessionId: sid, payload: { x: 1 } })
    let text = jl(lines)
    if (s.truncated) text = text.slice(0, -20) // a torn last line
    const file = join(dir, `${sid}.jsonl`)
    write(file, text, { mtime: s.mtime ?? updated })
    // the sibling directory a real session keeps, with a subagent transcript
    // that reuses the parent's sessionId: never listed as a conversation
    if (s.withSubagentDir) write(join(dir, sid, 'subagents', 'agent-abc.jsonl'), jl([{ type: 'user', isSidechain: true, agentId: 'abc', message: { role: 'user', content: 'sub prompt' }, timestamp: updated, cwd, sessionId: sid, version: '2.1.273', gitBranch: 'main' }]))
    if (s.prompts) for (const p of s.prompts) appendFileSync(join(home, 'history.jsonl'), JSON.stringify({ display: p, pastedContents: {}, timestamp: Date.parse(started), project: cwd, sessionId: sid }) + '\n')
    if (s.livePid) write(join(home, 'sessions', `${s.livePid}.json`), JSON.stringify({ pid: s.livePid, sessionId: sid, cwd, startedAt: Date.parse(started), version: '2.1.273', kind: 'interactive', status: 'busy' }))
    out.push({ id: sid, file, cwd })
  }
  return out
}

// Codex: sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl (+ session_index.jsonl, history.jsonl)
export function codexStore(home, threads = []) {
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const out = []
  for (const t of threads) {
    const tid = t.id ?? uuid(100 + out.length)
    const cwd = t.cwd ?? 'C:\\Projects\\toy'
    const started = t.started ?? '2026-09-11T12:00:00.000Z'
    const updated = t.updated ?? '2026-09-11T12:20:00.000Z'
    const day = t.day ?? '2026/09/11'
    const meta = { session_id: t.rootId ?? tid, id: tid, timestamp: started, cwd, originator: 'codex-tui', cli_version: t.version ?? '0.154.0', source: t.subagent ? { subagent: { thread_spawn: { parent_thread_id: t.rootId ?? uuid(1), depth: 1, agent_nickname: 'Bohr' } } } : 'cli', thread_source: t.subagent ? 'subagent' : 'user', model_provider: 'openai', base_instructions: { text: 'SYSTEM PROMPT NEVER SHOWN' } }
    if (t.git !== false) meta.git = { commit_hash: 'deadbeef', branch: t.branch ?? 'main', repository_url: 'https://example.invalid/toy.git' }
    const lines = [
      { timestamp: started, ordinal: 0, type: 'session_meta', payload: meta },
      { timestamp: started, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEVELOPER TEXT NEVER SHOWN' }] } },
      { timestamp: started, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] } },
      { timestamp: started, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.prompt ?? 'codex first prompt' }] } },
      { timestamp: updated, type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: updated, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.reply ?? 'codex answered' }] } },
      { timestamp: updated, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: t.reply ?? 'codex answered' } },
    ]
    if (t.malformedLine) lines.push(t.malformedLine)
    let text = jl(lines)
    if (t.bom) text = '\uFEFF' + text
    const stamp = started.replace(/[:.]/g, '-').replace('Z', '').replace(/-\d{3}$/, '')
    const file = join(home, 'sessions', ...day.split('/'), `rollout-${stamp}-${tid}.jsonl`)
    write(file, text, { mtime: t.mtime ?? updated })
    if (t.title) appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id: tid, thread_name: t.title, updated_at: updated }) + '\n')
    for (const p of t.prompts ?? []) appendFileSync(join(home, 'history.jsonl'), JSON.stringify({ session_id: tid, ts: Math.floor(Date.parse(started) / 1000), text: p }) + '\n')
    out.push({ id: tid, file, cwd })
  }
  return out
}

// Grok: sessions/<url-encoded cwd>/<id>/{summary.json,chat_history.jsonl}, prompt_history.jsonl per cwd
export function grokStore(home, sessions = []) {
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const out = []
  for (const s of sessions) {
    const sid = s.id ?? uuid(200 + out.length)
    const cwd = s.cwd ?? 'C:\\Projects\\toy'
    const cdir = join(home, 'sessions', encodeURIComponent(cwd))
    const started = s.started ?? '2026-09-12T08:00:00.000Z'
    const updated = s.updated ?? '2026-09-12T08:45:00.000Z'
    const summary = { info: { id: sid, cwd }, agent_id: 'ag1.x', attempt_id: 'at1.x', session_summary: s.summary ?? '', created_at: started, updated_at: updated, num_messages: 8, num_chat_messages: 4, current_model_id: 'grok-4.6', chat_format_version: 1, git_root_dir: (s.gitRoot ?? cwd).replace(/\\/g, '/') + '/', git_remotes: [], head_commit: 'cafe', head_branch: s.branch ?? 'main', last_active_at: updated, generated_title: s.title ?? '', agent_name: 'grok-build-plan' }
    if (s.kind) summary.session_kind = s.kind
    write(join(cdir, sid, 'summary.json'), (s.corruptSummary ? '{not json' : JSON.stringify(summary, null, 2)), { mtime: updated })
    write(join(cdir, sid, 'chat_history.jsonl'), jl([
      { type: 'system', content: 'You are Grok' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: windows' }] },
      { type: 'user', content: [{ type: 'text', text: s.prompt ?? 'grok first prompt' }] },
      { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'NEVER SHOWN', status: 'completed' },
      { type: 'assistant', content: s.reply ?? 'grok answered', model_id: 'grok-4.6-build' },
    ]))
    appendFileSync(join(cdir, 'prompt_history.jsonl'), JSON.stringify({ timestamp: started, session_id: sid, prompt: s.prompt ?? 'grok first prompt', is_bash: false }) + '\n')
    out.push({ id: sid, cwd, file: join(cdir, sid, 'chat_history.jsonl') })
  }
  if (sessions.some((s) => s.live)) write(join(home, 'active_sessions.json'), JSON.stringify(out.filter((_, i) => sessions[i].live).map((o) => ({ id: o.id }))))
  return out
}

// Antigravity: history.jsonl (+ annotations/<id>.pbtxt, presence/<id>.lock)
export function agyStore(home, conversations = []) {
  mkdirSync(home, { recursive: true })
  const out = []
  for (const c of conversations) {
    const cid = c.id ?? uuid(300 + out.length)
    const cwd = c.cwd ?? 'C:\\Projects\\toy'
    const t0 = Date.parse(c.started ?? '2026-09-13T09:00:00.000Z')
    const prompts = c.prompts ?? ['agy first prompt', 'agy second prompt']
    prompts.forEach((p, i) => appendFileSync(join(home, 'history.jsonl'), JSON.stringify({ display: p, timestamp: t0 + i * 60000, workspace: cwd, conversationId: cid }) + '\n'))
    if (c.slash) appendFileSync(join(home, 'history.jsonl'), JSON.stringify({ display: '/usage', timestamp: t0, workspace: cwd, type: 'slash_command' }) + '\n')
    if (c.title) write(join(home, 'annotations', `${cid}.pbtxt`), `title:"${c.title}"\n`)
    if (c.presence) write(join(home, 'presence', `${cid}.lock`), '', { mtime: c.presence })
    out.push({ id: cid, cwd })
  }
  return out
}

// Copilot CLI: session-state/<id>/{workspace.yaml,events.jsonl}
export function copilotStore(home, sessions = []) {
  mkdirSync(join(home, 'session-state'), { recursive: true })
  const out = []
  for (const s of sessions) {
    const sid = s.id ?? uuid(400 + out.length)
    const cwd = s.cwd ?? 'C:\\Projects\\toy'
    const dir = join(home, 'session-state', sid)
    const started = s.started ?? '2026-09-14T14:00:00.000Z'
    const updated = s.updated ?? '2026-09-14T14:10:00.000Z'
    write(join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: ${cwd}\ngit_root: ${cwd}\nrepository: example/toy\nhost_type: github\nbranch: ${s.branch ?? 'main'}\nclient_name: github/cli\nname: ${s.title ?? 'Copilot session'}\nuser_named: false\nsummary_count: 0\ncreated_at: ${started}\nupdated_at: ${updated}\n`, { mtime: updated })
    write(join(dir, 'events.jsonl'), jl([
      { type: 'session.start', data: { sessionId: sid, context: { cwd, branch: 'main' } }, id: 'e1', timestamp: started, parentId: null },
      { type: 'user.message', data: { content: s.prompt ?? 'copilot first prompt' }, id: 'e2', timestamp: started, parentId: 'e1' },
      { type: 'assistant.message', data: { content: s.reply ?? 'copilot answered' }, id: 'e3', timestamp: updated, parentId: 'e2' },
    ]))
    out.push({ id: sid, cwd, file: join(dir, 'events.jsonl') })
  }
  return out
}

// All five stores under one temp root, each in its own subdirectory, and the
// `homes` override that points discovery at them.
export function allStores(root, { claude = [], codex = [], grok = [], agy = [], copilot = [] } = {}) {
  const homes = { claude: join(root, 'claude-home'), codex: join(root, 'codex-home'), grok: join(root, 'grok-home'), agy: join(root, 'agy-home'), copilot: join(root, 'copilot-home') }
  return {
    homes,
    claude: claudeStore(homes.claude, claude),
    codex: codexStore(homes.codex, codex),
    grok: grokStore(homes.grok, grok),
    agy: agyStore(homes.agy, agy),
    copilot: copilotStore(homes.copilot, copilot),
  }
}
