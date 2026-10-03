import 'server-only'

import type { BackgroundPipeline } from './types'
import { testNoopPipeline } from './pipelines/test-noop'
import { outcomeAlignmentPipeline } from './pipelines/outcome-alignment'
import { renderScheduledDeckPipeline } from './pipelines/render-scheduled-deck'
import { embedMaterialPipeline } from './pipelines/embed-material'
import { nodeCheckPoolPipeline } from './pipelines/node-check-pool'
import { regenerateStudentInsightsPipeline } from './pipelines/regenerate-student-insights'
import { builderSlicePipeline } from '@/lib/studio/builder/harness'
import { validatorRevalidatePipeline, validatorRuntimePipeline } from '@/lib/studio/validator/pipelines'

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

/** Every registered pipeline, for the drain's time-budget filter. */
export function listPipelines(): BackgroundPipeline[] {
  return [...pipelines.values()]
}

// ── Built-in registrations ─────────────────────────────────────
registerPipeline(outcomeAlignmentPipeline)
registerPipeline(renderScheduledDeckPipeline)
registerPipeline(embedMaterialPipeline)
registerPipeline(nodeCheckPoolPipeline)
registerPipeline(regenerateStudentInsightsPipeline)
// Studio builder runs, one checkpointed slice per job. Not in AI_FEATURE_BY_JOB_TYPE:
// the harness checks the studio-builder switch itself before every model call, and
// that map's skip would mark the slice failed without letting the run end cleanly.
registerPipeline(builderSlicePipeline)
// Studio validator: cloud Stage 2 dispatch (its upkeep collects finished executions) and
// per-institution revalidation after the minimum ruleset is raised.
registerPipeline(validatorRuntimePipeline)
registerPipeline(validatorRevalidatePipeline)

// The test-noop pipeline is registered ONLY outside production so unit tests
// and local E2E can drive a real job through the worker without shipping a
// test vector to prod.
if (process.env.NODE_ENV !== 'production') {
  registerPipeline(testNoopPipeline)
}
