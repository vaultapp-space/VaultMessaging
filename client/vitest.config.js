import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors vite.config.js so tests import the shared modules the same
      // way the app does.
      $shared: fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    // Node 18+ exposes Web Crypto as globalThis.crypto, which is all the
    // crypto modules use — no jsdom or browser environment is needed.
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
