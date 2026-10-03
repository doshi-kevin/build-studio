/**
 * The builder harness: the `studio_builder_slice` background pipeline. One slice claims a
 * run, does bounded work, saves everything it did, and hands off, pauses or ends.
 * Nothing that steers a run lives only in memory: status, working copy, counters, plan,
 * approval card, questions and trajectory are all in the run row and its steps, so a
 * restarted instance, a crashed worker or a provider timeout costs at most one re-asked
 * model turn (docs/reference/studio-agent-harness.md, "Where a build runs").
 *
 * The model proposes; this file decides. Before every model call it checks, fresh: the
 * run is running, this slice still holds it, nobody pressed Stop, the professor still
 * has the section and the project, Studio and the studio-builder AI switch are on, the
 * school is under its daily spend, and every run budget has room. Before each tool it
 * checks Stop and the claim again, and every write goes through a database function that
 * re-checks the claim token, Stop, the working copy's revision and the caps.
 *
 * Every database write carries the slice's claim token. A slice whose claim was taken
 * over (it stalled, the run was re-claimed) has every write refused and exits; its model
 * spend is still recorded against the run.
 */
import 'server-only'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { STUDIO_BUILDER_MODEL } from '@/lib/ai/config'
import { computeCostUsd } from '@/lib/ai/cost'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { recordAiUsage } from '@/lib/ai/usage'
import { kickWorker } from '@/lib/jobs/enqueue'
import type { BackgroundPipeline } from '@/lib/jobs/types'
import { logger } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { studioAccess } from '../access'
import { builderActor } from '../context'
import * as db from '../db'
import {
  STUDIO_BUILDER_CONTEXT_MAX_TOKENS,
  STUDIO_BUILDER_HEARTBEAT_MS,
  STUDIO_BUILDER_HEARTBEAT_STALE_MS,
  STUDIO_BUILDER_HISTORY_RUNS,
  STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD,
  STUDIO_BUILDER_MAX_BYTES_WRITTEN,
  STUDIO_BUILDER_MAX_CHECK_RUNS,
  STUDIO_BUILDER_MAX_CONSECUTIVE_ERRORS,
  STUDIO_BUILDER_MAX_MODEL_TURNS,
  STUDIO_BUILDER_MAX_OUTPUT_TOKENS,
  STUDIO_BUILDER_MAX_QUESTIONS,
  STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
  STUDIO_BUILDER_MAX_RESUMES,
  STUDIO_BUILDER_MAX_SLICES,
  STUDIO_BUILDER_MAX_TOOL_CALLS,
  STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN,
  STUDIO_BUILDER_MAX_WRITES,
  STUDIO_BUILDER_MODEL_CALL_TIMEOUT_MS,
  STUDIO_BUILDER_RUN_MAX_ACTIVE_MS,
  STUDIO_BUILDER_RUN_MAX_COST_USD,
  STUDIO_BUILDER_SLICE_CUSHION_MS,
  STUDIO_BUILDER_SLICE_MAX_MS,
  STUDIO_BUILDER_SLICE_MIN_BUDGET_MS,
  STUDIO_BUILDER_SWEEP_LIMIT,
  STUDIO_BUILDER_WAITING_TTL_MS,
  STUDIO_MATERIAL_SOURCES_MAX,
  STUDIO_MEMORY_EXPIRE_LIMIT,
  STUDIO_MEMORY_MAX_ACTIVE,
  STUDIO_MEMORY_PROPOSAL_TTL_MS,
  STUDIO_MEMORY_PROPOSALS_PER_RUN,
} from '../limits'
import { parseManifest, type StudioManifest, type StudioManifestV2 } from '../manifest'
import { runDraftChecks, type DraftCheckResult } from './checks'
import { runWorkerCheck } from './check-worker'
import { buildTurnContext, skillsWanted, type HistoryEntry, type StepView } from './context-builder'
import { emptyMaterial, provenanceEntries, withSources, type MaterialFocus, type MaterialSearch, type MaterialSourceEntry, type RenderedSearch } from './course-material'
import { loadGuardSources, postgresRetriever, retrievalScope, type SearchOutcome } from './course-retriever'
import { professorTextsOf, type ProjectMemory } from './memory'
import { createGeminiModel, BuilderAbort, ModelUnavailable, type AgentModel, type ModelUsage } from './model'
import { PLUGIN_PATHS, utf8Bytes, type PluginPath } from './paths'
import { snapshotHash, workHash } from './snapshot'
import {
  checkStep,
  isToolName,
  MEMORY_REFUSALS,
  orderCalls,
  planGate,
  REFUSAL_HINTS,
  TOOLS,
  toolDeclarations,
  type Delta,
  type RefusalCode,
  type Summary,
  type ToolOutcome,
  type ToolState,
} from './tools'
import { initialWork, planSchema, type BuildResult, type Plan, type RunErrorCode, type TerminalStatus, type Work } from './work'

export const BUILDER_JOB_TYPE = 'studio_builder_slice'
export const BUILDER_LEDGER_FEATURE = 'studio_builder'

/** The worst a single next call can cost: a full prompt and a full reply at Pro rates. */
export const WORST_CASE_CALL_USD = computeCostUsd(STUDIO_BUILDER_MODEL, {
  inputTokens: STUDIO_BUILDER_CONTEXT_MAX_TOKENS,
  outputTokens: STUDIO_BUILDER_MAX_OUTPUT_TOKENS,
})

const CAPS = {
  tool_calls: STUDIO_BUILDER_MAX_TOOL_CALLS,
  writes: STUDIO_BUILDER_MAX_WRITES,
  bytes_written: STUDIO_BUILDER_MAX_BYTES_WRITTEN,
  check_runs: STUDIO_BUILDER_MAX_CHECK_RUNS,
  repair_rounds: STUDIO_BUILDER_MAX_REPAIR_ROUNDS,
  questions: STUDIO_BUILDER_MAX_QUESTIONS,
}

export type GateRefusal = 'studio_paused' | 'not_entitled' | 'ai_disabled' | 'access_lost' | 'project_archived' | 'limit_daily_cost'

export interface SliceData {
  slug: string
  published: StudioManifest | null
  publishedVersions: string[]
  base: { manifest: StudioManifestV2 | null; files: Partial<Record<PluginPath, string>> } | null
  course: { code: string; title: string } | null
  skills: string[] | null
  history: HistoryEntry[]
  /** Scheduled course sources earlier builds of the project showed the model (keys only). */
  materialSources: MaterialSourceEntry[]
}

type Outcome = Record<string, unknown> | null

/** The database, as the harness uses it. Real: db.builderRpcs. Tests: an in-memory store with the same rules. */
export interface RunStore {
  claim(runId: string, jobId: string, sliceNo: number): Promise<string | null>
  heartbeat(runId: string, token: string): Promise<{ fenceLost: boolean; cancelRequested: boolean }>
  loadRun(runId: string): Promise<db.BuilderRunRow | null>
  loadSteps(runId: string): Promise<StepView[] | null>
  addCost(runId: string, usage: { input: number; cached: number; output: number; costUsd: number }): Promise<void>
  recordTurn(runId: string, token: string, step: Record<string, unknown>, activeMs: number, refused: boolean): Promise<Outcome>
  apply(args: db.ApplyArgs): Promise<Outcome>
  pause(args: db.PauseArgs): Promise<Outcome>
  handoff(runId: string, token: string, activeMs: number): Promise<Outcome>
  end(args: db.EndArgs): Promise<Outcome>
  /** Records one memory proposal and its step, inert, behind the claim fence. */
  proposeMemory(args: db.ProposeMemoryArgs): Promise<Outcome>
}

export interface HarnessDeps {
  store: RunStore
  model: AgentModel
  loadSliceData(run: db.BuilderRunRow): Promise<SliceData | null>
  /** The project's active saved decisions. A failure (a throw or null) means none: a build never depends on memory. */
  loadMemories(run: db.BuilderRunRow): Promise<ProjectMemory[] | null>
  /** Everything outside the run that can stop it before a model call. */
  gate(run: db.BuilderRunRow): Promise<GateRefusal | null>
  runChecks(run: db.BuilderRunRow, data: SliceData, work: Work): Promise<DraftCheckResult>
  /** search_course_material, scoped from the run row. { ok: false } when the course can't be read. */
  searchMaterial(run: db.BuilderRunRow, query: string, focus: MaterialFocus | null): Promise<SearchOutcome>
  /** The run's searches re-read for this turn. Null when they can't be: the build goes on without them. */
  rehydrateMaterial(run: db.BuilderRunRow, searches: readonly MaterialSearch[]): Promise<RenderedSearch[] | null>
  recordUsage(run: db.BuilderRunRow, usage: ModelUsage, modelId: string, turn: number): Promise<void>
  /** A milestone for the audit trail: ids and counters only. */
  audit(run: db.BuilderRunRow, event: string, metadata: Record<string, string | number>): void
  kick(jobId: string): Promise<unknown> | void
  now(): number
  heartbeatMs: number
}

const paramsSchema = z.strictObject({ runId: z.uuid(), sliceNo: z.number().int().min(1) })

/** Budgets the harness checks before every model call, in order. */
export function budgetStop(
  c: db.BuilderRunRow['counters'],
): { status: TerminalStatus; code: RunErrorCode } | null {
  if (c.consecutiveErrors >= STUDIO_BUILDER_MAX_CONSECUTIVE_ERRORS) return { status: 'failed', code: 'repeated_tool_errors' }
  if (c.modelTurns >= STUDIO_BUILDER_MAX_MODEL_TURNS) return { status: 'budget_exhausted', code: 'limit_turns' }
  if (c.toolCalls >= STUDIO_BUILDER_MAX_TOOL_CALLS) return { status: 'budget_exhausted', code: 'limit_tool_calls' }
  if (c.writes >= STUDIO_BUILDER_MAX_WRITES) return { status: 'budget_exhausted', code: 'limit_writes' }
  if (c.bytesWritten >= STUDIO_BUILDER_MAX_BYTES_WRITTEN) return { status: 'budget_exhausted', code: 'limit_bytes' }
  if (c.activeMs >= STUDIO_BUILDER_RUN_MAX_ACTIVE_MS) return { status: 'budget_exhausted', code: 'limit_active_time' }
  if (c.costUsd + WORST_CASE_CALL_USD > STUDIO_BUILDER_RUN_MAX_COST_USD) return { status: 'budget_exhausted', code: 'limit_cost' }
  return null
}

const nonce = () => randomBytes(6).toString('hex')

function parseWork(raw: Record<string, unknown> | null): Work | null {
  if (!raw || typeof raw !== 'object') return null
  const manifest = raw.manifest ? parseManifest(raw.manifest) : null
  const material = raw.material as Work['material'] | undefined
  return {
    ...initialWork(null),
    ...(raw as unknown as Work),
    manifest: manifest?.ok && manifest.manifest.manifestVersion === 2 ? manifest.manifest : null,
    // Runs from before Step 9 have no material.
    material:
      material && Array.isArray(material.searches) && Array.isArray(material.sources)
        ? { ...emptyMaterial(), ...material, attempts: Number.isInteger(material.attempts) ? material.attempts : material.searches.length, unavailable: material.unavailable === true }
        : emptyMaterial(),
  }
}

function parsePlan(raw: Record<string, unknown> | null): Plan | null {
  const parsed = raw ? planSchema.safeParse(raw) : null
  return parsed?.success ? parsed.data : null
}

function buildResult(
  run: db.BuilderRunRow,
  data: SliceData | null,
  work: Work | null,
  plan: Plan | null,
  status: TerminalStatus,
  reason: RunErrorCode | null,
  extra: { summary?: string; openQuestions?: string[]; snapshotHash?: string | null; passed?: boolean; memoryApplied?: number; material?: RenderedSearch[] },
): BuildResult {
  const files = PLUGIN_PATHS.map((path) => {
    const before = data?.base?.files[path]
    const after = work?.files[path]
    return {
      path,
      bytes_before: typeof before === 'string' ? utf8Bytes(before) : null,
      bytes_after: typeof after === 'string' ? utf8Bytes(after) : null,
      changed: before !== after && after !== undefined,
    }
  })
  const result: BuildResult = {
    format: 'studio-builder-result-v1',
    status,
    reason,
    files,
    manifest_delta: work?.delta ?? { approved: [], declined: [], direct: [] },
    checks: work?.last_check?.summary ?? null,
    passed: extra.passed ?? false,
    committed: { result_hash: extra.snapshotHash ?? null, base_hash: run.baseHash },
    preview: { snapshot_hash: extra.snapshotHash ?? (status === 'completed' ? run.baseHash : null) },
    usage: {
      model_turns: run.counters.modelTurns,
      tool_calls: run.counters.toolCalls,
      repair_rounds: run.counters.repairRounds,
      check_runs: run.counters.checkRuns,
      cost_usd: run.counters.costUsd,
      active_ms: run.counters.activeMs,
    },
    goal: plan?.goal ?? null,
    summary: extra.summary ?? null,
    open_questions: extra.openQuestions ?? [],
    memory_applied: extra.memoryApplied ?? 0,
    material_read: materialRead(extra.material ?? []),
  }
  // The database refuses a result over 8 KiB (jsonb's text form adds a space after each
  // separator, so the margin is generous); trim the listed items, then the model's prose,
  // never the system fields.
  while (utf8Bytes(JSON.stringify(result)) > 7000) {
    const d = result.manifest_delta
    if (d.direct.length > 0) d.direct.pop()
    else if (d.approved.length > 0) d.approved.pop()
    else if (d.declined.length > 0) d.declined.pop()
    else if (result.checks && result.checks.unresolved.length > 0) result.checks.unresolved.pop()
    else if (result.checks && result.checks.warnings.length > 0) result.checks.warnings.pop()
    else if (result.open_questions.length > 0) result.open_questions.pop()
    else if (result.material_read.length > 0) result.material_read.pop()
    else if (result.summary && result.summary.length > 0) result.summary = cutBytes(result.summary, Math.floor(utf8Bytes(result.summary) / 2))
    else if (result.goal && result.goal.length > 0) result.goal = cutBytes(result.goal, Math.floor(utf8Bytes(result.goal) / 2))
    else break
  }
  return result
}

/** The ending card's list of what the builder read: one line per source, labels only, what
 * students can't see yet first, at most 8. */
function materialRead(searches: readonly RenderedSearch[]): BuildResult['material_read'] {
  const seen = new Map<string, BuildResult['material_read'][number]>()
  for (const s of searches) {
    for (const e of s.shown) {
      if (!seen.has(e.label)) seen.set(e.label, { label: e.label, visible: e.disclosure === 'released', opens_at: e.disclosure === 'released' ? null : e.opensAt })
    }
  }
  return [...seen.values()].sort((a, b) => Number(a.visible) - Number(b.visible)).slice(0, 8)
}

/** At most `max` UTF-8 bytes of text, cut between whole characters. */
function cutBytes(text: string, max: number): string {
  let chars = Array.from(text)
  while (chars.length > 0 && utf8Bytes(chars.join('')) > max) chars = chars.slice(0, Math.floor(chars.length * 0.9))
  return chars.join('')
}

const step = (
  kind: 'tool' | 'check' | 'system' | 'model_turn',
  toolCallId: string,
  status: 'done' | 'refused' | 'error' | 'interrupted',
  label: string,
  extra: { tool?: string | null; args?: Summary; result?: Summary; ms?: number; input_tokens?: number; output_tokens?: number; cost_usd?: number } = {},
): Record<string, unknown> => ({
  kind,
  tool: extra.tool ?? null,
  tool_call_id: toolCallId,
  status,
  label,
  args_summary: extra.args ?? {},
  result_summary: extra.result ?? {},
  ms: Math.max(0, Math.round(extra.ms ?? 0)),
  ...(extra.input_tokens !== undefined ? { input_tokens: extra.input_tokens, output_tokens: extra.output_tokens, cost_usd: extra.cost_usd } : {}),
})

/** One slice of one run. Never throws for a run outcome: the run's own state records it. */
export async function runBuilderSlice(rawParams: Record<string, unknown>, job: { id: string; deadline?: number }, deps: HarnessDeps): Promise<string> {
  const params = paramsSchema.safeParse(rawParams)
  if (!params.success) return 'invalid params'
  const { runId, sliceNo } = params.data
  const claimed = await deps.store.claim(runId, job.id, sliceNo)
  if (!claimed) return 'not claimed'
  const token: string = claimed

  const sliceStart = deps.now()
  const deadline = Math.min(job.deadline ?? Number.POSITIVE_INFINITY, sliceStart + STUDIO_BUILDER_SLICE_MAX_MS)
  const controller = new AbortController()
  const flags = { fenceLost: false, cancel: false }
  const heartbeat = setInterval(() => {
    void deps.store.heartbeat(runId, token).then(
      (h) => {
        if (h.fenceLost) flags.fenceLost = true
        if (h.cancelRequested) flags.cancel = true
        if (flags.fenceLost || flags.cancel) controller.abort()
      },
      () => undefined,
    )
  }, deps.heartbeatMs)

  let data: SliceData | null = null
  let tokenRatio = 1
  // Saved decisions: read once per slice, never fatal. `memoryAliases` holds only the labels the
  // latest prompt showed; `memoryApplied` is how many that was; `memoryProposals` counts this run's.
  let memories: ProjectMemory[] = []
  let memoryAliases: Record<string, { id: string; topic: ProjectMemory['topic']; slot: ProjectMemory['slot'] }> = {}
  let memoryApplied = 0
  let memoryProposals = 0
  // The latest re-read of this run's course searches, for the prompt and the ending card.
  let lastMaterial: RenderedSearch[] = []
  let activeSince = deps.now()
  // Time spent since the last write that carried it, for active-time accounting.
  const takeActive = () => {
    const now = deps.now()
    const ms = Math.max(0, now - activeSince)
    activeSince = now
    return Math.round(ms)
  }

  const end = async (
    run: db.BuilderRunRow,
    work: Work | null,
    plan: Plan | null,
    status: TerminalStatus,
    code: RunErrorCode | null,
    extra: Parameters<typeof buildResult>[6] & { snapshot?: Record<string, unknown> | null } = {},
  ): Promise<'stop'> => {
    // Fresh counters for the result: this turn's calls have moved them.
    const latest = (await deps.store.loadRun(runId)) ?? run
    // Course material is listed only from a re-read this slice made after its gate passed: an
    // ending before that (a lost section, Stop) reads nothing more from the course.
    const result = buildResult(latest, data, work, plan, status, code, { ...extra, memoryApplied, material: lastMaterial })
    const outcome = await deps.store.end({
      runId, token, status, errorCode: code, result: result as unknown as Record<string, unknown>,
      snapshot: extra.snapshot ?? null, activeMs: takeActive(),
    })
    const final = outcome?.outcome === 'cancelled' ? 'cancelled' : outcome?.outcome === 'conflict' ? 'blocked' : status
    if (outcome && outcome.outcome !== 'fence') {
      deps.audit(run, final === 'preview_ready' ? 'studio.build.preview_ready' : final === 'cancelled' ? 'studio.build.stopped' : 'studio.build.ended', {
        runId, status: final, errorCode: (outcome.outcome === 'conflict' ? 'draft_changed' : code) ?? 'none',
        modelTurns: latest.counters.modelTurns, toolCalls: latest.counters.toolCalls,
      })
      logger.info('studio.builder.end', { runId, status: final, errorCode: code, modelTurns: latest.counters.modelTurns, costUsd: latest.counters.costUsd })
    }
    return 'stop'
  }

  try {
    let run = await deps.store.loadRun(runId)
    if (!run || run.status !== 'running') return 'not running'
    data = await deps.loadSliceData(run)
    if (!data) return await end(run, null, null, 'failed', 'internal')
    try {
      memories = (await deps.loadMemories(run)) ?? []
    } catch (error) {
      memories = []
      logger.warn('studio.builder.memory: unreadable, building without saved decisions', { runId, name: error instanceof Error ? error.name : 'unknown' })
    }

    // The first slice persists the working copy, seeded from the draft it started on.
    if (!run.work) {
      const seeded = await deps.store.apply({
        runId, token, step: step('system', 'sys:work', 'done', 'run.slice', { args: { event: 'work_initialised' } }),
        expectedWorkRev: -1, work: initialWork(data.base) as unknown as Record<string, unknown>, plan: null, phase: null,
        delta: {}, caps: CAPS, activeMs: 0,
      })
      if (!seeded?.ok) return seeded?.reason === 'cancelled' ? await end(run, null, null, 'cancelled', null) : 'fence lost'
    }

    // Resume: calls a turn proposed but never recorded were never run. Mark them.
    const steps0 = (await deps.store.loadSteps(runId)) ?? []
    const lastTurn = [...steps0].reverse().find((s) => s.kind === 'model_turn')
    let resumed = run.resumeCount > 0
    if (lastTurn && lastTurn.status === 'done') {
      const recorded = new Set(steps0.map((s) => s.toolCallId))
      const count = Math.min(Number(lastTurn.argsSummary.count ?? 0), STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN)
      for (let i = 0; i < count; i++) {
        const id = `${lastTurn.seq}.${i}`
        if (recorded.has(id)) continue
        resumed = true
        await deps.store.apply({
          runId, token, step: step('tool', id, 'interrupted', 'step.interrupted', { args: { call: id } }),
          expectedWorkRev: 0, work: null, plan: null, phase: null, delta: {}, caps: CAPS, activeMs: 0,
        })
      }
    }

    for (;;) {
      if (deps.now() >= deadline - STUDIO_BUILDER_SLICE_CUSHION_MS) {
        const h = await deps.store.handoff(runId, token, takeActive())
        if (h?.outcome === 'cancelled') {
          const latest = await deps.store.loadRun(runId)
          if (latest) return await end(latest, parseWork(latest.work), parsePlan(latest.plan), 'cancelled', null)
        }
        if (h?.outcome === 'queued' && typeof h.job_id === 'string') await deps.kick(h.job_id)
        logger.info('studio.builder.handoff', { runId, sliceNo })
        return 'handed off'
      }
      run = await deps.store.loadRun(runId)
      if (!run || run.status !== 'running' || flags.fenceLost) return 'fence lost'
      let work = parseWork(run.work) ?? initialWork(data.base)
      const plan = parsePlan(run.plan)
      if (run.cancelRequested || flags.cancel) return await end(run, work, plan, 'cancelled', null)

      // ── The combined gate, before every model call ──
      const refusal = await deps.gate(run)
      if (refusal === 'limit_daily_cost') return await end(run, work, plan, 'budget_exhausted', 'limit_daily_cost')
      if (refusal) return await end(run, work, plan, 'blocked', refusal)
      const budget = budgetStop(run.counters)
      if (budget) return await end(run, work, plan, budget.status, budget.code)

      const steps = (await deps.store.loadSteps(runId)) ?? []
      const answers = run.questions.map((q) => ({ question: q.question, answer: q.answer }))
      // Course searches are re-read every turn, so material hidden mid-run leaves the prompt.
      // A failed read is never fatal: the build goes on without it.
      let materialUnavailable = false
      if (work.material.searches.length > 0) {
        const fresh = await deps.rehydrateMaterial(run, work.material.searches).catch(() => null)
        if (fresh) lastMaterial = fresh
        else materialUnavailable = true
        // A source shown as visible that students can no longer see (its week moved later, or it
        // was hidden) joins this run's provenance, so the copy guard and the release review cover
        // it. The cached check no longer proves the guard.
        // A key that didn't come back at all was hidden, unpublished or deleted: it counts too
        // (the prune at commit drops whatever has opened or no longer exists).
        const returned = new Set((fresh ?? []).flatMap((sr) => sr.shown.map((e) => e.key)))
        const nowUnopened = fresh
          ? [
              ...fresh.flatMap((sr) => sr.shown.filter((e) => e.disclosure !== 'released').map((e) => e.key)),
              ...work.material.searches.flatMap((sr) => sr.keys).filter((k) => !returned.has(k)),
            ]
          : []
        const added = [...new Set(nowUnopened)].filter((k) => !work.material.sources.includes(k))
        if (added.length > 0) {
          const next: Work = { ...work, last_check: null, material: { ...work.material, sources: withSources(work.material.sources, added, STUDIO_MATERIAL_SOURCES_MAX) } }
          const saved = await deps.store.apply({
            runId, token, step: step('system', `sys:material:${run.counters.modelTurns}`, 'done', 'material.reclassified', { args: { event: 'material_reclassified' }, result: { added: added.length } }),
            expectedWorkRev: work.work_rev, work: next as unknown as Record<string, unknown>, plan: null, phase: null, delta: {}, caps: CAPS, activeMs: 0,
          })
          if (!saved?.ok) return saved?.reason === 'cancelled' ? await end(run, work, plan, 'cancelled', null) : 'fence lost'
          work = next
        }
      } else {
        lastMaterial = []
      }
      const ctx = buildTurnContext({
        nonce: nonce(),
        request: run.request ?? '',
        answers,
        work,
        plan,
        phase: run.phase ?? 'understanding',
        firstBuild: run.baseHash === null,
        baseHash: run.baseHash,
        baseWorkHash: data.base ? workHash(data.base.manifest, data.base.files) : null,
        publishedVersions: data.publishedVersions,
        frozen: data.published?.collections ?? null,
        course: data.course,
        skills: skillsWanted(run.request ?? '', plan, work) ? data.skills : null,
        history: data.history,
        memories,
        material: materialUnavailable ? [] : lastMaterial,
        materialUnavailable,
        steps,
        resumed,
        counters: { ...run.counters },
        tokenRatio,
      })
      if (ctx.estimatedTokens > STUDIO_BUILDER_CONTEXT_MAX_TOKENS) return await end(run, work, plan, 'failed', 'internal')
      memoryAliases = Object.fromEntries(ctx.memory.map((m) => [m.alias, { id: m.id, topic: m.topic, slot: m.slot }]))
      memoryApplied = ctx.memory.length
      memoryProposals = steps.filter((s) => s.tool === 'propose_memory' && s.status === 'done').length

      // ── One model call ──
      const callStart = deps.now()
      let reply
      try {
        reply = await deps.model.step({
          system: ctx.system,
          prompt: ctx.prompt,
          tools: toolDeclarations(),
          maxOutputTokens: STUDIO_BUILDER_MAX_OUTPUT_TOKENS,
          abortSignal: controller.signal,
          timeoutMs: STUDIO_BUILDER_MODEL_CALL_TIMEOUT_MS,
        })
      } catch (error) {
        if (error instanceof BuilderAbort) {
          // The call was cut off, so its usage is unknown and the provider may still bill it.
          await deps.store.addCost(runId, { input: 0, cached: 0, output: 0, costUsd: WORST_CASE_CALL_USD })
          if (flags.cancel) return await end(run, work, plan, 'cancelled', null)
          return 'fence lost'
        }
        if (error instanceof ModelUnavailable) {
          // A provider that failed after its retries may still bill an attempt.
          await deps.store.addCost(runId, { input: 0, cached: 0, output: 0, costUsd: WORST_CASE_CALL_USD })
          logger.error('studio.builder.model', { name: 'ModelUnavailable', message: 'provider failed after retries' }, { runId })
          return await end(run, work, plan, 'failed', 'model_unavailable')
        }
        throw error
      }
      const turnNo = run.counters.modelTurns + 1
      // A timed-out call reports no usage but may still be billed: the budgets charge it at
      // the worst case, while the usage ledger records what the provider reported.
      const costUsd = reply.timedOut
        ? WORST_CASE_CALL_USD
        : computeCostUsd(reply.modelId, { inputTokens: reply.usage.input, cachedInputTokens: reply.usage.cachedInput, outputTokens: reply.usage.output, reasoningTokens: reply.usage.reasoning })
      await deps.recordUsage(run, reply.usage, reply.modelId, turnNo)
      await deps.store.addCost(runId, { input: reply.usage.input, cached: reply.usage.cachedInput, output: reply.usage.output, costUsd })
      if (reply.usage.input > 0) tokenRatio = Math.max(1, tokenRatio, reply.usage.input / Math.max(1, ctx.estimatedTokens / tokenRatio))

      const turnRefusal: RefusalCode | null = reply.timedOut ? 'turn_timeout' : reply.finishReason === 'length' ? 'turn_truncated' : reply.toolCalls.length === 0 ? 'no_tool_call' : null
      const proposed = reply.toolCalls.slice(0, STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN)
      const turn = await deps.store.recordTurn(
        runId,
        token,
        step('model_turn', `turn:${turnNo}:${run.counters.toolCalls}`, turnRefusal ? 'refused' : 'done', turnNo === 1 ? 'turn.understanding' : run.phase === 'repairing' ? 'repair.round' : 'turn.next', {
          args: { proposed: proposed.map((c) => (isToolName(c.name) ? c.name : 'unknown')), count: proposed.length, instructions: ctx.instructionsVersion, trims: ctx.trims, memories: ctx.memory.length },
          result: { model: reply.modelId, finish: reply.finishReason.slice(0, 20), timed_out: reply.timedOut, reasoning_tokens: reply.usage.reasoning, cached_tokens: reply.usage.cachedInput, ...(turnRefusal ? { reason: turnRefusal, hint: REFUSAL_HINTS[turnRefusal] } : {}) },
          ms: deps.now() - callStart,
          input_tokens: reply.usage.input,
          output_tokens: reply.usage.output,
          cost_usd: costUsd,
        }),
        takeActive(),
        turnRefusal !== null,
      )
      if (!turn?.ok) return turn?.reason === 'cancelled' ? await end(run, work, plan, 'cancelled', null) : 'fence lost'
      if (turnRefusal) continue
      const seq = Number(turn.seq)

      // ── The turn's calls ──
      const outcome = await runCalls(reply.toolCalls, seq, run, work, plan)
      if (outcome === 'stop') return 'stopped'
    }
  } catch (error) {
    logger.error('studio.builder.slice', { name: error instanceof Error ? error.name : 'unknown', message: 'harness fault' }, { runId })
    const run = await deps.store.loadRun(runId).catch(() => null)
    if (run && run.status === 'running') await end(run, null, null, 'failed', 'internal').catch(() => undefined)
    return 'faulted'
  } finally {
    clearInterval(heartbeat)
  }

  /** Validates and runs one turn's calls in order. 'stop' when the run paused or ended. */
  async function runCalls(
    rawCalls: { name: string; input: unknown; invalid: boolean }[],
    seq: number,
    run: db.BuilderRunRow,
    startWork: Work,
    startPlan: Plan | null,
  ): Promise<'stop' | 'continue'> {
    let work = startWork
    let plan = startPlan
    const counters = { ...run.counters }
    const calls = rawCalls.slice(0, STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN).map((c, index) => ({ ...c, index }))
    const ordered = orderCalls(calls)

    const persist = async (args: Omit<db.ApplyArgs, 'runId' | 'token' | 'caps' | 'activeMs'>): Promise<'ok' | 'stop'> => {
      const r = await deps.store.apply({ ...args, runId, token, caps: CAPS, activeMs: takeActive() })
      if (r?.ok) return 'ok'
      const reason = String(r?.reason ?? 'fence')
      if (reason === 'cancelled') await end(run, work, plan, 'cancelled', null)
      else if (reason.startsWith('limit_')) await end(run, work, plan, 'budget_exhausted', reason as RunErrorCode)
      else if (reason === 'check_runs' || reason === 'repair_rounds') await end(run, work, plan, 'blocked', reason)
      // A stale working-copy revision means two writers: never expected, so stop the run.
      else if (reason === 'stale_work') await end(run, work, plan, 'failed', 'internal')
      return 'stop'
    }
    const toolStep = (id: string, tool: string | null, status: 'done' | 'refused' | 'error' | 'interrupted', label: string, args: Summary, result: Summary, ms = 0) =>
      step(tool === 'run_checks' ? 'check' : 'tool', id, status, label, { tool, args: { ...args, call: id }, result: { ...result, call: id }, ms })

    // Calls past the eighth: one refused step, one error, none of them run.
    if (rawCalls.length > STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN) {
      const over = rawCalls.length - STUDIO_BUILDER_MAX_TOOL_CALLS_PER_TURN
      const r = await persist({
        step: toolStep(`${seq}.overflow`, null, 'refused', 'step.refused', { extra_calls: over }, { reason: 'turn_call_limit', hint: REFUSAL_HINTS.turn_call_limit }),
        expectedWorkRev: work.work_rev, work: null, plan: null, phase: null, delta: { tool_calls: 1, error: true },
      })
      if (r === 'stop') return 'stop'
      counters.toolCalls += 1
    }

    for (let k = 0; k < ordered.length; k++) {
      const call = ordered[k]
      const id = `${seq}.${call.index}`
      const later = ordered.slice(k + 1).map((c) => toolStep(`${seq}.${c.index}`, isToolName(c.name) ? c.name : null, 'interrupted', 'step.interrupted', {}, {}))
      if (counters.toolCalls >= STUDIO_BUILDER_MAX_TOOL_CALLS) {
        const r = await persist({ step: toolStep(id, isToolName(call.name) ? call.name : null, 'interrupted', 'step.interrupted', {}, {}), expectedWorkRev: work.work_rev, work: null, plan: null, phase: null, delta: {} })
        if (r === 'stop') return 'stop'
        continue
      }
      // The light gate: Stop and the claim, before any tool runs.
      if (flags.cancel) {
        await end(run, work, plan, 'cancelled', null)
        return 'stop'
      }
      if (flags.fenceLost) return 'stop'

      const started = deps.now()
      let outcome = await validateAndExecute(call, work, plan, counters, run)
      const ms = deps.now() - started
      const tool = isToolName(call.name) ? call.name : null

      // A memory proposal is recorded inert by one fenced database call. The database checks the
      // professor's words again; a refusal from it goes back to the model like any other.
      if (outcome.kind === 'memory') {
        const recorded = await deps.store.proposeMemory({
          runId, token, step: toolStep(id, tool, 'done', 'memory.proposed', outcome.args, { proposed: true }, ms),
          topic: outcome.proposal.topic, slot: outcome.proposal.slot, kind: outcome.proposal.kind, statement: outcome.proposal.statement,
          evidence: outcome.proposal.evidence, replacesId: outcome.proposal.replacesId,
          caps: { tool_calls: CAPS.tool_calls, memory_proposals: STUDIO_MEMORY_PROPOSALS_PER_RUN, memory_active: STUDIO_MEMORY_MAX_ACTIVE },
          activeMs: takeActive(),
        })
        if (recorded?.ok) {
          if (recorded.duplicate !== true) {
            memoryProposals += 1
            counters.toolCalls += 1
            // Ids and the topic only, never the words.
            deps.audit(run, 'studio.memory.proposed', { runId, topic: outcome.proposal.topic, slot: outcome.proposal.slot })
          }
          counters.consecutiveErrors = 0
          continue
        }
        const reason = recorded === null ? 'memory_unavailable' : String(recorded.reason ?? 'fence')
        if ((MEMORY_REFUSALS as readonly string[]).includes(reason)) {
          outcome = { kind: 'refused', code: reason as (typeof MEMORY_REFUSALS)[number], args: outcome.args }
        } else {
          if (reason === 'cancelled') await end(run, work, plan, 'cancelled', null)
          else if (reason.startsWith('limit_')) await end(run, work, plan, 'budget_exhausted', reason as RunErrorCode)
          return 'stop'
        }
      }

      if (outcome.kind === 'refused') {
        const r = await persist({
          step: toolStep(id, tool, 'refused', 'step.refused', outcome.args, { reason: outcome.code, hint: REFUSAL_HINTS[outcome.code], ...(outcome.issues ? { issues: outcome.issues } : {}) }, ms),
          expectedWorkRev: work.work_rev, work: null, plan: null, phase: null, delta: { tool_calls: 1, error: true },
        })
        if (r === 'stop') return 'stop'
        counters.toolCalls += 1
        counters.consecutiveErrors += 1
        continue
      }
      if (outcome.kind === 'error') {
        const r = await persist({ step: toolStep(id, tool, 'error', 'step.refused', outcome.args, { reason: outcome.code }, ms), expectedWorkRev: work.work_rev, work: null, plan: null, phase: null, delta: { tool_calls: 1, error: true } })
        if (r === 'stop') return 'stop'
        await end(run, work, plan, 'failed', outcome.code)
        return 'stop'
      }
      if (outcome.kind === 'approval') {
        const p = await deps.store.pause({
          runId, token,
          step: toolStep(id, tool, 'done', 'approval.waiting', outcome.args, outcome.result, ms),
          interrupted: later,
          pending: { ...outcome.pending, tool_call_id: id },
          question: null,
          delta: outcome.delta,
          caps: CAPS,
          waitingMs: STUDIO_BUILDER_WAITING_TTL_MS,
          activeMs: takeActive(),
        })
        if (p?.ok) deps.audit(run, 'studio.build.approval_requested', { runId, items: outcome.pending.items.length })
        else if (p?.reason === 'cancelled') await end(run, work, plan, 'cancelled', null)
        else if (typeof p?.reason === 'string' && p.reason.startsWith('limit_')) await end(run, work, plan, 'budget_exhausted', p.reason as RunErrorCode)
        return 'stop'
      }
      if (outcome.kind === 'question') {
        const p = await deps.store.pause({
          runId, token,
          step: toolStep(id, tool, 'done', 'question.asked', outcome.args, {}, ms),
          interrupted: later,
          pending: null,
          question: { id: randomUUID(), question: outcome.question, answer: null, askedAt: new Date(deps.now()).toISOString() },
          delta: {},
          caps: CAPS,
          waitingMs: STUDIO_BUILDER_WAITING_TTL_MS,
          activeMs: takeActive(),
        })
        if (!p?.ok && p?.reason === 'cancelled') await end(run, work, plan, 'cancelled', null)
        return 'stop'
      }
      if (outcome.kind === 'finish') {
        return await completion(id, outcome, work, plan, counters, run, ms)
      }

      // done
      const nextWork = outcome.work ?? null
      const r = await persist({
        step: toolStep(id, tool, 'done', outcome.label, outcome.args, outcome.result, ms),
        expectedWorkRev: work.work_rev,
        work: nextWork as unknown as Record<string, unknown> | null,
        plan: (outcome.plan as unknown as Record<string, unknown>) ?? null,
        phase: outcome.phase ?? null,
        delta: { tool_calls: 1, error: false, ...outcome.delta },
      })
      if (r === 'stop') return 'stop'
      counters.toolCalls += 1
      counters.consecutiveErrors = 0
      if (outcome.label === 'material.searched' && nextWork) {
        // Ids, counts and keys only, never the words or the text.
        const latestSearch = nextWork.material.searches.at(-1)
        deps.audit(run, 'studio.builder.material_searched', { runId, results: latestSearch?.keys.length ?? 0, keys: (latestSearch?.keys ?? []).join(' ').slice(0, 1000) })
      }
      counters.writes += outcome.delta.writes ?? 0
      counters.bytesWritten += outcome.delta.bytes_written ?? 0
      counters.checkRuns += outcome.delta.check_runs ?? 0
      counters.repairRounds += outcome.delta.repair_rounds ?? 0
      if (nextWork) work = nextWork
      if (outcome.plan) plan = outcome.plan
      if (outcome.exhausted) {
        await end(run, work, plan, 'blocked', outcome.exhausted)
        return 'stop'
      }
    }
    return 'continue'
  }

  function toolState(work: Work, plan: Plan | null, counters: db.BuilderRunRow['counters'], run: db.BuilderRunRow): ToolState {
    return {
      work,
      plan,
      firstBuild: run.baseHash === null,
      slug: data!.slug,
      published: data!.published,
      counters: { writes: counters.writes, bytesWritten: counters.bytesWritten, checkRuns: counters.checkRuns, repairRounds: counters.repairRounds, questions: run.questions.length },
      memory: { aliases: memoryAliases, professorTexts: professorTextsOf(run), proposals: memoryProposals },
      runChecks: (w) => deps.runChecks(run, data!, w),
      searchMaterial: (query, focus) => deps.searchMaterial(run, query, focus),
    }
  }

  /** The registry's rules, first refusal wins: SDK-invalid, unknown tool, schema, plan, then the tool. */
  async function validateAndExecute(call: { name: string; input: unknown; invalid: boolean }, work: Work, plan: Plan | null, counters: db.BuilderRunRow['counters'], run: db.BuilderRunRow): Promise<ToolOutcome> {
    if (call.invalid) return { kind: 'refused', code: 'sdk_invalid', args: {} }
    if (!isToolName(call.name)) return { kind: 'refused', code: 'unknown_tool', args: { name: call.name.replace(/[^a-z_]/gi, '').slice(0, 40) } }
    const spec = TOOLS[call.name]
    const parsed = spec.schema.safeParse(call.input)
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '(arguments)')))].slice(0, 5)
      // Path and code only: zod messages can quote model-chosen keys.
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map((p) => String(p).replace(/[^\w.-]/g, '').slice(0, 40)).join('.') || 'arguments'}: ${i.code}`)
      return { kind: 'refused', code: 'invalid_args', args: { fields: fields.map((f) => f.replace(/[^\w.-]/g, '').slice(0, 40)) }, issues }
    }
    const state = toolState(work, plan, counters, run)
    const planHint = planGate(state, call.name, parsed.data as Record<string, unknown>)
    if (planHint) return { kind: 'refused', code: 'plan_required', args: {}, issues: [planHint] }
    return spec.execute(state, parsed.data as never)
  }

  /** finish: the model asks; the harness verifies everything itself. */
  async function completion(
    id: string,
    outcome: Extract<ToolOutcome, { kind: 'finish' }>,
    work: Work,
    plan: Plan | null,
    counters: db.BuilderRunRow['counters'],
    run: db.BuilderRunRow,
    ms: number,
  ): Promise<'stop' | 'continue'> {
    const record = (status: 'done' | 'refused', label: string, result: Summary, delta: Delta & { error?: boolean } = {}) =>
      deps.store.apply({
        runId, token, step: step('tool', id, status, label, { tool: 'finish', args: { ...outcome.args, call: id }, result: { ...result, call: id }, ms }),
        expectedWorkRev: work.work_rev, work: null, plan: null, phase: null, delta: { tool_calls: 1, ...delta }, caps: CAPS, activeMs: takeActive(),
      })
    const stopFor = async (r: Outcome): Promise<'stop' | null> => {
      if (r?.ok) return null
      if (r?.reason === 'cancelled') await end(run, work, plan, 'cancelled', null)
      else if (typeof r?.reason === 'string' && r.reason.startsWith('limit_')) await end(run, work, plan, 'budget_exhausted', r.reason as RunErrorCode)
      return 'stop'
    }

    if (outcome.status === 'blocked') {
      if (await stopFor(await record('done', 'run.finishing', { status: 'blocked' }, { error: false }))) return 'stop'
      return await end(run, work, plan, 'blocked', 'agent_blocked', { summary: outcome.summary, openQuestions: outcome.openQuestions })
    }

    // A plan was required for this kind of change.
    const needsPlan = run.baseHash === null || work.changed.length > 1 || work.delta.direct.length + work.delta.approved.length > 0
    if (needsPlan && !plan) {
      const r = await record('refused', 'step.refused', { reason: 'plan_required', hint: REFUSAL_HINTS.plan_required }, { error: true })
      return (await stopFor(r)) ?? 'continue'
    }

    // The gate: the same checks as run_checks, re-run when anything changed since.
    const state = toolState(work, plan, counters, run)
    const gate = await checkStep(state, { gate: true })
    if (gate.kind === 'refused') {
      // No check runs left to prove the work.
      if (await stopFor(await record('done', 'run.finishing', { gate: 'no_checks_left' }, { error: false }))) return 'stop'
      return await end(run, work, plan, 'blocked', 'check_runs')
    }
    if (gate.kind === 'error') {
      await record('refused', 'step.refused', { reason: gate.code }, { error: true })
      return await end(run, work, plan, 'failed', gate.code)
    }
    if (gate.kind !== 'done') return await end(run, work, plan, 'failed', 'internal')
    let gateWork = work
    if (!('cached' in gate && gate.cached)) {
      const r = await deps.store.apply({
        runId, token, step: step('check', `${id}.gate`, 'done', gate.label, { tool: 'run_checks', args: { gate: true, call: `${id}.gate` }, result: gate.result }),
        expectedWorkRev: work.work_rev, work: (gate.work ?? null) as unknown as Record<string, unknown> | null, plan: null, phase: gate.phase ?? null,
        delta: gate.delta, caps: CAPS, activeMs: takeActive(),
      })
      if (await stopFor(r)) return 'stop'
      if (gate.work) gateWork = gate.work
    }
    const check = gateWork.last_check
    if (!check || !check.passed) {
      if (gate.exhausted) {
        await record('done', 'run.finishing', { gate: 'failed' }, { error: false })
        return await end(run, gateWork, plan, 'blocked', gate.exhausted)
      }
      // A failed gate is a repair round: the findings go back to the model.
      const r = await record('done', 'check.failed', { gate: 'failed', blocking: check?.findings.filter((f) => f.required).length ?? 0 }, { error: false })
      return (await stopFor(r)) ?? 'continue'
    }

    if (await stopFor(await record('done', 'run.finishing', { status: 'completed' }, { error: false }))) return 'stop'
    const manifest = gateWork.manifest!
    const files = gateWork.files as Record<PluginPath, string>
    if (data!.base && workHash(data!.base.manifest, data!.base.files) === workHash(manifest, files)) {
      return await end(run, gateWork, plan, 'completed', null, { summary: outcome.summary, openQuestions: outcome.openQuestions, passed: true })
    }
    // Commit: the bundles come from the trusted compiler, on exactly these files.
    const fresh = gate.check ?? (await deps.runChecks(run, data!, gateWork))
    if (!fresh.passed || !fresh.bundles || !fresh.compiler || fresh.workHash !== check.work_hash) {
      return await end(run, gateWork, plan, 'failed', 'internal')
    }
    const hash = snapshotHash(fresh.compiler, manifest, files)
    return await end(run, gateWork, plan, 'preview_ready', null, {
      summary: outcome.summary,
      openQuestions: outcome.openQuestions,
      passed: true,
      snapshotHash: hash,
      snapshot: {
        hash,
        compiler: fresh.compiler,
        manifest,
        files,
        student_bundle: fresh.bundles.student,
        professor_bundle: fresh.bundles.professor,
        check_summary: fresh.summary,
      },
    })
  }
}

// ── The real dependencies ────────────────────────────────────────────

export const builderRunStore: RunStore = {
  claim: async (runId, jobId, sliceNo) => {
    const r = await db.builderRpcs.claim(runId, jobId, sliceNo, STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES)
    return typeof r?.token === 'string' ? r.token : null
  },
  heartbeat: async (runId, token) => {
    const r = await db.builderRpcs.heartbeat(runId, token)
    return { fenceLost: r?.fence_lost === true, cancelRequested: r?.cancel_requested === true }
  },
  loadRun: db.loadBuilderRun,
  loadSteps: async (runId) => db.listBuilderSteps(runId, 0, 500),
  addCost: async (runId, u) => void (await db.builderRpcs.addCost(runId, u)),
  recordTurn: db.builderRpcs.recordTurn,
  apply: db.builderRpcs.apply,
  pause: db.builderRpcs.pause,
  handoff: (runId, token, activeMs) => db.builderRpcs.handoff(runId, token, STUDIO_BUILDER_MAX_SLICES, activeMs),
  end: db.builderRpcs.end,
  proposeMemory: db.memoryRpcs.propose,
}

async function loadSliceData(run: db.BuilderRunRow): Promise<SliceData | null> {
  const [project, latest, base, history, course, skills] = await Promise.all([
    db.loadBuilderProject(run.projectId),
    db.loadLatestProjectManifest(run.projectId),
    run.baseHash ? db.loadSnapshot(run.projectId, run.baseHash) : Promise.resolve(null),
    db.listProjectRuns(run.projectId, STUDIO_BUILDER_HISTORY_RUNS + 1),
    run.sectionId ? db.loadSectionCourse(run.sectionId) : Promise.resolve(null),
    run.sectionId ? db.loadSectionSkills(run.sectionId) : Promise.resolve(null),
  ])
  if (!project) return null
  if (run.baseHash && !base) return null
  const published = latest ? parseManifest(latest.manifest) : null
  const baseManifest = base ? parseManifest(base.manifest) : null
  const versions = await db.listProjectVersions(run.projectId)
  return {
    slug: project.slug,
    published: published?.ok ? published.manifest : null,
    publishedVersions: versions.map((v) => v.version).slice(0, 5),
    base: base
      ? { manifest: baseManifest?.ok && baseManifest.manifest.manifestVersion === 2 ? baseManifest.manifest : null, files: base.files as Partial<Record<PluginPath, string>> }
      : null,
    course,
    skills: skills ? skills.map((s) => s.name) : null,
    materialSources: project.materialSources,
    history: (history ?? [])
      .filter((r) => r.id !== run.id && r.endedAt !== null)
      .slice(0, STUDIO_BUILDER_HISTORY_RUNS)
      .reverse()
      .map((r) => ({
        status: r.status,
        reason: r.errorCode,
        request: r.request,
        summary: typeof r.result?.summary === 'string' ? r.result.summary : null,
        filesChanged: Array.isArray(r.result?.files) ? (r.result.files as { path: string; changed: boolean }[]).filter((f) => f.changed).map((f) => f.path) : [],
      })),
  }
}

/** The project's active decisions, pinned to the run's project and institution. Null when unreadable. */
async function loadMemories(run: db.BuilderRunRow): Promise<ProjectMemory[] | null> {
  const rows = await db.listActiveMemories(run.projectId, run.institutionId)
  return rows ? rows.map((r) => ({ id: r.id, topic: r.topic, slot: r.slot, kind: r.kind, statement: r.statement, createdAt: r.createdAt, updatedAt: r.updatedAt })) : null
}

async function gate(run: db.BuilderRunRow): Promise<GateRefusal | null> {
  const [actor, access, ai, spend] = await Promise.all([
    builderActor(run),
    studioAccess(run.institutionId),
    checkAiFeature(createAdminClient(), run.institutionId, 'studio-builder'),
    db.loadInstitutionBuilderSpend(run.institutionId),
  ])
  if (access === 'off') return 'studio_paused'
  if (access === 'read_only') return 'not_entitled'
  if (!ai.allowed) return 'ai_disabled'
  if (!actor.ok) return actor.reason
  // Fails closed: unreadable spend stops the build.
  if (spend === null || spend + WORST_CASE_CALL_USD > STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD) return 'limit_daily_cost'
  return null
}

export function realHarnessDeps(model: AgentModel = createGeminiModel()): HarnessDeps {
  return {
    store: builderRunStore,
    model,
    loadSliceData,
    loadMemories,
    gate,
    runChecks: async (run, data, work) => {
      const roster = await db.loadOwnerRosterFullNames(run.ownerId)
      // The guard covers every scheduled source the project's builds read, this run's included.
      const entries = provenanceEntries(data.materialSources, work.material.sources, run.sectionId)
      const disclosureSources = roster === null ? null : await loadGuardSources(run.institutionId, entries, roster, run.ownerId)
      return runDraftChecks(work, { workerCheck: runWorkerCheck, rosterFullNames: roster, published: data.published, disclosureSources })
    },
    searchMaterial: async (run, query, focus) => {
      const scope = retrievalScope(run)
      return scope ? postgresRetriever.search(scope, query, focus) : { ok: false }
    },
    rehydrateMaterial: async (run, searches) => {
      const scope = retrievalScope(run)
      return scope ? postgresRetriever.rehydrate(scope, searches) : null
    },
    recordUsage: (run, usage, modelId, turn) =>
      recordAiUsage({
        feature: BUILDER_LEDGER_FEATURE,
        model: modelId,
        institutionId: run.institutionId,
        sectionId: run.sectionId,
        userId: run.ownerId,
        usage: { inputTokens: usage.input, cachedInputTokens: usage.cachedInput, outputTokens: usage.output, reasoningTokens: usage.reasoning },
        metadata: { runId: run.id, turn },
      }),
    audit: (run, event, metadata) =>
      logEvent({ userId: run.ownerId, eventType: event, eventCategory: 'studio', sectionId: run.sectionId ?? undefined, metadata }),
    kick: (jobId) => kickWorker(jobId),
    now: () => Date.now(),
    heartbeatMs: STUDIO_BUILDER_HEARTBEAT_MS,
  }
}

/** The background pipeline the job registry runs. */
export const builderSlicePipeline: BackgroundPipeline = {
  type: BUILDER_JOB_TYPE,
  minBudgetMs: STUDIO_BUILDER_SLICE_MIN_BUDGET_MS,
  run: async (params, ctx) => {
    const outcome = await runBuilderSlice(params, { id: ctx.job.id, deadline: ctx.deadline }, realHarnessDeps())
    return { result: { outcome }, summary: `Builder slice: ${outcome}` }
  },
  // Recovers or releases stalled runs whether or not anyone has the page open, so a dead
  // slice can't hold a live slot and an unanswered card expires on time. Counts only.
  upkeep: async () => {
    // Memory proposals nobody answered are rejected, whether or not the run sweep found anything.
    const lapsed = await db.memoryRpcs.expire(STUDIO_MEMORY_PROPOSAL_TTL_MS, STUDIO_MEMORY_EXPIRE_LIMIT)
    if (lapsed) logger.info('studio/builder.upkeep', { memoryProposalsExpired: lapsed })
    const swept = await db.builderRpcs.sweep(STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES, STUDIO_BUILDER_SWEEP_LIMIT)
    if (!swept) return
    const counts = Object.fromEntries(['requeued', 'failed', 'cancelled', 'expired', 'error'].map((k) => [k, Number(swept[k] ?? 0)]))
    if (Object.values(counts).some((n) => n > 0)) logger.info('studio/builder.upkeep', counts)
  },
}
