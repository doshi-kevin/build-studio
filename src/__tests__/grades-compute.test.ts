// Tests for the weighted-gradebook compute engine (src/lib/grades/compute.ts).
// Covers the three weighting shapes (individual / group / best-of-N), current grade,
// released-only visibility, excused + extra credit, empty-category redistribution,
// gradedWeight, hasEnoughGradedData, and letter mapping.

import { describe, it, expect } from 'vitest'
import {
  computeGrade,
  percentToLetter,
  DEFAULT_LETTER_CUTOFFS,
  itemKey,
  hasEnoughGradedData,
  MIN_GRADED_WEIGHT_FRACTION,
  type ItemScore,
  type SchemeCategory,
} from '@/lib/grades/compute'

// ── helpers ──────────────────────────────────────────────────────
function s(earned: number | null, possible = 100, extra: Partial<ItemScore> = {}): ItemScore {
  return { earned, possible, graded: earned != null, released: true, excused: false, ...extra }
}
function cat(id: string, itemIds: string[], extra: Partial<SchemeCategory> = {}): SchemeCategory {
  return {
    id, name: id, weight: 100, aggregation: 'average', keepN: null,
    scoreMode: 'points', isExtraCredit: false, position: 0,
    items: itemIds.map((iid) => ({ itemType: 'assignment', itemId: iid, isExtraCredit: false })),
    ...extra,
  }
}
const k = (id: string) => itemKey('assignment', id)

describe('computeGrade — basic weighting', () => {
  it('individual category maps a single item straight through', () => {
    const cats = [cat('final', ['a1'], { weight: 100, aggregation: 'single' })]
    const r = computeGrade(cats, { [k('a1')]: s(90) })
    expect(r.currentPercent).toBe(90)
    expect(r.currentLetter).toBe('A-')
    expect(r.weightTotal).toBe(100)
  })

  it('combines two categories by their weights', () => {
    const cats = [
      cat('hw', ['h1', 'h2'], { weight: 20 }),          // points: (100+50)/200 = 75
      cat('final', ['f1'], { weight: 80, aggregation: 'single' }), // 80
    ]
    const r = computeGrade(cats, { [k('h1')]: s(100), [k('h2')]: s(50), [k('f1')]: s(80) })
    // (20*75 + 80*80) / 100 = 79
    expect(r.currentPercent).toBe(79)
    expect(r.currentLetter).toBe('C+')
  })

  it('normalizes proportionally when weights do not sum to 100', () => {
    const cats = [cat('a', ['a1'], { weight: 30 }), cat('b', ['b1'], { weight: 30 })]
    const r = computeGrade(cats, { [k('a1')]: s(100), [k('b1')]: s(0) })
    expect(r.weightTotal).toBe(60)
    expect(r.currentPercent).toBe(50) // (30*100 + 30*0)/60
  })

  it('returns nulls when there are no categories or no graded work', () => {
    expect(computeGrade([], {}).currentPercent).toBeNull()
    const cats = [cat('a', ['a1'])]
    const r = computeGrade(cats, { [k('a1')]: s(null) })
    expect(r.currentPercent).toBeNull()
  })
})

describe('computeGrade — score modes', () => {
  it('equal mode averages item percentages regardless of point size', () => {
    const cats = [cat('c', ['a1', 'a2'], { scoreMode: 'equal' })]
    const r = computeGrade(cats, { [k('a1')]: s(90, 100), [k('a2')]: s(8, 10) })
    expect(r.currentPercent).toBe(85) // (90% + 80%) / 2
  })

  it('points mode weights by point total', () => {
    const cats = [cat('c', ['a1', 'a2'], { scoreMode: 'points' })]
    const r = computeGrade(cats, { [k('a1')]: s(90, 100), [k('a2')]: s(8, 10) })
    expect(r.currentPercent).toBe(89.1) // (90+8)/110*100
  })
})

describe('computeGrade — best-of-N', () => {
  it('keeps the top N by percentage and drops the rest', () => {
    const cats = [cat('q', ['q1', 'q2'], { aggregation: 'best_of_n', keepN: 1 })]
    const r = computeGrade(cats, { [k('q1')]: s(90), [k('q2')]: s(40) })
    expect(r.currentPercent).toBe(90)
    const dropped = r.categories[0].items.find((i) => i.itemId === 'q2')
    const kept = r.categories[0].items.find((i) => i.itemId === 'q1')
    expect(dropped?.state).toBe('dropped')
    expect(kept?.state).toBe('counted')
  })

  it('ranks by percentage, not raw points, before dropping', () => {
    // q1 = 18/20 = 90%, q2 = 45/50 = 90%... make q1 clearly better: 19/20=95 vs 40/50=80
    const cats = [cat('q', ['q1', 'q2'], { aggregation: 'best_of_n', keepN: 1, scoreMode: 'equal' })]
    const r = computeGrade(cats, { [k('q1')]: s(19, 20), [k('q2')]: s(40, 50) })
    expect(r.currentPercent).toBe(95)
  })

  it('drops nothing when graded count does not exceed keepN', () => {
    const cats = [cat('q', ['q1', 'q2'], { aggregation: 'best_of_n', keepN: 3 })]
    const r = computeGrade(cats, { [k('q1')]: s(80), [k('q2')]: s(40) })
    expect(r.currentPercent).toBe(60) // both kept: (80+40)/200
  })

  it('keepN of 0 keeps all items (documented "0 = keep all", not "drop all")', () => {
    const cats = [cat('q', ['q1', 'q2'], { aggregation: 'best_of_n', keepN: 0 })]
    const r = computeGrade(cats, { [k('q1')]: s(90), [k('q2')]: s(40) })
    expect(r.currentPercent).toBe(65) // both kept: (90+40)/200
  })
})

describe('computeGrade — current (released-only)', () => {
  it('ungraded item is pending and does not affect current', () => {
    const cats = [cat('c', ['a1', 'a2'])]
    const r = computeGrade(cats, { [k('a1')]: s(50), [k('a2')]: s(null) })
    expect(r.currentPercent).toBe(50)   // only graded item contributes
    expect(r.categories[0].items.find((i) => i.itemId === 'a2')?.state).toBe('pending')
  })

  it('an auto-zeroed (graded 0) item counts in current', () => {
    const cats = [cat('c', ['a1'])]
    const r = computeGrade(cats, { [k('a1')]: s(0) })
    expect(r.currentPercent).toBe(0)
  })

  it('released-only: an unreleased grade is pending for the student view', () => {
    const cats = [cat('c', ['a1'])]
    const r = computeGrade(cats, { [k('a1')]: s(30, 100, { released: false }) })
    expect(r.currentPercent).toBeNull()    // not counted while unreleased
    expect(r.categories[0].items[0].state).toBe('pending')
  })
})

describe('computeGrade — excused', () => {
  it('removes an excused item from the denominator', () => {
    const cats = [cat('c', ['a1', 'a2'])]
    const r = computeGrade(cats, { [k('a1')]: s(80), [k('a2')]: s(20, 100, { excused: true }) })
    expect(r.currentPercent).toBe(80) // only a1 counts
    expect(r.categories[0].items.find((i) => i.itemId === 'a2')?.state).toBe('excused')
  })

  it('redistributes weight when a whole category has no counted items', () => {
    const cats = [
      cat('a', ['a1'], { weight: 50 }),
      cat('b', ['b1'], { weight: 50 }),
    ]
    const r = computeGrade(cats, {
      [k('a1')]: s(60, 100, { excused: true }), // cat a empty
      [k('b1')]: s(80),
    })
    expect(r.categories[0].currentPercent).toBeNull()
    expect(r.currentPercent).toBe(80) // cat b absorbs the full weight
  })
})

describe('computeGrade — extra credit', () => {
  it('an extra-credit item adds to the numerator but not the denominator (points mode)', () => {
    const cats: SchemeCategory[] = [{
      ...cat('c', []),
      items: [
        { itemType: 'assignment', itemId: 'n1', isExtraCredit: false },
        { itemType: 'assignment', itemId: 'e1', isExtraCredit: true },
      ],
    }]
    const r = computeGrade(cats, { [k('n1')]: s(80), [k('e1')]: s(10) })
    expect(r.currentPercent).toBe(90) // (80 + 10) / 100
  })

  it('an extra-credit item lifts the average in equal mode (numerator only, denom = normal count)', () => {
    const cats: SchemeCategory[] = [{
      ...cat('c', []),
      scoreMode: 'equal',
      items: [
        { itemType: 'assignment', itemId: 'n1', isExtraCredit: false },
        { itemType: 'assignment', itemId: 'e1', isExtraCredit: true },
      ],
    }]
    const r = computeGrade(cats, { [k('n1')]: s(80), [k('e1')]: s(10) })
    expect(r.currentPercent).toBe(90) // (80% + 10%) / 1 normal item
  })

  it('an extra-credit category adds on top and is excluded from weightTotal', () => {
    const cats = [
      cat('main', ['m1'], { weight: 100 }),
      cat('bonus', ['b1'], { weight: 10, isExtraCredit: true }),
    ]
    const r = computeGrade(cats, { [k('m1')]: s(80), [k('b1')]: s(100) })
    expect(r.weightTotal).toBe(100)     // EC weight excluded
    expect(r.currentPercent).toBe(90)   // 80 + (10/100 * 100)
  })
})

describe('computeGrade — gradedWeight', () => {
  it('is 0 when nothing is graded', () => {
    const cats = [cat('a', ['a1'], { weight: 60 }), cat('b', ['b1'], { weight: 40 })]
    const r = computeGrade(cats, { [k('a1')]: s(null), [k('b1')]: s(null) })
    expect(r.gradedWeight).toBe(0)
  })

  it('equals weight of only the categories that have graded data', () => {
    const cats = [cat('a', ['a1'], { weight: 60 }), cat('b', ['b1'], { weight: 40 })]
    // only cat a graded
    const r = computeGrade(cats, { [k('a1')]: s(80), [k('b1')]: s(null) })
    expect(r.gradedWeight).toBe(60)
  })

  it('equals weightTotal when all non-EC categories are graded', () => {
    const cats = [cat('a', ['a1'], { weight: 60 }), cat('b', ['b1'], { weight: 40 })]
    const r = computeGrade(cats, { [k('a1')]: s(80), [k('b1')]: s(70) })
    expect(r.gradedWeight).toBe(100)
    expect(r.gradedWeight).toBe(r.weightTotal)
  })

  it('excludes EC category weight from gradedWeight', () => {
    const cats = [
      cat('main', ['m1'], { weight: 100 }),
      cat('bonus', ['b1'], { weight: 10, isExtraCredit: true }),
    ]
    const r = computeGrade(cats, { [k('m1')]: s(80), [k('b1')]: s(100) })
    expect(r.gradedWeight).toBe(100) // EC not counted
  })

  it('uses the redistribution denom, not raw weight, matching computeCurrent active filter', () => {
    // Two cats 50+50; only one graded. gradedWeight = 50, not 100.
    const cats = [cat('hw', ['h1'], { weight: 50 }), cat('final', ['f1'], { weight: 50 })]
    const r = computeGrade(cats, { [k('h1')]: s(80), [k('f1')]: s(null) })
    expect(r.gradedWeight).toBe(50)
    expect(r.currentPercent).toBe(80)
  })
})

describe('hasEnoughGradedData', () => {
  it('returns false when nothing is graded', () => {
    const cats = [cat('a', ['a1'], { weight: 100 })]
    const r = computeGrade(cats, { [k('a1')]: s(null) })
    expect(hasEnoughGradedData(r)).toBe(false)
  })

  it('returns false when graded fraction is below 20%', () => {
    // 10 weight graded out of 100 total = 10% < 20%
    const cats = [cat('small', ['s1'], { weight: 10 }), cat('big', ['b1'], { weight: 90 })]
    const r = computeGrade(cats, { [k('s1')]: s(80), [k('b1')]: s(null) })
    expect(r.gradedWeight / r.weightTotal).toBeLessThan(MIN_GRADED_WEIGHT_FRACTION)
    expect(hasEnoughGradedData(r)).toBe(false)
  })

  it('returns true exactly at the 20% boundary', () => {
    // 20 weight graded out of 100 total = exactly 20%
    const cats = [cat('a', ['a1'], { weight: 20 }), cat('b', ['b1'], { weight: 80 })]
    const r = computeGrade(cats, { [k('a1')]: s(70), [k('b1')]: s(null) })
    expect(r.gradedWeight / r.weightTotal).toBe(0.2)
    expect(hasEnoughGradedData(r)).toBe(true)
  })

  it('returns true when more than 20% is graded', () => {
    const cats = [cat('a', ['a1'], { weight: 50 }), cat('b', ['b1'], { weight: 50 })]
    const r = computeGrade(cats, { [k('a1')]: s(90), [k('b1')]: s(null) })
    expect(hasEnoughGradedData(r)).toBe(true)
  })

  it('returns true when everything is graded', () => {
    const cats = [cat('a', ['a1'], { weight: 100 })]
    const r = computeGrade(cats, { [k('a1')]: s(85) })
    expect(hasEnoughGradedData(r)).toBe(true)
  })
})

describe('percentToLetter', () => {
  it('maps the standard scale', () => {
    expect(percentToLetter(97)).toBe('A+')
    expect(percentToLetter(93)).toBe('A')
    expect(percentToLetter(90)).toBe('A-')
    expect(percentToLetter(89.9)).toBe('B+')
    expect(percentToLetter(60)).toBe('D-')
    expect(percentToLetter(59)).toBe('F')
    expect(percentToLetter(0)).toBe('F')
  })

  it('respects custom cutoffs', () => {
    const custom = [{ letter: 'A' as const, min: 90 }, { letter: 'B' as const, min: 80 }, { letter: 'F' as const, min: 0 }]
    expect(percentToLetter(95, custom)).toBe('A')
    expect(percentToLetter(85, custom)).toBe('B')
    expect(percentToLetter(50, custom)).toBe('F')
  })

  it('returns null for a null percent', () => {
    expect(percentToLetter(null)).toBeNull()
    expect(DEFAULT_LETTER_CUTOFFS.length).toBeGreaterThan(0)
  })
})

describe('computeGrade — guards', () => {
  it('skips a zero-point item from the denominator instead of dividing by zero', () => {
    const cats = [cat('c', ['a1', 'a2'])]
    const r = computeGrade(cats, { [k('a1')]: s(80), [k('a2')]: s(0, 0) })
    expect(r.currentPercent).toBe(80)
    expect(r.categories[0].items.find((i) => i.itemId === 'a2')?.state).toBe('pending')
  })
})

describe('computeGrade — single aggregation', () => {
  it('uses exactly the one item in a single-item category (ignores score_mode)', () => {
    // score_mode 'equal' must NOT change the result — single always uses earned/possible
    const cats = [cat('final', ['f1'], { aggregation: 'single', scoreMode: 'equal', weight: 100 })]
    const r = computeGrade(cats, { [k('f1')]: s(75, 100) })
    expect(r.currentPercent).toBe(75)
  })

  it('uses equal scoreMode result same as points for single item — both should be 75', () => {
    // Confirm score_mode is truly irrelevant: same inputs, different scoreMode, same output
    const catsPoints = [cat('final', ['f1'], { aggregation: 'single', scoreMode: 'points', weight: 100 })]
    const catsEqual = [cat('final', ['f1'], { aggregation: 'single', scoreMode: 'equal', weight: 100 })]
    const scores = { [k('f1')]: s(75, 100) }
    expect(computeGrade(catsPoints, scores).currentPercent).toBe(computeGrade(catsEqual, scores).currentPercent)
  })

  it('with multiple items (legacy data), uses the first item by position and ignores the rest', () => {
    // First item: 90%; second: 40%. Result must be 90, not an average/total.
    const cats = [cat('final', ['f1', 'f2'], { aggregation: 'single', weight: 100 })]
    const r = computeGrade(cats, { [k('f1')]: s(90, 100), [k('f2')]: s(40, 100) })
    expect(r.currentPercent).toBe(90)
  })
})
