/**
 * The shapes the builder keeps in its run row: the private working copy, the plan, and
 * the result written when a run ends. Pure.
 */
import { z } from 'zod'
import type { StudioManifestV2 } from '../manifest'
import type { KitImportName } from '../kit/plugin-kit-types'
import { STUDIO_BUILDER_PLAN_MAX_BYTES } from '../limits'
import type { BuilderFinding, CheckSummary } from './checks'
import { emptyMaterial, type WorkMaterial } from './course-material'
import { AVAILABLE_CAPABILITIES, type DeltaItem } from './manifest-delta'
import { PLUGIN_PATHS, type PluginPath, characterProblem, utf8Bytes } from './paths'

export interface LastCheck {
  work_hash: string
  passed: boolean
  findings: BuilderFinding[]
  total: number
  summary: CheckSummary
}

/** The run's private copy of the draft. Nothing outside the run sees it until commit. */
export interface Work {
  /** +1 per applied change; the database refuses a write against a stale revision. */
  work_rev: number
  manifest: StudioManifestV2 | null
  files: Partial<Record<PluginPath, string>>
  /** Views whose text the model sees: read, written or edited in this run. */
  working_set: PluginPath[]
  /** Views written in this run (the plan gate counts them). */
  changed: PluginPath[]
  /** Kit names the model looked up, newest last. */
  kit_refs: KitImportName[]
  last_check: LastCheck | null
  /** Per blocking finding key (check|file): how many consecutive failed checks have had it. */
  streaks: Record<string, number>
  /** Manifest changes so far, for the result card. */
  delta: { approved: DeltaItem[]; declined: DeltaItem[]; direct: DeltaItem[] }
  /** Course-material searches (keys only) and the scheduled sources they showed. */
  material: WorkMaterial
  /** Synthetic records the preview and the design review show (write_sample_data). Null: the
   * preview bridge's generated placeholders. */
  sample: SampleData | null
  /** Design reviews this run (at most STUDIO_BUILDER_MAX_REVIEW_ROUNDS) and the latest one. */
  review: {
    rounds: number
    last: ReviewRecord | null
    /** The model turn count when the latest review sent the builder back to improve. */
    improveFromTurn?: number | null
    /** The builder's finish note from before that review, kept for a build the harness settles. */
    summary?: string | null
    /** The draft the latest review saw: it passed every check and rendered without crashing. */
    good?: { manifest: StudioManifestV2; files: Partial<Record<PluginPath, string>>; sample: SampleData | null } | null
  }
  /** What educational product this build is for (Step 12B). Null when the run has none, which
   * is every run until something fills it; nothing reads it yet. */
  product_intelligence: ProductIntelligence | null
}

/** Per collection, the records the preview shows. `student` indexes the synthetic roster
 * (preview-roster.ts); it is set exactly for perStudent and staffPerStudent collections. */
export type SampleData = Record<string, { student?: number; data: Record<string, unknown> }[]>

/** One design review: the model's findings as data, fenced when shown back. */
export interface ReviewRecord {
  round: number
  /** The working copy the review looked at. */
  work_hash: string
  verdict: 'ready' | 'improve'
  /** Whether screenshots were part of it, or the code alone. */
  rendered: boolean
  unmet_requirements: string[]
  major_issues: string[]
  minor_issues: string[]
}

export function initialWork(
  base: { manifest: StudioManifestV2 | null; files: Partial<Record<PluginPath, string>>; sample?: SampleData | null } | null,
): Work {
  return {
    work_rev: 0,
    manifest: base?.manifest ?? null,
    files: { ...(base?.files ?? {}) },
    working_set: [],
    changed: [],
    kit_refs: [],
    last_check: null,
    streaks: {},
    delta: { approved: [], declined: [], direct: [] },
    material: emptyMaterial(),
    sample: base?.sample ?? null,
    review: { rounds: 0, last: null },
    product_intelligence: null,
  }
}

const prose = (max: number) =>
  z.string().min(1).max(max).refine((s) => characterProblem(s) === null, 'contains a control or bidirectional character')

const items = (maxItems: number, maxChars: number) => z.array(prose(maxChars)).max(maxItems)

const planFields = {
  goal: prose(500),
  files_to_change: z.array(z.enum(PLUGIN_PATHS)).min(1).max(2),
  manifest_changes: z.array(prose(200)).max(10),
  capabilities_needed: z.array(z.enum(AVAILABLE_CAPABILITIES as [string, ...string[]])).max(10),
  checks: z.array(prose(200)).max(5),
}

/** submit_plan's arguments: professor-safe engineering intent, never reasoning. */
export const planSchema = z
  .strictObject({
    ...planFields,
    professor_view: items(10, 240),
    student_view: items(10, 240),
    data: items(8, 300),
    requirements: z.array(prose(300)).min(1).max(12),
    enhancements: items(6, 240),
  })
  .refine((p) => utf8Bytes(JSON.stringify(p)) <= STUDIO_BUILDER_PLAN_MAX_BYTES, 'The plan is too long')

/** A plan saved before plan v2 has none of the view, data or requirement lists. */
const legacyPlanSchema = z.strictObject(planFields)

/** A stored plan, either shape; a legacy one reads with empty lists. Null when neither parses. */
export function readPlan(raw: unknown): Plan | null {
  const current = planSchema.safeParse(raw)
  if (current.success) return current.data
  const legacy = legacyPlanSchema.safeParse(raw)
  return legacy.success ? { ...legacy.data, professor_view: [], student_view: [], data: [], requirements: [], enhancements: [] } : null
}

export type Plan = z.infer<typeof planSchema>

export const PRODUCT_INTELLIGENCE_FORMAT = 'studio-product-intelligence-v1'

/** Kept small beside the files in the run row's 256 KiB working copy. Here rather than in
 * limits.ts, which the check worker bundles whole. */
export const PRODUCT_INTELLIGENCE_MAX_BYTES = 24 * 1024

/** The primary way a concept teaches. Closed on purpose: three concepts that share one are
 * the same idea in different layouts (ideation.ts refuses them). */
export const LEARNING_MECHANICS = [
  'predict_commit_reveal', 'simulation_what_if', 'diagnosis', 'staged_case', 'debugging', 'branching_decision',
  'reverse_reasoning', 'experiment_design', 'misconception_mapping', 'compare_contrast', 'scenario_stress_test',
  'mastery_repetition', 'argument_evidence',
] as const

/** One candidate educational product from divergent ideation (Step 12B.2). */
export const conceptSchema = z.strictObject({
  name: prose(80),
  mechanic: z.enum(LEARNING_MECHANICS),
  idea: prose(300),
  learningMechanic: prose(300),
  studentLoop: prose(300),
  professorValue: prose(250),
  dataProduced: prose(250),
  domainSpecificity: prose(250),
  whyBetterThanGenericLMS: prose(250),
  feasibility: z.enum(['feasible', 'adapted', 'infeasible']),
  /** What the tool leaves out or what the professor must supply; "None." when nothing. */
  limitations: prose(250),
})

export type Concept = z.infer<typeof conceptSchema>

/** The provider call(s) behind a stage, with their cost. */
const modelRecordSchema = z.strictObject({
  provider: z.literal('anthropic'),
  id: prose(60),
  calls: z.number().int().min(1).max(2),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
})

export type ModelRecord = z.infer<typeof modelRecordSchema>

/** What ideation produced and what it cost, kept with the artifact. */
export const ideationSchema = z.strictObject({
  candidates: z.array(conceptSchema).length(3),
  selectedIndex: z.number().int().min(0).max(2),
  selectionRationale: prose(600),
  /** Whether the first set failed the divergence or platform checks and was regenerated once. */
  repaired: z.boolean(),
  model: modelRecordSchema,
})

export type Ideation = z.infer<typeof ideationSchema>

/** The Product Specification (Step 12B.3): the selected concept elaborated into how the
 * product works, for the builder to implement. Behaviour and intent only: no code, no manifest. */
export const specificationSchema = z.strictObject({
  productGoal: prose(300),
  /** Must equal the selected concept's mechanic. */
  mechanic: z.enum(LEARNING_MECHANICS),
  /** Ordered steps, each naming what the student does: "Predict: ...", "Reveal: ...". */
  learningLoop: z.array(prose(200)).min(3).max(8),
  professorWorkflow: z.strictObject({ setup: prose(260), contentCreation: prose(260), running: prose(260), interpreting: prose(260) }),
  studentWorkflow: z.array(prose(180)).min(3).max(8),
  states: z.array(z.strictObject({ name: prose(30), meaning: prose(140) })).min(1).max(7),
  contentStrategy: z.strictObject({
    /** Fixed scenarios, cases, questions, benchmarks: records the professor writes. */
    professorAuthored: z.array(prose(180)).max(5),
    /** Items or outcomes computed in code from formulas and random parameters. */
    generated: z.array(prose(180)).max(5),
  }),
  computation: z.array(prose(300)).max(6),
  professorInsight: z.array(prose(180)).min(1).max(5),
  dataModel: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][A-Za-z0-9]{1,39}$/, 'a camelCase collection name'),
    access: z.enum(['perStudent', 'staffPerStudent', 'shared', 'staffOnly']),
    purpose: prose(160),
    /** Who creates its records. */
    writtenBy: z.enum(['professor', 'student', 'both']),
  })).max(6),
  relationships: z.array(prose(160)).max(4),
  primaryInteractions: z.array(prose(150)).min(2).max(6),
  edgeStates: z.array(prose(200)).max(6),
  limitations: z.array(prose(180)).max(5),
  model: modelRecordSchema,
})

export type Specification = z.infer<typeof specificationSchema>

/**
 * The Product Intelligence artifact (Step 12B): what educational product a build is for,
 * decided before any code. `direct_build` is a request that already names the tool;
 * `teaching_problem` describes a problem and leaves the product to Studio. A field nobody
 * knows yet is null or an empty list. Separate from submit_plan, which stays the builder's
 * engineering intent.
 */
export const productIntelligenceSchema = z
  .strictObject({
    format: z.literal(PRODUCT_INTELLIGENCE_FORMAT),
    requestType: z.enum(['direct_build', 'teaching_problem']),
    teachingProblem: prose(600).nullable(),
    domainContext: prose(600).nullable(),
    studentDifficulty: prose(600).nullable(),
    professorGoal: prose(400).nullable(),
    studentGoal: prose(400).nullable(),
    platformConstraints: items(8, 240),
    selectedConcept: z.strictObject({ title: prose(120), summary: prose(600) }).nullable(),
    learningLoop: items(8, 240),
    professorWorkflow: items(10, 240),
    studentWorkflow: items(10, 240),
    /** Absent on a direct build and on an artifact saved before 12B.2. */
    ideation: ideationSchema.nullable().optional(),
    /** Absent until 12B.3 fills it, and when the specification failed its checks twice. */
    specification: specificationSchema.nullable().optional(),
  })
  .refine((p) => utf8Bytes(JSON.stringify(p)) <= PRODUCT_INTELLIGENCE_MAX_BYTES, 'The product intelligence is too long')

export type ProductIntelligence = z.infer<typeof productIntelligenceSchema>

/** A stored artifact, or null: absent (a run from before Step 12B, or one without it) or no longer valid. */
export function readProductIntelligence(raw: unknown): ProductIntelligence | null {
  if (raw === null || raw === undefined) return null
  const parsed = productIntelligenceSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export type TerminalStatus = 'preview_ready' | 'completed' | 'blocked' | 'cancelled' | 'budget_exhausted' | 'failed'

export const BUDGET_CODES = ['limit_turns', 'limit_tool_calls', 'limit_writes', 'limit_bytes', 'limit_active_time', 'limit_slices', 'limit_cost', 'limit_daily_cost'] as const
export const VALIDATION_CODES = ['repair_rounds', 'same_finding', 'check_runs'] as const
export const BLOCK_CODES = ['agent_blocked', 'draft_changed', 'studio_paused', 'not_entitled', 'ai_disabled', 'access_lost', 'project_archived'] as const
export const FAILURE_CODES = ['repeated_tool_errors', 'model_unavailable', 'check_timeout', 'interrupted', 'internal'] as const

export type BudgetCode = (typeof BUDGET_CODES)[number]
export type ValidationCode = (typeof VALIDATION_CODES)[number]
export type BlockCode = (typeof BLOCK_CODES)[number]
export type FailureCode = (typeof FAILURE_CODES)[number]
export type RunErrorCode = BudgetCode | ValidationCode | BlockCode | FailureCode | 'superseded' | 'expired'

/** What a run produced, written once when it ends. System fields come from the harness;
 * only `goal`, `summary` and `open_questions` are the model's words. */
export interface BuildResult {
  format: 'studio-builder-result-v1'
  status: TerminalStatus
  reason: RunErrorCode | null
  files: { path: PluginPath; bytes_before: number | null; bytes_after: number | null; changed: boolean }[]
  manifest_delta: Work['delta']
  checks: CheckSummary | null
  passed: boolean
  committed: { result_hash: string | null; base_hash: string | null }
  preview: { snapshot_hash: string | null }
  usage: { model_turns: number; tool_calls: number; repair_rounds: number; check_runs: number; cost_usd: number; active_ms: number }
  goal: string | null
  summary: string | null
  open_questions: string[]
  /** How many saved decisions the last prompt carried. Not a claim that they changed the output. */
  memory_applied: number
  /** Course material the builder read, by label; `opens_at` set when students can't see it yet. At most 8. */
  material_read: { label: string; visible: boolean; opens_at: string | null }[]
  /** Design reviews run, and whether the last one saw screenshots. */
  review?: { rounds: number; rendered: boolean; verdict: 'ready' | 'improve' | null }
  /** The harness stopped the optional polishing and kept a draft that passes every check. */
  polish_stopped?: boolean
}
