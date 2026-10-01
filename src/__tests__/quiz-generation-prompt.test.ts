// The quiz generation prompt is split (design §11b) into a run-STATIC system
// prompt (buildQuizSystemPrompt) and a per-call assignment tail
// (buildQuizCallAssignment) appended after the source content — Gemini's
// implicit caching discounts a repeated request prefix, so per-call values
// must never appear in the system prompt. The system prompt's two grounding
// modes must NOT leak into each other: in the normal mode the model may only
// use the provided content and MUST cite a [Title, page N] source marker; in
// "beyond the document" mode the material is topic briefs (no page markers),
// so the prompt must flip to standard-knowledge grounding AND drop the
// source-attribution instructions — otherwise the model is told to cite pages
// that don't exist.
import { describe, it, expect } from 'vitest'
import { buildQuizSystemPrompt, buildQuizCallAssignment } from '@/lib/ai/prompts'

describe('buildQuizSystemPrompt — grounding modes', () => {
  it('grounds to ONLY the provided content and requires source attribution by default', () => {
    const prompt = buildQuizSystemPrompt(undefined, false, ['multiple_choice'])
    expect(prompt).toContain('from the provided lecture content')
    expect(prompt).toContain('based ONLY on the provided content')
    expect(prompt).toContain('SOURCE ATTRIBUTION')
  })

  it('flips to standard-knowledge grounding and DROPS source attribution in beyondDocument mode', () => {
    const prompt = buildQuizSystemPrompt(undefined, false, ['multiple_choice'], true)
    // Topic-brief framing, standard-knowledge accuracy rule.
    expect(prompt).toContain('topic briefs')
    expect(prompt).toContain('standard, widely-accepted knowledge')
    // The page-marker instructions would tell the model to cite nonexistent
    // pages — they must be absent when there are no source markers to cite.
    expect(prompt).not.toContain('SOURCE ATTRIBUTION')
    expect(prompt).not.toContain('based ONLY on the provided content')
  })
})

describe('buildQuizSystemPrompt / buildQuizCallAssignment — static/varying split', () => {
  it('keeps every per-call value OUT of the system prompt (cache-prefix invariant)', () => {
    // Identical run settings, different call values → byte-identical system prompt.
    const a = buildQuizSystemPrompt(undefined, false, ['multiple_choice'])
    const b = buildQuizSystemPrompt(undefined, false, ['multiple_choice'])
    expect(a).toBe(b)
    // No question-count-shaped text (the "EXACTLY 2-4 rubric nodes" type rule
    // is static and fine) — the count lives only in the assignment tail.
    expect(a).not.toMatch(/EXACTLY \d+ questions/i)
  })

  it('pins the exact requested count in the assignment tail', () => {
    expect(buildQuizCallAssignment(7)).toContain('EXACTLY 7')
    expect(buildQuizCallAssignment(7)).toContain('not 8')
  })

  it('carries difficulty, focus concepts, and avoid-list in the assignment tail only', () => {
    const tail = buildQuizCallAssignment(
      5,
      { easy: 1, medium: 3, hard: 1 },
      ['What is Laplace smoothing?'],
      [{ name: 'Laplace smoothing', summary: 'add-one counts' }],
      ['multiple_choice'],
    )
    expect(tail).toContain('EXACTLY 1 easy, 3 medium, and 1 hard')
    expect(tail).toContain('ASSIGNED CONCEPTS')
    expect(tail).toContain('Laplace smoothing — add-one counts [as multiple_choice]')
    expect(tail).toContain('DO NOT REPEAT')
    expect(tail).toContain('What is Laplace smoothing?')
  })
})

describe('question-type distribution — multi-type requests must yield a spread', () => {
  const concepts = [
    { name: 'C0', summary: 's0' },
    { name: 'C1', summary: 's1' },
    { name: 'C2', summary: 's2' },
  ]

  it('round-robins a distinct concrete type per concept, cycling when types run out', () => {
    const tail = buildQuizCallAssignment(3, undefined, undefined, concepts, ['multiple_choice', 'true_false'])
    // Not the old "[as X or Y]" form (which let the model pick X every time → all-MC).
    expect(tail).not.toContain('[as multiple_choice or true_false]')
    expect(tail).toContain('C0 — s0 [as multiple_choice]')
    expect(tail).toContain('C1 — s1 [as true_false]')
    // index 2 % 2 wraps back to the first type.
    expect(tail).toContain('C2 — s2 [as multiple_choice]')
  })

  it('pins the single type on every concept when only one is requested', () => {
    const tail = buildQuizCallAssignment(3, undefined, undefined, concepts, ['short_answer'])
    expect(tail).toContain('C0 — s0 [as short_answer]')
    expect(tail).toContain('C1 — s1 [as short_answer]')
    expect(tail).toContain('C2 — s2 [as short_answer]')
  })

  it('emits the balanced-mix directive only when more than one type is listed', () => {
    const multi = buildQuizSystemPrompt(undefined, false, ['multiple_choice', 'true_false'])
    expect(multi).toContain('DISTRIBUTE')
    const single = buildQuizSystemPrompt(undefined, false, ['multiple_choice'])
    expect(single).toContain('Only one type is listed')
    expect(single).not.toContain('DISTRIBUTE')
  })
})
