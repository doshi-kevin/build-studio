// Tests the CCAT free-text grader: position-aligned node coverage, the soft-score
// g = nodes_met/total, and the keyword fallback when the model call fails. The
// Gemini SDK is mocked so these are deterministic and offline.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the AI SDK + provider so no network/key is needed.
const generateObjectMock = vi.fn()
/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('ai', () => ({ generateObject: (...args: unknown[]) => generateObjectMock(...args) }))
vi.mock('@ai-sdk/google', () => ({ google: () => 'mock-model' }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { gradeExplanation, gradeWalkthrough, walkthroughTurn, keywordGrade } from '@/lib/quiz/irt/grader'
import type { RubricNode } from '@/lib/validations/quiz'

const RUBRIC: RubricNode[] = [
  { concept: 'sigmoid saturates so its derivative approaches 0', match: ['saturat', 'derivative'] },
  { concept: 'many small derivatives multiply and vanish through layers', match: ['multiply', 'vanish'] },
  { concept: 'ReLU has gradient 1 on the positive side', match: ['relu', 'gradient 1'] },
]

beforeEach(() => generateObjectMock.mockReset())

describe('gradeExplanation — Gemini node coverage', () => {
  it('aligns verdicts by POSITION and computes g = nodes_met/total', async () => {
    // Model says node 1 + node 3 met, node 2 not → 2/3.
    generateObjectMock.mockResolvedValue({
      object: {
        points: [{ met: true }, { met: false }, { met: true }],
        rationale: 'Good on saturation and ReLU; missed the multiplication-through-layers step.',
      },
    })
    const grade = await gradeExplanation('Explain vanishing gradients.', RUBRIC, 'some answer', { sectionId: 'sec-1' })
    expect(grade.mode).toBe('gemini')
    expect(grade.nodesMet).toBe(2)
    expect(grade.total).toBe(3)
    expect(grade.g).toBeCloseTo(2 / 3, 6)
    expect(grade.nodes.map((n) => n.met)).toEqual([true, false, true])
    expect(grade.nodes[0].concept).toBe(RUBRIC[0].concept)
  })

  it('defaults missing trailing verdicts to false (never crashes on short model output)', async () => {
    generateObjectMock.mockResolvedValue({ object: { points: [{ met: true }], rationale: '' } })
    const grade = await gradeExplanation('Q', RUBRIC, 'partial', { sectionId: 'sec-1' })
    expect(grade.nodes.map((n) => n.met)).toEqual([true, false, false])
    expect(grade.g).toBeCloseTo(1 / 3, 6)
  })

  it('keyword fallback matches each node by its `match` keywords', () => {
    // Answer hits node 1 (derivative/saturate) and node 3 (relu) by keyword.
    const grade = keywordGrade(RUBRIC, 'the derivative saturates and relu helps')
    expect(grade.mode).toBe('keyword')
    expect(grade.nodes.map((n) => n.met)).toEqual([true, false, true])
    expect(grade.g).toBeCloseTo(2 / 3, 6)
  })

  it('returns g=0 with no rubric rather than calling the model', async () => {
    const grade = await gradeExplanation('Q', [], 'anything')
    expect(generateObjectMock).not.toHaveBeenCalled()
    expect(grade.g).toBe(0)
    expect(grade.total).toBe(0)
  })
})

// AI generation no longer emits a `match` keyword array (it sent Gemini into
// repetition loops), so the offline keyword fallback now derives keywords from
// each node's concept text and credits on a ≥half-the-words threshold. These
// cover that path — the `match`-list path is covered above.
describe('keywordGrade — concept-derived fallback (no `match` list)', () => {
  it('credits a node when the answer hits ≥half its significant concept words', () => {
    // concept words (len≥4, non-stopword): sigmoid, saturates, derivative,
    // approaches → 4 words, threshold = ceil(4/2) = 2. Answer hits 2 (sigmoid,
    // derivative) → met.
    const rubric: RubricNode[] = [{ concept: 'sigmoid saturates so its derivative approaches 0' }]
    const grade = keywordGrade(rubric, 'the sigmoid has a small derivative here')
    expect(grade.mode).toBe('keyword')
    expect(grade.nodes[0].met).toBe(true)
    expect(grade.g).toBeCloseTo(1, 6)
  })

  it('does NOT credit a node below the half-words threshold', () => {
    // Same 4 words, threshold 2. Answer hits only 1 (sigmoid) → not met.
    const rubric: RubricNode[] = [{ concept: 'sigmoid saturates so its derivative approaches 0' }]
    const grade = keywordGrade(rubric, 'the sigmoid is a function')
    expect(grade.nodes[0].met).toBe(false)
    expect(grade.g).toBe(0)
  })

  it('mixes explicit-match (any-hit) and derived (half-words) nodes correctly', () => {
    const rubric: RubricNode[] = [
      { concept: 'gradients vanish through layers', match: ['vanish'] }, // any single hit
      { concept: 'ReLU keeps gradient positive saturating never' }, // derived, threshold 3
    ]
    // Node 1: 'vanish' present → met. Node 2: derived words relu/keeps/gradient/
    // positive/saturating/never (6, threshold 3); answer hits relu+gradient only
    // (2 < 3) → not met.
    const grade = keywordGrade(rubric, 'vanishing happens; relu and gradient are mentioned')
    expect(grade.nodes.map((n) => n.met)).toEqual([true, false])
    expect(grade.g).toBeCloseTo(1 / 2, 6)
  })

  it('treats a concept with no significant words (all short/stopwords) as not met', () => {
    const rubric: RubricNode[] = [{ concept: 'it is so on the' }]
    const grade = keywordGrade(rubric, 'it is so on the')
    expect(grade.nodes[0].met).toBe(false)
    expect(grade.g).toBe(0)
  })
})

describe('kill-switch attribution requirement', () => {
  it('NO attribution → keyword fallback, model never called (fail-closed spend guard)', async () => {
    // Trap documented for the next person: quizAiAllowed(undefined) refuses
    // WITHOUT consulting the (mocked-open) kill-switch module — an
    // unattributable call must never spend. Forgetting attribution in a new
    // caller silently downgrades to keyword grading; this pins that behavior.
    generateObjectMock.mockResolvedValue({
      object: { points: [{ met: true }, { met: true }, { met: true }], rationale: 'n/a' },
    })
    const grade = await gradeExplanation('Q', RUBRIC, 'saturates derivative')
    expect(grade.mode).toBe('keyword')
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})

describe('gradeWalkthrough', () => {
  it('scores the transcript by insights demonstrated', async () => {
    generateObjectMock.mockResolvedValue({
      object: { points: [{ met: true }, { met: true }, { met: false }], rationale: 'Solid.' },
    })
    const grade = await gradeWalkthrough(
      'Reason about X.',
      RUBRIC,
      [
        { role: 'tutor', text: 'opening' },
        { role: 'student', text: 'my reasoning' },
      ],
      { sectionId: 'sec-1' },
    )
    expect(grade.g).toBeCloseTo(2 / 3, 6)
  })
})

describe('walkthroughTurn', () => {
  it('forces done=true once the student turn cap is reached', async () => {
    generateObjectMock.mockResolvedValue({ object: { reply: 'Nice work.', done: false } })
    const transcript = [
      { role: 'tutor' as const, text: 'q1' },
      { role: 'student' as const, text: 'a1' },
      { role: 'tutor' as const, text: 'q2' },
      { role: 'student' as const, text: 'a2' },
    ]
    const out = await walkthroughTurn('prompt', RUBRIC, transcript, 2, { sectionId: 'sec-1' }) // cap = 2 student turns
    expect(out.done).toBe(true) // forced even though the model returned done=false
  })

  it('continues (done=false) while under the cap', async () => {
    generateObjectMock.mockResolvedValue({ object: { reply: 'Go deeper.', done: false } })
    const out = await walkthroughTurn('prompt', RUBRIC, [{ role: 'student', text: 'a1' }], 4, { sectionId: 'sec-1' })
    expect(out.done).toBe(false)
    expect(out.reply).toBe('Go deeper.')
  })
})
