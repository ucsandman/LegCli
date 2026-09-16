import js from '@eslint/js'
import globals from 'globals'

export default [
  // marketing/ and .design/ are gitignored local production scratch (video
  // recorders, seeders, design mocks). They are not shipped and are not held to
  // the package's lint rules.
  { ignores: ['node_modules/**', '.supergoal/**', 'fixtures/**', 'docs/**', '.baton/**', '.baton-worktrees/**', '.leg/**', '.leg-worktrees/**', '.context-handoffs/**', 'marketing/**', '.design/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
