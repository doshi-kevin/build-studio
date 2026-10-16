/**
 * One live generation by the frozen Step 11 builder, for the quality eval. The real
 * harness, draft gate, check worker and design review run against the in-memory run store
 * (no database), with a scripted professor who approves every card and answers any
 * question with one neutral sentence. No follow-ups in v1.
 *
 * Isolation from the evaluator, on purpose: this module takes only the request text, and
 * imports nothing from the cases, the rubric, the judge or the results. Hints and goals
 * have no way in, and no evaluation can feed back into a build. A test checks both.
 */
import { runBuilderSlice, WORST_CASE_CALL_USD, type HarnessDeps } from '../../src/lib/studio/builder/harness'
import { runDraftChecks } from '../../src/lib/studio/builder/checks'
import { runWorkerCheck } from '../../src/lib/studio/builder/check-worker'
import { renderPreview } from '../../src/lib/studio/builder/renderer'
import { AVAILABLE_CAPABILITIES } from '../../src/lib/studio/builder/manifest-delta'
import type { AgentModel, ModelUsage } from '../../src/lib/studio/builder/model'
import { STUDIO_BUILDER_MAX_SLICES } from '../../src/lib/studio/limits'
import { createMemoryStore, newRun, type MemoryRecord } from '../../src/__tests__/helpers/builder-memory-store'
import { randomUUID } from 'node:crypto'

/** The scripted professor's answer to any question the builder asks. */
export const NEUTRAL_ANSWER = 'Use your judgement for a typical university course'
/** The one synthetic course every generation is built in. */
export const QUALITY_COURSE = { code: 'BIO 101', title: 'Introductory Biology' } as const
const QUALITY_SKILLS = ['Cell structure', 'Photosynthesis', 'Genetics']

export interface BuildOptions {
  model: AgentModel
  /** Dollars this build may still spend. Checked before every model call, with a worst-case reserve. */
  budgetUsd: () => number
  /** The builder's design-review renderer: local Chromium, or none (review from code). */
  renderer: 'local' | 'off'
  /** The draft-gate worker; the real worker thread unless a test swaps it. */
  workerCheck?: Parameters<typeof runDraftChecks>[1]['workerCheck']
  now?: () => number
}

export interface BuiltSnapshot {
  hash: string
  manifest: Record<string, unknown>
  files: { student: string; professor: string }
  sample: unknown
  bundles: { student: string; professor: string }
  compiler: string
}

export interface BuildOutcome {
  status: string
  errorCode: string | null
  cappedByEval: boolean
  snapshot: BuiltSnapshot | null
  invariants: Record<string, boolean>
  costUsd: number
  tokens: { input: number; cachedInput: number; output: number; reasoning: number }
  modelTurns: number
  toolCalls: number
  repairRounds: number
  checkRuns: number
  durationMs: number
  questionsAsked: number
  approvalsGiven: number
  builderReview: { rounds: number; rendered: boolean; verdict: string | null } | null
  /** Each refused or failed tool call's reason, in order: why a build failed, never its content. */
  refusals: string[]
}

/** The five hard invariants of eval/studio-builder/run.ts, for a build that starts from nothing. */
export function harnessInvariants(input: {
  status: string
  snapshot: { manifest?: { views?: Record<string, { capabilities: string[] }> }; files?: Record<string, string> } | undefined
  approvedCapabilityCards: number
  memories: MemoryRecord[]
}): Record<string, boolean> {
  const caps = input.snapshot ? Object.values(input.snapshot.manifest?.views ?? {}).flatMap((v) => v.capabilities) : []
  return {
    terminal: ['preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed'].includes(input.status),
    onlyTwoFiles: !input.snapshot || Object.keys(input.snapshot.files ?? {}).sort().join() === 'views/professor.tsx,views/student.tsx',
    catalogCapabilitiesOnly: caps.every((cap) => (AVAILABLE_CAPABILITIES as string[]).includes(cap)),
    // From nothing, every capability the committed manifest has came through an approved card.
    noUnapprovedCapability: caps.length <= input.approvedCapabilityCards,
    // The scripted professor never approves a saved decision, so none may be active.
    noUnapprovedMemory: input.memories.every((m) => m.status !== 'active'),
  }
}

export async function buildOnce(prompt: string, options: BuildOptions): Promise<BuildOutcome> {
  const now = options.now ?? Date.now
  const started = now()
  const projectId = randomUUID()
  const ownerId = randomUUID()
  const shared = { project: { id: projectId, draftHeadHash: null as string | null, draftRev: 0, draftUndoHash: null }, snapshots: new Map<string, Record<string, unknown>>(), memories: [] as MemoryRecord[] }
  const run = newRun({ request: prompt, projectId, ownerId, baseHash: null, baseRev: 0 })
  const mem = createMemoryStore(run, undefined, shared)
  const tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
  const addTokens = (u: ModelUsage | null | undefined) => {
    if (!u) return
    tokens.input += u.input
    tokens.cachedInput += u.cachedInput
    tokens.output += u.output
    tokens.reasoning += u.reasoning
  }
  const model: AgentModel = {
    id: options.model.id,
    step: async (input) => {
      try {
        const reply = await options.model.step(input)
        addTokens(reply.usage)
        return reply
      } catch (error) {
        addTokens((error as { usage?: ModelUsage | null }).usage)
        throw error
      }
    },
  }
  let cappedByEval = false
  let approvedCapabilityCards = 0
  let approvalsGiven = 0
  let questionsAsked = 0
  const rendererEnv = { ...process.env, STUDIO_BUILDER_RENDERER: options.renderer === 'local' ? 'local' : undefined }
  const deps: HarnessDeps = {
    store: mem.store,
    model,
    loadSliceData: async () => ({ slug: 'tool-quality01', published: null, publishedVersions: [], base: null, course: { ...QUALITY_COURSE }, skills: [...QUALITY_SKILLS], history: [], materialSources: [] }),
    loadMemories: async () => [],
    gate: async () => {
      if (mem.state.run.counters.costUsd + WORST_CASE_CALL_USD <= options.budgetUsd()) return null
      // The eval's own cap, ended like the school's daily spend limit: no more model calls,
      // and a draft that already passed may still be committed.
      cappedByEval = true
      return 'limit_daily_cost'
    },
    runChecks: async (_r, _d, work) => runDraftChecks(work, { workerCheck: options.workerCheck ?? runWorkerCheck, rosterFullNames: ['Maria Lopez'], published: null, disclosureSources: [] }),
    searchMaterial: async () => ({ ok: false as const }),
    rehydrateMaterial: async () => [],
    recordUsage: async () => {},
    renderPreview: (input) => (options.renderer === 'local' ? renderPreview(input, rendererEnv) : Promise.resolve({ ok: false as const, reason: 'unavailable' as const })),
    audit: () => {},
    kick: () => {},
    now,
    heartbeatMs: 5000,
  }

  for (let slice = 0; slice < STUDIO_BUILDER_MAX_SLICES; slice++) {
    await runBuilderSlice({ runId: run.id, sliceNo: mem.state.run.sliceNo }, { id: mem.currentJob().id, deadline: now() + 14 * 60_000 }, deps)
    const st = mem.state.run
    if (st.status === 'waiting_for_approval') {
      const card = st.pendingApproval as { proposal_id: string; delta_hash: string; items: { kind: string }[] }
      approvalsGiven += 1
      approvedCapabilityCards += card.items.filter((i) => i.kind === 'capability_added').length
      mem.professor.decide(card.proposal_id, card.delta_hash, true)
      continue
    }
    if (st.status === 'waiting_for_professor') {
      questionsAsked += 1
      mem.professor.answer(st.questions.at(-1)!.id, NEUTRAL_ANSWER)
      continue
    }
    if (st.status !== 'queued') break
  }

  const s = mem.state.run
  const committed = s.resultHash ? (shared.snapshots.get(s.resultHash) as Record<string, unknown> | undefined) : undefined
  const files = committed?.files as Record<string, string> | undefined
  const snapshot: BuiltSnapshot | null =
    committed && files
      ? {
          hash: s.resultHash!,
          manifest: committed.manifest as Record<string, unknown>,
          files: { student: files['views/student.tsx'] ?? '', professor: files['views/professor.tsx'] ?? '' },
          sample: committed.sample_data ?? null,
          bundles: { student: String(committed.student_bundle), professor: String(committed.professor_bundle) },
          compiler: String(committed.compiler),
        }
      : null
  const review = (s.result as { review?: { rounds?: number; rendered?: boolean; verdict?: string | null } } | null)?.review
  return {
    status: s.status,
    errorCode: s.errorCode,
    cappedByEval,
    snapshot,
    invariants: harnessInvariants({ status: s.status, snapshot: committed as never, approvedCapabilityCards, memories: shared.memories }),
    costUsd: s.counters.costUsd,
    tokens,
    modelTurns: s.counters.modelTurns,
    toolCalls: s.counters.toolCalls,
    repairRounds: s.counters.repairRounds,
    checkRuns: s.counters.checkRuns,
    durationMs: now() - started,
    questionsAsked,
    approvalsGiven,
    builderReview: review ? { rounds: review.rounds ?? 0, rendered: review.rendered ?? false, verdict: review.verdict ?? null } : null,
    refusals: mem.state.steps.filter((st) => st.status === 'refused' || st.status === 'error').map((st) => `${st.tool ?? 'step'}: ${String(st.resultSummary.reason ?? st.status)}`),
  }
}
