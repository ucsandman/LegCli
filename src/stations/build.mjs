// Station prompt template: build. The agent implements the task.
export default {
  goal: 'Implement the task in this working directory.',
  deliverables: [
    'Make the code change the task describes, with tests where the repository has a test suite.',
    'Run the repository\'s own checks (tests, lint) when they exist and fix what you broke.',
    'If PLAN.md exists, follow it; note any deviation in .leg/PROGRESS.md.',
  ],
}
