// resolveCitationsForBatch attributes each generated question to a real source
// page. "Beyond the document" (AI-extended) questions are the exception: they
// carry a {kind:'ai_extended'} tag set at generation and have NO source page —
// resolution must preserve that tag verbatim and never overwrite it with a
// resolved/null page citation (doing so would hand a topic-based question a
// bogus source link). Pure function — no mocking.
import { describe, it, expect } from 'vitest'
import { resolveCitationsForBatch } from '@/lib/quiz/ai-generation'
import type { GeneratedQuestion } from '@/lib/ai/llm-client'
import type { QuizSource } from '@/lib/quiz/source-citation'

const sources: QuizSource[] = [
  {
    title: 'Transformers',
    pageCount: 20,
    ref: { kind: 'module_item', moduleItemId: 'item-1' },
  },
]

const mc = (over: Partial<GeneratedQuestion>): GeneratedQuestion =>
  ({
    questionText: 'What is attention?',
    content: {
      questionType: 'multiple_choice',
      choices: [
        { id: '1', text: 'right', isCorrect: true },
        { id: '2', text: 'wrong', isCorrect: false },
      ],
      allowMultiple: false,
    },
    ...over,
  }) as GeneratedQuestion

describe('resolveCitationsForBatch — ai_extended preservation', () => {
  it('keeps an ai_extended tag verbatim and strips any raw source hint', () => {
    const q = mc({
      sourceCitation: { kind: 'ai_extended', topic: 'Backpropagation' },
      // Spurious hint the model may have emitted — must not survive.
      sourceTitle: 'Transformers',
      sourcePage: 3,
    })
    const cited = resolveCitationsForBatch([q], sources)
    expect(q.sourceCitation).toEqual({ kind: 'ai_extended', topic: 'Backpropagation' })
    expect(q.sourceTitle).toBeUndefined()
    expect(q.sourcePage).toBeUndefined()
    // ai_extended counts as "cited" (it has an attribution, just not a page).
    expect(cited).toBe(1)
  })

  it('still resolves a normal question in the same batch (early-continue skips only the ai_extended one)', () => {
    const extended = mc({ sourceCitation: { kind: 'ai_extended', topic: 'Attention' } })
    const grounded = mc({ questionText: 'Grounded Q', sourceTitle: 'Transformers', sourcePage: 5 })
    const cited = resolveCitationsForBatch([extended, grounded], sources)
    expect(extended.sourceCitation).toEqual({ kind: 'ai_extended', topic: 'Attention' })
    expect(grounded.sourceCitation).toMatchObject({ kind: 'module_item', moduleItemId: 'item-1', page: 5 })
    expect(cited).toBe(2)
  })
})
