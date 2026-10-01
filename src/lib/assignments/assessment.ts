/**
 * Assessment-mode phase logic — the single source of truth for "which phase is this
 * student in, and how long is left". Pure and deterministic: the same function runs on
 * the server (to ENFORCE what the student may see/do) and on the client (to render a
 * cosmetic countdown). The client clock is never trusted; enforcement always recomputes
 * server-side from the DB-stored timestamps.
 *
 * Phases:
 *   lobby  — not started yet (assessment_started_at is null)
 *   work   — doing the assignment; brief is visible, proctoring on
 *   upload — handout window; brief + downloads hidden, only the upload widget
 *   closed — window fully elapsed; whatever exists is auto-submitted
 */

import type { AssessmentConfig } from '@/lib/validations/assignment'

export type AssessmentPhase = 'lobby' | 'work' | 'upload' | 'closed'

export interface AssessmentTiming {
  phase: AssessmentPhase
  /** Whole seconds left in the current phase (0 for lobby/closed). */
  remainingSeconds: number
  /** Epoch ms when the work phase ends (early-finish aware); null in lobby. */
  workEndsAtMs: number | null
  /** Epoch ms when the upload window closes; null in lobby. */
  uploadEndsAtMs: number | null
}

const MIN = 60_000

/**
 * Compute the current phase + remaining time.
 *
 * @param startedAt   assignment_submissions.assessment_started_at (ISO) or null
 * @param workEndedAt assignment_submissions.assessment_work_ended_at (ISO) or null —
 *                    set only when the student ends work early
 * @param config      the assignment's assessment config
 * @param nowMs       current time in epoch ms (Date.now() on client; server clock on server)
 */
export function computeAssessmentTiming(
  startedAt: string | null,
  workEndedAt: string | null,
  config: Pick<AssessmentConfig, 'workMinutes' | 'uploadMinutes'>,
  nowMs: number,
): AssessmentTiming {
  if (!startedAt) {
    return { phase: 'lobby', remainingSeconds: 0, workEndsAtMs: null, uploadEndsAtMs: null }
  }

  const startMs = new Date(startedAt).getTime()
  const earlyEnd = workEndedAt ? new Date(workEndedAt).getTime() : null

  // Work end: a set limit (early-finish can only shrink it, never extend past it), or —
  // when work is untimed (workMinutes null) — only when the student explicitly finishes.
  let workEndsAtMs: number | null
  if (config.workMinutes == null) {
    workEndsAtMs = earlyEnd // null until the student clicks "Finish & upload"
  } else {
    const scheduledWorkEnd = startMs + config.workMinutes * MIN
    workEndsAtMs = earlyEnd !== null ? Math.min(earlyEnd, scheduledWorkEnd) : scheduledWorkEnd
  }

  // Untimed work still in progress → work phase with no countdown.
  if (workEndsAtMs === null) {
    return { phase: 'work', remainingSeconds: 0, workEndsAtMs: null, uploadEndsAtMs: null }
  }

  const uploadEndsAtMs = workEndsAtMs + config.uploadMinutes * MIN

  if (nowMs < workEndsAtMs) {
    return {
      phase: 'work',
      remainingSeconds: Math.max(0, Math.ceil((workEndsAtMs - nowMs) / 1000)),
      workEndsAtMs,
      uploadEndsAtMs,
    }
  }
  if (nowMs < uploadEndsAtMs) {
    return {
      phase: 'upload',
      remainingSeconds: Math.max(0, Math.ceil((uploadEndsAtMs - nowMs) / 1000)),
      workEndsAtMs,
      uploadEndsAtMs,
    }
  }
  return { phase: 'closed', remainingSeconds: 0, workEndsAtMs, uploadEndsAtMs }
}

/** The brief/template and any downloads are visible ONLY during the work phase. */
export function isBriefVisible(phase: AssessmentPhase): boolean {
  return phase === 'work'
}

/**
 * Pure predicate: can the student submit at `nowMs`?
 *
 * Returns false only when the upload window has closed beyond the grace period AND no
 * professor reopen window is active. The grace period (2 min) covers the auto-submit
 * network race — the client fires just before the countdown hits zero, but round-trip +
 * server processing can push nowMs a few seconds past uploadEndsAtMs.
 */
export function canSubmitAssessmentAt(
  timing: AssessmentTiming,
  nowMs: number,
  resubmitUntil: string | null | undefined,
): boolean {
  // Not yet past the upload window — always allowed once work is over.
  if (timing.phase !== 'closed') return true
  // No known window end (untimed work never-finished edge case) — allow.
  if (timing.uploadEndsAtMs === null) return true

  const SUBMIT_GRACE_MS = 2 * 60_000
  if (nowMs <= timing.uploadEndsAtMs + SUBMIT_GRACE_MS) return true

  // Past grace period: only a professor reopen window saves them.
  if (resubmitUntil == null) return false
  const until = new Date(resubmitUntil).getTime()
  return !Number.isNaN(until) && nowMs < until
}

/**
 * computeAssessmentTiming against the current clock. Keeps the impure Date.now() call
 * inside this lib (server components read "now" once per request, so this is safe there
 * and avoids the react-hooks/purity warning at the call site).
 */
export function assessmentTimingNow(
  startedAt: string | null,
  workEndedAt: string | null,
  config: Pick<AssessmentConfig, 'workMinutes' | 'uploadMinutes'>,
): AssessmentTiming {
  return computeAssessmentTiming(startedAt, workEndedAt, config, Date.now())
}

/**
 * True when a timed assessment's per-student window has closed for good against the current clock
 * — the attempt can no longer be submitted and no reopen window is active.
 *
 * Shared by the student assignments list and detail page so both label the same state identically.
 * Note this window is derived from when the student STARTED, so it is independent of the
 * assignment's own due date and can close while the deadline is still days away. Keeps Date.now()
 * inside this lib for the same reason as assessmentTimingNow above.
 */
export function isAssessmentWindowClosedNow(
  startedAt: string | null,
  workEndedAt: string | null,
  config: Pick<AssessmentConfig, 'workMinutes' | 'uploadMinutes'>,
  resubmitUntil: string | null | undefined,
): boolean {
  if (!startedAt) return false
  const now = Date.now()
  return !canSubmitAssessmentAt(computeAssessmentTiming(startedAt, workEndedAt, config, now), now, resubmitUntil)
}

/**
 * The submission is ALREADY recorded server-side (submitAssessment saw status submitted/graded).
 * On the flaky-network-at-deadline race this feature exists for, the server can commit while the
 * client loses the response; the retry then hits this. The work IS in, so the runner treats it as
 * success (reassure + show the submitted view) rather than a "lost work" banner.
 */
export function isAlreadySubmittedError(message: string): boolean {
  return /already (completed|submitted)/i.test(message)
}

/**
 * A submit error that RETRYING can never clear: the window closed past grace, the deadline passed,
 * the attempt was reset by the professor, or it's already submitted. The runner uses this to stop
 * promising a retry (disables the button, swaps the banner copy). Kept a pure predicate — matching
 * server-error substrings is fragile, so it's pinned by unit tests and lives beside the messages'
 * enforcement logic (canSubmitAssessmentAt) rather than inline in the component.
 */
export function isTerminalSubmitError(message: string): boolean {
  return /closed|reset|reopen|deadline/i.test(message) || isAlreadySubmittedError(message)
}
