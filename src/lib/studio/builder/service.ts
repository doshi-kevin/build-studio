/**
 * The builder's trusted entry points: everything the professor's browser can ask of the
 * builder goes through one of these, called from a thin server action or route.
 *
 * Every entry derives identity from the session (requireProfessor or the session user),
 * re-binds each id the client sent to that user, checks Studio access and the builder's
 * AI switch where the call leads to model spend, and then makes one database call that
 * re-checks state under a lock. Refusals look the same whether a run is missing or
 * belongs to someone else.
 *
 * Builder data is owner-only: a TA of the section sees none of it (decision 41).
 * Nothing here publishes, installs, activates or shows anything to students; Save as
 * version is lifecycle.publishDraft, a separate professor action.
 */
import 'server-only'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { kickWorker } from '@/lib/jobs/enqueue'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { STUDIO_PAUSED, studioAccess } from '../access'
import { allowedBridgeMethods } from '../bridge/catalog'
import { requireProfessor, sessionUserId, type StudioProfessor } from '../context'
import * as db from '../db'
import { addVersionToCourse, publishDraft, versionPlacement } from '../lifecycle'
import { buildPluginCard, cardAdditions, type PluginCard } from '../plugin-card'
import type { BlockerCode, Issue, WarningCode } from '../student-visibility'
import { currentVerdict, requestRuntimeValidation } from '../validator/service'
import {
  STUDIO_BUILDER_ANSWER_MAX_CHARS,
  STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR,
  STUDIO_BUILDER_DRAFT_HISTORY_MAX,
  STUDIO_BUILDER_DRAFT_HISTORY_REQUEST_MAX_CHARS,
  STUDIO_BUILDER_HEARTBEAT_STALE_MS,
  STUDIO_BUILDER_PROGRESS_POLL_MS,
  STUDIO_BUILDER_REKICK_AFTER_MS,
  STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD,
  STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION,
  STUDIO_BUILDER_MAX_MODEL_TURNS,
  STUDIO_BUILDER_MAX_RESUMES,
  STUDIO_BUILDER_PROGRESS_EVENTS_MAX,
  STUDIO_BUILDER_REQUEST_MAX_CHARS,
  STUDIO_MEMORY_MAX_ACTIVE,
  STUDIO_MEMORY_PROPOSAL_TTL_MS,
  STUDIO_MEMORY_STATEMENT_MAX_CHARS,
} from '../limits'
import { parseManifest, type StudioManifest } from '../manifest'
import { draftFrameUrl } from '../runtime/frame-ticket'
import type { PluginView } from '../runtime/protocol'
import { categoryLabel, isSlotOf, KIND_LABEL, MEMORY_KINDS, MEMORY_SLOT_KEYS, MEMORY_TOPICS, statementProblem, type MemoryKind, type MemorySlot, type MemoryTopic, type StatementProblem } from './memory'
import { characterProblem } from './paths'

export const BUILDER_NOT_AVAILABLE = 'This isn’t available.'

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string; conflict?: { kind: 'busy' | 'waiting'; runId: string } }

const denied = (): { ok: false; error: string } => ({ ok: false, error: BUILDER_NOT_AVAILABLE })

/** Progress copy. Fixed sentences only: never a tool name, check id, file content or model text. */
const LABELS: Record<string, string | null> = {
  'run.started': 'Getting ready',
  'run.slice': null,
  'run.resumed': 'Picking up where I left off',
  'turn.understanding': 'Understanding your request',
  'turn.next': 'Working on the next step',
  'repair.round': 'Fixing what the checks found',
  'plan.submitted': 'Planning the changes',
  'file.read': 'Reading the {view} view',
  'kit.read': 'Looking up a building block',
  'file.written': 'Writing the {view} view',
  'file.edited': 'Editing the {view} view',
  'manifest.applied': 'Updating what the tool stores and uses',
  'approval.waiting': 'Waiting for your approval',
  'approval.approved': 'You approved the change',
  'approval.declined': 'You declined the change',
  'question.asked': 'Athena has a question for you',
  'question.answered': 'You answered',
  'check.passed': 'Checks passed',
  'check.failed': 'Found issues to fix',
  'check.cached': null,
  'run.finishing': 'Wrapping up',
  'memory.proposed': null,
  'material.searched': 'Reading your course material',
  'material.unavailable': 'Couldn’t open your course material, so I’m building without it',
  'material.reclassified': null,
  'step.refused': 'That step didn’t work, so I’m trying another way',
  'step.interrupted': null,
  'run.preview_ready': 'Preview ready',
  'run.completed': 'Done: nothing needed to change',
  'run.blocked': 'Couldn’t finish this request',
  'run.cancelled': 'Stopped',
  'run.budget_exhausted': 'Reached the limit for one build',
  'run.failed': 'Something went wrong',
}

/** Why a run ended, for the professor. Fixed copy per status and reason. `hasNote`: Athena left a summary. */
export function endingCopy(status: db.BuilderRunStatus, reason: string | null, hasNote = true): string | null {
  switch (status) {
    case 'preview_ready':
      return 'Preview ready. Your saved tool hasn’t changed until you save this draft as a version.'
    case 'completed':
      return 'Nothing needed to change.'
    case 'cancelled':
      return reason === 'expired' ? 'This request expired. Your tool is unchanged.' : reason === 'superseded' ? 'Replaced by your newer request. Your tool is unchanged.' : 'Stopped. Your tool is unchanged.'
    case 'budget_exhausted':
      return reason === 'limit_daily_cost'
        ? 'Your school has used today’s budget for Athena’s tool builder, so I stopped without saving. Try again tomorrow.'
        : 'I reached the limit for one build, so I stopped without saving. Ask me again, in smaller steps if you can.'
    case 'failed':
      if (reason === 'model_unavailable') return 'I couldn’t reach the AI service, so I stopped without saving. Your tool is unchanged.'
      return reason === 'interrupted' ? 'The build was interrupted too many times. Your tool is unchanged.' : 'Something went wrong on our side. Your tool is unchanged.'
    case 'blocked':
      if (reason === 'repair_rounds' || reason === 'same_finding' || reason === 'check_runs') return 'I couldn’t get every check to pass, so I didn’t save anything. Try describing the change differently.'
      if (reason === 'draft_changed') return 'Your draft changed while I worked, so I didn’t overwrite it. Ask again to build on the latest draft.'
      if (reason === 'studio_paused') return STUDIO_PAUSED
      if (reason === 'not_entitled') return entitlementRefusalMessage('studio')
      if (reason === 'ai_disabled') return 'Athena’s tool builder is switched off for your school.'
      if (reason === 'access_lost') return 'You no longer have access to this course, so I stopped.'
      if (reason === 'project_archived') return 'This tool was archived, so I stopped.'
      return hasNote ? 'I couldn’t do this one. My note below explains why.' : 'I couldn’t do this one. Try describing the change differently, or ask for something smaller.'
    default:
      return null
  }
}

/** Studio and the builder's AI switch, for an action that leads to model spend. */
async function buildRefused(professor: StudioProfessor): Promise<{ ok: false; error: string } | null> {
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }
  const ai = await checkAiFeature(createAdminClient(), professor.institutionId, 'studio-builder')
  if (!ai.allowed) return { ok: false, error: aiRefusalMessage(ai.lockedBy) }
  return null
}

/** The run, only if it is this professor's own. */
async function ownRun(professor: StudioProfessor, runId: string): Promise<db.BuilderRunRow | null> {
  const run = await db.loadBuilderRun(runId)
  return run && run.ownerId === professor.userId && run.institutionId === professor.institutionId ? run : null
}

/** The project, only if it is this professor's own. */
async function ownProject(professor: StudioProfessor, projectId: string): Promise<db.BuilderProjectRow | null> {
  const project = await db.loadBuilderProject(projectId)
  return project && project.ownerId === professor.userId && project.institutionId === professor.institutionId ? project : null
}

function audit(professor: StudioProfessor, eventType: string, metadata: Record<string, string>) {
  logEvent({ userId: professor.userId, eventType, eventCategory: 'studio', sectionId: professor.sectionId, metadata })
}

const id = z.uuid()
const requestText = z
  .string()
  .trim()
  .min(1)
  .max(STUDIO_BUILDER_REQUEST_MAX_CHARS)
  .refine((s) => characterProblem(s) === null, 'contains a control character')

const startInput = z.strictObject({
  sectionId: id,
  pluginProjectId: id.nullable(),
  request: requestText,
  clientRequestId: id,
  /** The professor confirmed replacing the run that is waiting for them (decision 1.2). */
  replaceRunId: id.nullable().optional(),
})

export async function startBuild(input: z.input<typeof startInput>): Promise<ServiceResult<{ runId: string; pluginProjectId: string }>> {
  const parsed = startInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Describe what you want in a few sentences.' }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const refused = await buildRefused(professor)
  if (refused) return refused

  const r = await db.builderRpcs.start({
    ownerId: professor.userId,
    institutionId: professor.institutionId,
    sectionId: professor.sectionId,
    projectId: parsed.data.pluginProjectId,
    newSlug: `tool-${randomBytes(4).toString('hex')}`,
    newName: 'Untitled tool',
    request: parsed.data.request,
    clientRequestId: parsed.data.clientRequestId,
    replaceRunId: parsed.data.replaceRunId ?? null,
    maxDailyRuns: STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR,
    maxLiveRuns: STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION,
    maxDailyCost: STUDIO_BUILDER_INSTITUTION_DAILY_COST_USD,
  })
  switch (r?.outcome) {
    case 'started':
      if (typeof r.job_id === 'string') await kickWorker(r.job_id)
      audit(professor, 'studio.build.started', { runId: String(r.run_id), pluginProjectId: String(r.project_id) })
      return { ok: true, value: { runId: String(r.run_id), pluginProjectId: String(r.project_id) } }
    case 'existing':
      return { ok: true, value: { runId: String(r.run_id), pluginProjectId: String(r.project_id) } }
    case 'busy':
      return { ok: false, error: 'Athena is still working on your last request.', conflict: { kind: 'busy', runId: String(r.run_id) } }
    case 'waiting':
      return { ok: false, error: 'Your last request is waiting for you. Answer it, or replace it with this one.', conflict: { kind: 'waiting', runId: String(r.run_id) } }
    case 'limit_daily_runs':
      return { ok: false, error: `You’ve started ${STUDIO_BUILDER_DAILY_RUNS_PER_PROFESSOR} builds in the last day. Try again tomorrow.` }
    case 'limit_live_runs':
      return { ok: false, error: 'Athena is busy for your school right now. Try again in a few minutes.' }
    case 'limit_daily_cost':
      return { ok: false, error: 'Your school has reached today’s limit for building tools. Try again tomorrow.' }
    default:
      return denied()
  }
}

const runInput = z.strictObject({ sectionId: id, runId: id })

export async function stopBuild(input: z.input<typeof runInput>): Promise<ServiceResult<{ status: string }>> {
  const parsed = runInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const run = await ownRun(professor, parsed.data.runId)
  if (!run) return denied()
  // Always allowed: stopping only reduces what runs.
  const r = await db.builderRpcs.stop(run.id, professor.userId, STUDIO_BUILDER_HEARTBEAT_STALE_MS)
  if (!r || r.outcome === 'gone') return denied()
  audit(professor, 'studio.build.stopped', { runId: run.id })
  return { ok: true, value: { status: String(r.outcome) } }
}

const decideInput = z.strictObject({ sectionId: id, runId: id, proposalId: id, deltaHash: z.string().regex(/^[0-9a-f]{64}$/), approve: z.boolean() })

/** Approve or decline one exact approval card. */
export async function decideApproval(input: z.input<typeof decideInput>): Promise<ServiceResult<null>> {
  const parsed = decideInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const run = await ownRun(professor, parsed.data.runId)
  if (!run) return denied()
  const refused = await buildRefused(professor)
  if (refused) return refused
  const r = await db.builderRpcs.decide(run.id, professor.userId, parsed.data.proposalId, parsed.data.deltaHash, parsed.data.approve, STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION)
  if (r?.outcome === 'decided') {
    if (typeof r.job_id === 'string') await kickWorker(r.job_id)
    audit(professor, parsed.data.approve ? 'studio.build.approved' : 'studio.build.declined', { runId: run.id })
    return { ok: true, value: null }
  }
  if (r?.outcome === 'busy') return { ok: false, error: 'Athena is busy for your school right now. Try again in a few minutes.' }
  if (r?.outcome === 'expired') return { ok: false, error: 'This request expired. Your tool is unchanged.' }
  return { ok: false, error: 'This request is no longer waiting for you.' }
}

const answerInput = z.strictObject({
  sectionId: id,
  runId: id,
  questionId: id,
  answer: z.string().trim().min(1).max(STUDIO_BUILDER_ANSWER_MAX_CHARS).refine((s) => characterProblem(s) === null, 'contains a control character'),
})

/** Answer the run's open question; the same run continues with the answer. */
export async function answerQuestion(input: z.input<typeof answerInput>): Promise<ServiceResult<null>> {
  const parsed = answerInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Write your answer in a few sentences.' }
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const run = await ownRun(professor, parsed.data.runId)
  if (!run) return denied()
  const refused = await buildRefused(professor)
  if (refused) return refused
  const r = await db.builderRpcs.answer(run.id, professor.userId, parsed.data.questionId, parsed.data.answer, STUDIO_BUILDER_MAX_LIVE_RUNS_PER_INSTITUTION)
  if (r?.outcome === 'answered') {
    if (typeof r.job_id === 'string') await kickWorker(r.job_id)
    audit(professor, 'studio.build.answered', { runId: run.id })
    return { ok: true, value: null }
  }
  if (r?.outcome === 'busy') return { ok: false, error: 'Athena is busy for your school right now. Try again in a few minutes.' }
  if (r?.outcome === 'expired') return { ok: false, error: 'This question expired. Your tool is unchanged.' }
  return { ok: false, error: 'This question is no longer waiting for you.' }
}

export interface ProgressEvent {
  seq: number
  label: string
  outcome: 'done' | 'refused' | 'error' | 'interrupted'
}

export interface ProgressRead {
  runId: string
  pluginProjectId: string
  status: db.BuilderRunStatus
  phase: string | null
  /** How long a queued run has waited for a worker to pick it up; null once it has started. */
  queuedMs?: number | null
  turns: { used: number; max: number }
  checks: number
  repairRounds: number
  approval: null | { proposalId: string; deltaHash: string; items: string[]; expiresAt: string | null }
  question: null | { id: string; text: string; expiresAt: string | null }
  ending: string | null
  /** The ending's fixed reason code (the run's error code), for the UI to choose a next step. */
  endingReason: string | null
  result: null | {
    summary: string | null
    openQuestions: string[]
    previewHash: string | null
    passed: boolean
    unresolved: { check: string; file: string | null; count: number }[]
    filesChanged: string[]
    /** Course material the builder read, by label. `opensAt` (ISO) is set when it opens to students later. */
    materialRead: { label: string; visible: boolean; opensAt: string | null }[]
  }
  /** Saved decisions: how many the last prompt carried, and the proposals waiting for a yes or no. */
  memory: { applied: number; proposals: MemoryProposalView[] }
  events: ProgressEvent[]
  lastSeq: number
}

export interface MemoryProposalView {
  id: string
  /** What the decision is about, in words: "Content and AI rules: Use of AI". */
  categoryLabel: string
  kindLabel: string
  statement: string
  /** The professor's own words that the proposal rests on. */
  evidence: string
  /** Every saved decision approving this one would replace: none, one, or (a general one it names plus the one in its slot) two. */
  replaces: string[]
}

/** A run that ended in a way the professor may want to keep a decision from. */
const MEMORY_CARD_STATUSES: db.BuilderRunStatus[] = ['preview_ready', 'completed', 'blocked']

const ACTIVE: db.BuilderRunStatus[] = ['queued', 'running', 'waiting_for_approval', 'waiting_for_professor']

/** What a check id means to a professor. */
const CHECK_COPY: Record<string, string> = {
  'builder.compile': 'The code doesn’t compile',
  'builder.typecheck': 'The code uses something the kit doesn’t have',
  'builder.manifest': 'The tool’s settings aren’t valid',
  'builder.purpose_text': 'The tool’s description needs another look',
  'builder.roster': 'A student’s name appears in the tool',
  'kit.required_states': 'A screen is missing its loading, empty or error state',
  'kit.components_only': 'A screen uses something other than kit components',
  'kit.no_hardcoded_style': 'A screen sets its own styles',
  'data.answer_key': 'The student view contains what looks like answers',
  'code.bridge_usage': 'The tool asks for data it hasn’t declared',
}

/** The owner's view of one run: status, the approval card or question, the ending, and
 * fixed-copy progress lines after `afterSeq`. Also does lazy upkeep: an expired card or
 * question ends the run, and a stalled run is requeued. */
export async function readProgress(runId: string, afterSeq: number): Promise<ProgressRead | null> {
  if (!id.safeParse(runId).success) return null
  const userId = await sessionUserId()
  if (!userId) return null
  let run = await db.loadBuilderRun(runId)
  if (!run || run.ownerId !== userId) return null

  if (ACTIVE.includes(run.status)) {
    const tended = await db.builderRpcs.tend(run.id, userId, STUDIO_BUILDER_HEARTBEAT_STALE_MS, STUDIO_BUILDER_MAX_RESUMES)
    if (tended?.outcome === 'requeued' && typeof tended.job_id === 'string') await kickWorker(tended.job_id)
    if (tended && tended.outcome !== 'none') run = (await db.loadBuilderRun(runId)) ?? run
    // A lost kick leaves a queued run waiting for the next sweep: nudge the worker again, once
    // per STUDIO_BUILDER_REKICK_AFTER_MS (the poll that lands first in each window), not on every poll.
    const age = Date.now() - Date.parse(run.createdAt)
    if (run.status === 'queued' && run.jobId && age >= STUDIO_BUILDER_REKICK_AFTER_MS && age % STUDIO_BUILDER_REKICK_AFTER_MS < STUDIO_BUILDER_PROGRESS_POLL_MS) await kickWorker(run.jobId)
  }

  const steps = (await db.listBuilderSteps(run.id, Math.max(0, afterSeq), STUDIO_BUILDER_PROGRESS_EVENTS_MAX)) ?? []
  const events: ProgressEvent[] = []
  for (const s of steps) {
    const code = s.status === 'refused' || s.status === 'error' ? 'step.refused' : s.status === 'interrupted' ? 'step.interrupted' : s.label
    const template = Object.hasOwn(LABELS, code) ? LABELS[code] : null
    if (!template) continue
    const path = typeof s.argsSummary.path === 'string' ? s.argsSummary.path : ''
    const view = path === 'views/student.tsx' ? 'student' : path === 'views/professor.tsx' ? 'professor' : 'tool'
    // An unavailable course search is a step that didn't work, whatever its stored status.
    events.push({ seq: s.seq, label: template.replace('{view}', view), outcome: s.label === 'material.unavailable' ? 'refused' : s.status })
  }

  const proposals = MEMORY_CARD_STATUSES.includes(run.status) ? ((await db.listRunMemoryProposals(run.id, userId)) ?? []) : []

  const pending = run.status === 'waiting_for_approval' ? run.pendingApproval : null
  const openQuestion = run.status === 'waiting_for_professor' ? run.questions.at(-1) : undefined
  const result = run.result
  const checks = (result?.checks ?? null) as { unresolved?: { check_id: string; file: string | null; count: number }[] } | null
  const files = Array.isArray(result?.files) ? (result.files as { path: string; changed: boolean }[]) : []

  return {
    runId: run.id,
    pluginProjectId: run.projectId,
    status: run.status,
    phase: run.phase,
    queuedMs: run.status === 'queued' ? Math.max(0, Date.now() - Date.parse(run.createdAt)) : null,
    turns: { used: run.counters.modelTurns, max: STUDIO_BUILDER_MAX_MODEL_TURNS },
    checks: run.counters.checkRuns,
    repairRounds: run.counters.repairRounds,
    approval: pending
      ? {
          proposalId: String(pending.proposal_id),
          deltaHash: String(pending.delta_hash),
          items: Array.isArray(pending.items) ? (pending.items as { line: string }[]).map((i) => i.line) : [],
          expiresAt: run.waitingUntil,
        }
      : null,
    question: openQuestion && openQuestion.answer === null ? { id: openQuestion.id, text: openQuestion.question, expiresAt: run.waitingUntil } : null,
    ending: ACTIVE.includes(run.status) ? null : endingCopy(run.status, run.errorCode, typeof result?.summary === 'string'),
    endingReason: ACTIVE.includes(run.status) ? null : run.errorCode,
    result: result
      ? {
          summary: typeof result.summary === 'string' ? result.summary : null,
          openQuestions: Array.isArray(result.open_questions) ? (result.open_questions as string[]).slice(0, 5) : [],
          previewHash: run.status === 'preview_ready' ? run.resultHash : null,
          passed: result.passed === true,
          unresolved: (checks?.unresolved ?? []).map((u) => ({ check: CHECK_COPY[u.check_id] ?? 'A check didn’t pass', file: u.file, count: u.count })),
          filesChanged: files.filter((f) => f.changed).map((f) => f.path),
          materialRead: materialReadOf(result.material_read),
        }
      : null,
    memory: {
      applied: typeof result?.memory_applied === 'number' ? result.memory_applied : 0,
      proposals: proposals.map((m) => ({
        id: m.id,
        categoryLabel: categoryLabel(m.topic, m.slot),
        kindLabel: KIND_LABEL[m.kind],
        statement: m.statement,
        evidence: m.evidence ?? '',
        replaces: m.replacesStatements,
      })),
    },
    events,
    lastSeq: steps.at(-1)?.seq ?? afterSeq,
  }
}

/** The result's material_read list, as the ending card shows it. Labels only; at most 8. */
function materialReadOf(raw: unknown): { label: string; visible: boolean; opensAt: string | null }[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 8).flatMap((m) => {
    const e = m as { label?: unknown; visible?: unknown; opens_at?: unknown }
    if (typeof e.label !== 'string') return []
    return [{ label: e.label, visible: e.visible === true, opensAt: typeof e.opens_at === 'string' ? e.opens_at : null }]
  })
}

export interface DraftSummary {
  pluginProjectId: string
  name: string
  hasDraft: boolean
  headHash: string | null
  latestRun: { runId: string; status: db.BuilderRunStatus } | null
  savedVersion: string | null
}

const sectionInput = z.strictObject({ sectionId: id })

/** The professor's own drafts, for the Studio page. */
export async function listDrafts(input: z.input<typeof sectionInput>): Promise<DraftSummary[] | null> {
  const parsed = sectionInput.safeParse(input)
  if (!parsed.success) return null
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return null
  const projects = (await db.listOwnedProjects(professor.userId, professor.institutionId, 30)) ?? []
  const [latest, heads] = await Promise.all([
    db.listLatestRuns(projects.map((p) => p.id)),
    db.loadDraftHeads(projects.flatMap((p) => (p.draftHeadHash ? [{ projectId: p.id, hash: p.draftHeadHash }] : []))),
  ])
  return projects.map((p) => {
    const head = heads.get(p.id)
    const run = latest.get(p.id)
    return {
      pluginProjectId: p.id,
      name: head?.name ?? p.name,
      hasDraft: p.draftHeadHash !== null,
      headHash: p.draftHeadHash,
      latestRun: run ? { runId: run.id, status: run.status } : null,
      savedVersion: head?.savedVersion ?? null,
    }
  })
}

export interface ConversationTurn {
  runId: string
  request: string | null
  status: db.BuilderRunStatus
  ending: string | null
  summary: string | null
  createdAt: string
}

const projectInput = z.strictObject({ sectionId: id, pluginProjectId: id })

/** A project's conversation, oldest first: each request and how its run ended. */
export async function loadConversation(input: z.input<typeof projectInput>): Promise<ConversationTurn[] | null> {
  const parsed = projectInput.safeParse(input)
  if (!parsed.success) return null
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return null
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return null
  const runs = (await db.listProjectRuns(project.id, 20)) ?? []
  return runs.reverse().map((r) => ({
    runId: r.id,
    request: r.request,
    status: r.status,
    ending: ACTIVE.includes(r.status) ? null : endingCopy(r.status, r.errorCode),
    summary: typeof r.result?.summary === 'string' ? r.result.summary : null,
    createdAt: r.createdAt,
  }))
}

const previewInput = z.strictObject({ sectionId: id, pluginProjectId: id, snapshotHash: z.string().regex(/^[0-9a-f]{64}$/), view: z.enum(['student', 'professor']) })

/** A signed frame URL for one view of one of the professor's own draft snapshots, with
 * the Bridge methods its manifest allows. The frame runs on the in-memory preview bridge
 * with sample records: no real records, no publication, nothing students can see. */
export async function issueDraftPreview(
  input: z.input<typeof previewInput>,
): Promise<ServiceResult<{ frameUrl: string; allowedMethods: string[]; manifest: StudioManifest; title: string }>> {
  const parsed = previewInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return denied()
  if ((await studioAccess(professor.institutionId)) === 'off') return { ok: false, error: STUDIO_PAUSED }
  const snapshot = await db.loadSnapshot(project.id, parsed.data.snapshotHash)
  const manifest = snapshot ? parseManifest(snapshot.manifest) : null
  if (!snapshot || !manifest?.ok) return denied()
  const view = parsed.data.view as PluginView
  const frameUrl = draftFrameUrl(project.id, snapshot.hash, view)
  if (!frameUrl) return { ok: false, error: 'Previews aren’t available here right now.' }
  return { ok: true, value: { frameUrl, allowedMethods: allowedBridgeMethods(manifest.manifest, view), manifest: manifest.manifest, title: manifest.manifest.name } }
}

/** Save the current draft as a new immutable version: human-only (lifecycle.publishDraft). */
export async function saveDraftAsVersion(input: { sectionId: string; pluginProjectId: string; snapshotHash: string }): Promise<ServiceResult<{ versionId: string; version: string }>> {
  const r = await publishDraft({ sectionId: input.sectionId, projectId: input.pluginProjectId, snapshotHash: input.snapshotHash })
  return r.ok ? r : { ok: false, error: r.error }
}

/** What the Save card offers next for a saved version. */
export interface VersionRelease {
  /** add: the course doesn't have this tool. use: it has another version. current: it already uses this one. */
  mode: 'add' | 'use' | 'current'
  /** Students can see the tool, so a switch reaches them at once. */
  visible: boolean
  /** The course's installation of this tool, when it has one: the blocked card links to it. */
  installationId: string | null
  card: PluginCard
  /** use only: what this version can do that the course's version can't (rule 8.2). */
  added: string[]
}

/** The saved version's place in the course and its plugin card. Owner only. */
export async function versionRelease(input: { sectionId: string; versionId: string }): Promise<ServiceResult<VersionRelease>> {
  const placement = await versionPlacement(input)
  if (!placement.ok) return placement
  const { mode, installationId, visible } = placement.value
  const installation = installationId ? await db.loadInstallation(installationId) : null
  const [version, current] = await Promise.all([db.loadVersion(input.versionId), installation ? db.loadVersion(installation.currentVersionId) : null])
  const manifest = version ? parseManifest(version.manifest) : null
  if (!manifest?.ok) return { ok: false, error: 'This version can’t be used.' }
  const card = buildPluginCard(manifest.manifest, null)
  const previous = current ? parseManifest(current.manifest) : null
  return { ok: true, value: { mode, visible, installationId, card, added: mode === 'use' && previous?.ok ? cardAdditions(card, buildPluginCard(previous.manifest, null)) : [] } }
}

export type AddToCourseResult =
  | { ok: true; value: { installationId: string; added: boolean; checks: string } }
  | { ok: false; error: string; blockers?: Issue<BlockerCode>[]; warnings?: Issue<WarningCode>[] }

/**
 * Add to this course / Use this version in the course, then start Studio's browser checks
 * on their own (within quota). The checks' answer never undoes the step: when they can't
 * start, the professor is told why and the tool page keeps its "Run browser checks" button.
 */
export async function addSavedVersionToCourse(input: { sectionId: string; versionId: string; acknowledgeWarnings?: boolean }): Promise<AddToCourseResult> {
  const placed = await addVersionToCourse(input)
  if (!placed.ok) return { ok: false, error: placed.error, blockers: placed.blockers, warnings: placed.warnings }
  const checks = await requestRuntimeValidation({ sectionId: input.sectionId, installationId: placed.value.installationId })
  const said = !checks.ok
    ? await whyChecksDidNotStart(input.versionId, checks.error)
    : checks.status === 'running'
      ? 'Studio’s automatic checks are running. This can take a few minutes.'
      : checks.status === 'passed'
        ? 'Studio’s automatic checks have passed.'
        : 'Studio’s automatic checks didn’t finish. You can run them again from the tool’s page.'
  return { ok: true, value: { installationId: placed.value.installationId, added: placed.value.added, checks: said } }
}

/** When the browser checks can't start, the reason in terms of what the professor waits for. */
async function whyChecksDidNotStart(versionId: string, refusal: string): Promise<string> {
  const verdict = await currentVerdict(versionId)
  if (verdict.status === 'needs_review') return 'Studio’s checks are waiting for a Scholera reviewer. You don’t need to do anything until they decide.'
  if (verdict.status === 'failed') return 'This version didn’t pass Studio’s automatic checks. The tool’s page lists what to fix.'
  // Stage 1 still to finish or to run again: not something to retry from here. Quota and
  // cooldown refusals keep their own words, which say when to try.
  if (verdict.status === 'unavailable' && ['checking', 'not_checked', 'validator_error', 'below_minimum_ruleset'].includes(verdict.reason)) {
    return 'Studio’s checks haven’t finished yet. The tool’s page shows where they are.'
  }
  return refusal
}

export interface DraftHistoryEntry {
  hash: string
  runId: string
  /** The professor's own request, shortened. Never model-written text. */
  request: string | null
  createdAt: string | null
  current: boolean
  undoTarget: boolean
  savedVersion: string | null
}

export interface DraftHistory {
  entries: DraftHistoryEntry[]
  /** What an undo must name: the draft the professor is looking at. */
  head: { hash: string | null; rev: number }
  canUndo: boolean
}

/** The project's drafts, newest first: which is current, which Undo goes back to, and
 * which were saved as versions. Owner only. */
export async function listDraftHistory(input: z.input<typeof projectInput>): Promise<DraftHistory | null> {
  const parsed = projectInput.safeParse(input)
  if (!parsed.success) return null
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return null
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return null
  const rows = await db.listDraftHistory(project.id, STUDIO_BUILDER_DRAFT_HISTORY_MAX)
  if (!rows) return null
  const max = STUDIO_BUILDER_DRAFT_HISTORY_REQUEST_MAX_CHARS
  return {
    entries: rows.map((r) => ({
      hash: r.hash,
      runId: r.runId,
      request: r.request && r.request.length > max ? `${r.request.slice(0, max - 1).trimEnd()}…` : r.request,
      createdAt: r.snapshotCreatedAt,
      current: r.hash === project.draftHeadHash,
      undoTarget: r.hash === project.draftUndoHash,
      savedVersion: r.savedVersion,
    })),
    head: { hash: project.draftHeadHash, rev: project.draftRev },
    canUndo: project.status === 'active' && project.draftUndoHash !== null,
  }
}

const undoInput = z.strictObject({
  sectionId: id,
  pluginProjectId: id,
  expectedHead: z.string().regex(/^[0-9a-f]{64}$/),
  expectedRev: z.number().int().min(0),
})

/** Undo the last build: the draft goes back to the one before it. One step, by
 * compare-and-swap on the draft the professor was looking at. Nothing is deleted, and no
 * version, installation or student view changes. Owner only. */
export async function undoDraft(input: z.input<typeof undoInput>): Promise<ServiceResult<{ headHash: string; rev: number }>> {
  const parsed = undoInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return denied()
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }

  const r = await db.builderRpcs.undo(project.id, professor.userId, parsed.data.expectedHead, parsed.data.expectedRev)
  switch (r?.outcome) {
    case 'undone':
      audit(professor, 'studio.draft.undone', { projectId: project.id, fromHash: parsed.data.expectedHead.slice(0, 16), toHash: String(r.head).slice(0, 16) })
      return { ok: true, value: { headHash: String(r.head), rev: Number(r.rev) } }
    case 'busy':
      return { ok: false, error: 'Athena is still working on this tool. Wait for it to finish, or stop it, then undo.' }
    case 'draft_changed':
      return { ok: false, error: 'This draft changed since you opened it. Look at the latest draft, then try again.' }
    case 'unavailable':
      return { ok: false, error: 'There’s no earlier draft to go back to.' }
    case 'archived':
      return { ok: false, error: 'This tool was archived, so its draft can’t change.' }
    default:
      return denied()
  }
}

// ── Project memory ───────────────────────────────────────────────────
// The professor's lasting decisions about one tool. Owner only, like every builder read.
// The model reaches memory through propose_memory alone; a proposal is inert until the
// professor approves that exact row here.

export interface MemoryItem {
  id: string
  topic: MemoryTopic
  slot: MemorySlot
  /** What the decision is about, in words: "Content and AI rules: Use of AI". */
  categoryLabel: string
  kind: MemoryKind
  kindLabel: string
  statement: string
  updatedAt: string
}

const STATEMENT_COPY: Record<StatementProblem, string> = {
  length: `Write one sentence of up to ${STUDIO_MEMORY_STATEMENT_MAX_CHARS} characters.`,
  characters: 'Use plain text only.',
  format: 'Use plain text on one line, without angle brackets.',
  meta: 'Describe how the tool should look or behave, not how Athena builds it.',
}

/** Whether the professor may change memory now: Studio is on and the school is entitled. */
async function memoryRefused(professor: StudioProfessor): Promise<{ ok: false; error: string } | null> {
  const access = await studioAccess(professor.institutionId)
  if (access === 'off') return { ok: false, error: STUDIO_PAUSED }
  if (access === 'read_only') return { ok: false, error: entitlementRefusalMessage('studio') }
  return null
}

const memoryProjectInput = z.strictObject({ sectionId: id, pluginProjectId: id })

/** A tool's active saved decisions, oldest first. Null when the tool isn't the professor's or can't be read. */
export async function listProjectMemories(input: z.input<typeof memoryProjectInput>): Promise<MemoryItem[] | null> {
  const parsed = memoryProjectInput.safeParse(input)
  if (!parsed.success) return null
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return null
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return null
  if ((await studioAccess(professor.institutionId)) === 'off') return null
  const rows = await db.listActiveMemories(project.id, project.institutionId)
  if (!rows) return null
  return rows.map((m) => ({
    id: m.id,
    topic: m.topic,
    slot: m.slot,
    categoryLabel: categoryLabel(m.topic, m.slot),
    kind: m.kind,
    kindLabel: KIND_LABEL[m.kind],
    statement: m.statement,
    updatedAt: m.updatedAt,
  }))
}

const saveMemoryInput = z
  .strictObject({
    sectionId: id,
    pluginProjectId: id,
    topic: z.enum(MEMORY_TOPICS),
    slot: z.enum(MEMORY_SLOT_KEYS),
    kind: z.enum(MEMORY_KINDS),
    statement: z.string().trim(),
    /** The decision being edited. The edit is a new row that supersedes it. */
    replaceId: id.nullable(),
  })
  .refine((v) => isSlotOf(v.topic, v.slot), 'that slot is not one of the topic’s slots')

/** Add a decision, or edit one. The professor is the author, so there is no confirmation step. */
export async function saveProjectMemory(input: z.input<typeof saveMemoryInput>): Promise<ServiceResult<{ id: string }>> {
  const parsed = saveMemoryInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return denied()
  const problem = statementProblem(parsed.data.statement)
  if (problem) return { ok: false, error: STATEMENT_COPY[problem] }
  const refused = await memoryRefused(professor)
  if (refused) return refused
  const r = await db.memoryRpcs.save(project.id, professor.userId, parsed.data.topic, parsed.data.slot, parsed.data.kind, parsed.data.statement, parsed.data.replaceId, STUDIO_MEMORY_MAX_ACTIVE)
  switch (r?.outcome) {
    case 'saved':
      audit(professor, 'studio.memory.saved', { pluginProjectId: project.id, memoryId: String(r.id), topic: parsed.data.topic, slot: parsed.data.slot })
      return { ok: true, value: { id: String(r.id) } }
    case 'unchanged':
      return { ok: true, value: { id: String(r.id) } }
    case 'full':
      return { ok: false, error: `This tool already keeps ${STUDIO_MEMORY_MAX_ACTIVE} decisions. Remove one first.` }
    case 'archived':
      return { ok: false, error: 'This tool was archived, so it can’t keep new decisions.' }
    default:
      return denied()
  }
}

const removeMemoryInput = z.strictObject({ sectionId: id, pluginProjectId: id, memoryId: id })

export async function removeProjectMemory(input: z.input<typeof removeMemoryInput>): Promise<ServiceResult<null>> {
  const parsed = removeMemoryInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const project = await ownProject(professor, parsed.data.pluginProjectId)
  if (!project) return denied()
  const refused = await memoryRefused(professor)
  if (refused) return refused
  const r = await db.memoryRpcs.remove(parsed.data.memoryId, professor.userId, project.id)
  if (r?.outcome !== 'removed') return { ok: false, error: 'That decision is already gone.' }
  audit(professor, 'studio.memory.removed', { pluginProjectId: project.id, memoryId: parsed.data.memoryId })
  return { ok: true, value: null }
}

const decideMemoryInput = z.strictObject({ sectionId: id, runId: id, memoryId: id, approve: z.boolean() })

/** Approve or decline one proposal Athena raised in one of the professor's own builds. */
export async function decideMemoryProposal(input: z.input<typeof decideMemoryInput>): Promise<ServiceResult<null>> {
  const parsed = decideMemoryInput.safeParse(input)
  if (!parsed.success) return denied()
  const professor = await requireProfessor(parsed.data.sectionId)
  if (!professor) return denied()
  const run = await ownRun(professor, parsed.data.runId)
  if (!run) return denied()
  const refused = await memoryRefused(professor)
  if (refused) return refused
  const r = await db.memoryRpcs.decide(parsed.data.memoryId, run.id, professor.userId, parsed.data.approve, STUDIO_MEMORY_MAX_ACTIVE, STUDIO_MEMORY_PROPOSAL_TTL_MS)
  switch (r?.outcome) {
    case 'decided':
      audit(professor, parsed.data.approve ? 'studio.memory.approved' : 'studio.memory.declined', { runId: run.id, memoryId: parsed.data.memoryId })
      return { ok: true, value: null }
    case 'full':
      return { ok: false, error: `This tool already keeps ${STUDIO_MEMORY_MAX_ACTIVE} decisions. Remove one first.` }
    case 'archived':
      return { ok: false, error: 'This tool was archived, so it can’t keep new decisions.' }
    default:
      return { ok: false, error: 'This suggestion is no longer waiting for you.' }
  }
}
