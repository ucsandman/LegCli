// pr — the opt-in land mode. Instead of fast-forwarding trunk, build the
// `gh pr create` argv and run it through BATON_GH_BIN. This run never
// executes a real gh (hard stop: no remotes); tests point BATON_GH_BIN at a
// stub that logs its argv and prints a URL.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchName } from '../worktree.mjs'
import { scrub } from '../runner.mjs'

export function prArgv({ card, bodyFile }) {
  return ['pr', 'create', '--base', card.trunk || 'main', '--head', branchName(card.card_id), '--title', card.title || card.card_id, '--body-file', bodyFile]
}

export function prBody(card, bundleSummary = '') {
  return `## Task\n\n${card.task}\n\n## Leg\n\ncard ${card.card_id}, pipeline ${card.pipeline.map((s) => s.name).join(' → ')}\n\n${bundleSummary ? `## Handoff summary\n\n${bundleSummary}\n` : ''}`
}

export function openPr({ card, runDir, bundleSummary = '' }) {
  const bin = (process.env.LEG_GH_BIN || process.env.BATON_GH_BIN)
  if (!bin) return { ok: false, error: 'LEG_GH_BIN or BATON_GH_BIN is not set; pr land mode is stub-only in this build (no live gh)' }
  mkdirSync(runDir, { recursive: true })
  const bodyFile = join(runDir, 'pr-body.md')
  writeFileSync(bodyFile, prBody(card, bundleSummary))
  const argv = prArgv({ card, bodyFile })
  const viaNode = /\.(mjs|cjs|js)$/.test(bin)
  const r = spawnSync(viaNode ? process.execPath : bin, viaNode ? [bin, ...argv] : argv, { cwd: card.worktree ?? card.repo, windowsHide: true, encoding: 'utf8', timeout: 60000, env: process.env })
  if (r.error || r.status !== 0) return { ok: false, error: scrub(r.error?.message || r.stderr || r.stdout).slice(0, 300), argv }
  const url = (r.stdout.match(/https?:\/\/\S+/) || [null])[0]
  return { ok: true, url, argv, stdout: r.stdout.trim() }
}
