// Vitest configuration for Scholera — unit, integration, and component tests.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // `db/` needs a running local Supabase, so it is its own tier — see vitest.db.config.ts
    // and `npm run test:db`. It must never join the fast suite, which is hermetic by design.
    exclude: ['src/__tests__/e2e/**', 'src/__tests__/db/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      include: [
        'src/lib/**/*.ts',
        'src/app/**/actions.ts',
        'src/components/**/use-*-reducer.ts',
      ],
      exclude: [
        'src/lib/supabase/types.ts',
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
      ],
      thresholds: {
        'src/lib/quiz/scoring.ts': { lines: 95, branches: 90 },
        'src/lib/quiz/analytics-utils.ts': { lines: 95 },
        // CLAUDE.md has named a 100% target for attendance since before this file existed, but
        // named the wrong path (`attendance.ts`, which does not exist), so nothing enforced it
        // and it had drifted to 89.47%. Stated targets that are not thresholds do not hold.
        'src/lib/live-classroom/attendance/actions.ts': { lines: 100, branches: 100 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` throws when bundled for the client; in tests there is no
      // client bundle, so stub it to a no-op (lets tests import the real logic
      // of modules guarded by `import 'server-only'`, e.g. lib/extraction/enqueue).
      'server-only': path.resolve(__dirname, './src/__tests__/stubs/server-only.ts'),
    },
  },
})
