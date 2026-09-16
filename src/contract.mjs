// contract — the per-leg prompt. Every CLI gets the same contract file at
// .leg/CONTRACT.md in the worktree (CLI-agnostic completion: write
// .leg/DONE when finished). Leg 1 prompt = the contract; a later leg or a
// resume = the handoff bundle's resume text + the contract.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEMPLATES = {
  plan: () => import('./stations/plan.mjs'),
  build: () => import('./stations/build.mjs'),
  review: () => import('./stations/review.mjs'),
}

export async function stationTemplate(name = 'build') {
  const load = TEMPLATES[name] ?? TEMPLATES.build
  return (await load()).default
}

export async function renderContract({ card, station, leg, entry, worktree, resumed = false, bounceReason = null }) {
  const t = await stationTemplate(station.prompt ?? station.name)
  const lines = [
    `# Leg contract, card ${card.card_id}, station ${station.name}, leg ${leg} (${entry?.adapter ?? 'agent'})`,
    '',
    '## Task',
    '',
    card.task,
    '',
    '## Station goal',
    '',
    t.goal,
    '',
    ...t.deliverables.map((d) => `- ${d}`),
    '',
  ]
  if (bounceReason) {
    lines.push('## Why this card came back', '', bounceReason, '')
  }
  if (resumed) {
    lines.push('## Continuation', '',
      'A previous agent already worked on this card in this same directory. Its handoff resume is above this contract; .leg/PROGRESS.md holds its notes. Continue from there; do not start over.', '')
  }
  lines.push(
    '## Rules',
    '',
    `- Work only inside this directory: ${worktree}. It is a git worktree on its own branch; commit as you go or leave changes uncommitted, both are fine.`,
    '- Keep .leg/PROGRESS.md updated as you go: one line per meaningful step, newest last. It is how the next agent (or a human) picks up if you stop early.',
    '- Maintain .leg/SYNTHESIS-<session-id>.md using the schema in section 4. Update it whenever you rule out an approach, make a consequential decision, or change direction. Keep each section to 5 bullets max, one line per bullet.',
    '- Do not push, do not create remotes, do not open pull requests, do not change git config.',
    '- Do not touch anything under .leg/ except PROGRESS.md, SYNTHESIS-*.md, and DONE.',
    '- No interactive prompt will be answered; if you need a permission you do not have, write what you need to .leg/PROGRESS.md and stop.',
    '',
    '## Finish',
    '',
    'When the task is finished and verified, write the file .leg/DONE containing one line that summarizes what you did. Without that file Leg treats the run as unfinished and hands it to the next agent.',
    '',
  )
  return lines.join('\n')
}

export function writeContract(worktree, text) {
  const dir = join(worktree, '.leg')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'CONTRACT.md')
  writeFileSync(path, text)
  return path
}

export function legPrompt({ contractText, resumeText = null }) {
  const head = 'You are working on a Leg card. The contract below is also saved at .leg/CONTRACT.md.'
  if (resumeText) {
    return `${head}\n\n=== HANDOFF RESUME (from the previous agent) ===\n\n${resumeText.trim()}\n\n=== CONTRACT ===\n\n${contractText}`
  }
  return `${head}\n\n${contractText}`
}
