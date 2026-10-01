// Browser isolation tests for the Studio plugin runtime. Runs against harness.mjs, not the
// app, so it needs no database or login: `npx playwright test --config=e2e/studio-runtime/playwright.config.ts`.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4310' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node harness.mjs',
    url: 'http://localhost:4310/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
