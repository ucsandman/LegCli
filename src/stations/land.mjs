// Station template: land. No agent runs here; the merge queue does the work
// (src/mergequeue.mjs). Kept so every station kind has a template entry.
export default {
  goal: 'Rebase onto trunk, run the repository tests, fast-forward trunk.',
  deliverables: [],
}
