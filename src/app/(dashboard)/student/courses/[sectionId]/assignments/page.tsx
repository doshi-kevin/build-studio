/**
 * Student Assignments Page — list of published assignments + submission status.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/assignments
 */

import Link from 'next/link'
import { FileText, Clock, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { EmptyState } from '@/components/ui/empty-state'
import { parseAccepts, labelForKind, areGradesPublished, parseAssessment, type SubmissionStatus } from '@/lib/validations/assignment'
import { isAssessmentWindowClosedNow } from '@/lib/assignments/assessment'
import {
  getStudentAssignmentStatus,
  scoreTone,
  STATUS_TONE_CLASSES,
  type StudentStatusTone,
  type StudentStatusGroup,
  type StudentAssignmentStatus,
} from '@/lib/assignments/student-status'
import type { LucideIcon } from 'lucide-react'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface StudentAssignmentsPageProps {
  params: Promise<{ sectionId: string }>
}

function dueLabel(dueAt: string | null): string {
  if (!dueAt) return 'No due date'
  return `Due ${new Date(dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function parseAcceptsLabel(settings: unknown): string {
  const { fileTypes } = parseAccepts(settings)
  return fileTypes.length === 0 ? 'Text response' : `${fileTypes.map(labelForKind).join(', ')} + text`
}

const GROUP_ORDER: StudentStatusGroup[] = ['attention', 'upcoming', 'submitted', 'graded']
const GROUP_TITLES: Record<StudentStatusGroup, string> = {
  attention: 'Needs attention',
  upcoming: 'Up next',
  submitted: 'Submitted',
  graded: 'Graded',
}

// ── Local subcomponents (server-only, not exported) ──────────────────────────

function StatusChip({ status }: { status: StudentAssignmentStatus }) {
  const { chip } = STATUS_TONE_CLASSES[status.tone]
  const Icon = status.icon
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium sm:px-3 ${chip}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {status.label}
    </span>
  )
}

type SubmissionRow = {
  score: number | null
  is_graded?: boolean
  submitted_at: string | null
  graded_at: string | null
  status: string
}

function ScoreSlot({
  sub,
  points,
  isGraded,
}: {
  sub: SubmissionRow | undefined
  points: number
  isGraded: boolean
}) {
  const score = sub?.score ?? null
  // Show numeric score only for graded assignments where score is numeric and is_graded !== false
  if (isGraded && score !== null && sub?.status === 'graded') {
    const tone = scoreTone(score, points)
    const toneClass: Record<StudentStatusTone, string> = {
      success: 'text-success-muted-foreground',
      warning: 'text-warning-muted-foreground',
      destructive: 'text-destructive',
      info: 'text-info-muted-foreground',
      neutral: 'text-muted-foreground',
    }
    const pct = points > 0 ? Math.round((score / points) * 100) : null
    return (
      <div className="shrink-0 text-right">
        <p className={`text-sm font-semibold tabular-nums ${toneClass[tone]}`}>
          {score} / {points}
        </p>
        {pct !== null && (
          <p className={`text-xs tabular-nums ${toneClass[tone]}`}>{pct}%</p>
        )}
      </div>
    )
  }
  // Graded kind but no numeric score or is_graded = false: show neutral "Graded" chip
  if (sub?.status === 'graded') {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        Graded
      </span>
    )
  }
  return null
}

function AssignmentRow({
  assignment,
  sub,
  status,
  sectionId,
}: {
  assignment: {
    id: string
    title: string
    due_at: string | null
    points: number
    settings: unknown
    is_graded: boolean
  }
  sub: SubmissionRow | undefined
  status: StudentAssignmentStatus
  sectionId: string
}) {
  const { tone, kind } = status
  const { stripe, iconBadge } = STATUS_TONE_CLASSES[tone]
  const Icon: LucideIcon = status.icon
  const accepts = parseAcceptsLabel(assignment.settings)
  const isGraded = kind === 'graded' || kind === 'regrade-pending'

  return (
    <li>
      <Link
        href={`/student/courses/${sectionId}/assignments/${assignment.id}`}
        className="relative flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 shadow-sm transition-shadow hover:shadow-md sm:gap-4"
      >
        {/* Left tone stripe */}
        <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${stripe}`} />

        {/* Icon badge — hidden on mobile to free space for the title */}
        <div
          className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl sm:flex ${iconBadge}`}
        >
          <Icon className="h-5 w-5" />
        </div>

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">{assignment.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {/* A closed assessment window REPLACES the due date rather than sitting beside it: the
                per-student window is independent of the deadline, so "Due Aug 6" next to an
                "Assessment closed" chip gives the student two contradictory answers to "can I still
                do this?" — and they'll believe the countdown. */}
            <span
              className={`inline-flex items-center gap-1 ${
                kind === 'missing' || kind === 'assessment-closed' ? 'font-medium text-destructive' : ''
              }`}
            >
              <Clock className="h-3.5 w-3.5" />
              {kind === 'assessment-closed' ? 'Your window has closed' : dueLabel(assignment.due_at)}
            </span>
            <span>{accepts}</span>
          </div>
        </div>

        {/* Right slot */}
        {isGraded ? (
          <ScoreSlot sub={sub} points={assignment.points} isGraded={assignment.is_graded} />
        ) : (
          <StatusChip status={status} />
        )}

        <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
      </Link>
    </li>
  )
}

function StatBar({
  attention,
  upcoming,
  submitted,
  avgGrade,
}: {
  attention: number
  upcoming: number
  submitted: number
  avgGrade: { value: number; tone: StudentStatusTone } | null
}) {
  const toneClass: Record<StudentStatusTone, string> = {
    success: 'text-success-muted-foreground',
    warning: 'text-warning-muted-foreground',
    destructive: 'text-destructive',
    info: 'text-info-muted-foreground',
    neutral: 'text-muted-foreground',
  }

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="flex flex-col items-center justify-center p-4">
          <p
            className={`text-2xl font-bold tabular-nums ${attention > 0 ? 'text-destructive' : 'text-foreground'}`}
          >
            {attention}
          </p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Need attention
          </p>
        </div>
        <div className="flex flex-col items-center justify-center p-4">
          <p className="text-2xl font-bold tabular-nums text-foreground">{upcoming}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Up next
          </p>
        </div>
        <div className="flex flex-col items-center justify-center p-4">
          <p className="text-2xl font-bold tabular-nums text-foreground">{submitted}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Awaiting grade
          </p>
        </div>
        <div className="flex flex-col items-center justify-center p-4">
          {avgGrade ? (
            <p className={`text-2xl font-bold tabular-nums ${toneClass[avgGrade.tone]}`}>
              {avgGrade.value}%
            </p>
          ) : (
            <p className="text-2xl font-bold tabular-nums text-muted-foreground">N/A</p>
          )}
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Average grade
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function StudentAssignmentsPage({ params }: StudentAssignmentsPageProps) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'assignments')
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // RLS returns only published assignments for enrolled students.
  const assignments = await assignmentQueries.listSectionAssignments(supabase, sectionId)
  const submissions = user
    ? await assignmentQueries.listStudentSubmissions(
        supabase,
        assignments.map((a) => a.id),
        user.id,
      )
    : []
  const byAssignment = new Map(submissions.map((s) => [s.assignment_id, s]))

  // Derive rows with status. resubmitUntil and the assessment window are passed here for the same
  // reason the detail page passes them: without them a reopened assignment reads "Missing
  // submission" and a closed assessment reads "Due soon", so the list and the detail page would
  // tell the student two different things about whether they can still submit.
  const rows = assignments.map((a) => {
    const sub = byAssignment.get(a.id)
    const assessment = parseAssessment(a.settings)
    const assessmentClosed =
      assessment.enabled &&
      isAssessmentWindowClosedNow(
        sub?.assessment_started_at ?? null,
        sub?.assessment_work_ended_at ?? null,
        assessment,
        sub?.resubmit_until ?? null,
      )
    const status = getStudentAssignmentStatus({
      dueAt: a.due_at,
      submissionStatus: sub?.status as SubmissionStatus | undefined,
      gradesPublished: areGradesPublished(a.settings),
      resubmitUntil: sub?.resubmit_until ?? null,
      assessmentClosed,
    })
    return { assignment: a, sub, status }
  })

  // Bucket into groups
  const groups: Record<StudentStatusGroup, typeof rows> = {
    attention: [],
    upcoming: [],
    submitted: [],
    graded: [],
  }
  for (const row of rows) {
    groups[row.status.group].push(row)
  }

  // Sort each group per spec
  const nullsLast = (a: string | null, b: string | null) => {
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return new Date(a).getTime() - new Date(b).getTime()
  }

  groups.attention.sort((a, b) => nullsLast(a.assignment.due_at, b.assignment.due_at))
  groups.upcoming.sort((a, b) => nullsLast(a.assignment.due_at, b.assignment.due_at))
  groups.submitted.sort((a, b) => {
    const ta = a.sub?.submitted_at ? new Date(a.sub.submitted_at).getTime() : 0
    const tb = b.sub?.submitted_at ? new Date(b.sub.submitted_at).getTime() : 0
    return tb - ta
  })
  groups.graded.sort((a, b) => {
    const ta = a.sub?.graded_at ? new Date(a.sub.graded_at).getTime() : 0
    const tb = b.sub?.graded_at ? new Date(b.sub.graded_at).getTime() : 0
    return tb - ta
  })

  // Compute average grade stat
  const gradedEligible = rows.filter(
    (r) =>
      (r.status.kind === 'graded' || r.status.kind === 'regrade-pending') &&
      r.sub?.score !== null &&
      r.sub?.score !== undefined &&
      r.assignment.points > 0,
  )
  const avgGrade: { value: number; tone: StudentStatusTone } | null =
    gradedEligible.length > 0
      ? (() => {
          const avg =
            gradedEligible.reduce(
              (sum, r) => sum + ((r.sub!.score as number) / r.assignment.points) * 100,
              0,
            ) / gradedEligible.length
          const rounded = Math.round(avg)
          return { value: rounded, tone: scoreTone(rounded, 100) }
        })()
      : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">
          Assignments
        </h1>
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nothing due yet"
          description="Assignments will appear here once your instructor publishes them."
        />
      ) : (
        <>
          <StatBar
            attention={groups.attention.length}
            upcoming={groups.upcoming.length}
            submitted={groups.submitted.length}
            avgGrade={avgGrade}
          />

          {GROUP_ORDER.map(
            (g) =>
              groups[g].length > 0 && (
                <section key={g} className="space-y-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {GROUP_TITLES[g]}{' '}
                    <span className="font-normal">({groups[g].length})</span>
                  </h2>
                  <ul className="space-y-3">
                    {groups[g].map((row) => (
                      <AssignmentRow
                        key={row.assignment.id}
                        assignment={row.assignment}
                        sub={row.sub}
                        status={row.status}
                        sectionId={sectionId}
                      />
                    ))}
                  </ul>
                </section>
              ),
          )}
        </>
      )}
    </div>
  )
}
