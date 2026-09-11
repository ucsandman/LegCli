// Station prompt template: plan. The agent turns the task into a plan file.
export default {
  goal: 'Turn the task into a concrete plan before any code changes.',
  deliverables: [
    'Write PLAN.md at the repository root: goal, the files you expect to touch, the steps in order, how each step is verified, and open questions.',
    'Do not implement anything in this station; planning only.',
  ],
}
