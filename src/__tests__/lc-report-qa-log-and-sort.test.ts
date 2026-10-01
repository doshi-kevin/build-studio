/**
 * Two of the three defects in #645. (Part 2 — "zero attendance reported as Not
 * tracked" — is deliberately NOT addressed: rooms that ended before attendance
 * tracking existed genuinely weren't tracked, so making `tracked` always-true
 * would have 172 historical reports assert "0 of N attended". See the fix-lane
 * note in the QA tracker.)
 *
 * Part 1: the answered-questions panel rendered `qa.top.filter(answered)`, and
 * `top` was truncated to 5 BEFORE the filter. So a session with 6 answered
 * questions could display 2 of them while the stat card read "6 answered", on a
 * surface presented as the complete Q&A log. The oracle is the COUNT of answered
 * questions surviving the pipeline — asserting the list is non-empty would pass
 * against the old code.
 *
 * Part 3: the per-student sort substituted `?? -1` for a null accuracy. Being a
 * real number it got scaled by the direction multiplier, so ascending floated
 * "no data" to the top. The oracle is the position of the null row in BOTH
 * directions; testing one direction would pass against the old code.
 */

import { describe, it, expect } from 'vitest'
import { computeSessionStats, type SessionReportInput } from '@/lib/live-classroom/report/compute'

const ROOM_START = '2026-06-14T10:00:00.000Z'
const ROOM_END = '2026-06-14T11:00:00.000Z'

/** n answered questions with descending upvotes, plus m unanswered with HIGHER upvotes. */
function questionInteractions(answered: number, unanswered: number) {
  const out: SessionReportInput['interactions'] = []
  // Unanswered ones deliberately out-rank every answered one, which is what made
  // the old top-5 slice starve the answered panel.
  for (let i = 0; i < unanswered; i++) {
    out.push({
      id: `u${i}`,
      kind: 'question',
      payload: { text: `Unanswered ${i}`, upvotes: 100 - i, answered: false },
      status: 'open',
      created_by: `s${i}`,
    })
  }
  for (let i = 0; i < answered; i++) {
    out.push({
      id: `a${i}`,
      kind: 'question',
      payload: { text: `Answered ${i}`, upvotes: 10 - i, answered: true },
      status: 'closed',
      created_by: `s${i}`,
    })
  }
  return out
}

function input(overrides: Partial<SessionReportInput> = {}): SessionReportInput {
  return {
    room: { createdAt: ROOM_START, endedAt: ROOM_END },
    decks: [],
    interactions: [],
    responses: [],
    enrolledStudents: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Student ${i}` })),
    attendance: [],
    ...overrides,
  }
}

describe('#645 part 1 — the Q&A log must not truncate answered questions', () => {
  it('keeps ALL answered questions, not the 5 highest-upvoted overall', async () => {
    // 6 answered + 4 unanswered, and the unanswered ones out-rank all answered.
    const report = computeSessionStats(input({ interactions: questionInteractions(6, 4) }))

    expect(report.qa.answeredCount).toBe(6)
    // The bug in one assertion: the panel's source must hold all 6.
    expect(report.qa.answered).toHaveLength(6)
    // The stat card and the list must agree — that mismatch was the reported symptom.
    expect(report.qa.answered?.length).toBe(report.qa.answeredCount)
    // Old top-5 view: every unanswered question out-ranks the answered ones, so
    // filtering it would have yielded 1 of the 6.
    expect(report.qa.top.filter((q) => q.answered).length).toBeLessThan(report.qa.answeredCount)
  })

  it('sorts answered questions by upvotes', async () => {
    const report = computeSessionStats(input({ interactions: questionInteractions(3, 0) }))
    const ups = (report.qa.answered ?? []).map((q) => q.upvotes)
    expect(ups).toEqual([...ups].sort((a, b) => b - a))
  })
})

// Part 3 (the null-sort ordering) is exercised against the real rendered table in
// lc-report-student-sort.test.tsx — a comparator mirrored into this file would pass
// even with the old `?? -1` still in the component, which is no regression guard
// at all.
