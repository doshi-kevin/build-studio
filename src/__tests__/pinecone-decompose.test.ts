// Query decomposition: the GATE (pure) and the SPLIT (one model call).
//
// The gate exists to control cost: firing decides whether a question pays for a
// model call plus extra searches. A false negative costs nothing (today's
// behaviour); a false positive costs money on every message that trips it. So
// the tests that matter are the ones that pin what must NOT fire.
//
// The split's contract is narrower but sharper: it answers `[]` for every
// outcome that isn't a genuine multi-topic split — a thrown model call, a
// single sub-query — because `[]` is what makes the caller retrieve the whole
// question. Anything else there turns a cheap rewrite's bad day into a student
// getting an error or a duplicated search.

import { describe, it, expect, vi } from 'vitest'

vi.mock('ai', () => ({ generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import { generateObject } from 'ai'
import { recordAiUsage } from '@/lib/ai/usage'
import { decomposeQuery, shouldDecompose } from '@/lib/pinecone/decompose'

const gen = vi.mocked(generateObject)
const billed = vi.mocked(recordAiUsage)

// NO beforeEach hook on `gen`: with mockReset/mockClear in beforeEach, vitest 4
// mis-attributes an error thrown by a mock implementation — even one CAUGHT by
// the code under test — as a test failure (see llm-quiz-dedup-types.test.ts).
// Every test sets its own implementation, so nothing leaks between them.
const resolve = (subQueries: string[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gen.mockResolvedValue({ object: { subQueries }, usage: { inputTokens: 40, outputTokens: 12 } } as any)

const SCOPE = {
  institutionId: 'a1b2c3d4-1111-4111-8111-000000000002',
  sectionId: 'a1b2c3d4-1111-4111-8111-000000000003',
}
const QUESTION = 'How do word2vec embeddings relate to a transformer’s input representations?'

describe('shouldDecompose', () => {
  it('fires on questions that relate two topics', () => {
    expect(shouldDecompose('How do word2vec embeddings relate to the input representations a transformer sees?')).toBe(true)
    expect(shouldDecompose('What is the difference between encoder-only and decoder-only transformers?')).toBe(true)
    expect(shouldDecompose('How does supervised fine-tuning compare to teacher forcing?')).toBe(true)
  })

  it('does NOT fire on a bare "and" — course titles are full of them', () => {
    // "Seq2Seq and Attention", "GloVe and word2vec", "RNNs and Beyond" are one
    // topic each. Splitting on "and" would bill the split on ordinary questions.
    expect(shouldDecompose('What does layer normalization do and why does it help training?')).toBe(false)
    expect(shouldDecompose('Explain the Seq2Seq and Attention lecture in simple terms')).toBe(false)
  })

  it('does not fire on a short question, however phrased', () => {
    // Length is the cheap guard against a connective appearing in a one-topic
    // question ("compare these" has nothing to split).
    expect(shouldDecompose('compare them')).toBe(false)
    expect(shouldDecompose('word2vec vs GloVe')).toBe(false)
  })

  it('does not fire on ordinary single-topic questions', () => {
    expect(shouldDecompose('What is the formula for scaled dot-product attention?')).toBe(false)
    expect(shouldDecompose('Why is the vanishing gradient a problem in RNNs?')).toBe(false)
    expect(shouldDecompose('What is the penalty for turning in an assignment one day late?')).toBe(false)
  })
})

describe('decomposeQuery', () => {
  it('splits a multi-topic question and meters the call', async () => {
    resolve(['  what is word2vec  ', 'what are a transformer’s input representations'])
    billed.mockClear()

    const out = await decomposeQuery(QUESTION, SCOPE)

    expect(out).toEqual(['what is word2vec', 'what are a transformer’s input representations'])
    // The split is an extra paid call on top of the extra searches — if it
    // stops reaching the ledger, its spend disappears from the cost report.
    expect(billed.mock.calls[0][0]).toMatchObject({ feature: 'material_search', sectionId: SCOPE.sectionId })
  })

  it('answers [] when the model call fails, so retrieval degrades to the whole question', async () => {
    // The only thing standing between a flaky rewrite model and a student
    // seeing an error instead of an answer.
    gen.mockRejectedValue(new Error('503 model overloaded'))

    await expect(decomposeQuery(QUESTION, SCOPE)).resolves.toEqual([])
  })

  it('answers [] when the model returns ONE sub-query — that is the original search', async () => {
    // "One topic after all" must not come back as a decomposition: the caller
    // would run a pooled path over a single pool, paying an extra model call to
    // arrive exactly where the plain search already was.
    resolve(['what is word2vec'])
    await expect(decomposeQuery(QUESTION, SCOPE)).resolves.toEqual([])

    // Same for a list that only LOOKS like two once blanks are dropped.
    resolve(['what is word2vec', '   '])
    await expect(decomposeQuery(QUESTION, SCOPE)).resolves.toEqual([])
  })

  it('caps the split at three — more fragments the question and multiplies the searches', async () => {
    resolve(['one', 'two', 'three', 'four', 'five'])
    await expect(decomposeQuery(QUESTION, SCOPE)).resolves.toEqual(['one', 'two', 'three'])
  })
})
