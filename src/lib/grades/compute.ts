// Weighted-gradebook compute engine — pure, dependency-free, unit-tested.
//
// DEFERRED (#464): this engine is currently reachable only from its tests — its live callers (the
// scheme actions + the professor/student grade views) were removed from PR #469 as unreachable
// dead code. Kept in the branch on purpose: the #464 follow-up PR resurrects the grade views and
// wires this back in. If #464 is abandoned, delete this file + fetch.ts's read functions with it.
//
// Turns a section's grading scheme (weighted categories of assignment/quiz/project items) plus one
// student's per-item scores into a Current grade (graded + released work only). Everything on both
// the professor and student surfaces renders from this output — keep all grade math here, not in
// the UI or actions.
//
// Current — only items that are graded AND released (and not excused) contribute. Categories with
// no graded items are excluded and their weight redistributes across those that do, so this reads
// as "your weighted average on graded work so far".
//
// The professor view passes released=true for every graded item (staff see true numbers); the student
// view passes the real release state so unreleased grades read as "pending" until the professor
// releases them.

export type ItemType = 'assignment' | 'quiz' | 'project'
export type Aggregation = 'average' | 'best_of_n' | 'single'
export type ScoreMode = 'points' | 'equal'

/** A member item of a category. */
export interface CategoryItemRef {
  itemType: ItemType
  itemId: string
  /** Earned points add to the numerator without adding to the denominator; never dropped. */
  isExtraCredit: boolean
}

export interface SchemeCategory {
  id: string
  name: string
  /** Percent of the final grade. Non-extra-credit weights are expected (but not required) to sum to 100. */
  weight: number
  aggregation: Aggregation
  /** best_of_n only: how many top items (by %) to keep. Null/<=0 or >= item count ⇒ keep all. */
  keepN: number | null
  scoreMode: ScoreMode
  /** An extra-credit category adds on top of the grade and is excluded from the 100% denominator. */
  isExtraCredit: boolean
  position: number
  items: CategoryItemRef[]
}

/** One student's result for a single item. `possible` must be > 0 to contribute. */
export interface ItemScore {
  earned: number | null
  possible: number
  /** Has a score been recorded at all (a real 0 counts as graded). */
  graded: boolean
  /** Is the score visible to the student. Pass true for all graded items on the professor view. */
  released: boolean
  /** Excused for this student — removed from the grade entirely (not a 0, not a drop). */
  excused: boolean
}

export interface LetterCutoff {
  letter: string
  min: number
}

export type ItemState = 'counted' | 'pending' | 'dropped' | 'excused'

export interface ItemResult {
  itemType: ItemType
  itemId: string
  earned: number | null
  possible: number
  /** earned/possible*100, rounded to 1 decimal. Null when not graded/released. */
  percent: number | null
  isExtraCredit: boolean
  /** State in the Current view (what actually counts right now). */
  state: ItemState
}

export interface CategoryResult {
  categoryId: string
  name: string
  weight: number
  isExtraCredit: boolean
  currentPercent: number | null
  /** Percentage points this category contributes to the current grade (after weight normalization). */
  currentContribution: number | null
  items: ItemResult[]
}

export interface GradeResult {
  currentPercent: number | null
  currentLetter: string | null
  categories: CategoryResult[]
  /** Sum of non-extra-credit category weights — UI warns when this isn't 100. */
  weightTotal: number
  /** Sum of non-EC category weights that have a non-null currentPercent (graded coverage denominator). */
  gradedWeight: number
}

// The minimum fraction of total course weight that must be graded before we surface the overall
// grade to students. Below this threshold, the computed number is not meaningful.
export const MIN_GRADED_WEIGHT_FRACTION = 0.2

/** Returns true when enough of the course has been graded to show the student the overall grade. */
export function hasEnoughGradedData(r: GradeResult): boolean {
  return r.currentPercent != null && r.weightTotal > 0 && r.gradedWeight / r.weightTotal >= MIN_GRADED_WEIGHT_FRACTION
}

// Standard US letter scale, used when a section hasn't customized its cutoffs.
export const DEFAULT_LETTER_CUTOFFS: LetterCutoff[] = [
  { letter: 'A+', min: 97 },
  { letter: 'A', min: 93 },
  { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 },
  { letter: 'B', min: 83 },
  { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 },
  { letter: 'C', min: 73 },
  { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 },
  { letter: 'D', min: 63 },
  { letter: 'D-', min: 60 },
  { letter: 'F', min: 0 },
]

export function itemKey(itemType: ItemType, itemId: string): string {
  return `${itemType}:${itemId}`
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Map a percentage to a letter using cutoffs sorted high→low. Returns null when percent is null. */
export function percentToLetter(
  percent: number | null,
  cutoffs: LetterCutoff[] = DEFAULT_LETTER_CUTOFFS,
): string | null {
  if (percent == null) return null
  const sorted = [...cutoffs].sort((a, b) => b.min - a.min)
  for (const c of sorted) {
    if (percent >= c.min) return c.letter
  }
  // Below the lowest cutoff: fall back to the last (lowest) letter if defined.
  return sorted.length > 0 ? sorted[sorted.length - 1].letter : null
}

interface PreparedItem {
  ref: CategoryItemRef
  score: ItemScore
  /** Contributes to the Current view (graded & released & not excused & has points). */
  inCurrent: boolean
  /** earned used for the Current view. */
  curEarned: number
  curPercent: number
}

/**
 * Aggregate one category for the current view.
 * @param prepared  the category's non-excused member items
 */
function aggregateCategory(
  category: SchemeCategory,
  prepared: PreparedItem[],
): { percent: number | null; keptKeys: Set<string> } {
  // Split extra-credit items out — they never rank/drop and never enter the denominator.
  const normal = prepared.filter((p) => !p.ref.isExtraCredit)
  const extra = prepared.filter((p) => p.ref.isExtraCredit)

  if (normal.length === 0 && extra.length === 0) return { percent: null, keptKeys: new Set() }

  // best_of_n: rank normal items by % and keep the top keepN (only drops once count exceeds keepN).
  let kept = normal
  if (category.aggregation === 'best_of_n') {
    const keepN = category.keepN
    if (keepN != null && keepN > 0 && normal.length > keepN) {
      kept = [...normal].sort((a, b) => b.curPercent - a.curPercent).slice(0, keepN)
    }
  }

  const keptKeys = new Set(kept.map((p) => itemKey(p.ref.itemType, p.ref.itemId)))

  if (kept.length === 0 && extra.length === 0) return { percent: null, keptKeys }

  let percent: number
  if (category.aggregation === 'single') {
    // Single-item category: the grade is exactly the first item's fraction. score_mode is irrelevant.
    // We use the first item by stored position. If legacy data placed multiple items here, we ignore
    // all but the first — the schema refine prevents this going forward.
    const item = kept[0]
    if (!item) return { percent: null, keptKeys }
    if (item.score.possible <= 0) return { percent: null, keptKeys }
    percent = (item.curEarned / item.score.possible) * 100
  } else if (category.scoreMode === 'equal') {
    // Average of per-item percentages; extra-credit percents lift the sum without raising the count.
    const denom = kept.length
    if (denom === 0) return { percent: null, keptKeys }
    const sum = kept.reduce((s, p) => s + p.curPercent, 0) + extra.reduce((s, p) => s + p.curPercent, 0)
    percent = sum / denom
  } else {
    // points: total earned / total possible over kept normal items;
    // extra-credit earned adds to the numerator only.
    const possible = kept.reduce((s, p) => s + p.score.possible, 0)
    if (possible <= 0) return { percent: null, keptKeys }
    const earned =
      kept.reduce((s, p) => s + p.curEarned, 0) + extra.reduce((s, p) => s + p.curEarned, 0)
    percent = (earned / possible) * 100
  }

  return { percent: round1(percent), keptKeys }
}

/**
 * Compute a student's Current grade from the scheme and their item scores.
 * @param categories  the section's categories (with member item refs)
 * @param scores      lookup keyed by itemKey(type,id) → this student's ItemScore
 * @param cutoffs     letter-grade cutoffs (defaults to the standard scale)
 */
export function computeGrade(
  categories: SchemeCategory[],
  scores: Record<string, ItemScore>,
  cutoffs: LetterCutoff[] = DEFAULT_LETTER_CUTOFFS,
): GradeResult {
  const categoryResults: CategoryResult[] = []

  for (const category of categories) {
    // Resolve + prepare each member item (skip missing scores and excused items from aggregation).
    const prepared: PreparedItem[] = []
    const itemResults: ItemResult[] = []

    for (const ref of category.items) {
      const score = scores[itemKey(ref.itemType, ref.itemId)]
      if (!score) continue // orphaned membership (item deleted) — ignore

      const gradedReleased = score.graded && score.released && !score.excused && score.possible > 0
      const curEarned = gradedReleased ? score.earned ?? 0 : 0
      const curPercent = score.possible > 0 ? (curEarned / score.possible) * 100 : 0

      if (!score.excused) {
        prepared.push({
          ref,
          score,
          inCurrent: gradedReleased,
          curEarned,
          curPercent,
        })
      }

      itemResults.push({
        itemType: ref.itemType,
        itemId: ref.itemId,
        earned: gradedReleased ? score.earned ?? 0 : null,
        possible: score.possible,
        percent: gradedReleased ? round1(curPercent) : null,
        isExtraCredit: ref.isExtraCredit,
        state: score.excused ? 'excused' : gradedReleased ? 'counted' : 'pending',
      })
    }

    // Current view uses only graded+released items.
    const currentPrepared = prepared.filter((p) => p.inCurrent)
    const { percent: currentPercent, keptKeys: curKept } = aggregateCategory(category, currentPrepared)

    // Mark items dropped by best-of-N in the Current view (only among counted items).
    if (category.aggregation === 'best_of_n') {
      for (const ir of itemResults) {
        if (ir.state === 'counted' && !ir.isExtraCredit && !curKept.has(itemKey(ir.itemType, ir.itemId))) {
          ir.state = 'dropped'
        }
      }
    }

    categoryResults.push({
      categoryId: category.id,
      name: category.name,
      weight: category.weight,
      isExtraCredit: category.isExtraCredit,
      currentPercent,
      currentContribution: null, // filled after normalization below
      items: itemResults,
    })
  }

  // ── Combine categories into the overall grade ──────────────────
  const normalCats = categoryResults.filter((c) => !c.isExtraCredit)
  const ecCats = categoryResults.filter((c) => c.isExtraCredit)

  const weightTotal = round1(normalCats.reduce((s, c) => s + c.weight, 0))

  // CURRENT — grade on graded work only. Categories with no graded items are excluded and their
  // weight redistributes across the categories that do, so this reads as "your average so far".
  const active = normalCats.filter((c) => c.currentPercent != null && c.weight > 0)
  const denom = active.reduce((s, c) => s + c.weight, 0)

  let currentPercent: number | null = null
  if (denom > 0) {
    let grade = active.reduce((s, c) => s + c.weight * (c.currentPercent as number), 0) / denom
    for (const c of active) c.currentContribution = round1((c.weight / denom) * (c.currentPercent as number))
    for (const ec of ecCats) {
      if (ec.currentPercent != null && ec.weight > 0) {
        grade += (ec.weight / 100) * ec.currentPercent
        ec.currentContribution = round1((ec.weight / 100) * ec.currentPercent)
      }
    }
    currentPercent = round1(grade)
  }

  // gradedWeight = sum of non-EC category weights that have graded data (the denom above).
  const gradedWeight = denom

  return {
    currentPercent,
    currentLetter: percentToLetter(currentPercent, cutoffs),
    categories: categoryResults,
    weightTotal,
    gradedWeight,
  }
}
