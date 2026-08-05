import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'public/sw.js', '.svelte-kit/**'],
  },
  js.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.js', '**/*.svelte'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Web Crypto is used throughout the crypto modules.
        crypto: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],

      // The three rules below are warnings, not errors, so the lint gate
      // stays meaningful without demanding a refactor of working UI code.
      // They are real signal and worth burning down — just not as a
      // precondition for every commit.

      // Mostly static marketing lists (Landing, VaultCoin). Keys matter for
      // lists that reorder or are keyed by identity; add them there first.
      'svelte/require-each-key': 'warn',
      // Heuristic ("Possibly it may occur…") against code that demonstrably
      // works. Investigate before acting on any individual report.
      'svelte/infinite-reactive-loop': 'warn',
      // Suggests Svelte 5's SvelteMap/SvelteSet. This codebase uses Svelte 4
      // style `$:` and holds these Maps in stores, not in reactive template
      // state, so converting buys nothing today.
      'svelte/prefer-svelte-reactivity': 'warn',
    },
  },
  {
    // MessageBubble renders decrypted peer content through {@html}. That is
    // safe here and deliberately so: parseMarkdown() escapes & < > " ' BEFORE
    // applying any markup, and the autolink regex only matches https?:// so
    // no javascript: URL can be produced. Do not relax either property.
    files: ['src/components/MessageBubble.svelte', 'src/components/VaultCoin.svelte'],
    rules: { 'svelte/no-at-html-tags': 'off' },
  },
  {
    files: ['test/**/*.js', 'vitest.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
