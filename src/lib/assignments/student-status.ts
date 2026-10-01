import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, Clock, CheckCircle2, RotateCcw, FileText, MessageSquarePlus, RefreshCw } from 'lucide-react'
import type { SubmissionStatus } from '@/lib/validations/assignment'
import { isPastDue, isReopenWindowActive } from '@/lib/assignments/submissions'

// Composite student-facing status for one assignment+submission, shared by the
// student assignments list and detail pages. Pure and server-safe: imports only
// lucide icon types and existing validation helpers, no hooks, no 'use client'.

/** An assignment with no submission (or only a draft) is "due soon" within this window. */
export const DUE_SOON_MS = 72 * 60 * 60 * 1000 // 3 days

export type StudentStatusTone = 'destructive' | 'warning' | 'info' | 'success' | 'neutral'
export type StudentStatusGroup = 'attention' | 'upcoming' | 'submitted' | 'graded'

export interface StudentAssignmentStatus {
  kind: 'missing' | 'assessment-closed' | 'due-soon' | 'not-started' | 'submitted' | 'returned' | 'regrade-pending' | 'graded' | 'reopened'
  label: string
  tone: StudentStatusTone
  icon: LucideIcon
  group: StudentStatusGroup
}

export function getStudentAssignmentStatus(input: {
  dueAt: string | null
  /** null/undefined = no submission row. A 'draft' row counts as not submitted. */
  submissionStatus: SubmissionStatus | null | undefined
  /** areGradesPublished(assignment.settings) — masks graded → submitted until release. */
  gradesPublished: boolean
  /** Detail page only (list submission data has no regrade rows). */
  hasOpenRegrade?: boolean
  /** Professor-granted reopen window end time (ISO); present means a window was granted. */
  resubmitUntil?: string | null
  /** True when this is a timed assessment whose per-student window has closed with nothing
   *  submitted. Independent of dueAt: the window is derived from when the student started, so it
   *  can close while the assignment's own deadline is still days away. */
  assessmentClosed?: boolean
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
}): StudentAssignmentStatus {
  const {
    dueAt,
    submissionStatus,
    gradesPublished,
    hasOpenRegrade = false,
    resubmitUntil,
    assessmentClosed = false,
    now = Date.now(),
  } = input

  // A graded submission whose grades are not yet published reads as "submitted".
  const effective: SubmissionStatus | null | undefined =
    submissionStatus === 'graded' && !gradesPublished ? 'submitted' : submissionStatus

  const notSubmitted = !effective || effective === 'draft'
  const reopenActive = isReopenWindowActive(resubmitUntil, now)

  // Evaluation order matters — first match wins (see design doc mapping table).
  if (effective === 'returned') {
    return { kind: 'returned', label: 'Changes requested', tone: 'destructive', icon: RotateCcw, group: 'attention' }
  }
  // Reopened: the student is locked out (deadline passed, or a timed assessment window closed) but
  // the professor opened a window — show the opportunity, not the lockout.
  if (notSubmitted && reopenActive && (isPastDue(dueAt) || assessmentClosed)) {
    const until = resubmitUntil ? ` until ${new Date(resubmitUntil).toLocaleDateString()}` : ''
    return { kind: 'reopened', label: `Reopened${until}`, tone: 'warning', icon: RefreshCw, group: 'attention' }
  }
  // A timed assessment whose window has closed is terminal and takes precedence over the
  // assignment's own due date: the attempt cannot be finished even if the deadline is days away,
  // so labelling it "Due soon" would send the student to do work they are locked out of.
  if (notSubmitted && assessmentClosed) {
    return { kind: 'assessment-closed', label: 'Assessment closed', tone: 'destructive', icon: AlertTriangle, group: 'attention' }
  }
  // Missing: deadline passed, no active reopen window, never submitted — no longer just "overdue".
  if (notSubmitted && isPastDue(dueAt)) {
    return { kind: 'missing', label: 'Missing submission', tone: 'destructive', icon: AlertTriangle, group: 'attention' }
  }
  if (notSubmitted && dueAt && new Date(dueAt).getTime() - now <= DUE_SOON_MS) {
    return { kind: 'due-soon', label: 'Due soon', tone: 'warning', icon: Clock, group: 'attention' }
  }
  if (effective === 'graded' && hasOpenRegrade) {
    return { kind: 'regrade-pending', label: 'Regrade requested', tone: 'info', icon: MessageSquarePlus, group: 'submitted' }
  }
  if (effective === 'submitted') {
    return { kind: 'submitted', label: 'Submitted', tone: 'info', icon: CheckCircle2, group: 'submitted' }
  }
  if (effective === 'graded') {
    return { kind: 'graded', label: 'Graded', tone: 'success', icon: CheckCircle2, group: 'graded' }
  }
  return { kind: 'not-started', label: 'Not started', tone: 'neutral', icon: FileText, group: 'upcoming' }
}

/**
 * Score percentage → tone, matching the globals.css contract:
 * ≥80 success, ≥60 warning, <60 destructive. Null score or points <= 0
 * (includes is_graded === false, where points is 0) → 'neutral'.
 */
export function scoreTone(score: number | null, points: number): StudentStatusTone {
  if (score === null || points <= 0) return 'neutral'
  const pct = (score / points) * 100
  if (pct >= 80) return 'success'
  if (pct >= 60) return 'warning'
  return 'destructive'
}

/**
 * Tone → literal Tailwind semantic-token class strings (literal so Tailwind's
 * scanner emits them). `chip` includes the `border` width utility.
 */
export const STATUS_TONE_CLASSES: Record<StudentStatusTone, { chip: string; stripe: string; iconBadge: string }> = {
  destructive: {
    chip: 'border border-destructive/30 bg-destructive-muted text-destructive-muted-foreground',
    stripe: 'bg-destructive',
    iconBadge: 'bg-destructive-muted text-destructive-muted-foreground',
  },
  warning: {
    chip: 'border border-warning/30 bg-warning-muted text-warning-muted-foreground',
    stripe: 'bg-warning',
    iconBadge: 'bg-warning-muted text-warning-muted-foreground',
  },
  info: {
    chip: 'border border-info/30 bg-info-muted text-info-muted-foreground',
    stripe: 'bg-info',
    iconBadge: 'bg-info-muted text-info-muted-foreground',
  },
  success: {
    chip: 'border border-success/30 bg-success-muted text-success-muted-foreground',
    stripe: 'bg-success',
    iconBadge: 'bg-success-muted text-success-muted-foreground',
  },
  neutral: {
    chip: 'border border-border bg-muted text-muted-foreground',
    stripe: 'bg-border',
    iconBadge: 'bg-muted text-muted-foreground',
  },
}
