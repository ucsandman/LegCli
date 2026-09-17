#!/usr/bin/env node
// probe — run one real tiny task on one CLI through the ported runner and
// keep the evidence under fixtures/live/<adapter>/.
//   node scripts/probe.mjs --adapter <name> --repo <path> [--mode <m>] [--timeout-s 300]
// Prints: probe <name>: exit=<code> file=<yes|no> done=<yes|no> auth_source=<yes|no> seconds=<n>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { get as getAdapter } from '../src/adapters/index.mjs'
import { scrub } from '../src/runner.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const HOME = process.env.LEG_HOME || process.env.BATON_HOME || (existsSync(join(homedir(), '.leg')) ? join(homedir(), '.leg') : existsSync(join(homedir(), '.baton')) ? join(homedir(), '.baton') : join(homedir(), '.leg'))

const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
const name = args.adapter
const repo = args.repo && resolve(args.repo)
if (!name || !repo || !existsSync(repo)) {
  process.stderr.write('usage: probe.mjs --adapter <name> --repo <existing dir> [--mode m] [--timeout-s 300]\n')
  process.exit(2)
}
const timeoutS = parseInt(args['timeout-s'] ?? '300', 10)
const adapter = await getAdapter(name)
const mode = args.mode ?? adapter.modes.default

const PROMPT = `Create a file named hello-${name}.txt in the current directory containing exactly the word hi. Then create the directory .leg if it is missing and write the file .leg/DONE containing the single line: done. Do nothing else. Do not ask questions.\n`

const node = (script, a) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', env: process.env })

// Fresh DONE marker per probe so "done=yes" is this CLI's own work.
rmSync(join(repo, '.leg', 'DONE'), { force: true })
rmSync(join(repo, '.baton', 'DONE'), { force: true })
rmSync(join(repo, `hello-${name}.txt`), { force: true })

const id = node(join(SRC, 'ledger.mjs'), ['create', '--slug', `probe-${name}`.slice(0, 30), '--task', PROMPT.trim(),
  '--repo', repo, '--chain', JSON.stringify([{ adapter: name, mode }])]).trim()
const promptFile = join(HOME, 'cards', id, 'probe-prompt.txt')
writeFileSync(promptFile, PROMPT)

const t0 = Date.now()
let launch
try {
  launch = JSON.parse(node(join(SRC, 'runner.mjs'), ['launch', '--card', id, '--adapter', name,
    '--prompt-file', promptFile, '--cwd', repo, '--mode', mode]))
} catch (err) {
  process.stdout.write(`probe ${name}: launch failed: ${String(err.stderr ?? err.message).trim()}\n`)
  process.exit(1)
}
const runDir = launch.run_dir
const runJson = () => { try { return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) } catch { return null } }

// LESSONS 07-10: claude -p prints nothing until the end; poll the run record,
// never a short timeout on stdout.
let run = runJson()
while (Date.now() - t0 < timeoutS * 1000) {
  run = runJson()
  if (run && ['exited', 'killed', 'failed', 'orphaned'].includes(run.status)) break
  await new Promise((r) => setTimeout(r, 2000))
}
const seconds = Math.round((Date.now() - t0) / 1000)

// Fixtures are committed: secrets are scrubbed and the local user's home
// directory becomes "~" in every slash and escape form.
export function scrubPaths(text) {
  const [drive, ...segs] = homedir().split(/[\\/]+/)
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // C:\Users\name, C:/Users/name, C:\\Users\\name (JSON), C:\\\\… (nested JSON), /c/Users/name (MSYS)
  const re = new RegExp(`(?:${esc(drive)}|/${drive[0].toLowerCase()})${segs.map((s) => `[\\\\/]+${esc(s)}`).join('')}`, 'gi')
  return scrub(text).replace(re, '~')
}

const out = join(ROOT, 'fixtures', 'live', name)
mkdirSync(out, { recursive: true })
for (const f of ['out.log', 'err.log', 'run.json', 'supervisor.log', 'last.md']) {
  if (existsSync(join(runDir, f))) writeFileSync(join(out, f), scrubPaths(readFileSync(join(runDir, f), 'utf8')))
}
// the same opts the runner passed, so cmd.txt is the command that really ran
const spec = adapter.argv({ mode, cwd: repo, prompt: PROMPT, promptFile: join(runDir, 'prompt.txt'), runDir, killMs: 5400000 })
writeFileSync(join(out, 'cmd.txt'), scrubPaths([spec.bin, ...spec.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')) + '\n')
const textOf = (f) => (existsSync(join(runDir, f)) ? readFileSync(join(runDir, f), 'utf8') : '')
const authSource = /another auth source/i.test(textOf('err.log') + textOf('out.log'))
const file = existsSync(join(repo, `hello-${name}.txt`))
  && readFileSync(join(repo, `hello-${name}.txt`), 'utf8').trim() === 'hi'
const done = existsSync(join(repo, '.leg', 'DONE')) || existsSync(join(repo, '.baton', 'DONE'))
const exit = run?.status === 'exited' ? run.exit_code : `${run?.status ?? 'unknown'}`
const parsed = adapter.parseResult(textOf('out.log'))
writeFileSync(join(out, 'parsed.json'), scrubPaths(JSON.stringify({ ...parsed, raw: undefined }, null, 2)) + '\n')
process.stdout.write(`probe ${name}: exit=${exit} file=${file ? 'yes' : 'no'} done=${done ? 'yes' : 'no'} auth_source=${authSource ? 'yes' : 'no'} seconds=${seconds} session=${parsed?.session_id ?? 'none'}\n`)
process.exit(file && done && run?.exit_code === 0 ? 0 : 1)
