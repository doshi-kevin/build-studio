/**
 * An in-memory stand-in for the builder's database functions, for the hermetic harness
 * suite. It enforces the same rules the SQL functions do (claim token, Stop, working
 * copy revision, caps, one step per tool_call_id, the commit compare-and-swap, one-step
 * undo), so the
 * harness can be tested without a database. The SQL itself is tested against real
 * Postgres in src/__tests__/db/studio-builder.test.ts.
 */
import { randomUUID } from 'node:crypto'
import type { ApplyArgs, BuilderRunRow, BuilderRunStatus, EndArgs, PauseArgs } from '@/lib/studio/db'
import type { RunStore } from '@/lib/studio/builder/harness'
import type { StepView } from '@/lib/studio/builder/context-builder'

const TERMINAL: BuilderRunStatus[] = ['preview_ready', 'completed', 'blocked', 'cancelled', 'budget_exhausted', 'failed']

export interface MemoryProject {
  id: string
  draftHeadHash: string | null
  draftRev: number
  draftUndoHash: string | null
}

export interface MemoryState {
  run: BuilderRunRow
  token: string | null
  heartbeatAt: number
  steps: (StepView & { label: string })[]
  project: MemoryProject
  snapshots: Map<string, Record<string, unknown>>
  jobs: { id: string; sliceNo: number }[]
}

export function newRun(overrides: Partial<BuilderRunRow> = {}): BuilderRunRow {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    institutionId: randomUUID(),
    ownerId: randomUUID(),
    sectionId: randomUUID(),
    request: 'Build flashcards',
    status: 'queued',
    phase: null,
    errorCode: null,
    plan: null,
    work: null,
    pendingApproval: null,
    questions: [],
    waitingUntil: null,
    result: null,
    baseHash: null,
    baseRev: 0,
    resultHash: null,
    counters: {
      modelTurns: 0, toolCalls: 0, writes: 0, bytesWritten: 0, repairRounds: 0, checkRuns: 0,
      consecutiveErrors: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, activeMs: 0,
    },
    sliceNo: 1,
    resumeCount: 0,
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  }
}

/** `shared` lets several runs of one project share its pointer and snapshots, as
 * successive builds do. */
export function createMemoryStore(
  run: BuilderRunRow,
  project?: Partial<MemoryProject>,
  shared?: { project: MemoryProject; snapshots: Map<string, Record<string, unknown>> },
) {
  const state: MemoryState = {
    run: structuredClone(run),
    token: null,
    heartbeatAt: 0,
    steps: [],
    project: shared?.project ?? { id: run.projectId, draftHeadHash: run.baseHash, draftRev: run.baseRev, draftUndoHash: null, ...project },
    snapshots: shared?.snapshots ?? new Map(),
    jobs: [],
  }
  const nextSeq = () => (state.steps.at(-1)?.seq ?? 0) + 1
  const insertStep = (step: Record<string, unknown>): number | null => {
    if (state.steps.some((s) => s.toolCallId === step.tool_call_id)) return null
    const seq = nextSeq()
    state.steps.push({
      seq,
      kind: String(step.kind),
      toolCallId: String(step.tool_call_id),
      tool: (step.tool as string | null) ?? null,
      status: String(step.status),
      label: String(step.label),
      argsSummary: (step.args_summary as Record<string, unknown>) ?? {},
      resultSummary: (step.result_summary as Record<string, unknown>) ?? {},
    })
    return seq
  }
  const fence = (token: string): { ok: false; reason: string } | null => {
    if (state.run.status !== 'running' || state.token !== token) return { ok: false, reason: 'fence' }
    if (state.run.cancelRequested) return { ok: false, reason: 'cancelled' }
    return null
  }
  const close = (status: BuilderRunStatus, code: string | null) => {
    state.run.status = status
    state.run.errorCode = code
    state.run.work = null
    state.token = null
    state.run.pendingApproval = null
    state.run.result = { format: 'studio-builder-result-v1', status, reason: code ?? 'stopped', sqlEnded: true }
    state.run.endedAt = new Date().toISOString()
    insertStep({ kind: 'system', tool_call_id: `sys:${status}:${nextSeq()}`, status: 'done', label: `run.${status}` })
  }
  const queueSlice = () => {
    const job = { id: randomUUID(), sliceNo: state.run.sliceNo }
    state.jobs.push(job)
    return job.id
  }
  state.jobs.push({ id: randomUUID(), sliceNo: 1 })

  const store: RunStore = {
    async claim(runId, _jobId, sliceNo) {
      if (runId !== state.run.id || sliceNo !== state.run.sliceNo) return null
      if (state.run.status === 'queued' || (state.run.status === 'running' && Date.now() - state.heartbeatAt > 60_000)) {
        if (state.run.status === 'running') state.run.resumeCount += 1
        state.run.status = 'running'
        state.token = randomUUID()
        state.heartbeatAt = Date.now()
        state.run.phase ??= 'understanding'
        insertStep({ kind: 'system', tool_call_id: `sys:claim:${sliceNo}:${state.run.resumeCount}`, status: 'done', label: sliceNo === 1 ? 'run.started' : 'run.slice', args_summary: { event: 'claimed' } })
        return state.token
      }
      return null
    },
    async heartbeat(_runId, token) {
      if (state.run.status !== 'running' || state.token !== token) return { fenceLost: true, cancelRequested: false }
      state.heartbeatAt = Date.now()
      return { fenceLost: false, cancelRequested: state.run.cancelRequested }
    },
    async loadRun() {
      return structuredClone(state.run)
    },
    async loadSteps() {
      return structuredClone(state.steps)
    },
    async addCost(_runId, u) {
      state.run.counters.inputTokens += u.input
      state.run.counters.outputTokens += u.output
      state.run.counters.costUsd += u.costUsd
    },
    async recordTurn(_runId, token, step, activeMs, refused) {
      const f = fence(token)
      if (f) return f
      const seq = insertStep(step)
      state.run.counters.modelTurns += 1
      if (refused) state.run.counters.consecutiveErrors += 1
      state.run.counters.activeMs += activeMs
      return { ok: true, seq }
    },
    async apply(a: ApplyArgs) {
      const f = fence(a.token)
      if (f) return f
      const existing = state.steps.find((s) => s.toolCallId === a.step.tool_call_id)
      if (existing) return { ok: true, duplicate: true, result_summary: existing.resultSummary }
      const rev = state.run.work ? Number((state.run.work as { work_rev: number }).work_rev) : -1
      if (a.work && rev !== a.expectedWorkRev) return { ok: false, reason: 'stale_work' }
      const d = a.delta as Record<string, number | boolean | undefined>
      const c = state.run.counters
      const add = (k: string) => Number(d[k] ?? 0)
      if (c.toolCalls + add('tool_calls') > a.caps.tool_calls) return { ok: false, reason: 'limit_tool_calls' }
      if (c.writes + add('writes') > a.caps.writes) return { ok: false, reason: 'limit_writes' }
      if (c.bytesWritten + add('bytes_written') > a.caps.bytes_written) return { ok: false, reason: 'limit_bytes' }
      if (c.checkRuns + add('check_runs') > a.caps.check_runs) return { ok: false, reason: 'check_runs' }
      if (c.repairRounds + add('repair_rounds') > a.caps.repair_rounds) return { ok: false, reason: 'repair_rounds' }
      const seq = insertStep(a.step)
      if (a.work) state.run.work = structuredClone(a.work)
      if (a.plan) state.run.plan = structuredClone(a.plan)
      if (a.phase) state.run.phase = a.phase
      c.toolCalls += add('tool_calls')
      c.writes += add('writes')
      c.bytesWritten += add('bytes_written')
      c.checkRuns += add('check_runs')
      c.repairRounds += add('repair_rounds')
      if (d.error === true) c.consecutiveErrors += 1
      else if (d.error === false) c.consecutiveErrors = 0
      c.activeMs += a.activeMs
      return { ok: true, seq }
    },
    async pause(a: PauseArgs) {
      const f = fence(a.token)
      if (f) return f
      insertStep(a.step)
      for (const s of a.interrupted) insertStep(s)
      state.run.status = a.pending ? 'waiting_for_approval' : 'waiting_for_professor'
      state.run.pendingApproval = a.pending ? structuredClone(a.pending) : null
      if (a.question) state.run.questions = [...state.run.questions, structuredClone(a.question) as BuilderRunRow['questions'][number]]
      state.run.counters.toolCalls += 1
      state.run.counters.writes += Number(a.delta.writes ?? 0)
      state.run.counters.bytesWritten += Number(a.delta.bytes_written ?? 0)
      state.token = null
      return { ok: true }
    },
    async handoff(_runId, token) {
      const f = fence(token)
      if (f) return { outcome: f.reason }
      state.run.status = 'queued'
      state.run.sliceNo += 1
      state.token = null
      return { outcome: 'queued', job_id: queueSlice() }
    },
    async end(a: EndArgs) {
      if (state.run.status !== 'running' || state.token !== a.token) return { outcome: 'fence' }
      if (state.run.cancelRequested && a.status !== 'cancelled') {
        close('cancelled', null)
        return { outcome: 'cancelled' }
      }
      let hash: string | null = null
      if (a.snapshot) {
        if (state.project.draftRev !== state.run.baseRev) {
          close('blocked', 'draft_changed')
          return { outcome: 'conflict' }
        }
        hash = String(a.snapshot.hash)
        if (!state.snapshots.has(hash)) state.snapshots.set(hash, structuredClone(a.snapshot))
        if (state.project.draftHeadHash !== hash) state.project.draftUndoHash = state.project.draftHeadHash
        state.project.draftHeadHash = hash
        state.project.draftRev += 1
      }
      state.run.status = a.status
      state.run.errorCode = a.errorCode
      state.run.result = structuredClone(a.result)
      state.run.resultHash = hash
      state.run.work = null
      state.token = null
      insertStep({ kind: 'system', tool_call_id: 'sys:ended', status: 'done', label: `run.${a.status}` })
      return { outcome: 'ended' }
    },
  }

  /** The professor's side, as the SQL functions do it. */
  const professor = {
    stop() {
      if (state.run.status === 'running') state.run.cancelRequested = true
      else if (!TERMINAL.includes(state.run.status)) close('cancelled', null)
    },
    decide(proposalId: string, deltaHash: string, approve: boolean): 'decided' | 'gone' {
      const p = state.run.pendingApproval
      if (state.run.status !== 'waiting_for_approval' || !p || p.proposal_id !== proposalId || p.delta_hash !== deltaHash) return 'gone'
      if (insertStep({ kind: 'approval', tool_call_id: `approval:${proposalId}`, status: 'done', label: approve ? 'approval.approved' : 'approval.declined', result_summary: { decision: approve ? 'approved' : 'declined' } }) === null) return 'gone'
      const work = state.run.work as Record<string, unknown> & { work_rev: number; delta: Record<string, unknown[]> }
      if (approve) {
        work.manifest = p.proposed_manifest
        work.work_rev += 1
        work.delta.approved = [...(work.delta.approved ?? []), ...((p.items as unknown[]) ?? [])]
        work.delta.direct = [...(work.delta.direct ?? []), ...((p.direct as unknown[]) ?? [])]
      } else {
        work.delta.declined = [...(work.delta.declined ?? []), ...((p.items as unknown[]) ?? [])]
      }
      state.run.pendingApproval = null
      state.run.status = 'queued'
      state.run.sliceNo += 1
      queueSlice()
      return 'decided'
    },
    answer(questionId: string, answer: string): 'answered' | 'gone' {
      const last = state.run.questions.at(-1)
      if (state.run.status !== 'waiting_for_professor' || !last || last.id !== questionId || last.answer !== null) return 'gone'
      last.answer = answer
      insertStep({ kind: 'answer', tool_call_id: `answer:${questionId}`, status: 'done', label: 'question.answered' })
      state.run.status = 'queued'
      state.run.sliceNo += 1
      queueSlice()
      return 'answered'
    },
    /** Another writer moves the draft while the run works. */
    moveHead() {
      state.project.draftRev += 1
    },
    /** studio_builder_undo, for a project whose only run is this one. */
    undo(expectedHead: string, expectedRev: number): Record<string, unknown> {
      if (!TERMINAL.includes(state.run.status)) return { outcome: 'busy' }
      const p = state.project
      if (p.draftHeadHash !== expectedHead || p.draftRev !== expectedRev) return { outcome: 'draft_changed' }
      if (p.draftUndoHash === null) return { outcome: 'unavailable' }
      p.draftHeadHash = p.draftUndoHash
      p.draftUndoHash = null
      p.draftRev += 1
      return { outcome: 'undone', head: p.draftHeadHash, rev: p.draftRev }
    },
  }

  return { store, state, professor, currentJob: () => state.jobs.at(-1)! }
}
