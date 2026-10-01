import 'server-only'

import type { BackgroundPipeline } from './types'
import { testNoopPipeline } from './pipelines/test-noop'
import { outcomeAlignmentPipeline } from './pipelines/outcome-alignment'
import { renderScheduledDeckPipeline } from './pipelines/render-scheduled-deck'
import { embedMaterialPipeline } from './pipelines/embed-material'
import { nodeCheckPoolPipeline } from './pipelines/node-check-pool'
import { regenerateStudentInsightsPipeline } from './pipelines/regenerate-student-insights'

// The pipeline registry: a static map of job `type` → pipeline. New background
// features register here (Slice 2 adds 'outcome_alignment'). Keeping it a plain
// module-level map is deliberate — dynamic registration isn't needed.
const pipelines = new Map<string, BackgroundPipeline>()

export function registerPipeline(pipeline: BackgroundPipeline): void {
  pipelines.set(pipeline.type, pipeline)
}

export function getPipeline(type: string): BackgroundPipeline | null {
  return pipelines.get(type) ?? null
}

// ── Built-in registrations ─────────────────────────────────────
registerPipeline(outcomeAlignmentPipeline)
registerPipeline(renderScheduledDeckPipeline)
registerPipeline(embedMaterialPipeline)
registerPipeline(nodeCheckPoolPipeline)
registerPipeline(regenerateStudentInsightsPipeline)

// The test-noop pipeline is registered ONLY outside production so unit tests
// and local E2E can drive a real job through the worker without shipping a
// test vector to prod.
if (process.env.NODE_ENV !== 'production') {
  registerPipeline(testNoopPipeline)
}
