// Standalone Playwright config for the student-dashboard to-do emit spec.
//
// Why a separate config: the shared e2e harness (playwright.config.ts) runs a
// globalSetup that seeds via `db:seed:e2e` — which is currently broken against
// the schema (profiles/sections now require institution_id, the seed doesn't set
// it). This config skips globalSetup entirely and drives the flow against the
// LOCAL DEV seed data (professor@scholera.dev + student3@scholera.dev), which is
// already correctly tenanted. Reuses the dev server already running on :3000.
//
// Run:  npx dotenv -e .env.test -- npx playwright test --config=e2e/playwright.todos.config.ts

import { defineConfig, devices } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

// Load .env.test so the spec's admin client + baseURL resolve (same loader the
// main config uses).
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
  testMatch: 'student-todo-emit.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Reuses the dev server you already have on :3000. Only spawns one if none
    // is running (falls back to .env.local via `npm run dev`).
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
