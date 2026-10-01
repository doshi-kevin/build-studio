// buildInlineFillInText (src/lib/ai/llm-client.ts) — converts an AI-generated
// fill-in-blank question (prose with `_____` markers + a parallel blanks[] answer
// list) into inline {{blank:id:answers}} tokens. A mapping bug here silently
// corrupts the answer key (drops/mis-orders answers), so the marker↔blank count
// mismatch paths are the ones worth pinning down.
import { describe, it, expect } from 'vitest'
import { buildInlineFillInText, parseRawQuestion, type RawQuestion } from '@/lib/ai/llm-client'

describe('buildInlineFillInText', () => {
  it('maps markers to blanks in order', () => {
    expect(
      buildInlineFillInText('The _____ makes _____.', [
        { id: 'b1', acceptedAnswers: ['mitochondria', 'mito'] },
        { id: 'b2', acceptedAnswers: ['ATP'] },
      ]),
    ).toBe('The {{blank:b1:mitochondria|mito}} makes {{blank:b2:ATP}}.')
  })

  it('appends surplus blanks when there are fewer markers than blanks (no answer dropped)', () => {
    const out = buildInlineFillInText('Only one _____ here.', [
      { id: 'b1', acceptedAnswers: ['first'] },
      { id: 'b2', acceptedAnswers: ['second'] },
    ])
    expect(out).toBe('Only one {{blank:b1:first}} here. {{blank:b2:second}}')
  })

  it('converts surplus markers into empty blanks (never a dead literal _____)', () => {
    const out = buildInlineFillInText('_____ then _____ then _____.', [
      { id: 'b1', acceptedAnswers: ['a'] },
    ])
    // Surplus markers become answerless {{blank:id}} tokens with fresh ids —
    // fillable chips the professor must complete, not dead underscores.
    expect(out).toMatch(
      /^\{\{blank:b1:a\}\} then \{\{blank:[A-Za-z0-9_-]+\}\} then \{\{blank:[A-Za-z0-9_-]+\}\}\.$/,
    )
    expect(out).not.toContain('_____')
  })

  it('appends every blank when the text has no markers at all', () => {
    expect(
      buildInlineFillInText('Define the term.', [{ id: 'b1', acceptedAnswers: ['osmosis'] }]),
    ).toBe('Define the term. {{blank:b1:osmosis}}')
  })

  it('emits positional-only tokens for blanks with no accepted answers', () => {
    expect(buildInlineFillInText('The _____ works.', [{ id: 'b1', acceptedAnswers: [] }])).toBe(
      'The {{blank:b1}} works.',
    )
  })
})

// parseRawQuestion fill_in_blank handling — the model sometimes omits blanks[]
// (putting the answer in the SA-style top-level acceptedAnswers instead), which
// used to fabricate a blank whose accepted answer was the literal word "answer"
// — rendered verbatim in the authoring chip and grading every student wrong.
describe('parseRawQuestion fill_in_blank fallbacks', () => {
  const fib = (over: Partial<RawQuestion>): RawQuestion => ({
    questionType: 'fill_in_blank',
    questionText: 'The objective is the average _____ log likelihood.',
    difficulty: 'medium',
    ...over,
  })

  it('salvages a top-level SA-style acceptedAnswers as a single blank', () => {
    const q = parseRawQuestion(fib({ acceptedAnswers: ['negative', 'Negative'] }), 0)
    expect(q).not.toBeNull()
    const content = q!.content as { questionType: string; blanks: { acceptedAnswers: string[] }[] }
    expect(content.blanks).toHaveLength(1)
    expect(content.blanks[0].acceptedAnswers).toEqual(['negative', 'Negative'])
    expect(q!.questionText).toContain(':negative|Negative}}')
    expect(q!.questionText).not.toMatch(/:answer\}\}/)
  })

  it('drops the question entirely when no answer exists anywhere (never fabricates "answer")', () => {
    expect(parseRawQuestion(fib({}), 0)).toBeNull()
    expect(parseRawQuestion(fib({ blanks: [] }), 0)).toBeNull()
    expect(parseRawQuestion(fib({ blanks: [{ acceptedAnswers: [] }] }), 0)).toBeNull()
  })

  it('keeps an answerless blank as an empty chip and mirrors it in content.blanks', () => {
    // 1 marker, 2 blank entries (second has no answers): the marker maps to the
    // answered blank; the answerless one is appended as an EMPTY chip token —
    // and content.blanks is derived from the final text, so they stay 1:1.
    const q = parseRawQuestion(
      fib({ blanks: [{ acceptedAnswers: ['solid'] }, { acceptedAnswers: [] }] }),
      0,
    )
    const content = q!.content as { blanks: { acceptedAnswers: string[] }[] }
    expect(content.blanks).toHaveLength(2)
    expect(content.blanks[0].acceptedAnswers).toEqual(['solid'])
    expect(content.blanks[1].acceptedAnswers).toEqual([])
    expect(q!.questionText).toMatch(/\{\{blank:[A-Za-z0-9_-]+\}\}/) // the empty chip
  })

  it('mints an empty blank for a surplus marker and includes it in content.blanks', () => {
    // 2 markers, 1 answered blank: the second marker becomes an empty chip whose
    // id also appears in content.blanks — text and blanks never disagree.
    const q = parseRawQuestion(
      fib({
        questionText: 'The _____ ratio is larger than _____.',
        blanks: [{ acceptedAnswers: ['solid'] }],
      }),
      0,
    )
    const content = q!.content as { blanks: { id: string; acceptedAnswers: string[] }[] }
    expect(content.blanks).toHaveLength(2)
    expect(content.blanks[1].acceptedAnswers).toEqual([])
    expect(q!.questionText).not.toContain('_____')
    // Every token id in the text has a matching content.blanks entry
    const idsInText = [...q!.questionText.matchAll(/\{\{blank:([A-Za-z0-9_-]+)/g)].map((m) => m[1])
    expect(idsInText).toEqual(content.blanks.map((b) => b.id))
  })
})

// Same "drop, never fabricate" contract for the other answer-bearing types.
// A large single-call batch made the model coast — emitting question text but
// omitting choices/answers. The parser used to paper over that with "Option N"
// / "Answer" placeholders that looked complete and graded every student wrong.
describe('parseRawQuestion multiple_choice drops instead of fabricating', () => {
  const mc = (over: Partial<RawQuestion>): RawQuestion => ({
    questionType: 'multiple_choice',
    questionText: 'What is the primary formal task of a language model?',
    difficulty: 'medium',
    ...over,
  })

  it('drops when fewer than 2 real choices come back (no "Option N" padding)', () => {
    expect(parseRawQuestion(mc({ choices: [] }), 0)).toBeNull()
    expect(parseRawQuestion(mc({ choices: [{ text: 'only one', isCorrect: true }] }), 0)).toBeNull()
    // Blank/whitespace-only choice text doesn't count toward the 2 minimum
    expect(
      parseRawQuestion(mc({ choices: [{ text: 'real', isCorrect: true }, { text: '  ' }] }), 0),
    ).toBeNull()
  })

  it('drops when no choice is marked correct (ungradeable answer key)', () => {
    expect(
      parseRawQuestion(mc({ choices: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }), 0),
    ).toBeNull()
  })

  it('keeps a well-formed MC (≥2 real choices, one correct)', () => {
    const q = parseRawQuestion(
      mc({ choices: [{ text: 'right', isCorrect: true }, { text: 'wrong', isCorrect: false }] }),
      0,
    )
    expect(q).not.toBeNull()
    const content = q!.content as { choices: { text: string; isCorrect: boolean }[] }
    expect(content.choices.map((c) => c.text)).toEqual(['right', 'wrong'])
    expect(content.choices.some((c) => c.isCorrect)).toBe(true)
    expect(content.choices.map((c) => c.text)).not.toContain('Option 1')
  })
})

describe('parseRawQuestion short_answer drops instead of fabricating', () => {
  const sa = (over: Partial<RawQuestion>): RawQuestion => ({
    questionType: 'short_answer',
    questionText: "What is an 'n-gram'?",
    difficulty: 'medium',
    ...over,
  })

  it('drops when no accepted answer comes back (never fabricates "Answer")', () => {
    expect(parseRawQuestion(sa({}), 0)).toBeNull()
    expect(parseRawQuestion(sa({ acceptedAnswers: [] }), 0)).toBeNull()
    expect(parseRawQuestion(sa({ acceptedAnswers: ['   '] }), 0)).toBeNull()
  })

  it('keeps a real single answer and expands case variants', () => {
    const q = parseRawQuestion(sa({ acceptedAnswers: ['BST'] }), 0)
    expect(q).not.toBeNull()
    const content = q!.content as { acceptedAnswers: string[] }
    expect(content.acceptedAnswers).toContain('BST')
    expect(content.acceptedAnswers).toContain('bst')
    expect(content.acceptedAnswers).not.toEqual(['Answer', 'answer', 'ANSWER'])
  })
})
