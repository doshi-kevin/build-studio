// Student dossier — the versioned facts snapshot behind the roadmap's
// floating student card, plus the pure aggregations that build it from raw
// rows. The snapshot is stored alongside the AI summary in
// `student_insight_summaries` so Athena (the professor assistant) and the
// data-intelligence layer can read the same structured signals later —
// bump `version` when the shape changes so downstream readers can branch.
//
// Pure module: no client, no crypto, no 'server-only' — the professor card
// imports the types, the server action imports the aggregations, and the
// unit tests exercise them directly.

import type { JourneyState } from '@/lib/roadmap/journey-state'

/** v2 added materialsOpened + classMaterialsOpenedPct. */
export const DOSSIER_FACTS_VERSION = 2
export const DOSSIER_MAX_FUMBLES = 5
export const DOSSIER_MAX_LATES = 5
export const DOSSIER_MAX_WEAK_SKILLS = 3

export interface DossierFumble {
  questionText: string
  quizTitle: string
  /** Times this student answered it wrong (across submitted attempts). */
  wrongCount: number
  /** Times they answered it at all. */
  attempts: number
}

export interface DossierLateItem {
  title: string
  kind: 'assignment' | 'quiz'
  lateBySeconds: number
}

export interface DossierWeakSkill {
  name: string
  /** Curated Topic Mastery score, 0–100. */
  score: number
}

/** How much of the section's openable material this student has actually opened
 *  — the effort signal beside the achievement ones (is a low score "hasn't
 *  looked" or "looked and didn't get it?"). */
export interface DossierMaterialOpens {
  /** Distinct tracked items opened. */
  opened: number
  /** Tracked items they could open (locked weeks excluded). */
  total: number
  /** opened/total as 0–100; null when the section has no openable material. */
  pct: number | null
}

/** The stored snapshot — every number the AI summary is allowed to use. */
export interface DossierFacts {
  version: typeof DOSSIER_FACTS_VERSION
  masteryPct: number | null
  classMasteryPct: number | null
  quizAvg: number | null
  counts: Record<JourneyState, number>
  weakestSkills: DossierWeakSkill[]
  materialsOpened: DossierMaterialOpens
  /** Roster mean of the same rate, for the "vs class" comparison. */
  classMaterialsOpenedPct: number | null
  /** TRUE totals — the lists below are capped for display, these are not.
   *  The card's tiles (and any downstream reader) must use these, never the
   *  list lengths, or a student with 14 lates reads as having 10. */
  lateCount: number
  fumbledCount: number
  lateAssignments: DossierLateItem[]
  lateQuizzes: DossierLateItem[]
  fumbledQuestions: DossierFumble[]
}

// ── Aggregations ─────────────────────────────────────────────────

export interface FumbleRow {
  questionId: string
  isCorrect: boolean | null
  questionText: string | null
  quizTitle: string | null
}

/**
 * Group one student's per-question answers into "fumbled most": questions
 * they got wrong at least once, most-wrong first (ties → more attempts
 * first, i.e. kept fumbling). Rows whose question no longer resolves
 * (deleted question/quiz) are dropped rather than shown as blanks.
 */
export function aggregateFumbles(rows: FumbleRow[], max = DOSSIER_MAX_FUMBLES): DossierFumble[] {
  const byQuestion = new Map<string, DossierFumble>()
  for (const r of rows) {
    if (!r.questionText) continue
    const agg = byQuestion.get(r.questionId) ?? {
      questionText: r.questionText,
      quizTitle: r.quizTitle ?? 'Quiz',
      wrongCount: 0,
      attempts: 0,
    }
    agg.attempts += 1
    if (r.isCorrect === false) agg.wrongCount += 1
    byQuestion.set(r.questionId, agg)
  }
  return Array.from(byQuestion.values())
    .filter((f) => f.wrongCount > 0)
    .sort((a, b) => b.wrongCount - a.wrongCount || b.attempts - a.attempts)
    .slice(0, max)
}

export interface LateSubmissionRow {
  title: string | null
  dueAt: string | null
  submittedAt: string | null
}

/** Submissions that landed after their deadline, most-late first. */
export function collectLateAssignments(rows: LateSubmissionRow[], max = DOSSIER_MAX_LATES): DossierLateItem[] {
  const out: DossierLateItem[] = []
  for (const r of rows) {
    if (!r.dueAt || !r.submittedAt) continue
    const lateBySeconds = Math.round((new Date(r.submittedAt).getTime() - new Date(r.dueAt).getTime()) / 1000)
    if (lateBySeconds <= 0) continue
    out.push({ title: r.title ?? 'Assignment', kind: 'assignment', lateBySeconds })
  }
  return out.sort((a, b) => b.lateBySeconds - a.lateBySeconds).slice(0, max)
}

export interface LateQuizRow {
  title: string | null
  isLate: boolean
  lateBySeconds: number | null
}

/** Late quiz attempts, one entry per quiz (worst attempt), most-late first. */
export function collectLateQuizzes(rows: LateQuizRow[], max = DOSSIER_MAX_LATES): DossierLateItem[] {
  const byQuiz = new Map<string, DossierLateItem>()
  for (const r of rows) {
    if (!r.isLate) continue
    const title = r.title ?? 'Quiz'
    const secs = r.lateBySeconds ?? 0
    const prev = byQuiz.get(title)
    if (!prev || secs > prev.lateBySeconds) byQuiz.set(title, { title, kind: 'quiz', lateBySeconds: secs })
  }
  return Array.from(byQuiz.values()).sort((a, b) => b.lateBySeconds - a.lateBySeconds).slice(0, max)
}

export interface MaterialOpenEvent {
  studentId: string
  itemId: string
}

/**
 * Per-student material-open rates + the class mean, from raw `material.viewed`
 * events.
 *
 * Two deliberate rules:
 * - **Only tracked items count.** An event for an item that has since been
 *   deleted (or sits in a still-locked week) is dropped, so a student can never
 *   read over 100%.
 * - **The class mean is over the ROSTER, not over students who opened
 *   something.** A student who opened nothing is a 0, not an absence —
 *   otherwise the average the card compares against is silently inflated.
 */
export function materialOpenRates(
  events: MaterialOpenEvent[],
  itemIds: string[],
  rosterStudentIds: string[],
): { byStudent: Map<string, DossierMaterialOpens>; classPct: number | null } {
  const tracked = new Set(itemIds)
  const total = tracked.size
  const openedBy = new Map<string, Set<string>>()
  for (const e of events) {
    if (!tracked.has(e.itemId)) continue
    const set = openedBy.get(e.studentId) ?? new Set<string>()
    set.add(e.itemId)
    openedBy.set(e.studentId, set)
  }

  const byStudent = new Map<string, DossierMaterialOpens>()
  const rates: number[] = []
  for (const studentId of rosterStudentIds) {
    const opened = openedBy.get(studentId)?.size ?? 0
    const pct = total > 0 ? Math.round((opened / total) * 100) : null
    byStudent.set(studentId, { opened, total, pct })
    if (pct != null) rates.push(pct)
  }

  return {
    byStudent,
    classPct: rates.length > 0 ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
  }
}

export interface DossierTopicRow {
  id: string
  name: string
  excluded?: boolean | null
  suppressed?: boolean | null
}

/**
 * The student's lowest-scoring curated topics — same exclusion filter as the
 * roster/analytics (`excluded`/`suppressed` topics never surface, #493).
 */
export function collectWeakestSkills(
  topics: DossierTopicRow[],
  mastery: { skill_id: string; score: number | null }[],
  max = DOSSIER_MAX_WEAK_SKILLS,
): DossierWeakSkill[] {
  const nameById = new Map<string, string>()
  for (const t of topics) {
    if (t.excluded || t.suppressed) continue
    nameById.set(t.id, t.name)
  }
  const out: DossierWeakSkill[] = []
  for (const m of mastery) {
    const name = nameById.get(m.skill_id)
    if (!name || m.score == null) continue
    out.push({ name, score: Math.round(m.score) })
  }
  return out.sort((a, b) => a.score - b.score).slice(0, max)
}
