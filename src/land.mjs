// land — the land station. Phase 5 ships the stub (records `landed` without
// touching trunk); phase 7 replaces it with the merge queue: rebase onto
// trunk in the worktree, run the repo test command, ff-only trunk if green,
// bounce with the failure attached otherwise.
export async function landCard(card, worktree) {
  void worktree
  return { landed: true, summary: `landed (stub: phase 7 wires the merge queue; land_mode=${card.land_mode ?? 'ff'})` }
}
