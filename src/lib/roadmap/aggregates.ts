/**
 * aggregates — pure statistics for the Slice 2 roadmap signals. No DB, no React:
 * the admin actions read the rows, these functions do the maths, and the results
 * feed the triage engine. Kept pure so the arithmetic (point-biserial, "no
 * movement", "slow and wrong") is unit-tested in isolation.
 */

// ── Item discrimination (P6) — point-biserial per question ────────
export interface AttemptScore { id: string; score: number }
export interface AnswerCorrect { attemptId: string; questionId: string; isCorrect: boolean | null }
export interface ItemStat { discrimination: number | null; difficulty: number; n: number }

/**
 * Point-biserial correlation between getting each item right and the attempt's
 * total score, per question. Classic item analysis: a well-discriminating item is
 * one strong students get right and weak students get wrong (high positive r);
 * near-zero or negative r flags a poor item. `discrimination` is null when it
 * can't be estimated (fewer than 2 responses, everyone right/wrong, or zero score
 * spread). `difficulty` is the proportion correct.
 */
export function pointBiserialByQuestion(attempts: AttemptScore[], answers: AnswerCorrect[]): Map<string, ItemStat> {
  const scoreById = new Map(attempts.map((a) => [a.id, a.score]))
  const byQ = new Map<string, { score: number; correct: boolean }[]>()
  for (const ans of answers) {
    if (ans.isCorrect == null) continue
    const score = scoreById.get(ans.attemptId)
    if (score == null) continue
    let rows = byQ.get(ans.questionId)
    if (!rows) byQ.set(ans.questionId, (rows = []))
    rows.push({ score, correct: ans.isCorrect })
  }

  const out = new Map<string, ItemStat>()
  for (const [qid, rows] of byQ) {
    const n = rows.length
    const nCorrect = rows.filter((r) => r.correct).length
    const difficulty = nCorrect / n
    let discrimination: number | null = null
    if (n >= 2 && nCorrect > 0 && nCorrect < n) {
      const scores = rows.map((r) => r.score)
      const mean = scores.reduce((s, x) => s + x, 0) / n
      const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n)
      if (sd > 0) {
        const m1 = rows.filter((r) => r.correct).reduce((s, r) => s + r.score, 0) / nCorrect
        const m0 = rows.filter((r) => !r.correct).reduce((s, r) => s + r.score, 0) / (n - nCorrect)
        const p = difficulty
        discrimination = ((m1 - m0) / sd) * Math.sqrt(p * (1 - p))
      }
    }
    out.set(qid, { discrimination, difficulty, n })
  }
  return out
}

// ── Attempts without improvement (C10) ───────────────────────────
export interface QuizAttemptRow { quizId: string; score: number | null; startedAt: string }

/**
 * Quizzes the student retook (≥ minAttempts submitted attempts) without a score
 * gain — the last attempt is no better than the first. Signals a stuck student.
 */
export function noImprovementByQuiz(attempts: QuizAttemptRow[], minAttempts = 2): { quizId: string; attempts: number }[] {
  const byQuiz = new Map<string, QuizAttemptRow[]>()
  for (const a of attempts) {
    if (a.score == null) continue
    let rows = byQuiz.get(a.quizId)
    if (!rows) byQuiz.set(a.quizId, (rows = []))
    rows.push(a)
  }
  const out: { quizId: string; attempts: number }[] = []
  for (const [quizId, rows] of byQuiz) {
    if (rows.length < minAttempts) continue
    rows.sort((x, y) => new Date(x.startedAt).getTime() - new Date(y.startedAt).getTime())
    const first = rows[0].score as number
    const last = rows[rows.length - 1].score as number
    if (last <= first + 1e-9) out.push({ quizId, attempts: rows.length }) // no gain across tries
  }
  return out
}

// ── Slow-and-wrong (C7) ───────────────────────────────────────────
export interface AnswerTiming { attemptId: string; questionId: string; isCorrect: boolean | null; timeSpent: number }

/**
 * Quiz ids where the student spent well over the expected time on an item AND got
 * it wrong — comprehension trouble (not a careless slip). Standard quizzes map
 * skills at the quiz level, so this is per-quiz. `factor` is how far past expected
 * counts as "slow".
 */
export function slowWrongQuizIds(
  answers: AnswerTiming[],
  attemptToQuiz: Map<string, string>,
  expectedByQuestion: Map<string, number | null | undefined>,
  factor = 1.5,
): Set<string> {
  const out = new Set<string>()
  for (const a of answers) {
    if (a.isCorrect !== false) continue // must be wrong
    const exp = expectedByQuestion.get(a.questionId)
    if (exp == null || exp <= 0) continue
    if (a.timeSpent > exp * factor) {
      const quizId = attemptToQuiz.get(a.attemptId)
      if (quizId) out.add(quizId)
    }
  }
  return out
}

// ── Mastery trend (P4 / S2) — from the nightly snapshots ─────────
/**
 * Per-key score change between a baseline point and the latest point. Both maps
 * are keyed the same way (student trend: skill id → own score; class trend: skill
 * id → class-average score). Only keys present in both, with a rounded change,
 * are returned — the builder decides direction (slip vs gain).
 */
export function computeTrends(baseline: Map<string, number>, latest: Map<string, number>): { key: string; from: number; to: number }[] {
  const out: { key: string; from: number; to: number }[] = []
  for (const [key, toRaw] of latest) {
    const fromRaw = baseline.get(key)
    if (fromRaw == null) continue
    /* Difference FIRST, then round. Rounding each endpoint on its own made the
       reported change depend on where the two happened to fall: a true 0.9-point
       move read as "+1" from 69.4→70.3 and as nothing from 69.6→70.4, so a delta
       could appear, vanish and change value across consecutive daily snapshots
       while the class did nothing. `to` is derived from the rounded delta so
       `to - from` is exactly what we decided to report. */
    const delta = Math.round(toRaw - fromRaw)
    if (delta === 0) continue
    const from = Math.round(fromRaw)
    out.push({ key, from, to: from + delta })
  }
  return out
}

// ── Open counts (P1) — from material.viewed events ───────────────
export interface ViewEvent { itemId: string; studentId: string; at: number } // at = epoch ms

/** Per item: how many distinct students viewed it recently, and ever (in the
 *  fetched window). Drives "no one has opened this" and "N opened this week". */
export function openCounts(events: ViewEvent[], now: number, windowMs: number): Map<string, { recent: number; ever: number }> {
  const byItem = new Map<string, { recent: Set<string>; ever: Set<string> }>()
  for (const e of events) {
    let g = byItem.get(e.itemId)
    if (!g) byItem.set(e.itemId, (g = { recent: new Set(), ever: new Set() }))
    g.ever.add(e.studentId)
    if (now - e.at <= windowMs) g.recent.add(e.studentId)
  }
  const out = new Map<string, { recent: number; ever: number }>()
  for (const [itemId, g] of byItem) out.set(itemId, { recent: g.recent.size, ever: g.ever.size })
  return out
}

/** Per item: how many distinct students DOWNLOADED it repeatedly (≥ repeatMin
 *  times each). Drives "students keep re-downloading this" — a re-download is a
 *  distinct signal from a first view (reference-heavy or confusing resource).
 *  Only items with ≥1 repeat downloader appear in the map. */
export function reDownloadCounts(events: ViewEvent[], repeatMin = 2): Map<string, number> {
  const perItem = new Map<string, Map<string, number>>()
  for (const e of events) {
    let byStudent = perItem.get(e.itemId)
    if (!byStudent) perItem.set(e.itemId, (byStudent = new Map()))
    byStudent.set(e.studentId, (byStudent.get(e.studentId) ?? 0) + 1)
  }
  const out = new Map<string, number>()
  for (const [itemId, byStudent] of perItem) {
    let repeaters = 0
    for (const count of byStudent.values()) if (count >= repeatMin) repeaters++
    if (repeaters > 0) out.set(itemId, repeaters)
  }
  return out
}

// ── Delivery depth contrast (P24 / S23) — slice 4 ─────────────────
export interface SlideMinutes { slide: number; minutes: number }
export interface DepthContrast {
  deepSlide: number
  deepMinutes: number
  skimmedSlide: number
  skimmedSeconds: number
}

const DEPTH_MIN_SLIDES = 4 // fewer spoken slides can't show a teaching pattern
const DEPTH_MIN_DEEP_MINUTES = 3 // the deep slide must be a real dwell
const DEPTH_MAX_SKIM_MINUTES = 0.75 // the skimmed slide must be a real skim (≤45s)
// No separate ratio guard: the two absolute thresholds already force ≥4× contrast
// (3 min / 45 s), so a ratio check could never reject anything they pass.

/**
 * The one deep-vs-skimmed pair worth naming on a taught deck (P24/S23), or null
 * when the deck was taught evenly — an evenly-taught deck is the normal case and
 * gets no annotation. Depth rows only exist for slides with speech, so
 * "skimmed" means reached-but-barely-taught; slides never reached at all are
 * the coverage signal (P18/S17), not this one.
 */
export function depthContrast(slides: SlideMinutes[]): DepthContrast | null {
  if (slides.length < DEPTH_MIN_SLIDES) return null
  let deep = slides[0]
  let skim = slides[0]
  for (const s of slides) {
    if (s.minutes > deep.minutes) deep = s
    if (s.minutes < skim.minutes) skim = s
  }
  if (deep.minutes < DEPTH_MIN_DEEP_MINUTES) return null
  if (skim.minutes > DEPTH_MAX_SKIM_MINUTES) return null
  return {
    deepSlide: deep.slide,
    deepMinutes: Math.round(deep.minutes),
    skimmedSlide: skim.slide,
    // Rounded to 5s steps, floored at 5 — "0s on slide 9" reads as a bug, and a
    // slide with any speech at all was at least glanced at.
    skimmedSeconds: Math.max(5, Math.round((skim.minutes * 60) / 5) * 5),
  }
}

// ── Absence gap (C3) ──────────────────────────────────────────────
const normName = (s: string) => s.trim().toLowerCase()

/**
 * Missed sessions whose covered concepts intersect the student's own weak skills —
 * "you missed this, and one of your weakest topics was taught here". Matches
 * concept labels to weak-skill names case/whitespace-insensitively.
 */
export function absenceGapMatches(
  missedSessions: { title: string; concepts: string[] }[],
  weakSkillNames: string[],
): { sessionTitle: string; topic: string }[] {
  const weak = new Set(weakSkillNames.map(normName))
  const out: { sessionTitle: string; topic: string }[] = []
  for (const s of missedSessions) {
    const hit = s.concepts.find((c) => weak.has(normName(c)))
    if (hit) out.push({ sessionTitle: s.title, topic: hit })
  }
  return out
}
