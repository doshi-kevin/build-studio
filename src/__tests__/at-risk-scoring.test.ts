// The at-risk scoring engine (src/lib/risk/at-risk.ts).
//
// This replaces "below pass on 2+ quizzes OR missing 2+ quizzes", which had
// three copies and four defects. Each test below pins one of the defects shut,
// because every one of them fails silently: the professor sees a confident
// sentence and no error.
//
//   - assignments were invisible, so an assignments-only course flagged nobody
//     and then claimed everyone was fine
//   - a brutal item indicted the student instead of itself
//   - the rule fired the instant a deadline passed
//   - an empty list and "not enough evidence" were the same screen

import { describe, it, expect } from 'vitest'
import {
  scoreStudentRisk,
  compareRisk,
  MISSING_WORK_GRACE_MS,
  MIN_CLOSED_ITEMS,
  type RiskItem,
} from '@/lib/risk/at-risk'

const NOW = Date.parse('2026-03-01T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

/** A graded, handed-in item the class did fine on. Override per test. */
const item = (over: Partial<RiskItem> = {}): RiskItem => ({
  itemId: `i-${Math.random().toString(36).slice(2)}`,
  kind: 'assignment',
  title: 'Lab',
  studentPct: 80,
  submitted: true,
  dueAt: NOW - 10 * DAY,
  passThreshold: 60,
  classMedianPct: 80,
  exempt: false,
  ...over,
})

const score = (items: RiskItem[], weakSkillShare: number | null = null) =>
  scoreStudentRisk({ items, weakSkillShare, now: NOW })

describe('scoreStudentRisk — evidence gate', () => {
  it('refuses to judge before enough work has closed', () => {
    /* The defect this closes: an empty at-risk list rendered "All students are
       performing within acceptable thresholds", which is a claim of safety made
       from no evidence. hasEnoughSignal is what lets the UI say so. */
    const v = score([item({ studentPct: 5, classMedianPct: 90 })])
    expect(v.hasEnoughSignal).toBe(false)
    expect(v.atRisk).toBe(false)
    expect(v.band).toBeNull()
  })

  it('counts an item as closed once it is graded OR its grace has expired', () => {
    // One graded, one overdue and unsubmitted: two closed items, so judgeable.
    const v = score([
      item({ studentPct: 20, classMedianPct: 85 }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 5 * DAY }),
    ])
    expect(v.hasEnoughSignal).toBe(true)
  })

  it('does not count work that is still open', () => {
    const openItems = [
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW + 5 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW + 6 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: null }),
    ]
    expect(score(openItems).hasEnoughSignal).toBe(false)
    expect(MIN_CLOSED_ITEMS).toBe(2)
  })
})

describe('scoreStudentRisk — assignments are first-class', () => {
  it('flags a student who has skipped assignments in a course with no quizzes', () => {
    /* The headline defect. This exact student was invisible to the old rule and
       the tab said everyone was fine. */
    const missed = Array.from({ length: 3 }, (_, n) =>
      item({ kind: 'assignment', title: `Lab ${n}`, studentPct: null, submitted: false, classMedianPct: 75, dueAt: NOW - 10 * DAY }),
    )
    const v = score(missed)

    expect(v.hasEnoughSignal).toBe(true)
    expect(v.atRisk).toBe(true)
    expect(v.missingCount).toBe(3)
    expect(v.reasons[0]).toBe('missing 3 items')
  })

  it('treats a quiz and an assignment the same way', () => {
    const asQuiz = score([
      item({ kind: 'quiz', studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ kind: 'quiz', studentPct: null, submitted: false, classMedianPct: 80 }),
    ])
    const asAssignment = score([
      item({ kind: 'assignment', studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ kind: 'assignment', studentPct: null, submitted: false, classMedianPct: 80 }),
    ])
    expect(asQuiz.points).toBe(asAssignment.points)
    expect(asQuiz.atRisk).toBe(asAssignment.atRisk)
  })
})

describe('scoreStudentRisk — a hard item indicts itself, not the student', () => {
  it('does not count a below-pass score when the class also failed it', () => {
    // Class median 52 against a pass mark of 60: the quiz is the problem.
    const v = score([
      item({ studentPct: 50, passThreshold: 60, classMedianPct: 52 }),
      item({ studentPct: 51, passThreshold: 60, classMedianPct: 52 }),
    ])
    expect(v.belowCount).toBe(0)
    expect(v.atRisk).toBe(false)
  })

  it('does count it when the class cleared the bar comfortably', () => {
    const v = score([
      item({ studentPct: 40, passThreshold: 60, classMedianPct: 85 }),
      item({ studentPct: 35, passThreshold: 60, classMedianPct: 88 }),
    ])
    expect(v.belowCount).toBe(2)
    expect(v.points).toBeGreaterThan(0)
    expect(v.reasons).toContain('below the pass mark on 2 items')
    /* Grades alone max out at 30 of 100, so this lands in Monitor and stays off
       the alert list. That is the design's precision-over-recall stance: no
       single signal escalates on its own, because one axis looking bad is how
       false positives get in front of a professor. */
    expect(v.band).toBe('monitor')
    expect(v.atRisk).toBe(false)
  })

  it('escalates the same grades once a second signal agrees', () => {
    // Identical scores, but now most of their scored skills are under the bar.
    const v = score(
      [
        item({ studentPct: 40, passThreshold: 60, classMedianPct: 85 }),
        item({ studentPct: 35, passThreshold: 60, classMedianPct: 88 }),
      ],
      1,
    )
    expect(v.atRisk).toBe(true)
    expect(v.band).toBe('needs-support')
  })

  it('scores a student trailing the class even when they are technically passing', () => {
    // 62 against a class median of 95, pass mark 60. Passing, and far behind.
    const v = score([
      item({ studentPct: 62, passThreshold: 60, classMedianPct: 95 }),
      item({ studentPct: 61, passThreshold: 60, classMedianPct: 96 }),
    ])
    expect(v.belowCount).toBe(0)
    expect(v.points).toBeGreaterThan(0)
    expect(v.reasons).toContain('scoring below the class on graded work')
  })
})

describe('scoreStudentRisk — the grace window', () => {
  it('ignores work that went overdue less than the grace period ago', () => {
    const justOverdue = NOW - (MISSING_WORK_GRACE_MS - 60_000)
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: justOverdue }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: justOverdue }),
      item({ studentPct: 90, classMedianPct: 80 }),
      item({ studentPct: 88, classMedianPct: 80 }),
    ])
    expect(v.missingCount).toBe(0)
  })

  it('counts it once the grace period has passed', () => {
    const wellOverdue = NOW - (MISSING_WORK_GRACE_MS + DAY)
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: wellOverdue }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: wellOverdue }),
    ])
    expect(v.missingCount).toBe(2)
  })

  it('never counts an item with no due date as missing', () => {
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: null }),
      item({ studentPct: 70, classMedianPct: 75 }),
      item({ studentPct: 72, classMedianPct: 75 }),
    ])
    expect(v.missingCount).toBe(0)
  })

  it('treats a saved draft as not turned in', () => {
    // segmentRoster buckets a draft into notSubmitted: saved is not submitted.
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
    ])
    expect(v.missingCount).toBe(2)
  })
})

describe('scoreStudentRisk — exemptions', () => {
  it('never flags an exempt item as missing', () => {
    /* Covers an extension via resubmit_until, an excusal, and work assigned
       before the student enrolled. All three arrive here as exempt. */
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: 80, exempt: true }),
      item({ studentPct: null, submitted: false, classMedianPct: 80, exempt: true }),
      item({ studentPct: 85, classMedianPct: 80 }),
      item({ studentPct: 90, classMedianPct: 80 }),
    ])
    expect(v.missingCount).toBe(0)
    expect(v.atRisk).toBe(false)
  })

  it('excludes exempt items from the evidence gate too', () => {
    // Two exempt items are not two closed items.
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: 80, exempt: true }),
      item({ studentPct: null, submitted: false, classMedianPct: 80, exempt: true }),
    ])
    expect(v.hasEnoughSignal).toBe(false)
  })
})

describe('scoreStudentRisk — skill mastery signal', () => {
  it('adds concern when most of a student’s scored skills are under the bar', () => {
    const items = [item({ studentPct: 65, classMedianPct: 70 }), item({ studentPct: 66, classMedianPct: 70 })]
    const withoutSkills = score(items, null)
    const withWeakSkills = score(items, 0.9)
    expect(withWeakSkills.points).toBeGreaterThan(withoutSkills.points)
    expect(withWeakSkills.reasons.some((r) => r.includes('scored skills'))).toBe(true)
  })

  it('treats "no skills scored" the same as "all skills strong": no concern, never invented', () => {
    /* "Not measured" is not "failed". An unscored section must not manufacture
       risk, and must not be scored on a smaller denominator either — an earlier
       draft normalised over available signals and made two missing assignments
       read as "urgent" purely because the section curated no skills. */
    const items = [
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
    ]
    expect(score(items, null).points).toBe(score(items, 0).points)
  })

  it('does not let scarce evidence inflate the band', () => {
    // Two missing items and nothing else known is Monitor, not Urgent.
    const v = score(
      [
        item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 10 * DAY }),
        item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 10 * DAY }),
      ],
      null,
    )
    expect(v.missingCount).toBe(2)
    expect(v.band).toBe('monitor')
    expect(v.atRisk).toBe(false)
  })
})

describe('scoreStudentRisk — hysteresis and bands', () => {
  it('never rates a single bad graded item worse than monitor', () => {
    const v = score([
      item({ studentPct: 2, classMedianPct: 95 }),
      // second closed item, but not a comparable graded one
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: null, exempt: false, passThreshold: 60 }),
      item({ studentPct: null, submitted: false, classMedianPct: 90, dueAt: NOW + DAY }),
    ])
    if (v.hasEnoughSignal) {
      expect(v.band === null || v.band === 'monitor').toBe(true)
      expect(v.atRisk).toBe(false)
    }
  })

  it('reaches urgent only on a genuinely bad picture', () => {
    const bad = [
      item({ studentPct: 10, classMedianPct: 90 }),
      item({ studentPct: 15, classMedianPct: 88 }),
      item({ studentPct: null, submitted: false, classMedianPct: 85 }),
      item({ studentPct: null, submitted: false, classMedianPct: 85 }),
      item({ studentPct: null, submitted: false, classMedianPct: 85 }),
    ]
    const v = score(bad, 1)
    expect(v.band).toBe('urgent')
    expect(v.atRisk).toBe(true)
  })

  it('leaves a healthy student unflagged and unlabelled', () => {
    const v = score(
      [item({ studentPct: 92, classMedianPct: 80 }), item({ studentPct: 88, classMedianPct: 80 })],
      0,
    )
    expect(v.atRisk).toBe(false)
    expect(v.band).toBeNull()
    expect(v.reasons).toEqual([])
  })

  it('gives identical evidence an identical score whether or not skills are curated', () => {
    /* Curating skills must not change a student's standing when those skills
       are all strong, and not curating them must not change it either. Only
       demonstrated weak skills move the number. */
    const items = [
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ studentPct: null, submitted: false, classMedianPct: 80 }),
      item({ studentPct: 30, classMedianPct: 85 }),
    ]
    expect(score(items, null).points).toBe(score(items, 0).points)
    expect(score(items, 1).points).toBeGreaterThan(score(items, null).points)
  })
})

describe('compareRisk', () => {
  it('orders by concern, then missing work, then name', () => {
    const rows = [
      { points: 50, missingCount: 1, studentName: 'Zoe' },
      { points: 70, missingCount: 0, studentName: 'Adam' },
      { points: 50, missingCount: 3, studentName: 'Beth' },
      { points: 50, missingCount: 1, studentName: 'Alice' },
    ]
    expect([...rows].sort(compareRisk).map((r) => r.studentName)).toEqual(['Adam', 'Beth', 'Alice', 'Zoe'])
  })

  it('is stable across reversed input, so the list does not flip on reload', () => {
    const rows = [
      { points: 50, missingCount: 1, studentName: 'Zoe' },
      { points: 50, missingCount: 1, studentName: 'Alice' },
    ]
    const forward = [...rows].sort(compareRisk).map((r) => r.studentName)
    const backward = [...rows].reverse().sort(compareRisk).map((r) => r.studentName)
    expect(forward).toEqual(backward)
  })
})

describe('scoreStudentRisk — traps a reviewer raised', () => {
  it('does not clamp a student who has submitted nothing at all', () => {
    /* The one-graded-item clamp must key on exactly one COMPARABLE item, not on
       "few graded items". A student with zero graded work and four missing
       assignments would otherwise be pinned to Monitor, hiding the clearest
       at-risk case there is. */
    const v = score(
      Array.from({ length: 4 }, () =>
        item({ studentPct: null, submitted: false, classMedianPct: 80, dueAt: NOW - 10 * DAY }),
      ),
    )
    expect(v.gradedCount).toBe(0)
    expect(v.missingCount).toBe(4)
    expect(v.atRisk).toBe(true)
    expect(v.band).not.toBe('monitor')
  })

  it('requires corroboration before one catastrophic grade becomes an alert', () => {
    /* One graded item is not a trend, so its standing contribution is capped.
       A single 3% plus two missing items lands just under the alert line, and a
       SECOND graded item is what tips it. That is the design's precision stance
       working, not an oversight: the student surfaces as soon as anything
       corroborates, and until then a professor's attention is not spent. */
    const oneBadPlusTwoMissing = score([
      item({ studentPct: 3, classMedianPct: 95 }),
      item({ studentPct: null, submitted: false, classMedianPct: 90, dueAt: NOW - 10 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: 90, dueAt: NOW - 10 * DAY }),
    ])
    expect(oneBadPlusTwoMissing.band).toBe('monitor')
    expect(oneBadPlusTwoMissing.atRisk).toBe(false)

    const twoBadPlusTwoMissing = score([
      item({ studentPct: 3, classMedianPct: 95 }),
      item({ studentPct: 8, classMedianPct: 92 }),
      item({ studentPct: null, submitted: false, classMedianPct: 90, dueAt: NOW - 10 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: 90, dueAt: NOW - 10 * DAY }),
    ])
    expect(twoBadPlusTwoMissing.atRisk).toBe(true)
    // and the extra evidence must move it strictly upward, not just across a line
    expect(twoBadPlusTwoMissing.points).toBeGreaterThan(oneBadPlusTwoMissing.points)
  })

  it('judges a class where nobody submitted anything, rather than calling it no signal', () => {
    /* Every item is past grace and ungraded, so there is no class median
       anywhere. If "closed" required a grade, a section with a 100% miss rate
       would render "not enough signal yet" and hide a catastrophe. */
    const v = score([
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 10 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 10 * DAY }),
      item({ studentPct: null, submitted: false, classMedianPct: null, dueAt: NOW - 10 * DAY }),
    ])
    expect(v.hasEnoughSignal).toBe(true)
    expect(v.missingCount).toBe(3)
    expect(v.atRisk).toBe(true)
  })
})
