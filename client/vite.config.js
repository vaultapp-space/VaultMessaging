import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    basicSsl(),
    tailwindcss(),
    svelte(),
  ],
  resolve: {
    alias: {
      // Message envelope types are shared with the server rather than
      // duplicated, so the two can never drift out of sync.
      $shared: fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // The Bot API lives at /bot<token>/<method>, outside /api on purpose:
      // it is a separate authentication surface. It needs its own proxy entry
      // or bots hitting the dev server get the SPA's HTML back instead of a
      // response. A production reverse proxy needs the same rule.
      '/bot': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
