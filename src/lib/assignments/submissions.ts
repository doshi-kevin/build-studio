/**
 * Pure roster-segmentation logic for the professor grading view.
 *
 * Splits the enrolled roster into three intuitive buckets — Graded,
 * Needs grading (submitted, ungraded), and Not submitted — so the view can
 * render counts and lists without redoing this logic. Kept pure for tests.
 */

import type { SubmissionRow } from '@/lib/validations/assignment'

/** True when a due date exists and has already passed. */
export function isPastDue(dueAt: string | null | undefined): boolean {
  return !!dueAt && new Date(dueAt).getTime() < Date.now()
}

/** True while a professor-granted reopen window is still open (in the future). */
export function isReopenWindowActive(
  resubmitUntil: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (resubmitUntil == null) return false
  const until = new Date(resubmitUntil).getTime()
  return !Number.isNaN(until) && nowMs < until
}

/**
 * The deadline gate shared by submitAssignment and startAssessment.
 * Returns true when the student may submit/start: either the assignment is not past due,
 * or a professor-granted reopen window is still active. A null/absent dueAt means no deadline
 * (always allowed). Pure so the branching is unit-tested rather than mocked at the DB layer.
 */
export function canSubmitPastDeadline(
  dueAt: string | null | undefined,
  resubmitUntil: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!dueAt) return true
  const due = new Date(dueAt).getTime()
  if (Number.isNaN(due) || nowMs <= due) return true
  return isReopenWindowActive(resubmitUntil, nowMs)
}

/** True when a submission was turned in after the deadline. Both timestamps required. */
export function isLateSubmission(
  submittedAt: string | null | undefined,
  dueAt: string | null | undefined,
): boolean {
  if (submittedAt == null || dueAt == null) return false
  return new Date(submittedAt).getTime() > new Date(dueAt).getTime()
}

/**
 * Resolve the status an assignment should be created with from the wizard's intent.
 * A valid, future `scheduleAt` wins (→ `scheduled`, with the timestamp normalized to
 * ISO); a missing/invalid/past `scheduleAt` falls back to publish-now or draft. Pure so
 * the create action stays a thin wrapper and the branching is unit-tested.
 */
export function resolvePublishState(
  scheduleAt: string | null | undefined,
  publish: boolean,
  nowMs: number = Date.now(),
): { status: 'scheduled' | 'published' | 'draft'; scheduledPublishAt: string | null } {
  const at = scheduleAt ? new Date(scheduleAt).getTime() : NaN
  if (!Number.isNaN(at) && at > nowMs) {
    return { status: 'scheduled', scheduledPublishAt: new Date(at).toISOString() }
  }
  return { status: publish ? 'published' : 'draft', scheduledPublishAt: null }
}

export interface RosterStudent {
  id: string
  name: string
  email: string
}

export interface SegmentedStudent extends RosterStudent {
  submission: SubmissionRow | null
  /** Timestamp when the student requested a late submission (null = not requested). */
  lateRequestAt?: string | null
  /** True when the submission was graded before a rubric existed (graded_with_rubric false). */
  gradedByOldRubric?: boolean
  /**
   * True when a graded submission's stored score now EXCEEDS the assignment's current total —
   * e.g. the rubric (or points) was shrunk after grading, leaving a >100% score. Surfaced in
   * needsGrading so the professor re-grades; the score is preserved until they do.
   */
  scoreExceedsTotal?: boolean
}

export interface SubmissionSegments {
  graded: SegmentedStudent[]
  needsGrading: SegmentedStudent[]
  returned: SegmentedStudent[]
  notSubmitted: SegmentedStudent[]
}

/**
 * Buckets:
 *  - graded      → has a grade
 *  - needsGrading→ submitted, awaiting grade
 *  - returned    → professor asked for changes; awaiting the student's resubmit
 *  - notSubmitted→ no submission (a `draft` counts here — saved, not turned in)
 */
export function segmentRoster(
  students: RosterStudent[],
  submissions: SubmissionRow[],
  /** Student ids with an OPEN regrade request — surfaced in the "returned" (needs-attention)
   *  bucket even though their submission is graded, so the professor sees the appeal queue. */
  openRegradeStudentIds?: Set<string>,
  /**
   * Pass true when the assignment now has a rubric. Graded submissions whose grade predates
   * the rubric (graded_with_rubric false on the row) are moved into needsGrading and tagged
   * gradedByOldRubric so the professor knows to re-grade.
   */
  assignmentHasRubric = false,
  /**
   * The assignment's current total. When set, any graded submission whose stored score exceeds
   * it (the rubric/points was shrunk after grading → a >100% score) is moved into needsGrading
   * and tagged scoreExceedsTotal, so a stale over-max grade can't sit silently in Graded.
   */
  assignmentTotalPoints?: number | null,
): SubmissionSegments {
  const byStudent = new Map<string, SubmissionRow>()
  for (const s of submissions) byStudent.set(s.student_id, s)

  const segments: SubmissionSegments = {
    graded: [],
    needsGrading: [],
    returned: [],
    notSubmitted: [],
  }

  for (const student of students) {
    const submission = byStudent.get(student.id) ?? null
    const lateRequestAt = (submission as SubmissionRow & { late_request_at?: string | null } | null)?.late_request_at ?? null
    const entry: SegmentedStudent = { ...student, submission, lateRequestAt }
    if (submission?.status === 'graded') {
      if (openRegradeStudentIds?.has(student.id)) {
        segments.returned.push(entry)
      } else if (assignmentHasRubric && submission.graded_with_rubric === false) {
        // Graded before any rubric existed (graded_with_rubric === false — the explicit marker; a
        // grade saved while a rubric exists, manual or ticked, is true and stays in Graded).
        // Move to needsGrading so the professor keeps the score or re-grades; the score is preserved.
        segments.needsGrading.push({ ...entry, gradedByOldRubric: true })
      } else if (
        assignmentTotalPoints != null &&
        submission.score != null &&
        submission.score > assignmentTotalPoints
      ) {
        // The total was shrunk after this was graded, so the stored score is now above the max
        // (>100%). Surface it for re-grade instead of showing a broken 48/40 in Graded.
        segments.needsGrading.push({ ...entry, scoreExceedsTotal: true })
      } else {
        segments.graded.push(entry)
      }
    } else if (submission?.status === 'submitted') {
      segments.needsGrading.push(entry)
    } else if (submission?.status === 'returned') {
      segments.returned.push(entry)
    } else {
      // Keep the submission row (preserves resubmit_until, late_request_at); do not null it.
      segments.notSubmitted.push(entry)
    }
  }

  return segments
}
