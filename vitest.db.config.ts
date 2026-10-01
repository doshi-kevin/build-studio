// Vitest config for the row-level-security suite — the only tests that run against a real
// Postgres. Separate from vitest.config.ts because these need a running local Supabase, which
// makes them a LOCAL pre-merge gate (`npm run test:db`) rather than part of the hermetic suite
// that gates every PR.
//
// Differences from the main config that matter:
//   - node environment, not jsdom: there is no DOM here, and jsdom's fetch interferes with
//     supabase-js.
//   - singleFork: the tests share one seeded two-tenant fixture and assert on row visibility.
//     Running them in parallel across workers would let one file's writes change another's
//     answer, which is exactly the kind of flake that makes people stop trusting a suite.
//   - a long hook timeout: the first run builds the whole fixture.
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/db/**/*.test.ts'],
    setupFiles: ['./src/__tests__/db/setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './src/__tests__/stubs/server-only.ts'),
    },
  },
})
