// land — the land station handler the orchestrator calls. `ff` mode runs the
// merge queue (src/mergequeue.mjs); `pr` mode opens a pull request through the
// gh stub (src/stations/pr.mjs) and parks the card for a human.
import { join } from 'node:path'
import { land } from './mergequeue.mjs'
import { openPr } from './stations/pr.mjs'
import { cardDir, ledgerAppend } from './store.mjs'

export async function landCard(card, worktree) {
  const warn = (msg) => ledgerAppend(card.card_id, { type: 'land_warning', station: card.station, leg: 0, summary: msg })
  if (card.land_mode === 'pr') {
    const r = openPr({ card: { ...card, worktree }, runDir: join(cardDir(card.card_id), 'land') })
    if (!r.ok) return { landed: false, bounced: false, pr: false, reason: `pr mode: ${r.error}` }
    return { landed: false, pr: true, url: r.url, summary: `pull request opened: ${r.url ?? '(no url)'}`, argv: r.argv }
  }
  return land(card, worktree, { onWarning: warn })
}
