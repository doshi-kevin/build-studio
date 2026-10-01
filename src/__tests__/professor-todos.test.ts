// Unit tests for the professor dashboard to-do engine.
//
// The two behaviours worth protecting are the ones that make this engine
// different from the student's: aggregation to one row per (course × kind), and
// per-kind urgency (grading ages, deadlines count down, blocking work pins).
// Everything asserts observable output — bucket, title, count, href — never the
// shape of the implementation.

import { describe, it, expect } from 'vitest'
import {
  buildProfessorTodoList,
  countProfessorTodosBySection,
  buildGradingQueue,
  sortGradingQueue,
  type ProfessorTodoSources,
} from '@/lib/dashboard/professor-todos'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()
const daysAhead = (n: number) => new Date(NOW + n * DAY).toISOString()

const S1 = 'sec-1'
const S2 = 'sec-2'

function sources(over: Partial<ProfessorTodoSources> = {}): ProfessorTodoSources {
  return {
    courseCodeBySection: { [S1]: 'CS-513', [S2]: 'CS-101' },
    assessments: [],
    ungraded: [],
    turnedInByAssessment: {},
    enrolledBySection: { [S1]: 10, [S2]: 20 },
    failedSlideRooms: [],
    recentReportsBySection: {},
    ...over,
  }
}

const assignment = (id: string, sectionId: string, title: string, dueAt: string | null = null) =>
  ({ id, sectionId, title, dueAt, type: 'assignment' as const })

describe('grading — urgency comes from how long a student has waited', () => {
  const withAge = (days: number) =>
    buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1')],
        ungraded: [{ assignmentId: 'a1', submittedAt: daysAgo(days) }],
      }),
      NOW,
    )[0]

  it('escalates to Needs Attention at 3 days, not before', () => {
    expect(withAge(2).group).toBe('upcoming')
    expect(withAge(3).group).toBe('attention')
  })

  it('treats work submitted today as lowest urgency', () => {
    const row = withAge(0)
    expect(row.group).toBe('later')
    expect(row.dueLabel).toBe('New')
  })

  it('reports the age of the OLDEST submission, not the newest', () => {
    const [row] = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(1) },
          { assignmentId: 'a1', submittedAt: daysAgo(22) },
        ],
      }),
      NOW,
    )
    expect(row.dueLabel).toBe('22d waiting')
    expect(row.group).toBe('attention')
  })
})

describe('aggregation — one row per (course × kind)', () => {
  it('collapses many submissions across many assignments into a single row per course', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [
          assignment('a1', S1, 'Project 1'),
          assignment('a2', S1, 'Problem Set 6'),
          assignment('a3', S2, 'Essay'),
        ],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(5) },
          { assignmentId: 'a1', submittedAt: daysAgo(4) },
          { assignmentId: 'a2', submittedAt: daysAgo(1) },
          { assignmentId: 'a3', submittedAt: daysAgo(1) },
        ],
      }),
      NOW,
    )
    const grading = items.filter((i) => i.kind === 'grading')
    expect(grading).toHaveLength(2) // two courses, not four submissions
    expect(grading.map((g) => g.sectionId).sort()).toEqual([S1, S2])
  })

  it('names the assessment when there is exactly one, and links straight to it', () => {
    const [row] = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1')],
        ungraded: [{ assignmentId: 'a1', submittedAt: daysAgo(4) }],
      }),
      NOW,
    )
    expect(row.title).toBe('Project 1 — 1 to grade')
    expect(row.href).toBe('/professor/courses/sec-1/assignments/a1?tab=grading')
  })

  it('falls back to a count and the gradebook when several assessments are involved', () => {
    const [row] = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1'), assignment('a2', S1, 'Problem Set 6')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(4) },
          { assignmentId: 'a2', submittedAt: daysAgo(4) },
          { assignmentId: 'a2', submittedAt: daysAgo(4) },
        ],
      }),
      NOW,
    )
    expect(row.title).toBe('3 to grade across 2 assignments')
    expect(row.href).toBe('/professor/courses/sec-1/grades?tab=assignments')
  })

  it('ignores submissions whose assessment is outside the professor’s sections', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [],
        ungraded: [{ assignmentId: 'not-mine', submittedAt: daysAgo(9) }],
      }),
      NOW,
    )
    expect(items).toHaveLength(0)
  })
})

describe('deadlines — only inside the horizon, and never without a turn-in signal', () => {
  it('includes an assessment closing this week and states how many have submitted', () => {
    const [row] = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Problem Set 6', daysAhead(4))],
        turnedInByAssessment: { a1: 4 },
      }),
      NOW,
    )
    expect(row.kind).toBe('deadline')
    expect(row.title).toBe('Problem Set 6 — 4 of 10 submitted')
    expect(row.group).toBe('upcoming')
  })

  it('shares the student list’s 48-hour attention threshold', () => {
    const at = (n: number) =>
      buildProfessorTodoList(
        sources({ assessments: [assignment('a1', S1, 'Problem Set 6', daysAhead(n))] }),
        NOW,
      )[0].group
    expect(at(2)).toBe('attention') // exactly 48h out
    expect(at(3)).toBe('upcoming')
  })

  it('drops assessments beyond the 7-day horizon and ones already closed', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [
          assignment('far', S1, 'Final', daysAhead(30)),
          assignment('past', S1, 'Midterm', daysAgo(1)),
        ],
      }),
      NOW,
    )
    expect(items.filter((i) => i.kind === 'deadline')).toHaveLength(0)
  })
})

describe('class prep and reports', () => {
  it('names the session when only one deck failed', () => {
    const [row] = buildProfessorTodoList(
      sources({
        failedSlideRooms: [{ id: 'r1', sectionId: S1, name: 'Week 10 Lecture', scheduledAt: daysAhead(1) }],
      }),
      NOW,
    )
    expect(row.title).toBe('Slides failed for Week 10 Lecture')
    expect(row.group).toBe('attention') // tomorrow's class is inside the 48h window
  })

  it('keeps ready class reports on the radar, never blocking', () => {
    const [row] = buildProfessorTodoList(sources({ recentReportsBySection: { [S1]: 3 } }), NOW)
    expect(row.group).toBe('later')
    expect(row.title).toBe('3 class reports ready to review')
  })
})

describe('ordering', () => {
  it('sorts by bucket first, then puts blocking work above the bulk of grading', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1')],
        ungraded: [{ assignmentId: 'a1', submittedAt: daysAgo(10) }],
        failedSlideRooms: [{ id: 'r1', sectionId: S2, name: 'Week 10', scheduledAt: daysAhead(1) }],
        recentReportsBySection: { [S1]: 1 },
      }),
      NOW,
    )
    expect(items.map((i) => i.kind)).toEqual(['class_prep', 'grading', 'class_report'])
  })
})

describe('course-card counts match the list', () => {
  it('counts rows per section', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1')],
        ungraded: [{ assignmentId: 'a1', submittedAt: daysAgo(4) }],
        recentReportsBySection: { [S1]: 1, [S2]: 1 },
      }),
      NOW,
    )
    const counts = countProfessorTodosBySection(items)
    expect(counts.get(S1)).toBe(2) // grading + class_report
    expect(counts.get(S2)).toBe(1)
    // Every row is attributed to exactly one course.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(items.length)
  })
})

describe('grading queue card', () => {
  // The biggest pile is deliberately NOT the oldest here. A per-course summary
  // computed those two independently, so it could report a 22-day wait while
  // linking to work handed in this morning.
  const mismatched = () =>
    buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Essay'), assignment('a2', S2, 'Problem Set')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(0) },
          { assignmentId: 'a1', submittedAt: daysAgo(0) },
          { assignmentId: 'a1', submittedAt: daysAgo(0) },
          { assignmentId: 'a2', submittedAt: daysAgo(22) },
        ],
      }),
      NOW,
    )

  it('never reports an age from one assignment and a link to another', () => {
    for (const row of mismatched()) {
      expect(row.href).toContain(`/assignments/${row.assessmentId}?tab=grading`)
    }
    // The 22-day wait belongs to a2, so a2 is what the top row links to.
    const [first] = mismatched()
    expect(first.oldestDays).toBe(22)
    expect(first.assessmentId).toBe('a2')
  })

  it('gives every assignment in one course its own deep-linked row', () => {
    const rows = buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Essay'), assignment('a2', S1, 'Problem Set')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(4) },
          { assignmentId: 'a2', submittedAt: daysAgo(1) },
        ],
      }),
      NOW,
    )
    // Two assignments in ONE section: the old per-course grouping collapsed
    // these into a single row that could only link to the gradebook.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.href)).toEqual([
      '/professor/courses/sec-1/assignments/a1?tab=grading',
      '/professor/courses/sec-1/assignments/a2?tab=grading',
    ])
  })

  it('counts a missing submission timestamp as today rather than hiding the work', () => {
    const rows = buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Essay')],
        ungraded: [{ assignmentId: 'a1', submittedAt: null }],
      }),
      NOW,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].oldestDays).toBe(0)
    expect(rows[0].waiting).toBe(1)
  })

  it('leaves quizzes out — they auto-score, so nothing waits on the professor', () => {
    const rows = buildGradingQueue(
      sources({
        assessments: [{ id: 'q1', sectionId: S1, title: 'Midterm', dueAt: null, type: 'quiz' }],
        ungraded: [{ assignmentId: 'q1', submittedAt: daysAgo(5) }],
      }),
      NOW,
    )
    expect(rows).toEqual([])
  })

  it('is empty when nothing is waiting', () => {
    expect(buildGradingQueue(sources(), NOW)).toEqual([])
  })

  it('never renders a blank title, even for a whitespace-only one', () => {
    // The query layer defaults a NULL title but passes '' straight through, and
    // a row's title is the professor's only handle on the work.
    const rows = buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, ''), assignment('a2', S1, '   ')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(2) },
          { assignmentId: 'a2', submittedAt: daysAgo(4) },
        ],
      }),
      NOW,
    )
    expect(rows.map((r) => r.title)).toEqual(['Untitled assignment', 'Untitled assignment'])
  })

  it('drops a submission whose assignment is outside the professor’s sections', () => {
    // `src.assessments` IS the tenancy boundary here — it only ever holds
    // assignments from sections this professor owns. A submission with no
    // matching assessment must vanish, not surface a row (or throw on the
    // non-null lookup that follows the guard).
    const rows = buildGradingQueue(
      sources({
        assessments: [assignment('mine', S1, 'Essay')],
        ungraded: [
          { assignmentId: 'not-mine', submittedAt: daysAgo(30) },
          { assignmentId: 'mine', submittedAt: daysAgo(1) },
        ],
      }),
      NOW,
    )
    expect(rows.map((r) => r.assessmentId)).toEqual(['mine'])
  })

  it('counts only its own assignment’s submissions, not the course’s', () => {
    // The bug this rework fixes was a per-COURSE count. Both assignments live
    // in one section with different pile sizes, so a section-wide total would
    // report 4 and 4 instead of 3 and 1.
    const rows = buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Essay'), assignment('a2', S1, 'Problem Set')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(2) },
          { assignmentId: 'a1', submittedAt: daysAgo(2) },
          { assignmentId: 'a1', submittedAt: daysAgo(2) },
          { assignmentId: 'a2', submittedAt: daysAgo(5) },
        ],
      }),
      NOW,
    )
    expect(rows.map((r) => [r.title, r.waiting])).toEqual([
      ['Problem Set', 1],
      ['Essay', 3],
    ])
  })

  it('attributes each row to its own course, and tolerates a section with no code', () => {
    // Rows from two sections are interleaved by age, so a row's section and
    // course code must travel with the row rather than with its position.
    const rows = buildGradingQueue(
      sources({
        courseCodeBySection: { [S1]: 'CS-513' }, // S2 deliberately has no code
        assessments: [assignment('a1', S1, 'Essay'), assignment('a2', S2, 'Problem Set')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(1) },
          { assignmentId: 'a2', submittedAt: daysAgo(6) },
        ],
      }),
      NOW,
    )
    expect(rows.map((r) => [r.sectionId, r.courseCode])).toEqual([
      [S2, ''], // '' not undefined — the card renders the code conditionally on it
      [S1, 'CS-513'],
    ])
  })
})

describe('grading queue sorting', () => {
  const rows = () =>
    buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Essay'), assignment('a2', S2, 'Problem Set')],
        ungraded: [
          // a1: a big pile, all fresh. a2: one submission, very stale.
          ...Array.from({ length: 5 }, () => ({ assignmentId: 'a1', submittedAt: daysAgo(1) })),
          { assignmentId: 'a2', submittedAt: daysAgo(9) },
        ],
      }),
      NOW,
    )

  it('leads with the longest wait by default', () => {
    expect(rows().map((r) => r.assessmentId)).toEqual(['a2', 'a1'])
  })

  it('leads with the biggest pile when sorted by most', () => {
    expect(sortGradingQueue(rows(), 'most').map((r) => r.assessmentId)).toEqual(['a1', 'a2'])
  })

  it('breaks ties on title so the order never reshuffles between renders', () => {
    const tied = buildGradingQueue(
      sources({
        assessments: [assignment('a1', S1, 'Zebra'), assignment('a2', S1, 'Alpha')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(3) },
          { assignmentId: 'a2', submittedAt: daysAgo(3) },
        ],
      }),
      NOW,
    )
    expect(tied.map((r) => r.title)).toEqual(['Alpha', 'Zebra'])
    expect(sortGradingQueue(tied, 'most').map((r) => r.title)).toEqual(['Alpha', 'Zebra'])
  })

  it('does not mutate the array it is given', () => {
    const original = rows()
    const before = original.map((r) => r.assessmentId)
    sortGradingQueue(original, 'most')
    expect(original.map((r) => r.assessmentId)).toEqual(before)
  })
})

describe('link safety', () => {
  it('never emits an off-site or scheme-bearing href', () => {
    const items = buildProfessorTodoList(
      sources({
        assessments: [assignment('a1', S1, 'Project 1', daysAhead(1))],
        ungraded: [{ assignmentId: 'a1', submittedAt: daysAgo(4) }],
        failedSlideRooms: [{ id: 'r1', sectionId: S1, name: null, scheduledAt: daysAhead(1) }],
        recentReportsBySection: { [S1]: 1 },
      }),
      NOW,
    )
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.href.startsWith('/professor/courses/')).toBe(true)
      expect(item.href).not.toContain('//')
    }
  })

  it('holds the grading queue to the same invariant', () => {
    // The card is a second href-emitting surface, and `safeHref` only inspects
    // the PREFIX — it happily passes '/professor/courses//assignments/x', which
    // a blank section id would produce. Assert on the whole path.
    const rows = buildGradingQueue(
      sources({
        courseCodeBySection: {},
        assessments: [assignment('a1', S1, 'Project 1'), assignment('a2', S2, 'Essay')],
        ungraded: [
          { assignmentId: 'a1', submittedAt: daysAgo(4) },
          { assignmentId: 'a2', submittedAt: null },
        ],
      }),
      NOW,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.href.startsWith('/professor/courses/')).toBe(true)
      expect(row.href).not.toContain('//')
    }
  })
})
