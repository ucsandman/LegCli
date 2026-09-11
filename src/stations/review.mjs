// Station prompt template: review. The agent reviews the branch and fixes blockers.
export default {
  goal: 'Review the changes on this branch against the trunk and fix anything blocking.',
  deliverables: [
    'Write REVIEW.md at the repository root: findings ordered by severity, each with file:line and a one-line fix.',
    'Fix every blocking finding (bugs, broken tests, security) in place; leave non-blocking ones listed.',
  ],
}
