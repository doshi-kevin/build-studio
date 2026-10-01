// suggest.ts — buildAndSaveSuggestionsForAssignment skip paths. All collaborators
// (ingest, signals, graders, answer-key, validations) are mocked so the test drives
// the orchestrator's branching directly. Pins the two E9/E5-E6 drops that must reach
// onSkipped instead of silently under-counting the batch:
//   - ingest yields no gradable content → onSkipped('no text or supported files ...')
//   - the version-guarded RPC rejects (submission moved on) → onSkipped('graded or resubmitted ...')

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ingestSubmissionMock = vi.fn()
const buildGradingContextsMock = vi.fn()
const suggestGradeFromContextMock = vi.fn()

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/assignments/ai-grading/ingest', () => ({
  ingestSubmission: (...a: unknown[]) => ingestSubmissionMock(...a),
}))
vi.mock('@/lib/assignments/ai-grading/signals', () => ({
  buildGradingContexts: (...a: unknown[]) => buildGradingContextsMock(...a),
}))
vi.mock('@/lib/assignments/ai-grading/grader', () => ({
  buildGraderSystemPrompt: () => 'sys',
  suggestGradeFromContext: (...a: unknown[]) => suggestGradeFromContextMock(...a),
}))
vi.mock('@/lib/assignments/ai-grading/similarity-grader', () => ({
  suggestGradeFromSignals: vi.fn(),
}))
vi.mock('@/lib/assignments/ai-grading/hybrid-grader', () => ({
  suggestGradeHybrid: vi.fn(),
}))
vi.mock('@/lib/assignments/ai-grading/answer-key', () => ({
  loadAnswerKeyText: vi.fn().mockResolvedValue(null),
  loadRubricAi: vi.fn().mockResolvedValue({ approved: { criteria: {}, questions: {} } }),
}))
vi.mock('@/lib/assignments/ai-grading/mode', () => ({ aiGradingMode: () => 'default' }))
vi.mock('@/lib/validations/assignment', () => ({
  parseRubric: () => ({ questions: [{ label: 'Q1', points: 10, criteria: [{ description: 'c', points: 10 }] }] }),
  mergeRubricAi: (r: unknown) => r,
  rubricHasReferences: () => true,
  parseAiGradingState: () => ({ status: 'ready' }),
  gradedRubricTotal: () => 10,
}))

import { buildAndSaveSuggestionsForAssignment } from '@/lib/assignments/ai-grading/suggest'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'

const SUGGESTION: AiGradeSuggestion = {
  criteria: [],
  suggestedRubricScores: [],
  suggestedScore: 8,
  feedback: 'fb',
  confidence: 'high',
  flaggedCount: 0,
  unmappedQuestionIndexes: [],
  model: 'test',
}

/**
 * Fake admin client:
 *  - the submissions select returns `submissions`.
 *  - rpc('upsert_ai_grade_suggestion_if_current') returns `rpcData`: the stamped
 *    updated_at (string) when written, null when the submission moved on and the
 *    guarded write was rejected.
 */
const RPC_VERSION = '2026-09-07T17:30:00+00:00'
function fakeAdmin(opts: {
  submissions: { id: string; student_id: string; text_content: string | null; files: unknown; updated_at: string }[]
  rpcData?: string | null
}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ data: opts.submissions, error: null }),
        })),
      })),
    })),
    rpc: vi.fn().mockResolvedValue({ data: opts.rpcData === undefined ? RPC_VERSION : opts.rpcData, error: null }),
  } as never
}

const ARGS = {
  institutionId: 'inst-1',
  sectionId: 'sec-1',
  assignment: { id: 'a-1', points: 10, settings: {} },
  userId: 'u-1',
}

function contextMapFor(ids: string[]) {
  const map = new Map()
  for (const id of ids) {
    map.set(id, {
      mode: 'whole',
      criteria: [{ key: '0:0', questionIndex: 0, points: 10 }],
      wholeText: 'x',
      regions: null,
      submissionText: 'x',
      degraded: false,
    })
  }
  return map
}

beforeEach(() => {
  ingestSubmissionMock.mockReset()
  buildGradingContextsMock.mockReset()
  suggestGradeFromContextMock.mockReset()
})

describe('buildAndSaveSuggestionsForAssignment — skip paths', () => {
  it('emits onSkipped when ingest yields no gradable content (E9 drop, not silent)', async () => {
    ingestSubmissionMock.mockResolvedValue({ text: null, notebooks: [] })
    const admin = fakeAdmin({
      submissions: [{ id: 's1', student_id: 'st1', text_content: null, files: [], updated_at: 't0' }],
    })
    const onSkipped = vi.fn()
    const res = await buildAndSaveSuggestionsForAssignment({ ...ARGS, adminDb: admin, onSkipped })
    expect(res).toEqual({ count: 0 })
    expect(onSkipped).toHaveBeenCalledWith('s1', 'no text or supported files to grade')
  })

  it('emits onSkipped when the version-guarded RPC rejects a stale draft (E5/E6)', async () => {
    ingestSubmissionMock.mockResolvedValue({ text: 'answer', notebooks: [] })
    buildGradingContextsMock.mockResolvedValue(contextMapFor(['s1']))
    suggestGradeFromContextMock.mockResolvedValue(SUGGESTION)
    // rpcData=null → the submission was graded/resubmitted during the LLM call.
    const admin = fakeAdmin({
      submissions: [{ id: 's1', student_id: 'st1', text_content: 'answer', files: [], updated_at: 't0' }],
      rpcData: null,
    })
    const onSkipped = vi.fn()
    const res = await buildAndSaveSuggestionsForAssignment({ ...ARGS, adminDb: admin, onSkipped })
    expect(res).toEqual({ count: 0 })
    expect(onSkipped).toHaveBeenCalledWith('s1', 'graded or resubmitted while grading')
  })

  it('emits onSkipped when the grader returns null (AI grading failed)', async () => {
    ingestSubmissionMock.mockResolvedValue({ text: 'answer', notebooks: [] })
    buildGradingContextsMock.mockResolvedValue(contextMapFor(['s1']))
    suggestGradeFromContextMock.mockResolvedValue(null)
    const admin = fakeAdmin({
      submissions: [{ id: 's1', student_id: 'st1', text_content: 'answer', files: [], updated_at: 't0' }],
    })
    const onSkipped = vi.fn()
    const res = await buildAndSaveSuggestionsForAssignment({ ...ARGS, adminDb: admin, onSkipped })
    expect(res).toEqual({ count: 0 })
    expect(onSkipped).toHaveBeenCalledWith('s1', 'AI grading failed')
  })

  it('counts and emits onSuggestion on the happy path (persist-then-emit)', async () => {
    ingestSubmissionMock.mockResolvedValue({ text: 'answer', notebooks: [] })
    buildGradingContextsMock.mockResolvedValue(contextMapFor(['s1']))
    suggestGradeFromContextMock.mockResolvedValue(SUGGESTION)
    const admin = fakeAdmin({
      submissions: [{ id: 's1', student_id: 'st1', text_content: 'answer', files: [], updated_at: 't0' }],
      rpcData: RPC_VERSION,
    })
    const onSuggestion = vi.fn()
    const onSkipped = vi.fn()
    const res = await buildAndSaveSuggestionsForAssignment({
      ...ARGS,
      adminDb: admin,
      onSuggestion,
      onSkipped,
    })
    expect(res).toEqual({ count: 1 })
    // Third arg = the draft version stamped by the RPC, threaded to the stream so the
    // client can echo it back on grade save (correction capture's ghost-diff guard).
    expect(onSuggestion).toHaveBeenCalledWith('s1', SUGGESTION, RPC_VERSION)
    expect(onSkipped).not.toHaveBeenCalled()
  })
})
