// resolveGradeValue decides the score written on save. The bug it guards (filed three times as
// silent grade loss): a submission graded manually BEFORE a rubric was added must NOT have its
// score overwritten by the rubric total when the professor ticks a criterion. The grader now makes
// that choice explicit ("Keep this score" vs "Grade with the rubric") and passes it as
// `useManualField`, so this function is a single honest branch with no hidden preservation logic.

import { describe, it, expect } from 'vitest'
import { resolveGradeValue } from '@/lib/assignments/grade-value'

describe('resolveGradeValue', () => {
  it('uses the manual score field when useManualField is true', () => {
    expect(resolveGradeValue({ useManualField: true, manualScore: 88, rubricTotal: 0 })).toBe(88)
  })

  it('a kept pre-rubric score is the manual field, never the rubric total', () => {
    // The exact regression: pre-rubric 87.5, a rubric worth 10 exists; "Keep this score" saves 87.5.
    expect(resolveGradeValue({ useManualField: true, manualScore: 87.5, rubricTotal: 10 })).toBe(87.5)
  })

  it('uses the rubric total when grading with the rubric', () => {
    expect(resolveGradeValue({ useManualField: false, manualScore: 87.5, rubricTotal: 10 })).toBe(10)
  })

  it('grading with the rubric and nothing ticked is an intentional 0 (start fresh)', () => {
    expect(resolveGradeValue({ useManualField: false, manualScore: 87.5, rubricTotal: 0 })).toBe(0)
  })

  it('a blank manual field surfaces as NaN for the caller to reject', () => {
    expect(resolveGradeValue({ useManualField: true, manualScore: NaN, rubricTotal: 0 })).toBeNaN()
  })
})
