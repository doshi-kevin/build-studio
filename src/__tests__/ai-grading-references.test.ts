// references.ts — syncRubricReferenceVectors. Pinecone embed + data are mocked.
// Pins the stale-vector prune: over the MAX_REFS cap, only the first N are embedded,
// but the upsert-then-prune STILL runs so vectors for removed / renumbered criteria
// don't stay live (a live stale vector lets the grader match a deleted reference
// answer). Also pins the empty-refs full-erasure path and the graded===false skip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const embedReferenceSnippetMock = vi.fn()
const upsertMock = vi.fn()
const deleteMock = vi.fn()

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/pinecone/embed', () => ({
  embedReferenceSnippet: (...a: unknown[]) => embedReferenceSnippetMock(...a),
}))
vi.mock('@/lib/pinecone/data', () => ({
  upsertRubricReferenceVectors: (...a: unknown[]) => upsertMock(...a),
  deleteRubricReferenceVectors: (...a: unknown[]) => deleteMock(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { syncRubricReferenceVectors } from '@/lib/assignments/ai-grading/references'
import type { AssignmentRubric } from '@/lib/validations/assignment'

const IDS = { institutionId: 'inst-1', sectionId: 'sec-1', assignmentId: 'a-1' }

/** Rubric with `count` graded criteria, each carrying a reference answer, on one question. */
function rubricWithRefs(count: number): AssignmentRubric {
  return {
    questions: [
      {
        label: 'Q1',
        points: count,
        criteria: Array.from({ length: count }, (_, i) => ({
          description: `c${i}`,
          points: 1,
          referenceAnswer: `reference answer ${i}`,
        })),
      },
    ],
  }
}

beforeEach(() => {
  embedReferenceSnippetMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3])
  upsertMock.mockReset().mockResolvedValue(undefined)
  deleteMock.mockReset().mockResolvedValue(undefined)
})

describe('syncRubricReferenceVectors', () => {
  it('embeds every reference, upserts, THEN prunes stale (keepIds), returns ready', async () => {
    const res = await syncRubricReferenceVectors({ ...IDS, rubric: rubricWithRefs(3) })
    expect(res).toEqual({ status: 'ready', refCount: 3 })
    expect(embedReferenceSnippetMock).toHaveBeenCalledTimes(3)
    expect(upsertMock).toHaveBeenCalledTimes(1)
    // Prune runs AFTER upsert with a keepIds set holding exactly the upserted ids.
    expect(deleteMock).toHaveBeenCalledTimes(1)
    const [, , pruneOpts] = deleteMock.mock.calls[0]
    expect(pruneOpts).toHaveProperty('keepIds')
    expect((pruneOpts.keepIds as Set<string>).size).toBe(3)
  })

  it('over MAX_REFS: caps embeds to 100 but STILL upserts+prunes so removed criteria vectors die', async () => {
    const res = await syncRubricReferenceVectors({ ...IDS, rubric: rubricWithRefs(150) })
    // refCount reflects the cap, not the raw count.
    expect(res).toEqual({ status: 'ready', refCount: 100 })
    expect(embedReferenceSnippetMock).toHaveBeenCalledTimes(100)
    // The prune must run even in the over-cap path — this is the stale-vector guard.
    expect(upsertMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    const [, , pruneOpts] = deleteMock.mock.calls[0]
    expect((pruneOpts.keepIds as Set<string>).size).toBe(100)
  })

  it('no references: full-erasure delete (no keepIds) and status none', async () => {
    const rubric: AssignmentRubric = {
      questions: [{ label: 'Q1', points: 1, criteria: [{ description: 'c', points: 1 }] }],
    }
    const res = await syncRubricReferenceVectors({ ...IDS, rubric })
    expect(res).toEqual({ status: 'none', refCount: 0 })
    expect(upsertMock).not.toHaveBeenCalled()
    // Full erasure: delete called WITHOUT a keepIds option.
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock.mock.calls[0][2]).toBeUndefined()
  })

  it('skips graded===false questions when collecting references', async () => {
    const rubric: AssignmentRubric = {
      questions: [
        {
          label: 'Q1',
          points: 1,
          graded: false,
          criteria: [{ description: 'c', points: 1, referenceAnswer: 'excluded ref' }],
        },
        {
          label: 'Q2',
          points: 1,
          criteria: [{ description: 'c', points: 1, referenceAnswer: 'kept ref' }],
        },
      ],
    }
    const res = await syncRubricReferenceVectors({ ...IDS, rubric })
    expect(res).toEqual({ status: 'ready', refCount: 1 }) // only Q2's reference
    expect(embedReferenceSnippetMock).toHaveBeenCalledTimes(1)
    expect(embedReferenceSnippetMock).toHaveBeenCalledWith('kept ref')
  })

  it('returns failed when embedding throws (caller degrades AI grading)', async () => {
    embedReferenceSnippetMock.mockRejectedValue(new Error('embed down'))
    const res = await syncRubricReferenceVectors({ ...IDS, rubric: rubricWithRefs(2) })
    expect(res).toEqual({ status: 'failed', refCount: 0 })
  })
})
