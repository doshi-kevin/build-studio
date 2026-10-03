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
