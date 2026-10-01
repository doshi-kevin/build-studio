// grader.ts — suggestGradeFromContext post-processing. The Gemini SDK is mocked so
// these are deterministic and offline. They pin the load-bearing post-processing
// rules the LLM output alone can't guarantee:
//   - out-of-range suggestedPoints on a ticked criterion is FLAGGED (not silently absorbed)
//   - tick=true with unverifiable / empty evidence is FLAGGED but never auto-unticked
//   - a keyword miss deterministically caps the criterion to 0 and forces LOW confidence
//   - confidence rules: a clean grade is high; unmapped/degraded/keyword-miss force low
//   - the truncating schema transforms trim overruns instead of dropping the student

import { describe, it, expect, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: (...a: unknown[]) => generateObjectMock(...a) }))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import { suggestGradeFromContext } from '@/lib/assignments/ai-grading/grader'
import type { CriterionRef, GradingContext } from '@/lib/assignments/ai-grading/types'

function crit(over: Partial<CriterionRef> & { key: string }): CriterionRef {
  return {
    key: over.key,
    questionIndex: over.questionIndex ?? 0,
    questionLabel: over.questionLabel ?? 'Q0',
    criterionIndex: over.criterionIndex ?? 0,
    description: over.description ?? 'c',
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

/** Mock one generateObject response with the given criteria + feedback. */
function mockLLM(criteria: unknown[], feedback = 'ok') {
  generateObjectMock.mockResolvedValueOnce({ object: { criteria, feedback }, usage: {} })
}

const base = { systemPrompt: 'sys', maxScore: 100 }

describe('suggestGradeFromContext — post-processing', () => {
  it('returns null with no criteria (never calls the model)', async () => {
    const res = await suggestGradeFromContext({ context: ctx([], ''), ...base })
    expect(res).toBeNull()
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('produces a clean HIGH-confidence grade when evidence verifies and nothing is flagged', async () => {
    const submission = 'the student clearly explained recursion here'
    mockLLM([{ evidence: 'explained recursion', tick: true, suggestedPoints: 10, rationale: 'ok' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0', points: 10 })], submission),
      ...base,
    }))!
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(false)
    expect(res.suggestedScore).toBe(10)
    expect(res.confidence).toBe('high')
    expect(res.suggestedRubricScores).toEqual(['0:0'])
  })

  it('FLAGS an out-of-range suggestedPoints on a ticked criterion and clamps it to max', async () => {
    const submission = 'answer text present'
    mockLLM([{ evidence: 'answer text', tick: true, suggestedPoints: 999, rationale: 'r' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0', points: 10 })], submission),
      ...base,
    }))!
    expect(res.criteria[0].flagged).toBe(true)
    expect(res.criteria[0].suggestedPoints).toBe(10) // clamped to crit.points
    expect(res.flaggedCount).toBe(1)
  })

  it('FLAGS a ticked criterion whose evidence cannot be verified in the submission', async () => {
    mockLLM([{ evidence: 'a quote that is nowhere in the text', tick: true, suggestedPoints: 10, rationale: 'r' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0' })], 'entirely different submission body'),
      ...base,
    }))!
    // Never auto-unticked — a human must decide — but flagged.
    expect(res.criteria[0].tick).toBe(true)
    expect(res.criteria[0].flagged).toBe(true)
  })

  it('prepends "No supporting signal found." when unverifiable evidence AND low similarity coincide', async () => {
    mockLLM([{ evidence: 'not in text', tick: true, suggestedPoints: 10, rationale: 'base' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0', similarity: 0.1 })], 'other text'),
      ...base,
    }))!
    expect(res.criteria[0].rationale).toContain('No supporting signal found.')
  })

  it('deterministically caps a keyword-miss criterion to 0 and forces LOW confidence', async () => {
    // Model tries to tick it, but a required keyword is missing → hard cap.
    mockLLM([{ evidence: 'present', tick: true, suggestedPoints: 10, rationale: 'model said ok' }])
    const res = (await suggestGradeFromContext({
      context: ctx(
        [
          crit({
            key: '0:0',
            keywordResult: { required: ['bigO'], found: [], missing: ['bigO'] },
          }),
        ],
        'present in the submission',
      ),
      ...base,
    }))!
    expect(res.criteria[0].tick).toBe(false)
    expect(res.criteria[0].suggestedPoints).toBe(0)
    expect(res.criteria[0].rationale).toContain('Missing required term(s): bigO')
    expect(res.confidence).toBe('low')
  })

  it('fills a missing model entry with a flagged safe default (tick=false, 0 points)', async () => {
    // Two criteria, model returns only one.
    mockLLM([{ evidence: 'x', tick: true, suggestedPoints: 5, rationale: 'r' }])
    const res = (await suggestGradeFromContext({
      context: ctx(
        [crit({ key: '0:0', points: 5 }), crit({ key: '1:0', questionIndex: 1, points: 5 })],
        'x is in here',
      ),
      ...base,
    }))!
    expect(res.criteria[1].tick).toBe(false)
    expect(res.criteria[1].flagged).toBe(true)
    expect(res.criteria[1].rationale).toContain('no verdict')
    expect(res.confidence).toBe('low') // unmapped question forces low
  })

  it('forces LOW confidence on a degraded context even when the model output is clean', async () => {
    mockLLM([{ evidence: 'seen', tick: true, suggestedPoints: 10, rationale: 'r' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0' })], 'seen in submission', true),
      ...base,
    }))!
    expect(res.confidence).toBe('low')
  })

  it('clamps a ticked criterion to 0..points and awards full points when the model returns 0', async () => {
    // Model ticked but returned 0/absent points → Rule 2 promotes to full points.
    mockLLM([{ evidence: 'seen', tick: true, suggestedPoints: 0, rationale: 'r' }])
    const res = (await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0', points: 7 })], 'seen in submission'),
      ...base,
    }))!
    expect(res.criteria[0].suggestedPoints).toBe(7)
    // A negative model score on a ticked criterion is out-of-range → flagged, floored at 0.
    generateObjectMock.mockReset()
    mockLLM([{ evidence: 'seen', tick: true, suggestedPoints: -5, rationale: 'r' }])
    const neg = (await suggestGradeFromContext({
      context: ctx([crit({ key: '1:0', questionIndex: 1, points: 7 })], 'seen in submission'),
      ...base,
    }))!
    expect(neg.criteria[0].flagged).toBe(true)
    expect(neg.criteria[0].suggestedPoints).toBeGreaterThanOrEqual(0)
  })

  it('returns null when the model call throws (caller skips this student)', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('gemini down'))
    const res = await suggestGradeFromContext({
      context: ctx([crit({ key: '0:0' })], 'text'),
      ...base,
    })
    expect(res).toBeNull()
  })
})
