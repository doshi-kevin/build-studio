// Node-check generation (docs/designs/roadmap-mastery/roadmap-engine.md §14).
//
// The behaviour worth pinning is the CHEAPNESS: an item with nothing to ask
// about must never reach the model, and the answer must not always be option A.
// The model call itself is mocked — its output quality is a prompt concern,
// measured separately, not something a unit test can assert.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateObject = vi.fn()
const recordAiUsage = vi.fn()
vi.mock('ai', () => ({ generateObject: (...a: unknown[]) => generateObject(...a) }))
vi.mock('@ai-sdk/google', () => ({ google: (id: string) => id }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => recordAiUsage(...a) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { generateNodeCheck } = await import('@/lib/ai/node-check')

/** A blurb comfortably over the content threshold. */
const REAL_BLURB = 'Builds backpropagation from scratch in Python, deriving each gradient by hand before coding it.'

function modelReturns(questions: { q: string; a: string[] }[], notQuizzable = false) {
  generateObject.mockResolvedValue({
    object: { notQuizzable, questions },
    usage: { inputTokens: 100, outputTokens: 200 },
  })
}

const fifteen = Array.from({ length: 15 }, (_, i) => ({
  q: `Question ${i}?`,
  a: [`correct-${i}`, `wrong-a-${i}`, `wrong-b-${i}`, `wrong-c-${i}`],
}))

describe('generateNodeCheck — spending nothing on empty items', () => {
  beforeEach(() => { generateObject.mockReset() })

  it('never calls the model when there is no real content beyond the title', async () => {
    const res = await generateNodeCheck({ title: 'A very long and descriptive lecture title indeed' })
    expect(res.notQuizzable).toBe(true)
    expect(res.questions).toEqual([])
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('counts the description, not the title, toward the threshold', async () => {
    // A long title with a two-word description is still nothing to ask about.
    const res = await generateNodeCheck({
      title: 'Efficient Estimation of Word Representations in Vector Space (JMLR 2003)',
      description: 'The paper.',
    })
    expect(res.notQuizzable).toBe(true)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('does call the model once there is a real blurb', async () => {
    modelReturns(fifteen)
    const res = await generateNodeCheck({ title: 'Backprop', description: REAL_BLURB })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(res.notQuizzable).toBe(false)
    expect(res.questions).toHaveLength(15)
  })

  it('still fires on a SHORT real-world blurb — the threshold was tuned for these', async () => {
    // Measured on a real course, supplementary descriptions top out near 70
    // characters. Raising the threshold above that silently removes the check
    // from every extra in the product, which is invisible without this test.
    modelReturns(fifteen)
    const res = await generateNodeCheck({
      title: 'Efficient Estimation of Word Representations',
      description: 'The foundational neural language model paper (JMLR 2003).', // 57 chars
    })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(res.questions).toHaveLength(15)
  })

  it('attributes the spend to the tenant so per-section AI cost stays accurate', async () => {
    modelReturns(fifteen)
    await generateNodeCheck(
      { title: 'Backprop', description: REAL_BLURB },
      { institutionId: 'inst-1', sectionId: 'sec-1', userId: 'stu-1' },
    )
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'roadmap_node_check',
        institutionId: 'inst-1',
        sectionId: 'sec-1',
      }),
    )
  })

  it('honours the model saying there is nothing worth testing', async () => {
    modelReturns([], true)
    const res = await generateNodeCheck({ title: 'Q&A forum', description: REAL_BLURB })
    expect(res).toEqual({ questions: [], notQuizzable: true })
  })

  it('treats an empty question list as not quizzable rather than a broken pool', async () => {
    modelReturns([])
    expect((await generateNodeCheck({ title: 'x', description: REAL_BLURB })).notQuizzable).toBe(true)
  })
})

describe('generateNodeCheck — the answer is not always option A', () => {
  beforeEach(() => { generateObject.mockReset() })

  it('moves the correct choice off the first slot and keeps answerIndex pointing at it', async () => {
    modelReturns(fifteen)
    const { questions } = await generateNodeCheck({ title: 'Backprop', description: REAL_BLURB })

    // The prompt asks the model to put the answer first, so without shuffling
    // every answerIndex would be 0 and the check would be trivially passable.
    expect(new Set(questions.map((q) => q.answerIndex)).size).toBeGreaterThan(1)

    questions.forEach((q, i) => {
      expect(q.choices).toHaveLength(4)
      // answerIndex must still point at the option the model marked correct.
      expect(q.choices[q.answerIndex]).toBe(`correct-${i}`)
      expect(new Set(q.choices).size).toBe(4) // shuffle swapped, never duplicated
    })
  })

  it('caps the prompt so one enormous document cannot blow up the cost', async () => {
    modelReturns(fifteen)
    await generateNodeCheck({
      title: 'Huge',
      description: 'x'.repeat(50_000),
      concepts: Array.from({ length: 500 }, (_, i) => ({ name: `c${i}`, summary: 'y'.repeat(200) })),
    })
    const call = generateObject.mock.calls[0][0] as { prompt: string; system: string }
    expect(call.prompt.length).toBeLessThan(6_500)
  })
})
