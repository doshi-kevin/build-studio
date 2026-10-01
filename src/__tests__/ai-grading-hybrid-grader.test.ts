// hybrid-grader.ts — similarity certifies, the LLM reviews the rejections. Gemini
// mocked. Pins: stage-1 certification (>= HYBRID threshold, no keyword miss, no LLM
// tokens), stage-2 overturn/uphold with evidence verification + flag policy, the
// review-failure fallback (provisional rejections kept, LOW confidence), and E12 —
// a fully-certified submission still gets synthesized feedback (never blank).

import { describe, it, expect, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: (...a: unknown[]) => generateObjectMock(...a) }))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import {
  suggestGradeHybrid,
  HYBRID_MODEL_TAG,
} from '@/lib/assignments/ai-grading/hybrid-grader'
import {
  HYBRID_SIMILARITY_TICK_THRESHOLD,
  type CriterionRef,
  type GradingContext,
} from '@/lib/assignments/ai-grading/types'

function crit(over: Partial<CriterionRef> & { key: string }): CriterionRef {
  return {
    key: over.key,
    questionIndex: over.questionIndex ?? 0,
    questionLabel: over.questionLabel ?? 'Q0',
    criterionIndex: over.criterionIndex ?? 0,
    description: 'c',
    points: over.points ?? 10,
    referenceAnswer: null,
    absoluteKeywords: over.absoluteKeywords ?? [],
    keywordAliases: [],
    keywordResult: over.keywordResult ?? null,
    similarity: over.similarity ?? null,
  }
}

function ctx(criteria: CriterionRef[], submissionText: string, degraded = false): GradingContext {
  return {
    mode: 'whole',
    criteria,
    wholeText: submissionText,
    regions: null,
    submissionText,
    degraded,
  }
}

const CERT = HYBRID_SIMILARITY_TICK_THRESHOLD + 0.05
const LOW = HYBRID_SIMILARITY_TICK_THRESHOLD - 0.2

describe('suggestGradeHybrid — stage 1 certification', () => {
  it('certifies a high-similarity, keyword-clean criterion WITHOUT calling the LLM', async () => {
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: CERT, points: 10 })], 'body'),
      maxScore: 100,
    }))!
    expect(generateObjectMock).not.toHaveBeenCalled()
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.model).toBe(HYBRID_MODEL_TAG)
  })

  it('E12: a fully-certified submission gets synthesized feedback, never blank, at HIGH confidence', async () => {
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: CERT })], 'body'),
      maxScore: 100,
    }))!
    expect(res.feedback.trim().length).toBeGreaterThan(0)
    expect(res.confidence).toBe('high')
  })

  it('does NOT certify a high-similarity criterion that has a missing keyword (sends it to review)', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { criteria: [{ satisfied: false, evidence: '', reason: 'no' }], feedback: 'fb' },
      usage: {},
    })
    const res = (await suggestGradeHybrid({
      context: ctx(
        [
          crit({
            key: '0:0',
            similarity: CERT,
            keywordResult: { required: ['k'], found: [], missing: ['k'] },
          }),
        ],
        'body',
      ),
      maxScore: 100,
    }))!
    expect(generateObjectMock).toHaveBeenCalledTimes(1)
    expect(res.criteria[0].tick).toBe(false)
  })
})

describe('suggestGradeHybrid — stage 2 review', () => {
  it('overturns a rejection with verifiable evidence (ticked, not flagged)', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        criteria: [{ satisfied: true, evidence: 'the key phrase', reason: 'actually correct' }],
        feedback: 'nice',
      },
      usage: {},
    })
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: LOW, points: 10 })], 'contains the key phrase here'),
      maxScore: 100,
    }))!
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.suggestedScore).toBe(10)
  })

  it('flags an overturn whose evidence cannot be verified in the submission', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        criteria: [{ satisfied: true, evidence: 'phrase not present', reason: 'r' }],
        feedback: 'fb',
      },
      usage: {},
    })
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: LOW })], 'a totally different body'),
      maxScore: 100,
    }))!
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(true)
  })

  it('upholds a rejection (tick=false, not flagged — similarity and LLM agree)', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        criteria: [{ satisfied: false, evidence: '', reason: 'does not cover it' }],
        feedback: 'fb',
      },
      usage: {},
    })
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: LOW })], 'body'),
      maxScore: 100,
    }))!
    expect(res.criteria[0].tick).toBe(false)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.criteria[0].rationale).toContain('does not cover it')
  })

  it('keeps provisional rejections at LOW confidence when the review call fails', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('review down'))
    const res = (await suggestGradeHybrid({
      context: ctx([crit({ key: '0:0', similarity: LOW })], 'body'),
      maxScore: 100,
    }))!
    expect(res.criteria[0].tick).toBe(false)
    expect(res.criteria[0].flagged).toBe(true)
    expect(res.confidence).toBe('low')
  })

  it('returns null with no criteria', async () => {
    expect(await suggestGradeHybrid({ context: ctx([], ''), maxScore: 100 })).toBeNull()
  })
})
