// Fake client homes for the harness tests. buildClaudeHome(dir) and
// buildCodexHome(dir) populate a throwaway directory that stands in for a
// user's real OS home (LEG_HARNESS_HOME): rules, hooks, agents, commands,
// skills, MCP servers, permissions, plus the credential files a capture must
// never read. Ported from the engine's own fixture (engine/tests/fixtures/
// harness/build-home.cjs upstream) with Leg's canaries added.
//
// Every token-looking value is built at runtime, never a literal, so the
// pre-commit secret scan never trips on this file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const fakeToken = (tag = 'x') => 'sk-' + tag.repeat(24)
// Planted in the places a capture must not read (oauth blocks, auth.json).
// A test asserts these strings appear in no bundle file and no target file.
export const CANARY = { claude: 'canary-claude-oauth-' + 'q'.repeat(20), codex: 'canary-codex-auth-' + 'r'.repeat(20) }

export function writeFile(p, content) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
}

function noopHook() {
  return ['#!/usr/bin/env node', 'let buf = "";', 'process.stdin.on("data", (d) => { buf += d; });', 'process.stdin.on("end", () => { process.stdout.write("{}"); process.exit(0); });', 'process.stdin.resume();', ''].join('\n')
}

export const CLAUDE_HOOK_TOTAL = 6

// Planted where the engine used to scan nothing: rules text, identity text, a
// hook command line, an MCP argument, an MCP url, an agent body. A capture
// must redact or drop each of them and say so.
export const PLANTED = { rules: 'sk-' + 'r'.repeat(30), identity: 'ghp_' + 'i'.repeat(36), hook: 'sk-' + 'h'.repeat(30), arg: 'sk-' + 'g'.repeat(30), url: 'https://hooks.example.com/t/9f3a2b7c41d5e6088a1b2c3d4e', agent: 'sk-' + 'b'.repeat(30) }

export function buildClaudeHome(dir, { skills = ['alpha', 'beta', 'gamma'], rulesExtra = '', plantSecrets = false } = {}) {
  const plant = (v) => (plantSecrets ? v : '')
  const claude = join(dir, '.claude')
  writeFile(join(claude, 'CLAUDE.md'), ['# CLAUDE.md', '', 'Operating guide for the assistant.', '', '@~/.claude/team-rules.md', '', '## How to Work', '', '- Batch tool calls; one call per turn is the slow path.', '- Read a file before editing it.', rulesExtra, plant(`- The deploy key is ${PLANTED.rules}.`), '', '## Delegation and Model Routing', '', '- Route heavy synthesis to Opus, mechanical edits to Haiku.', ''].join('\n'))
  writeFile(join(claude, 'team-rules.md'), ['# Team rules', '', '- Never commit secrets.', ''].join('\n'))
  writeFile(join(claude, 'SOUL.md'), ['# SOUL', '', 'Direct, no filler.', plant(`token ${PLANTED.identity}`), ''].join('\n'))
  const hooksDir = join(claude, 'hooks')
  const names = ['secret-guard', 'rm-guard', 'post-log', 'stop-notify', 'session-start', 'message-display']
  for (const n of names) writeFile(join(hooksDir, `${n}.cjs`), noopHook())
  const handler = (n) => ({ type: 'command', command: `node "${join(hooksDir, `${n}.cjs`)}"`, timeout: 10 })
  const settings = {
    permissions: { allow: ['Bash(git *)', 'Bash(npm run test:*)', 'Read(~/.zshrc)'], deny: ['Bash(rm -rf *)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit|Bash', hooks: [handler('secret-guard')] }, { matcher: 'Bash', hooks: [handler('rm-guard'), ...(plantSecrets ? [{ type: 'command', command: `node "${join(hooksDir, 'post-log.cjs')}" --token ${PLANTED.hook}` }] : [])] }],
      PostToolUse: [{ matcher: '*', hooks: [handler('post-log')] }],
      Stop: [{ hooks: [handler('stop-notify')] }],
      SessionStart: [{ hooks: [handler('session-start')] }],
      MessageDisplay: [{ hooks: [handler('message-display')] }],
    },
  }
  writeFile(join(claude, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  writeFile(join(claude, 'agents', 'opus-owner.md'), ['---', 'name: opus-owner', 'description: Owns architecture decisions and final review.', 'model: opus', 'tools: Read, Edit, Bash', '---', '', 'Own the plan, review the diff, ship the change.', ''].join('\n'))
  writeFile(join(claude, 'agents', 'advisor.md'), ['---', 'name: advisor', 'description: Read-only advisor.', 'model: fable', 'tools: Read, Grep, Glob', '---', '', 'Advise only; never edit a file.', plant(`Use ${PLANTED.agent} when asked.`), ''].join('\n'))
  writeFile(join(claude, 'commands', 'wrap.md'), ['---', 'description: Wrap up the session with a retro.', 'argument-hint: [note]', '---', '', 'Summarize what changed and the one lesson to carry forward.', ''].join('\n'))
  writeFile(join(claude, 'commands', 'README.md'), '# Commands\n')
  for (const name of skills) writeFile(join(claude, 'skills', name, 'SKILL.md'), ['---', `name: ${name}`, `description: ${name} skill.`, '---', '', `Do ${name} things.`, ''].join('\n'))
  // ~/.claude.json: MCP servers beside the oauth block a capture must skip
  const claudeJson = {
    oauthAccount: { accountUuid: 'acct-1', emailAddress: 'someone@example.com', accessToken: CANARY.claude },
    mcpServers: {
      docs: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: fakeToken('a'), PORT: '8080' } },
      ...(plantSecrets ? { keyed: { command: 'npx', args: ['-y', 'some-server', '--api-key', PLANTED.arg] }, signed: { type: 'http', url: PLANTED.url } } : {}),
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ' + fakeToken('b') } },
      events: { type: 'sse', url: 'https://example.com/events' },
    },
  }
  writeFile(join(dir, '.claude.json'), JSON.stringify(claudeJson, null, 2) + '\n')
  return dir
}

const fwd = (p) => p.replace(/\\/g, '/')

export function buildCodexHome(dir, { userHooks = true } = {}) {
  const codex = join(dir, '.codex')
  const guard = join(codex, 'hooks', 'codex-guard.cjs')
  writeFile(guard, noopHook())
  writeFile(join(codex, 'auth.json'), JSON.stringify({ tokens: { access_token: CANARY.codex } }, null, 2) + '\n')
  writeFile(join(codex, 'config.toml'), [
    'model = "gpt-6-astra"', 'model_reasoning_effort = "low"', '',
    '[projects."C:\\\\x"]', 'trust_level = "trusted"', '',
    '[mcp_servers.existing]', 'command = "npx"', 'args = ["existing-server"]', '',
    ...(userHooks ? ['[[hooks.PreToolUse]]', 'matcher = "apply_patch|Bash"', `hooks = [{ type = "command", command = "node ${fwd(guard)}" }]`, ''] : []),
  ].join('\n'))
  writeFile(join(codex, 'AGENTS.md'), ['# AGENTS.md', '', 'Operating rules for Codex CLI in this environment.', '', '## How to Work', '', '- Keep diffs minimal and reversible.', ''].join('\n'))
  writeFile(join(codex, 'agents', 'one.toml'), ['name = "one"', 'description = "A worker agent."', 'model = "gpt-5.6-terra"', 'model_reasoning_effort = "medium"', 'sandbox_mode = "read-only"', 'developer_instructions = """', 'Follow the instructions exactly.', '"""', ''].join('\n'))
  writeFile(join(codex, 'prompts', 'p1.md'), 'Summarize the current diff and suggest a commit message.\n')
  writeFile(join(codex, 'skills', 'beta', 'SKILL.md'), ['---', 'name: beta', 'description: Codex-native beta skill.', '---', '', 'Do beta things, the Codex way.', ''].join('\n'))
  writeFile(join(codex, 'rules', 'default.rules'), ['prefix_rule(pattern=["ls"], decision="allow")', 'prefix_rule(pattern=["rm", "-rf"], decision="forbidden")', ''].join('\n'))
  writeFile(join(codex, 'models_cache.json'), JSON.stringify({ models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] }) + '\n')
  return dir
}

export function buildAgyHome(dir) {
  writeFile(join(dir, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ trustedWorkspaces: [] }, null, 2) + '\n')
  writeFile(join(dir, '.gemini', 'config', 'hooks.json'), JSON.stringify({ 'other-plugin': { PreToolUse: [{ hooks: [{ type: 'command', command: 'node other.cjs' }] }] } }, null, 2) + '\n')
  writeFile(join(dir, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n')
  return dir
}
