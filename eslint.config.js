import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**', '.supergoal/**', 'fixtures/**', 'docs/**', '.baton/**', '.baton-worktrees/**'] },
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
