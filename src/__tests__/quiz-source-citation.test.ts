import { describe, it, expect } from 'vitest'
import {
  resolveSourceCitation,
  attributeByContent,
  resolveQuestionCitation,
  type QuizSource,
} from '@/lib/quiz/source-citation'

const moduleSource: QuizSource = {
  title: 'Transformers',
  pageCount: 20,
  ref: { kind: 'module_item', moduleItemId: 'item-1' },
}
const uploadSource: QuizSource = {
  title: 'deck.pdf',
  pageCount: 5,
  ref: { kind: 'upload', filePath: 'sec-1/quiz-ai-uploads/deck.pdf' },
}
const sources = [moduleSource, uploadSource]

describe('resolveSourceCitation', () => {
  it('resolves an exact title match on a module item to a citation', () => {
    expect(resolveSourceCitation('Transformers', 14, sources)).toEqual({
      kind: 'module_item',
      moduleItemId: 'item-1',
      page: 14,
      title: 'Transformers',
    })
  })

  it('resolves an upload source to its file path', () => {
    expect(resolveSourceCitation('deck.pdf', 3, sources)).toEqual({
      kind: 'upload',
      filePath: 'sec-1/quiz-ai-uploads/deck.pdf',
      page: 3,
      title: 'deck.pdf',
    })
  })

  it('matches case- and whitespace-insensitively, but keeps the canonical title', () => {
    const c = resolveSourceCitation('  transformers ', 1, sources)
    expect(c?.title).toBe('Transformers') // canonical, not the model's string
  })

  it('falls back to a substring match when there is no exact match', () => {
    const c = resolveSourceCitation('Transformers (Lecture 4)', 2, sources)
    expect(c?.kind).toBe('module_item')
  })

  it('resolves a decayed hint that DROPPED the title prefix (makeup batches emit "Language Modeling" for "Lecture 2: Language Modeling")', () => {
    // Observed in the 2026-07-18 benchmark: makeup-batch questions carry the
    // concept-ish short title. The shorter-hint substring direction must
    // resolve it — this is why the decay needs no generation-side fix.
    const lectures: QuizSource[] = [
      { title: 'Lecture 2: Language Modeling', pageCount: 70, ref: { kind: 'module_item', moduleItemId: 'lec-2' } },
    ]
    expect(resolveSourceCitation('Language Modeling', 15, lectures)).toMatchObject({
      moduleItemId: 'lec-2',
      title: 'Lecture 2: Language Modeling',
    })
  })

  it('prefers an exact match over an earlier-listed substring match', () => {
    // Two sources where the first is only a substring candidate and the second
    // is the exact title. Exact must win regardless of order — guards against a
    // future refactor collapsing the two match passes into one.
    const withDecoy: QuizSource[] = [
      { title: 'Intro to Transformers', pageCount: 10, ref: { kind: 'module_item', moduleItemId: 'substr' } },
      { title: 'Transformers', pageCount: 10, ref: { kind: 'module_item', moduleItemId: 'exact' } },
    ]
    expect(resolveSourceCitation('Transformers', 1, withDecoy)).toMatchObject({ moduleItemId: 'exact' })
  })

  it('drops a citation whose page exceeds the document length', () => {
    expect(resolveSourceCitation('Transformers', 21, sources)).toBeNull()
  })

  it('drops a citation with no matching source — never a broken link', () => {
    expect(resolveSourceCitation('Some Other Lecture', 1, sources)).toBeNull()
  })

  it('drops a citation with a missing or invalid page', () => {
    expect(resolveSourceCitation('Transformers', undefined, sources)).toBeNull()
    expect(resolveSourceCitation('Transformers', 0, sources)).toBeNull()
    expect(resolveSourceCitation('Transformers', 1.5, sources)).toBeNull()
  })

  it('drops a citation with an empty/absent title', () => {
    expect(resolveSourceCitation(undefined, 1, sources)).toBeNull()
    expect(resolveSourceCitation('   ', 1, sources)).toBeNull()
  })

  it('skips the range check when the document page count is unknown (0)', () => {
    const unknown: QuizSource[] = [{ title: 'Notes', pageCount: 0, ref: { kind: 'module_item', moduleItemId: 'm' } }]
    expect(resolveSourceCitation('Notes', 999, unknown)?.page).toBe(999)
  })

  it('stamps the source renderability into the citation (gates the peek chip)', () => {
    const docx: QuizSource = { title: 'Syllabus', pageCount: 4, ref: { kind: 'module_item', moduleItemId: 'd' }, renderable: false }
    expect(resolveSourceCitation('Syllabus', 2, [docx])?.renderable).toBe(false)
    // Sources without the flag (legacy) leave it absent → chip stays clickable.
    expect(resolveSourceCitation('Transformers', 1, sources)?.renderable).toBeUndefined()
  })
})

// The content match is what actually makes the feature work — Gemini does not
// reliably emit a [Title, page N] hint, so each question is attributed to the
// page whose extracted text it overlaps most.
const deck: QuizSource = {
  title: 'Neural Networks Lecture',
  pageCount: 3,
  ref: { kind: 'module_item', moduleItemId: 'deck-1' },
  pages: [
    { page: 1, text: 'Neural networks are layers of weighted connections. A neuron computes a weighted sum then a nonlinearity.' },
    { page: 2, text: 'The sigmoid activation maps any real number to the range zero to one. It saturates causing vanishing gradients.' },
    { page: 3, text: 'Convolutions use local receptive fields and weight sharing. Pooling downsamples feature maps for images.' },
  ],
}

describe('attributeByContent', () => {
  it('attributes a question to the page whose text it overlaps most', () => {
    const c = attributeByContent('Why does the sigmoid activation cause vanishing gradients?', [deck])
    expect(c).toMatchObject({ kind: 'module_item', moduleItemId: 'deck-1', page: 2, title: 'Neural Networks Lecture' })
  })

  it('picks the convolution page for a CNN question', () => {
    const c = attributeByContent('What gives convolutional layers weight sharing and local receptive fields?', [deck])
    expect(c?.page).toBe(3)
  })

  it('returns null when nothing meaningfully overlaps (no wrong peek)', () => {
    expect(attributeByContent('Discuss the French Revolution and its economic causes', [deck])).toBeNull()
  })

  it('returns null when sources carry no page text', () => {
    const noPages: QuizSource = { title: 'X', pageCount: 5, ref: { kind: 'module_item', moduleItemId: 'x' } }
    expect(attributeByContent('sigmoid activation vanishing gradient neuron', [noPages])).toBeNull()
  })
})

describe('resolveQuestionCitation', () => {
  it('prefers a verifiable model hint over the content match', () => {
    // Hint says page 1; content clearly matches page 2. Hint wins when valid.
    const c = resolveQuestionCitation('Neural Networks Lecture', 1, 'sigmoid activation vanishing gradients', [deck])
    expect(c?.page).toBe(1)
  })

  it('falls back to the content match when the hint is absent', () => {
    const c = resolveQuestionCitation(undefined, undefined, 'sigmoid activation vanishing gradients', [deck])
    expect(c?.page).toBe(2)
  })

  it('falls back to the content match when the hint is unverifiable (bad page)', () => {
    const c = resolveQuestionCitation('Neural Networks Lecture', 99, 'convolution weight sharing receptive fields', [deck])
    expect(c?.page).toBe(3)
  })
})
