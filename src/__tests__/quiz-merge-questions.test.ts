// Regression guard for the "duplicate key" / "clicking one question selects two"
// bug in the quiz studio. AI-generated questions use their dbId as the clientId,
// and TWO code paths can merge the same server-persisted question into the rail
// concurrently: the live generation stream and the reattach poll (which fires on
// reload / navigation / a fresh tab while a run is still going). Without a dedupe
// at the append point they collide on that shared key. mergeQuestions runs inside
// the setQuestions updater to make every merge idempotent by identity.

import { describe, it, expect } from 'vitest'
import { mergeQuestions } from '@/components/professor/quizzes/wizard/QuizStudio'
import type { WizardQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'

// Only clientId/dbId matter to mergeQuestions — the rest is filler.
function q(clientId: string, dbId?: string | null): WizardQuestion {
  return { clientId, dbId: dbId ?? null } as WizardQuestion
}

describe('mergeQuestions', () => {
  it('appends genuinely new questions', () => {
    const prev = [q('a', 'a'), q('b', 'b')]
    const out = mergeQuestions(prev, [q('c', 'c')])
    expect(out.map((x) => x.clientId)).toEqual(['a', 'b', 'c'])
  })

  it('drops an incoming question already present by dbId (the live-stream vs reattach race)', () => {
    // Streamed with clientId===dbId; reattach maps the SAME row (also clientId===dbId).
    const prev = [q('q1', 'q1'), q('q2', 'q2')]
    const out = mergeQuestions(prev, [q('q2', 'q2'), q('q3', 'q3')])
    expect(out.map((x) => x.clientId)).toEqual(['q1', 'q2', 'q3'])
  })

  it('dedupes when a reattached row (clientId===dbId) meets a streamed row with a different clientId', () => {
    // Same dbId, different clientId — must still collapse to one.
    const prev = [q('stream-cid', 'db-1')]
    const out = mergeQuestions(prev, [q('db-1', 'db-1')])
    expect(out).toHaveLength(1)
    expect(out[0].clientId).toBe('stream-cid')
  })

  it('dedupes duplicates WITHIN a single incoming batch', () => {
    const out = mergeQuestions([], [q('x', 'x'), q('x', 'x'), q('y', 'y')])
    expect(out.map((x) => x.clientId)).toEqual(['x', 'y'])
  })

  it('keeps not-yet-persisted questions (no dbId) distinct by clientId', () => {
    const prev = [q('local-1', null)]
    const out = mergeQuestions(prev, [q('local-2', null), q('local-1', null)])
    expect(out.map((x) => x.clientId)).toEqual(['local-1', 'local-2'])
  })

  it('returns the same array reference when nothing is fresh (no needless re-render)', () => {
    const prev = [q('a', 'a')]
    const out = mergeQuestions(prev, [q('a', 'a')])
    expect(out).toBe(prev)
  })

  it('never produces duplicate clientIds across a merge', () => {
    const prev = [q('a', 'a'), q('b', 'b')]
    const out = mergeQuestions(prev, [q('b', 'b'), q('c', 'c'), q('c', 'c')])
    const ids = out.map((x) => x.clientId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
