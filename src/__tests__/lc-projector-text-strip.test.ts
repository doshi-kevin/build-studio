/**
 * #648 — the projector's snapshot carried every question stem and choice label
 * verbatim. Nothing rendered them (ProjectorView draws a kind-keyed pill), so it was
 * not a live leak — but the invariant "the wall shows no question text" rested
 * entirely on the last layer's restraint, one refactor away from putting a quiz
 * question on a screen the whole room is reading.
 *
 * The oracle is the SERIALISED payload, not the DOM: the point of the fix is that the
 * text never reaches the machine plugged into the projector. Asserting a component
 * renders nothing would pass against the unfixed version.
 *
 * The student direction matters just as much in reverse — students must KEEP the text
 * or they cannot answer — so that is asserted too.
 */

import { describe, it, expect } from 'vitest'
import { stripInteractionText, stripQuizAnswers } from '@/lib/live-classroom/snapshot-utils'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

const QUIZ = {
  id: 'q-1',
  room_id: 'r-1',
  kind: 'quiz',
  status: 'open',
  created_by: 'prof',
  created_at: '2026-06-14T10:00:00Z',
  opened_at: '2026-06-14T10:00:00Z',
  closed_at: null,
  payload: {
    title: 'Trees Quiz',
    questions: [
      {
        id: 'k1',
        prompt: 'Which traversal visits the root last?',
        correctChoiceId: 'b',
        explanation: 'Post-order.',
        choices: [
          { id: 'a', text: 'Pre-order' },
          { id: 'b', text: 'Post-order' },
        ],
      },
    ],
  },
} as unknown as SnapshotInteraction

const POLL = {
  id: 'p-1',
  room_id: 'r-1',
  kind: 'poll',
  status: 'open',
  created_by: 'prof',
  created_at: '2026-06-14T10:00:00Z',
  opened_at: '2026-06-14T10:00:00Z',
  closed_at: null,
  payload: {
    question: 'How are we doing on recursion?',
    choices: [
      { id: 'a', text: 'Comfortable' },
      { id: 'b', text: 'Lost' },
    ],
    counts: { a: 3, b: 1 },
  },
} as unknown as SnapshotInteraction

describe('#648 — projector payload carries no question or choice text', () => {
  /* The projector path applies BOTH strips, in this order — getRoomSnapshot runs
     stripQuizAnswers for anything student-safe and then stripInteractionText for the
     projector specifically. Composing them here is what the wall actually receives;
     testing stripInteractionText alone would leave `explanation` in the payload and
     misrepresent the guarantee. */
  const forProjector = (i: SnapshotInteraction) => stripInteractionText(stripQuizAnswers(i))

  it('removes the quiz stem and every choice label', () => {
    const json = JSON.stringify(stripInteractionText(QUIZ))
    expect(json).not.toContain('Which traversal visits the root last?')
    expect(json).not.toContain('Pre-order')
  })

  it('leaves no answer text anywhere once the full projector path has run', () => {
    const json = JSON.stringify(forProjector(QUIZ))
    expect(json).not.toContain('Which traversal visits the root last?')
    expect(json).not.toContain('Pre-order')
    expect(json).not.toContain('Post-order')
    expect(json).not.toContain('correctChoiceId')
  })

  it('removes the poll question and its choice labels', () => {
    const json = JSON.stringify(stripInteractionText(POLL))
    expect(json).not.toContain('How are we doing on recursion?')
    expect(json).not.toContain('Comfortable')
    expect(json).not.toContain('Lost')
  })

  it('keeps structure, ids and counts so the projector can still render', () => {
    const out = stripInteractionText(POLL)
    const payload = out.payload as Record<string, unknown>
    expect(payload.counts).toEqual({ a: 3, b: 1 })
    expect((payload.choices as Array<{ id: string }>).map((c) => c.id)).toEqual(['a', 'b'])
    expect(out.kind).toBe('poll')
    expect(out.id).toBe('p-1')
  })

  it('leaves non-quiz/poll interactions untouched', () => {
    const question = { ...QUIZ, kind: 'question', payload: { text: 'Why is it O(log n)?' } } as unknown as SnapshotInteraction
    expect(stripInteractionText(question)).toEqual(question)
  })

  it('does not mutate the input', () => {
    const before = JSON.stringify(QUIZ)
    stripInteractionText(QUIZ)
    expect(JSON.stringify(QUIZ)).toBe(before)
  })
})

describe('students must still receive the text they need to answer', () => {
  it('stripQuizAnswers removes the key but KEEPS stems and choices', () => {
    const json = JSON.stringify(stripQuizAnswers(QUIZ))
    // The anti-cheat half.
    expect(json).not.toContain('correctChoiceId')
    expect(json).not.toContain('Post-order.')
    // …and the half that must survive, or the quiz is unanswerable.
    expect(json).toContain('Which traversal visits the root last?')
    expect(json).toContain('Pre-order')
  })
})
