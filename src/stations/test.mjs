// Station kind: test. Runs the repo's test command in the worktree; green
// advances the card, red bounces it to the build station with the tail in
// the handoff bundle (the attempt cap is shared with the land station).
export async function run({ id, card, station, worktree, actor, ops }) {
  const { resolveTestCommand, runTestCommand, ledgerAppend, step, transition, handoffOn, apply, readCard } = ops
  const cmd = station.command ?? resolveTestCommand(card, worktree).command
  if (!cmd) {
    ledgerAppend(id, { type: 'status', station: station.name, leg: 0, summary: 'test station: no test command configured; treating as green' })
    return { card: step(id, 'test_result', { green: true }, actor) }
  }
  const t = await runTestCommand(cmd, worktree)
  ledgerAppend(id, { type: 'status', station: station.name, leg: 0, summary: `test ${t.green ? 'green' : 'red'}: ${t.command}${t.timedOut ? ' (timed out)' : ''}`, body: t.tail })
  // the suite ran for a while: a human may have killed or paused the card
  // meanwhile, and a result applied to that stale status would undo them
  const fresh = readCard(id)
  if (fresh.status !== 'running') {
    ledgerAppend(id, { type: 'status', station: station.name, leg: 0, summary: `test result not applied: the card was ${fresh.status} by then` })
    return { card: fresh, done: fresh.status !== 'queued' }
  }
  if (!t.green) {
    const bounced = transition(fresh, 'test_result', { green: false, reason: `test red (${t.command}, exit ${t.status}): ${t.tail.split('\n').slice(-5).join(' | ')}` })
    // Attach the failure to a bundle so the next build leg starts from it.
    handoffOn(fresh, { name: station.name, chain: [] }, { outcome: 'test_red', reason: t.tail, exit_code: t.status, adapter: 'test' }, worktree, [`test red: ${t.command}`, t.tail.slice(0, 1500)])
    return { card: apply(id, fresh, bounced, actor) }
  }
  return { card: step(id, 'test_result', { green: true }, actor) }
}
