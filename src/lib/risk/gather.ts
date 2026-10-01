import 'server-only'

// Reads the evidence the at-risk engine scores, for one section.
//
// Lives beside the engine rather than with a caller because three surfaces need
// the identical picture and used to disagree about it: the gradebook's at-risk
// tab, and loadCourseSnapshot + loadStudentPerformance in the professor
// assistant. Three copies of the rule meant three answers to "is this student
// at risk" for the same student on the same day.
//
// Everything here is a read. Scoring is src/lib/risk/at-risk.ts, which is pure.

import { logger } from '@/lib/logger'
import { skillQueries } from '@/lib/supabase/queries'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { aggregateStudentMastery, type MasteryDatum } from '@/lib/skills/aggregate'
import { scoreStudentRisk, compareRisk, type RiskItem, type RiskVerdict } from '@/lib/risk/at-risk'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

const ON_ROSTER = ['enrolled', 'completed', 'active']

export interface StudentRisk extends RiskVerdict {
  studentId: string
  studentName: string
  studentEmail: string
}

export interface SectionRisk {
  /** Every rostered student, scored. Alert-worthy ones are `atRisk`. */
  students: StudentRisk[]
  /** False when the section has too little closed work to judge anyone. The UI
   *  must say so rather than rendering an empty list, which reads as "everyone
   *  is fine" — a claim with nothing behind it. */
  hasEnoughSignal: boolean
  /** Closed items found, for the "needs N more" empty-state copy. */
  closedItemCount: number
}

const pct = (earned: number | null | undefined, total: number | null | undefined): number | null => {
  const t = Number(total) || 0
  if (t <= 0) return null
  return Math.max(0, Math.min(100, (Number(earned) || 0) / t * 100))
}

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Build every rostered student's risk picture for a section.
 *
 * Callers must already have verified access. This uses the admin client they
 * pass in and performs no authorization of its own.
 */
export async function gatherSectionRisk(
  adminDb: AdminDb,
  sectionId: string,
  now: number = Date.now(),
): Promise<SectionRisk> {
  const empty: SectionRisk = { students: [], hasEnoughSignal: false, closedItemCount: 0 }
  try {
    const [enrollRes, quizRes, assignmentRes, sectionRes, skillRows] = await Promise.all([
      adminDb
        .from('enrollments')
        .select('student_id, enrolled_at, student:profiles(id, name, email)')
        .eq('section_id', sectionId)
        .in('status', ON_ROSTER),
      adminDb
        .from('quizzes')
        .select('id, title, due_date, pass_threshold')
        .eq('section_id', sectionId)
        .eq('status', 'published'),
      /* is_graded defaults true, so an ungraded practice assignment only drops
         out when the professor explicitly says so. Drafts never count. */
      adminDb
        .from('assignments')
        .select('id, title, due_at, points')
        .eq('section_id', sectionId)
        .eq('is_graded', true)
        .in('status', ['published', 'closed']),
      adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
      skillQueries.listSectionSkills(adminDb, sectionId),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)
    const roster = ((enrollRes?.data ?? []) as Array<Record<string, unknown>>).map((e) => {
      const profile = resolveJoin(e.student)
      return {
        studentId: String(e.student_id),
        studentName: (profile?.name as string) || 'Unknown',
        studentEmail: (profile?.email as string) || '',
        enrolledAt: e.enrolled_at ? Date.parse(String(e.enrolled_at)) : null,
      }
    })
    if (roster.length === 0) return empty

    const quizzes = (quizRes?.data ?? []) as Array<{ id: string; title: string; due_date: string | null; pass_threshold: number | null }>
    const assignments = (assignmentRes?.data ?? []) as Array<{ id: string; title: string; due_at: string | null; points: number | null }>
    if (quizzes.length === 0 && assignments.length === 0) return empty

    const [attemptRes, submissionRes, masteryRows] = await Promise.all([
      quizzes.length
        ? adminDb
            .from('quiz_attempts')
            .select('student_id, quiz_id, score, status')
            .eq('section_id', sectionId)
            .in('status', ['submitted', 'graded'])
        : Promise.resolve({ data: [] }),
      assignments.length
        ? adminDb
            .from('assignment_submissions')
            .select('assignment_id, student_id, score, status, submitted_at, resubmit_until')
            .in('assignment_id', assignments.map((a) => a.id))
        : Promise.resolve({ data: [] }),
      skillQueries.getSectionMasteryRows(adminDb, sectionId),
    ])

    /* Best attempt per (student, quiz) — a retake is the student's standing, not
       an extra data point. */
    const quizScore = new Map<string, number>()
    for (const a of (attemptRes?.data ?? []) as Array<Record<string, unknown>>) {
      const score = a.score == null ? null : Number(a.score)
      if (score == null) continue
      const key = `${a.student_id}:${a.quiz_id}`
      const prev = quizScore.get(key)
      if (prev == null || score > prev) quizScore.set(key, score)
    }

    type Sub = { score: number | null; submitted: boolean; graded: boolean; resubmitUntil: number | null }
    const submission = new Map<string, Sub>()
    for (const s of (submissionRes?.data ?? []) as Array<Record<string, unknown>>) {
      const status = String(s.status ?? '')
      submission.set(`${s.student_id}:${s.assignment_id}`, {
        // Only a graded or returned submission carries a real score.
        score: status === 'graded' || status === 'returned' ? (s.score == null ? null : Number(s.score)) : null,
        // A `draft` is saved, not turned in — segmentRoster draws the same line.
        submitted: s.submitted_at != null,
        graded: status === 'graded' || status === 'returned',
        resubmitUntil: s.resubmit_until ? Date.parse(String(s.resubmit_until)) : null,
      })
    }

    /* Class median per item, so signal 1 can tell a struggling student from a
       brutal item. Computed from whoever is graded, not the whole roster. */
    const quizMedian = new Map<string, number | null>()
    for (const q of quizzes) {
      const scores = roster
        .map((r) => quizScore.get(`${r.studentId}:${q.id}`))
        .filter((v): v is number => v != null)
      quizMedian.set(q.id, median(scores))
    }
    const assignmentMedian = new Map<string, number | null>()
    for (const a of assignments) {
      const scores = roster
        .map((r) => submission.get(`${r.studentId}:${a.id}`))
        .filter((s): s is Sub => !!s && s.graded && s.score != null)
        .map((s) => pct(s.score, a.points))
        .filter((v): v is number => v != null)
      assignmentMedian.set(a.id, median(scores))
    }

    const config = resolveSkillMasteryConfig(sectionRes?.data?.settings)
    const trackedSkills = (skillRows ?? []).filter((s) => !s.excluded && !s.suppressed)
    const masteryByStudent = new Map<string, MasteryDatum[]>()
    for (const row of (masteryRows ?? []) as MasteryDatum[]) {
      const list = masteryByStudent.get(row.student_id) ?? []
      list.push(row)
      masteryByStudent.set(row.student_id, list)
    }

    let closedItemCount = 0
    const students: StudentRisk[] = roster.map((r) => {
      const items: RiskItem[] = []

      for (const q of quizzes) {
        const dueAt = q.due_date ? Date.parse(q.due_date) : null
        const score = quizScore.get(`${r.studentId}:${q.id}`)
        items.push({
          itemId: q.id,
          kind: 'quiz',
          title: q.title,
          studentPct: score ?? null,
          submitted: score != null,
          dueAt,
          passThreshold: q.pass_threshold ?? 60,
          classMedianPct: quizMedian.get(q.id) ?? null,
          // Work that closed before they joined was never theirs to do.
          exempt: dueAt != null && r.enrolledAt != null && dueAt < r.enrolledAt,
        })
      }

      for (const a of assignments) {
        const dueAt = a.due_at ? Date.parse(a.due_at) : null
        const sub = submission.get(`${r.studentId}:${a.id}`)
        /* An open reopen window is this product's extension mechanism, so the
           item is not missing while it is running. Known limit: resubmit_until
           lives on the submission row, so an extension granted to a student who
           never opened the assignment cannot be represented, and they will be
           flagged. */
        const extended = sub?.resubmitUntil != null && sub.resubmitUntil > now
        items.push({
          itemId: a.id,
          kind: 'assignment',
          title: a.title,
          studentPct: sub?.graded ? pct(sub.score, a.points) : null,
          submitted: sub?.submitted ?? false,
          dueAt,
          /* Assignments carry no pass mark in this product; only quizzes do.
             0 rather than an invented 60, so an assignment never contributes a
             "below the pass mark" count. It still feeds the class-relative
             standing signal, which is the meaningful comparison for it. */
          passThreshold: 0,
          classMedianPct: assignmentMedian.get(a.id) ?? null,
          exempt: extended || (dueAt != null && r.enrolledAt != null && dueAt < r.enrolledAt),
        })
      }

      /* Share of this student's SCORED skills under the section's bar. Unscored
         skills are excluded: "not measured" is not "failed". */
      const scored = aggregateStudentMastery(trackedSkills, masteryByStudent.get(r.studentId) ?? [])
        .filter((s) => s.classScore != null)
      const weakSkillShare = scored.length
        ? scored.filter((s) => (s.classScore as number) < config.atRiskThreshold).length / scored.length
        : null

      const verdict = scoreStudentRisk({ items, weakSkillShare, now })
      if (verdict.hasEnoughSignal) closedItemCount = Math.max(closedItemCount, items.length)
      return { ...verdict, studentId: r.studentId, studentName: r.studentName, studentEmail: r.studentEmail }
    })

    students.sort(compareRisk)
    return {
      students,
      hasEnoughSignal: students.some((s) => s.hasEnoughSignal),
      closedItemCount,
    }
  } catch (err) {
    logger.error('gatherSectionRisk: failed', err, { sectionId })
    return empty
  }
}
