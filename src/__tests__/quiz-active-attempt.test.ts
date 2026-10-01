// findLiveQuizAttempt decides whether Athena is locked (G8), so both halves of
// "live" matter: an attempt that is still submittable must lock, and one that no
// longer is must NOT — nothing server-side ever flips an abandoned row to
// submitted, so a naive status check would cost the student Athena for the term.

import { describe, it, expect } from 'vitest'
import { findLiveQuizAttempt } from '@/lib/quiz/active-attempt'

const NOW = Date.parse('2026-07-27T12:00:00Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

type Row = Record<string, unknown>

/** Minimal chainable Supabase double — the filters are exercised by the route
 *  suite; here the rows are handed in directly. */
function db(rows: Row[], error: { message: string } | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(resolve),
  }
  return { from: () => chain }
}

const attempt = (quiz: Row, startedMinutesAgo = 10) => ({
  id: 'att-1',
  started_at: ago(startedMinutesAgo),
  quiz,
})

describe('findLiveQuizAttempt', () => {
  it('locks during a timed attempt that is still running', async () => {
    const rows = [attempt({ title: 'Midterm Quiz', time_limit_minutes: 60 }, 10)]
    expect(await findLiveQuizAttempt(db(rows), 'student-1', NOW)).toEqual({ quizTitle: 'Midterm Quiz' })
  })

  it('stays locked inside the grace window just past the limit', async () => {
    // 62 min into a 60-min quiz: the submit can still land, so the lock must
    // hold. Without this the grace window could be deleted unnoticed — the
    // expiry case below passes either way.
    const rows = [attempt({ title: 'Midterm Quiz', time_limit_minutes: 60 }, 62)]
    expect(await findLiveQuizAttempt(db(rows), 'student-1', NOW)).toEqual({ quizTitle: 'Midterm Quiz' })
  })

  it('releases once the time limit (plus grace) has run out', async () => {
    // Started 70 min ago on a 60-min quiz: 5 min of grace has also passed.
    const rows = [attempt({ title: 'Midterm Quiz', time_limit_minutes: 60 }, 70)]
    expect(await findLiveQuizAttempt(db(rows), 'student-1', NOW)).toBeNull()
  })

  it('uses the due date when the quiz is untimed', async () => {
    const live = [attempt({ title: 'Take-home', due_date: ahead(30) })]
    const past = [attempt({ title: 'Take-home', due_date: ago(30) })]
    expect(await findLiveQuizAttempt(db(live), 'student-1', NOW)).toEqual({ quizTitle: 'Take-home' })
    expect(await findLiveQuizAttempt(db(past), 'student-1', NOW)).toBeNull()
  })

  it('backstops an open-ended attempt at 24h so it cannot lock Athena forever', async () => {
    const fresh = [attempt({ title: 'Practice' }, 60)]
    const abandoned = [attempt({ title: 'Practice' }, 25 * 60)]
    expect(await findLiveQuizAttempt(db(fresh), 'student-1', NOW)).toEqual({ quizTitle: 'Practice' })
    expect(await findLiveQuizAttempt(db(abandoned), 'student-1', NOW)).toBeNull()
  })

  it('stays locked when nothing dates the attempt at all', async () => {
    // No start time, no limit, no due date — there is no evidence the attempt is
    // over, so the fail-closed default has to keep the lock on (and the title
    // fallback has to produce a sentence the student can read).
    const rows = [{ id: 'att-1', started_at: null, quiz: { title: null } }]
    expect(await findLiveQuizAttempt(db(rows), 'student-1', NOW)).toEqual({ quizTitle: 'a quiz' })
  })

  it('skips a stale attempt but still finds a live one behind it', async () => {
    const rows = [
      attempt({ title: 'Old quiz', time_limit_minutes: 30 }, 300),
      attempt({ title: 'Current quiz', time_limit_minutes: 60 }, 5),
    ]
    expect(await findLiveQuizAttempt(db(rows), 'student-1', NOW)).toEqual({ quizTitle: 'Current quiz' })
  })

  it('throws on a read error instead of reporting "not locked"', async () => {
    // The callers decide: the send path refuses, the UI keeps rendering. Either
    // way this must never quietly return null.
    await expect(findLiveQuizAttempt(db([], { message: 'boom' }), 'student-1', NOW)).rejects.toThrow(/boom/)
  })
})
