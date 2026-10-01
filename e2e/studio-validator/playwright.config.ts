// Stage 2 validator runner tests. The runner launches its own Chromium, so these tests use
// no page fixture, app server or database: `npm run e2e:studio-validator`.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
})
