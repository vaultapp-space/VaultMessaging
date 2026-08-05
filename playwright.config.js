import { defineConfig, devices } from '@playwright/test';

// The client dev server runs over HTTPS via @vitejs/plugin-basic-ssl and
// proxies /api and /ws to the backend on 3001, so the whole app is exercised
// through one origin exactly as a browser would see it.
const CLIENT_URL = 'https://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  // Two browser contexts talking to each other through one backend cannot be
  // parallelised safely without more isolation than this suite needs.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: CLIENT_URL,
    // basic-ssl issues a self-signed certificate.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: [
    {
      // A dedicated database so an E2E run never touches development data.
      // Migrations run first: the server now refuses to boot unmigrated.
      command: 'npm run e2e:server',
      cwd: 'server',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: 'client',
      url: CLIENT_URL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
