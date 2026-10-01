import 'server-only'

import type { BackgroundPipeline } from '../types'

/**
 * A trivial pipeline used ONLY to verify the background-jobs foundation
 * (unit tests + local E2E). Registered by the registry only when
 * NODE_ENV !== 'production', so it never ships a test vector to prod.
 *
 * It reports two discrete progress transitions (start → done) and echoes
 * its params back as a compact result — enough to exercise claim → run →
 * progress → completion end to end.
 */
export const testNoopPipeline: BackgroundPipeline = {
  type: 'test-noop',
  async run(params, ctx) {
    const startedAt = new Date().toISOString()
    await ctx.reportProgress({ label: 'step-1', status: 'running', startedAt })
    await ctx.reportProgress({ label: 'step-1', status: 'done', startedAt })
    return {
      result: { echoed: params },
      summary: 'test-noop completed',
    }
  },
}
