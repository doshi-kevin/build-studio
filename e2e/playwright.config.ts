// Playwright config for Scholera E2E tests. Runs against a guarded production build
// (e2e/serve-guarded.mjs) on :3000 and a local Supabase on 127.0.0.1:54321. Global
// setup runs the seed via db:seed:e2e, then logs each role in once and
// persists storageState per role under e2e/.auth/.
//
// .env.test is required: without it this refuses to run rather than let anything fall
// back to .env, which holds production credentials. Its Supabase URL must be loopback.

import { defineConfig, devices } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const envPath = path.resolve(__dirname, '..', '.env.test')
if (!fs.existsSync(envPath)) {
  throw new Error('E2E refused: .env.test is missing. Create it with local Supabase values; .env is never used for tests.')
}
const testEnv: Record<string, string> = {}
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) testEnv[m[1]] = m[2]
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(testEnv.NEXT_PUBLIC_SUPABASE_URL ?? '')) {
  throw new Error('E2E refused: NEXT_PUBLIC_SUPABASE_URL in .env.test is not a loopback URL.')
}
// The test process (seeding, logins) reads these; .env.test wins over anything inherited.
Object.assign(process.env, testEnv)
// The server gets only what serve-guarded.mjs allows, passed by name as E2E_<NAME>.
const serverEnv = Object.fromEntries(Object.entries(testEnv).map(([k, v]) => [`E2E_${k}`, v]))

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests',
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
    command: 'node e2e/serve-guarded.mjs',
    cwd: path.resolve(__dirname, '..'),
    env: serverEnv,
    url: baseURL,
    // Never reuse a server this config didn't start: it may have loaded .env.
    reuseExistingServer: false,
    // A cold production build.
    timeout: 900_000,
  },
  globalSetup: require.resolve('./global-setup.ts'),
})
