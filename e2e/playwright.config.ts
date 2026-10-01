// Playwright config for Scholera E2E tests. Runs against a local Next.js
// dev server on :3000 and a local Supabase on 127.0.0.1:54321. Global
// setup runs the seed via db:seed:e2e, then logs each role in once and
// persists storageState per role under e2e/.auth/.

import { defineConfig, devices } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

// Load .env.test so baseURL + Supabase env are available both to the test
// process AND to the spawned Next.js dev server.
const envPath = path.resolve(__dirname, '..', '.env.test')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests',
  // 90s per test accommodates Next.js dev-server on-demand compilation for
  // routes hit for the first time in a session (attempt/results pages can
  // take 15-20s on cold compile). Prod bundles resolve this instantly.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx dotenv -e .env.test -- npm run dev',
    cwd: path.resolve(__dirname, '..'),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  globalSetup: require.resolve('./global-setup.ts'),
})
