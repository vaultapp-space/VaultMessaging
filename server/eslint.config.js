import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'uploads/**', 'migrations/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Catching a value you deliberately ignore is idiomatic here — the
      // codebase uses `catch {}` around best-effort socket sends on purpose.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Unused *arguments* are normal in fastify handlers — the signature is
      // (request, reply) whether or not the handler uses reply. Unused
      // *variables* and imports are still errors: those are real dead code.
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
