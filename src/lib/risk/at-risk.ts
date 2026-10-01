// At-risk detection — the pure scoring engine.
//
// Replaces three copies of "below pass on 2+ quizzes OR missing 2+ quizzes"
// (the gradebook's getClassAnalytics, and loadCourseSnapshot +
// loadStudentPerformance in the professor assistant). That rule was not wrong,
// it was narrow and uncalibrated:
//
//   - It ignored assignments entirely, so a student who skipped three labs was
//     invisible. On a course that runs no quizzes it flagged nobody, and the
//     gradebook then rendered "All students are performing within acceptable
//     thresholds" — a positive assertion of safety made from zero evidence.
//   - It treated a brutal quiz with a class median of 52% as evidence about the
//     student rather than about the quiz.
//   - It fired the instant a deadline passed, before late submissions and slow
//     grading had settled.
//
// Design: docs/designs/early-warning-system.md (§4.2, §4.3). That document
// specifies six signals; this implements the three that need no new tables.
// Signals 4 (mastery sliding, needs snapshots), 5 (dormancy) and 6 (material
// engagement) are deliberately absent — see MAX_POINTS_BY_SIGNAL below for how
// the score stays calibrated without them.
//
// Pure: no DB, no auth, no clock beyond what the caller passes in. Readers live
// with their callers, the same split src/lib/skills/scoring.ts uses.

/** How long after a due date a non-submission starts to count as missing.
 *  Late-window submissions and slow grading are the largest false-positive
 *  source at a deadline, so the rule waits them out. */
export const MISSING_WORK_GRACE_MS = 72 * 60 * 60 * 1000

/** Closed items a section needs before anyone can be flagged. Below this the
 *  answer is "not enough signal yet", never "nobody is at risk". */
export const MIN_CLOSED_ITEMS = 2

/** Signal weights, out of a fixed 100. Re-weighted from the design's §4.2, and
 *  the deviation is deliberate on both counts.
 *
 *  The design's 30/30/15 assumes all six of its signals are present and summing
 *  to 100. Only three are implemented here (4, 5 and 6 need snapshots, dormancy
 *  and event aggregates), so those numbers would top out at 75 against bands
 *  calibrated for 100, and nobody would ever be alertable. These three keep the
 *  design's relative ordering and are scaled to sum to 100 instead.
 *
 *  Missing work is also raised above its share so that severe absence can reach
 *  the alert list on its own. Under the design's weighting it cannot, and that
 *  is a hole: a student who has simply stopped submitting has no graded items,
 *  so signal 1 cannot fire, and no mastery evidence, so signal 3 cannot fire.
 *  They would cap at Monitor forever, which is precisely the student this
 *  feature exists to surface. Absence of work is not a noisy signal like one
 *  bad grade; it is the least ambiguous evidence available.
 *
 *  An earlier draft normalised the total over whichever signals happened to be
 *  available. That was worse in the other direction: a section with no skills
 *  curated had its denominator collapse to 30, so two missing assignments came
 *  out "urgent". Scarce evidence must not inflate confidence either. */
const MAX_POINTS_BY_SIGNAL = {
  gradedStanding: 35,
  missingWork: 45,
  weakSkills: 20,
} as const

/** Points for the first missing item and for each one after. 15 each, so one
 *  missed item stays unflagged, two reach Monitor, and three reach the alert
 *  list. That ladder is the whole calibration of signal 2. */
const MISSING_ITEM_POINTS = 15

/** How far below the class median counts as maximally concerning. At half the
 *  class median a student is not marginally behind, they are not following the
 *  course, so the signal saturates there rather than scaling linearly to zero. */
const STANDING_SATURATION = 0.5

/** Concern-point bands. Ordinal only — the number is never shown to anyone.
 *  Only `needs-support` and above enter the alert list. */
export const RISK_BANDS = { monitor: 25, needsSupport: 45, urgent: 70 } as const

export type RiskBand = 'monitor' | 'needs-support' | 'urgent'

/** One piece of gradeable work, from the student's point of view. */
export interface RiskItem {
  itemId: string
  kind: 'quiz' | 'assignment'
  title: string
  /** The student's score on it, 0-100. Null when not submitted or not graded. */
  studentPct: number | null
  /** True once the student has handed something in, graded or not. */
  submitted: boolean
  /** Due date in epoch ms, or null for no deadline. */
  dueAt: number | null
  /** This item's own pass mark, 0-100. */
  passThreshold: number
  /** The class's median score on it, 0-100, or null if nobody is graded yet.
   *  Signal 1 is relative to this, so a hard item indicts itself. */
  classMedianPct: number | null
  /** Excused, extended, or assigned before the student enrolled. Never counts
   *  as missing and never contributes a standing point. */
  exempt: boolean
}

export interface RiskInput {
  items: RiskItem[]
  /** Share of the student's SCORED skills sitting below the section's at-risk
   *  bar, 0 to 1. Null when the section tracks no skills or none are scored —
   *  "not measured" is not "failed", so the signal drops out rather than
   *  scoring zero. */
  weakSkillShare: number | null
  /** Epoch ms. Passed in so the engine stays pure and testable. */
  now: number
}

export interface RiskVerdict {
  /** False whenever the section has too little closed work to judge. Callers
   *  must render this differently from "nobody is at risk". */
  hasEnoughSignal: boolean
  atRisk: boolean
  /** 0-100, ordinal ranking key. Never render it. */
  points: number
  band: RiskBand | null
  /** Plain-language causes, most significant first. Every point traces to one. */
  reasons: string[]
  /** For the gradebook's existing columns. */
  belowCount: number
  missingCount: number
  gradedCount: number
  /** Mean of the student's graded scores, or null if nothing is graded. */
  averagePct: number | null
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** An item is closed once it is graded for somebody, or its grace has expired.
 *  Anything still open is not evidence either way. */
function isClosed(item: RiskItem, now: number): boolean {
  if (item.classMedianPct != null) return true
  return item.dueAt != null && now > item.dueAt + MISSING_WORK_GRACE_MS
}

/** Counts as missing only past the grace window, and never when exempt. A
 *  `draft` submission is NOT submitted: saved is not turned in. */
function isMissing(item: RiskItem, now: number): boolean {
  if (item.exempt || item.submitted) return false
  return item.dueAt != null && now > item.dueAt + MISSING_WORK_GRACE_MS
}

/**
 * Score one student's risk from their own graded work and mastery.
 *
 * The caller supplies every item the student was expected to complete, of both
 * kinds. Whether the section runs quizzes, assignments, or both is not this
 * function's business, which is the entire point of it existing.
 */
export function scoreStudentRisk(input: RiskInput): RiskVerdict {
  const { items, weakSkillShare, now } = input

  const eligible = items.filter((i) => !i.exempt)
  const closed = eligible.filter((i) => isClosed(i, now))
  const graded = eligible.filter((i) => i.studentPct != null)
  const missing = eligible.filter((i) => isMissing(i, now))

  const averagePct = graded.length
    ? Math.round(graded.reduce((sum, i) => sum + (i.studentPct as number), 0) / graded.length)
    : null

  /* Below the item's own pass mark, but only when the class cleared it. A quiz
     the whole class failed is a problem with the quiz. */
  const below = graded.filter(
    (i) => (i.studentPct as number) < i.passThreshold && (i.classMedianPct ?? 0) >= i.passThreshold,
  )

  const blank: RiskVerdict = {
    hasEnoughSignal: false,
    atRisk: false,
    points: 0,
    band: null,
    reasons: [],
    belowCount: below.length,
    missingCount: missing.length,
    gradedCount: graded.length,
    averagePct,
  }

  /* Week one. Nothing has closed, so signals 1 and 2 are both null and only a
     signal this engine does not implement could fire. Saying "nobody is at
     risk" here would be a claim with nothing behind it. */
  if (closed.length < MIN_CLOSED_ITEMS) return blank

  // ── Signal 1: graded standing, relative to each item's own class median ──
  let standing = 0
  let standingAvailable = false
  const comparable = graded.filter((i) => i.classMedianPct != null)
  if (comparable.length > 0) {
    standingAvailable = true
    /* Mean shortfall below the class, as a share of the median. A student at
       half the class median scores the full weight; at or above it, nothing. */
    const shortfalls = comparable.map((i) => {
      const median = i.classMedianPct as number
      if (median <= 0) return 0
      return clamp01((median - (i.studentPct as number)) / median)
    })
    const meanShortfall = shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length
    standing = clamp01(meanShortfall / STANDING_SATURATION) * MAX_POINTS_BY_SIGNAL.gradedStanding
    /* One graded item is not a trend. Cap its contribution so a single bad
       result cannot on its own carry a student past Monitor. */
    if (comparable.length === 1) standing = Math.min(standing, 10)
  }

  // ── Signal 2: missing work ──
  const missingPoints = Math.min(
    MAX_POINTS_BY_SIGNAL.missingWork,
    missing.length * MISSING_ITEM_POINTS,
  )

  /* ── Signal 3: skills under the bar ──
     Unscored skills are excluded rather than counted as zero: "not measured" is
     not "failed". A section that tracks no skills contributes nothing here,
     which is the same as a section whose skills are all strong. Both mean "no
     concern from this axis", and neither manufactures risk. */
  const weakSkillsAvailable = weakSkillShare != null
  const weakPoints = weakSkillsAvailable
    ? clamp01(weakSkillShare) * MAX_POINTS_BY_SIGNAL.weakSkills
    : 0

  const points = Math.round(standing + missingPoints + weakPoints)

  const reasons: string[] = []
  if (missing.length > 0) {
    reasons.push(`missing ${missing.length} ${missing.length === 1 ? 'item' : 'items'}`)
  }
  if (below.length > 0) {
    reasons.push(`below the pass mark on ${below.length} ${below.length === 1 ? 'item' : 'items'}`)
  }
  if (standingAvailable && standing > 0 && below.length === 0) {
    reasons.push('scoring below the class on graded work')
  }
  if (weakSkillsAvailable && (weakSkillShare as number) > 0) {
    reasons.push(`${Math.round((weakSkillShare as number) * 100)}% of their scored skills are below the bar`)
  }

  let band: RiskBand | null = null
  if (points >= RISK_BANDS.urgent) band = 'urgent'
  else if (points >= RISK_BANDS.needsSupport) band = 'needs-support'
  else if (points >= RISK_BANDS.monitor) band = 'monitor'

  /* One graded item and nothing missing is never worse than Monitor, however
     badly it went. Hysteresis: one bad day does not flag anyone. */
  if (comparable.length === 1 && missing.length === 0 && band && band !== 'monitor') {
    band = 'monitor'
  }

  return {
    hasEnoughSignal: true,
    // Only "needs support" and above are worth interrupting a professor for.
    atRisk: band === 'needs-support' || band === 'urgent',
    points,
    band,
    reasons,
    belowCount: below.length,
    missingCount: missing.length,
    gradedCount: graded.length,
    averagePct,
  }
}

/** Stable ordering for the alert list: most concerning first, then more missing
 *  work, then name. An unstable order flips the list on every page load, which
 *  is the same determinism rule class-insight.ts documents. */
export function compareRisk(
  a: { points: number; missingCount: number; studentName: string },
  b: { points: number; missingCount: number; studentName: string },
): number {
  return (
    b.points - a.points ||
    b.missingCount - a.missingCount ||
    a.studentName.localeCompare(b.studentName)
  )
}
