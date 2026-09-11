// Station kind: agent. One chain leg runs here (or, after `baton down` or a
// crashed server, the orchestrator re-attaches to the run it left behind),
// the run is settled, and its verdict is applied to the card. `ops` are the
// orchestrator's helpers; this module never imports the orchestrator.
export async function run({ id, card, station, worktree, actor, ops }) {
  const { unsettledRun, pidAlive, ledgerAppend, patchRun, waitForRun, runLeg, settleRun, readCard, handoffOn, transition, apply, step, log } = ops
  const pending = unsettledRun(id)
  if (pending?.driver_pid && pending.driver_pid !== process.pid && pidAlive(pending.driver_pid)) {
    log(`card ${id}: run ${pending.run} is driven by pid ${pending.driver_pid}; not attaching`)
    return { card, done: true }
  }
  if (pending) {
    ledgerAppend(id, { type: 'status', station: station.name, leg: card.leg, summary: `re-attached to run ${pending.run} (${pending.status}); no new leg launched` })
    patchRun(id, pending.run, { driver_pid: process.pid })
  }
  const runRecord = pending ? await waitForRun(id, pending.run) : await runLeg(card, station, worktree)
  settleRun(id, runRecord)
  const fresh = readCard(id)
  if (fresh.status !== 'running') {
    // A human acted while the leg ran; the machine already moved the card.
    // paused: keep the context for Resume. handing_off: the human asked for
    // the bundle, so write it and queue the next leg. queued: reassigned, and
    // the loop starts the new adapter. killed: nothing more to do.
    if (fresh.status === 'paused') handoffOn(fresh, station, runRecord, worktree, ['paused by a human; resume continues from this bundle'])
    if (fresh.status === 'handing_off') {
      handoffOn(fresh, station, runRecord, worktree, ['hand-off requested by a human; the running leg was stopped'])
      return { card: step(id, 'bundle_written', {}, actor) }
    }
    return { card: fresh, done: fresh.status !== 'queued' }
  }
  const before = fresh
  const result = transition(before, 'leg_result', {
    outcome: runRecord.outcome, handoff: runRecord.handoff, signal: runRecord.signal,
    adapter: station.chain[before.leg]?.adapter, run: runRecord.run,
  })
  let next = apply(id, before, result, actor)
  if (next.status === 'handing_off') {
    handoffOn(next, station, runRecord, worktree)
    next = step(id, 'bundle_written', {}, actor)
  }
  return { card: next }
}
