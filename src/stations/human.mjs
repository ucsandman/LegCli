// Station kind: human. Nothing runs; the card parks in waiting_human until a
// person presses Approve (or Kill / Reassign) on the board.
export async function run({ id, actor, ops }) {
  return { card: ops.step(id, 'start', {}, actor), done: true }
}
