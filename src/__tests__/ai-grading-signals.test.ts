// signals.ts — buildGradingContexts. Pinecone (fetch + embed) is mocked. Pins the
// degrade paths and, most importantly, the tenant-scoping RETHROW: a tenant-mismatch
// error from fetchRubricReferenceVectors must PROPAGATE (abort the batch) rather than
// be swallowed into a silent "similarity null" grade against the wrong tenant's data.
//
// Mode matters: the production default 'v9' strips signals for whole-mode students, so
// the signal-blind degrade cases run under AI_GRADING_MODE=default (a signals-using
// mode). Env is set per-describe and restored after.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchRubricReferenceVectorsMock = vi.fn()
const embedTextsBatchMock = vi.fn()

vi.mock('@/lib/pinecone/data', () => ({
  fetchRubricReferenceVectors: (...a: unknown[]) => fetchRubricReferenceVectorsMock(...a),
}))
vi.mock('@/lib/pinecone/embed', () => ({
  embedTextsBatch: (...a: unknown[]) => embedTextsBatchMock(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { buildGradingContexts } from '@/lib/assignments/ai-grading/signals'
import type { AssignmentRubric } from '@/lib/validations/assignment'

// A minimal one-question, one-criterion rubric with a reference answer.
const RUBRIC: AssignmentRubric = {
  questions: [
    {
      label: 'Q1',
      points: 10,
      criteria: [{ description: 'explains recursion', points: 10, referenceAnswer: 'recursion calls itself' }],
    },
  ],
}

const IDS = { institutionId: 'inst-1', sectionId: 'sec-1', assignmentId: 'a-1' }

function student(text: string | null, submissionId = 's1') {
  return { submissionId, text, notebooks: [] }
}

beforeEach(() => {
  fetchRubricReferenceVectorsMock.mockReset()
  embedTextsBatchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildGradingContexts — tenant-scoping rethrow (security)', () => {
  it('PROPAGATES a tenant-mismatch throw from fetchRubricReferenceVectors (not swallowed)', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'default')
    fetchRubricReferenceVectorsMock.mockRejectedValue(
      new Error('pinecone: tenant mismatch in fetchRubricReferenceVectors — scoping bug'),
    )
    await expect(
      buildGradingContexts({ ...IDS, rubric: RUBRIC, students: [student('some answer text')] }),
    ).rejects.toThrow(/tenant mismatch/)
  })

  it('does NOT propagate a generic fetch failure — it degrades to similarity null', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'default')
    fetchRubricReferenceVectorsMock.mockRejectedValue(new Error('pinecone timeout'))
    embedTextsBatchMock.mockResolvedValue({ vectors: [[1, 0, 0]] })
    const map = await buildGradingContexts({
      ...IDS,
      rubric: RUBRIC,
      students: [student('some answer text')],
    })
    const ctx = map.get('s1')!
    expect(ctx.criteria[0].similarity).toBeNull()
    // No reference vectors + signals-using mode → signal-blind → degraded.
    expect(ctx.degraded).toBe(true)
  })
})

describe('buildGradingContexts — degrade paths', () => {
  it('whole-mode: a signals mode with reference vectors but a FAILED embed degrades', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'default')
    fetchRubricReferenceVectorsMock.mockResolvedValue([
      { questionIndex: 0, criterionIndex: 0, values: [1, 0, 0] },
    ])
    embedTextsBatchMock.mockRejectedValue(new Error('embed down'))
    const map = await buildGradingContexts({
      ...IDS,
      rubric: RUBRIC,
      students: [student('an answer that needs embedding')],
    })
    const ctx = map.get('s1')!
    expect(ctx.mode).toBe('whole')
    expect(ctx.wholeText).toContain('an answer') // wholeText survives the embed failure
    expect(ctx.criteria[0].similarity).toBeNull()
    expect(ctx.degraded).toBe(true)
  })

  it('whole-mode: computes a real similarity when refs + embed both succeed (not degraded)', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'default')
    fetchRubricReferenceVectorsMock.mockResolvedValue([
      { questionIndex: 0, criterionIndex: 0, values: [1, 0, 0] },
    ])
    // Passage vector aligned with the reference vector → cosine 1.
    embedTextsBatchMock.mockResolvedValue({ vectors: [[1, 0, 0]] })
    const map = await buildGradingContexts({
      ...IDS,
      rubric: RUBRIC,
      students: [student('recursion calls itself in the base case.')],
    })
    const ctx = map.get('s1')!
    expect(ctx.criteria[0].similarity).toBeCloseTo(1, 5)
    expect(ctx.degraded).toBe(false)
  })

  it('llm-only mode strips signals: no embed call, similarity null, NOT degraded', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'llm-only')
    const map = await buildGradingContexts({
      ...IDS,
      rubric: RUBRIC,
      students: [student('an answer body')],
    })
    const ctx = map.get('s1')!
    expect(ctx.criteria[0].similarity).toBeNull()
    expect(ctx.criteria[0].keywordResult).toBeNull()
    expect(ctx.degraded).toBe(false)
    expect(embedTextsBatchMock).not.toHaveBeenCalled()
    expect(fetchRubricReferenceVectorsMock).not.toHaveBeenCalled()
  })

  it('returns an empty map for an empty student batch', async () => {
    const map = await buildGradingContexts({ ...IDS, rubric: RUBRIC, students: [] })
    expect(map.size).toBe(0)
  })

  it('skips graded===false questions entirely (no criterion minted)', async () => {
    vi.stubEnv('AI_GRADING_MODE', 'llm-only')
    const rubric: AssignmentRubric = {
      questions: [
        { label: 'Q1', points: 10, graded: false, criteria: [{ description: 'x', points: 10 }] },
        { label: 'Q2', points: 5, criteria: [{ description: 'y', points: 5 }] },
      ],
    }
    const map = await buildGradingContexts({ ...IDS, rubric, students: [student('body')] })
    const ctx = map.get('s1')!
    expect(ctx.criteria).toHaveLength(1)
    expect(ctx.criteria[0].questionLabel).toBe('Q2')
  })
})
