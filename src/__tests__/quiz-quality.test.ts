// @vitest-environment node
//
// Quality gate for generated quiz questions: semantic (embedding) dedup and
// the round-trip answerability audit. Both must FAIL OPEN — a broken checker
// can degrade quality but must never block generation.
import { describe, it, expect, vi } from 'vitest'

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  embedMany: vi.fn(),
  generateObject: vi.fn(),
}))
vi.mock('@ai-sdk/google', () => ({
  google: Object.assign(() => 'mock-model', { textEmbedding: () => 'mock-embedding-model' }),
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import { embedMany, generateObject } from 'ai'
import { recordAiUsage } from '@/lib/ai/usage'
import {
  SemanticDedup,
  QUIZ_DEDUP_EMBEDDING_MODEL,
  verifyAnswerability,
  verifyDistinctFacts,
  verifyTopicConsistency,
  cosineSimilarity,
  QUIZ_DEDUP_COSINE_THRESHOLD,
} from '@/lib/ai/quiz-quality'
import type { CreateQuestionServerInput } from '@/lib/validations/quiz'

const embed = vi.mocked(embedMany)
const gen = vi.mocked(generateObject)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withEmbeddings = (vectors: number[][]) => embed.mockResolvedValue({ embeddings: vectors } as any)

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, 0 for zero vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('SemanticDedup', () => {
  it('drops candidates too close to an ALREADY ACCEPTED stem across batches', async () => {
    const d = new SemanticDedup()
    withEmbeddings([[1, 0, 0]])
    expect(await d.filterFresh(['What is backprop?'], (s) => s)).toHaveLength(1)
    // Next batch: near-parallel vector (cos ≈ 0.995 ≥ threshold) + orthogonal one.
    withEmbeddings([
      [0.99, 0.1, 0],
      [0, 0, 1],
    ])
    const fresh = await d.filterFresh(['Explain backpropagation', 'What is a hash table?'], (s) => s)
    expect(fresh).toEqual(['What is a hash table?'])
  })

  it('catches within-batch near-duplicates too', async () => {
    const d = new SemanticDedup()
    withEmbeddings([
      [1, 0],
      [0.999, 0.01], // duplicate of the first, same batch
      [0, 1],
    ])
    const fresh = await d.filterFresh(['a', 'a-paraphrased', 'b'], (s) => s)
    expect(fresh).toEqual(['a', 'b'])
  })

  it('fails OPEN when embedding errors — keeps every candidate', async () => {
    const d = new SemanticDedup()
    embed.mockRejectedValueOnce(new Error('embedding service down'))
    expect(await d.filterFresh(['x', 'y'], (s) => s)).toEqual(['x', 'y'])
  })

  it('threshold clears the measured same-topic band for the model in use', () => {
    /* Calibration guard, re-derived 2026-08-06 for gemini-embedding-2 (the old
       bounds — >0.811, <0.875 — were gemini-embedding-001's populations, and
       they still ACCEPTED 0.82, which now sits inside the same-topic band).
       Measured on 14 real pairs: same-topic-but-different questions reach 0.843
       ("Define the softmax function" vs "Define the sigmoid function" — this
       model weighs the shared sentence frame heavily), and the paraphrase band
       runs 0.900+ once the one known form-mismatch miss (0.816) is set aside.
       A threshold inside the same-topic band silently deletes legitimate
       questions, which is the error that leaves no trace for the professor. */
    expect(QUIZ_DEDUP_COSINE_THRESHOLD).toBeGreaterThan(0.843)
    expect(QUIZ_DEDUP_COSINE_THRESHOLD).toBeLessThan(0.9)
  })

  // Dedup runs an embedding call per batch — paid input tokens. It went
  // unmetered until the constructor took attribution, so these pin BOTH that
  // the row is written and that it carries the tenant: an unattributed row
  // cannot be billed back to an institution, which is the same as not
  // metering it at all.
  it('meters the dedup embedding against the run’s attribution', async () => {
    const record = vi.mocked(recordAiUsage)
    record.mockClear()
    const d = new SemanticDedup({ institutionId: 'inst-1', sectionId: 'sec-1', userId: 'prof-1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embed.mockResolvedValue({ embeddings: [[1, 0]], usage: { tokens: 96 } } as any)
    await d.filterFresh(['What is backprop?'], (s) => s)
    expect(record).toHaveBeenCalledWith({
      feature: 'quiz_dedup_embedding',
      model: QUIZ_DEDUP_EMBEDDING_MODEL,
      institutionId: 'inst-1',
      sectionId: 'sec-1',
      userId: 'prof-1',
      usage: { inputTokens: 96 },
    })
  })

  it('still records the call when the SDK reports no usage, and when no attribution was passed', async () => {
    const record = vi.mocked(recordAiUsage)
    record.mockClear()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embed.mockResolvedValue({ embeddings: [[1, 0]] } as any)
    await new SemanticDedup().filterFresh(['a'], (s) => s)
    // 0 tokens, not a skipped row: the call happened and must stay visible on
    // the ledger (recordAiUsage flags the missing tenant itself).
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { inputTokens: 0 }, institutionId: undefined }),
    )
  })

  it('records nothing for an empty batch — no call, no row', async () => {
    const record = vi.mocked(recordAiUsage)
    record.mockClear()
    embed.mockClear()
    await new SemanticDedup().filterFresh([], (s: string) => s)
    expect(embed).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})

describe('verifyAnswerability', () => {
  const mcq = (text: string): { questionText: string; content: CreateQuestionServerInput['content'] } => ({
    questionText: text,
    content: {
      questionType: 'multiple_choice',
      choices: [
        { id: '1', text: 'right', isCorrect: true },
        { id: '2', text: 'wrong', isCorrect: false },
      ],
      allowMultiple: false,
    },
  })
  const explanationQ = (text: string): { questionText: string; content: CreateQuestionServerInput['content'] } => ({
    questionText: text,
    content: { questionType: 'explanation' },
  })

  it('drops questions the auditor marks not-ok, keeps the rest', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 0, ok: true }, { index: 1, ok: false }] } } as any)
    const out = await verifyAnswerability([mcq('Grounded?'), mcq('Hallucinated?')], 'source text')
    expect(out.map((q) => q.questionText)).toEqual(['Grounded?'])
  })

  it('skips the call entirely when no question is key-verifiable', async () => {
    gen.mockClear()
    const qs = [explanationQ('Explain X')]
    expect(await verifyAnswerability(qs, 'source')).toBe(qs)
    expect(gen).not.toHaveBeenCalled()
  })

  it('never audits rubric-graded types even when mixed with checkable ones', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 1, ok: false }] } } as any)
    const out = await verifyAnswerability([explanationQ('Explain X'), mcq('Bad MC')], 'source')
    // The explanation survives regardless; the flagged MC (index 1) is dropped.
    expect(out.map((q) => q.questionText)).toEqual(['Explain X'])
    // The audit prompt numbered the MC by its ORIGINAL index (1), not 0.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = String((gen.mock.calls[0]?.[0] as any)?.prompt ?? '')
    expect(prompt).toContain('1. [multiple_choice] Bad MC')
    expect(prompt).not.toContain('[explanation]')
  })

  it('ignores hallucinated verdict indices — an exempt rubric question can never be dropped', async () => {
    // The auditor was only given the MC at index 1, but returns a bogus
    // verdict for index 0 (the explanation) — it must be ignored.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 0, ok: false }] } } as any)
    const out = await verifyAnswerability([explanationQ('Explain X'), mcq('Fine MC')], 'source')
    expect(out.map((q) => q.questionText)).toEqual(['Explain X', 'Fine MC'])
  })

  it('fails OPEN when the audit call errors', async () => {
    gen.mockRejectedValueOnce(new Error('audit down'))
    const qs = [mcq('Q1'), mcq('Q2')]
    expect(await verifyAnswerability(qs, 'source')).toEqual(qs)
  })
})

// verifyDistinctFacts is the same-fact redundancy gate — the failure mode
// embedding dedup measurably can't catch (same-fact rewrites and genuinely
// different same-topic questions score in overlapping cosine bands). Same
// fail-open + hallucinated-index contract as the other audits; unlike them it
// audits ALL question types (redundancy is about the stem, not the key).
describe('verifyDistinctFacts', () => {
  const q = (text: string) => ({ questionText: text })
  const stem = (x: { questionText: string }) => x.questionText

  it('drops candidates the auditor flags redundant, keeps the rest', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 0, ok: false }, { index: 1, ok: true }] } } as any)
    const out = await verifyDistinctFacts(
      [q('Minimizing perplexity equals maximizing probability?'), q('Compute perplexity from these counts')],
      stem,
      ['Is minimizing perplexity equivalent to maximizing test-set probability?'],
    )
    expect(out.map(stem)).toEqual(['Compute perplexity from these counts'])
  })

  it('sends the existing stems and numbers candidates by index', async () => {
    gen.mockClear()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [] } } as any)
    await verifyDistinctFacts([q('Candidate A'), q('Candidate B')], stem, ['Existing question'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = String((gen.mock.calls[0]?.[0] as any)?.prompt ?? '')
    expect(prompt).toContain('- Existing question')
    expect(prompt).toContain('0. Candidate A')
    expect(prompt).toContain('1. Candidate B')
  })

  it('skips the call when there is nothing to be redundant with (no priors, single candidate)', async () => {
    gen.mockClear()
    const one = [q('Only question')]
    expect(await verifyDistinctFacts(one, stem, [])).toBe(one)
    expect(gen).not.toHaveBeenCalled()
  })

  it('still audits within-batch redundancy when there are no priors but 2+ candidates', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 1, ok: false }] } } as any)
    const out = await verifyDistinctFacts([q('First'), q('First, reworded')], stem, [])
    expect(out.map(stem)).toEqual(['First'])
  })

  it('ignores hallucinated verdict indices', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 7, ok: false }] } } as any)
    const qs = [q('A'), q('B')]
    expect(await verifyDistinctFacts(qs, stem, ['prior'])).toEqual(qs)
  })

  it('fails OPEN when the audit call errors', async () => {
    gen.mockRejectedValueOnce(new Error('audit down'))
    const qs = [q('A'), q('B')]
    expect(await verifyDistinctFacts(qs, stem, ['prior'])).toEqual(qs)
  })
})

// verifyTopicConsistency is the "beyond the document" sibling of
// verifyAnswerability: same fail-open, checkable-types-only, index-preserving
// verdict contract, but it audits against a TOPIC LIST instead of source text.
describe('verifyTopicConsistency', () => {
  const mcq = (text: string): { questionText: string; content: CreateQuestionServerInput['content'] } => ({
    questionText: text,
    content: {
      questionType: 'multiple_choice',
      choices: [
        { id: '1', text: 'right', isCorrect: true },
        { id: '2', text: 'wrong', isCorrect: false },
      ],
      allowMultiple: false,
    },
  })
  const explanationQ = (text: string): { questionText: string; content: CreateQuestionServerInput['content'] } => ({
    questionText: text,
    content: { questionType: 'explanation' },
  })
  const topics = ['Backpropagation', 'Attention']

  it('drops off-topic/incorrect questions the auditor flags, keeps the rest', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 0, ok: true }, { index: 1, ok: false }] } } as any)
    const out = await verifyTopicConsistency([mcq('On topic?'), mcq('Off topic?')], topics)
    expect(out.map((q) => q.questionText)).toEqual(['On topic?'])
  })

  it('skips the call entirely when no question is key-verifiable', async () => {
    gen.mockClear()
    const qs = [explanationQ('Explain X')]
    expect(await verifyTopicConsistency(qs, topics)).toBe(qs)
    expect(gen).not.toHaveBeenCalled()
  })

  it('audits checkable types against the allowed-topics list, numbered by original index', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 1, ok: false }] } } as any)
    const out = await verifyTopicConsistency([explanationQ('Explain X'), mcq('Bad MC')], topics)
    // The rubric-graded explanation survives regardless; the flagged MC drops.
    expect(out.map((q) => q.questionText)).toEqual(['Explain X'])
    // The prompt numbers the MC by its ORIGINAL index (1) and carries the topics.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = String((gen.mock.calls[0]?.[0] as any)?.prompt ?? '')
    expect(prompt).toContain('1. [multiple_choice] Bad MC')
    expect(prompt).not.toContain('[explanation]')
    expect(prompt).toContain('Backpropagation')
    expect(prompt).toContain('Attention')
  })

  it('ignores hallucinated verdict indices — an exempt rubric question can never be dropped', async () => {
    // The auditor was only given the MC at index 1 but returns a bogus verdict
    // for index 0 (the explanation) — it must be ignored.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gen.mockResolvedValueOnce({ object: { verdicts: [{ index: 0, ok: false }] } } as any)
    const out = await verifyTopicConsistency([explanationQ('Explain X'), mcq('Fine MC')], topics)
    expect(out.map((q) => q.questionText)).toEqual(['Explain X', 'Fine MC'])
  })

  it('fails OPEN when the audit call errors', async () => {
    gen.mockRejectedValueOnce(new Error('audit down'))
    const qs = [mcq('Q1'), mcq('Q2')]
    expect(await verifyTopicConsistency(qs, topics)).toEqual(qs)
  })
})
