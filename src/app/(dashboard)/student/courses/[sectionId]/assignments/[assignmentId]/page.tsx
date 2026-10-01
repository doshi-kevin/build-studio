/**
 * Student Assignment Detail — instructions + the submission workspace.
 *
 * Non-verbal assignments: two-pane layout with a sticky rail for status/grade.
 * Verbal assignments: keep the existing single-column layout untouched.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/assignments/[assignmentId]
 */

import Link from 'next/link'
import { ChevronLeft, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { assignmentQueries } from '@/lib/supabase/queries'
import { signMany } from '@/lib/supabase/signed-urls'
import { ASSIGNMENT_SUBMISSIONS_BUCKET, COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { EmptyState } from '@/components/ui/empty-state'
import { FileText } from 'lucide-react'
import { StudentAssignmentWorkspace } from '@/components/student/assignments/StudentAssignmentWorkspace'
import { StudentNotebookView } from '@/components/student/assignments/StudentNotebookView'
import { VerbalAssessmentRunner } from '@/components/student/assignments/VerbalAssessmentRunner'
import { StudentGradePanel } from '@/components/student/assignments/StudentGradePanel'
import { parseNotebookModel } from '@/lib/assignments/studio/notebook-model'
import { parseVerbalAssessment } from '@/lib/validations/verbal-assessment'
import { parseAssignmentDocument, stripStudioAnswerKeys, stripNotebookAnswerKeys } from '@/lib/validations/studio'
import { DocumentReadOnly } from '@/components/professor/assignments/studio/DocumentReadOnly'
import { DownloadDocumentButton } from '@/components/professor/assignments/studio/DownloadDocumentButton'
import type { JSONContent } from 'novel'
import { FilePreviewLink } from '@/components/assignments/FilePreviewLink'
import { Button } from '@/components/ui/button'
import {
  parseAccepts,
  parseAssignmentPdfs,
  parseRubric,
  stripRubricAiFields,
  parseAssessment,
  areGradesPublished,
  labelForKind,
  type SubmissionFile,
  type SubmissionStatus,
  type RegradeRequestRow,
  type SubmissionCommentRow,
} from '@/lib/validations/assignment'
import { isPastDue, isReopenWindowActive } from '@/lib/assignments/submissions'
import { assessmentTimingNow } from '@/lib/assignments/assessment'
import { AssessmentRunner } from '@/components/student/assignments/AssessmentRunner'
import {
  getStudentAssignmentStatus,
  STATUS_TONE_CLASSES,
} from '@/lib/assignments/student-status'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface PageProps {
  params: Promise<{ sectionId: string; assignmentId: string }>
}

/**
 * Render-time due countdown (server only; no client timer).
 * Returns a { text, tone } pair for display in the StatusCard.
 */
function dueCountdown(dueAt: string | null): { text: string; tone: 'destructive' | 'warning' | 'muted' | null } {
  if (!dueAt) return { text: 'No due date', tone: null }
  const due = new Date(dueAt)
  const now = Date.now()
  const diff = due.getTime() - now
  if (diff < 0) {
    return { text: `Was due ${due.toLocaleString()}`, tone: 'destructive' }
  }
  const hoursLeft = diff / (1000 * 60 * 60)
  if (hoursLeft < 24) {
    return { text: `Due in ${Math.ceil(hoursLeft)} hour${Math.ceil(hoursLeft) === 1 ? '' : 's'}`, tone: 'warning' }
  }
  const daysLeft = Math.ceil(hoursLeft / 24)
  return {
    text: `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${due.toLocaleDateString()})`,
    tone: 'muted',
  }
}

export default async function StudentAssignmentDetailPage({ params }: PageProps) {
  const { sectionId, assignmentId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'assignments')
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const assignment = await assignmentQueries.getAssignment(supabase, assignmentId)
  if (!assignment) {
    return (
      <EmptyState
        icon={FileText}
        title="Assignment unavailable"
        description="This assignment may not be published yet, or you don't have access to it."
      />
    )
  }

  const submissionRow = user
    ? await assignmentQueries.getStudentSubmission(supabase, assignmentId, user.id)
    : null

  // Sign any previously uploaded files for read-time download.
  const existingFiles = (submissionRow?.files as SubmissionFile[] | undefined) ?? []
  const signed = await signMany(
    ASSIGNMENT_SUBMISSIONS_BUCKET,
    existingFiles.map((f) => f.path),
  )

  const { fileTypes } = parseAccepts(assignment.settings)

  // Deadline gate: when past due, check if a reopen window is active.
  const deadlinePassed = isPastDue(assignment.due_at)
  const resubmitUntil = (submissionRow as { resubmit_until?: string | null } | null)?.resubmit_until ?? null
  const reopenWindowActive = isReopenWindowActive(resubmitUntil)
  const lateRequestAt = (submissionRow as { late_request_at?: string | null } | null)?.late_request_at ?? null

  // Past-deadline + no active reopen window + student hasn't firmly submitted: submissions locked.
  const submissionsClosed =
    deadlinePassed &&
    !reopenWindowActive &&
    (!submissionRow || submissionRow.status === 'draft' || submissionRow.status === 'returned')

  // Grades stay hidden until the professor publishes them.
  const gradeReleased =
    submissionRow?.status === 'graded' && areGradesPublished(assignment.settings)
  // FLAG 1: strip AI-grading fields (referenceAnswer / absoluteKeywords) before the rubric
  // reaches any student-facing surface — those fields are answer-key material.
  const rubricRaw = parseRubric(assignment.settings)
  const rubric = rubricRaw ? stripRubricAiFields(rubricRaw) : null
  const rubricScores = (submissionRow?.rubric_scores as string[] | undefined) ?? []

  // Comments are visible once the professor has taken a grade action: publish (gradeReleased)
  // or request changes (status === 'returned'). Regrade requests stay gated on gradeReleased only.
  const commentsVisible = gradeReleased || submissionRow?.status === 'returned'
  const [regradeRequests, submissionComments] = await Promise.all([
    gradeReleased && submissionRow
      ? assignmentQueries.getStudentRegradeRequests(supabase, submissionRow.id)
      : Promise.resolve([]),
    commentsVisible && submissionRow
      ? assignmentQueries.listSubmissionComments(supabase, submissionRow.id)
      : Promise.resolve([]),
  ])

  // Studio notebook (if any).
  const studioSettings = (assignment.settings ?? {}) as Record<string, unknown>
  const studioDoc = studioSettings.studio as {
    notebook?: unknown
    resources?: { moduleTags?: string[]; generatedLinks?: { label: string; url: string }[] }
  } | undefined
  // Strip the professor-only answer key BEFORE the notebook crosses into the client
  // component below — the whole object is serialized into the RSC payload, so the
  // student view's showAnswerKey={false} hides it on screen but does not withhold it.
  const parsedNotebook = studioDoc?.notebook ? parseNotebookModel(studioDoc.notebook) : null
  const studioNotebook = parsedNotebook ? stripNotebookAnswerKeys(parsedNotebook) : null

  // Blank "document" assignment: strip answer keys before rendering.
  const assignmentDocument = parseAssignmentDocument(assignment.settings)
  const studentDoc = assignmentDocument ? stripStudioAnswerKeys(assignmentDocument.doc) : null

  // Verbal assessment branch.
  const verbalConfig = parseVerbalAssessment(assignment.settings)
  const isVerbal = (studioSettings.kind === 'verbal' || !!studioSettings.verbalAssessment) && !!verbalConfig
  const studentName = user
    ? ((await supabase.from('profiles').select('name').eq('id', user.id).maybeSingle()).data?.name?.split(' ')[0] ?? 'there')
    : 'there'
  const verbalDone = isVerbal && submissionRow && submissionRow.status !== 'returned'

  // Professor-uploaded assignment PDFs.
  const assignmentPdfs = parseAssignmentPdfs(assignment.settings)
  const assignmentPdfSigned = await signMany(COURSE_MATERIALS_BUCKET, assignmentPdfs.map((p) => p.path))

  // ── Assessment mode: hand off to the timed, proctored runner WHILE the student is taking it.
  // Once submitted/graded it falls through to the standard assignment page below, so the
  // submitted/graded view is identical to a normal assignment. The brief is rendered ONLY during
  // the work phase, so a reload can never reveal it during the upload window.
  // A never-started assessment past due with no reopen window shows the Missing state, not the lobby.
  const assessment = parseAssessment(assignment.settings)
  const assessmentDone = submissionRow?.status === 'submitted' || submissionRow?.status === 'graded'
  const sub = submissionRow as
    | { id: string; status: string; assessment_started_at?: string | null; assessment_work_ended_at?: string | null }
    | null
  const assessmentStartedAt = sub?.assessment_started_at ?? null
  // Skip the runner when: deadline passed + no reopen window + student never started
  const assessmentMissingState = assessment.enabled && !isVerbal && !assessmentDone && deadlinePassed && !reopenWindowActive && !assessmentStartedAt
  if (assessment.enabled && !isVerbal && !assessmentDone && !assessmentMissingState) {
    const workEndedAt = (sub as { assessment_work_ended_at?: string | null } | null)?.assessment_work_ended_at ?? null
    const isSubmitted = sub?.status === 'submitted' || sub?.status === 'graded'
    const timing = assessmentTimingNow(assessmentStartedAt, workEndedAt, assessment)
    const showBrief = timing.phase === 'work' && !isSubmitted

    const briefSlot = showBrief ? (
      <div className="space-y-6">
        {assignment.description && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{assignment.description}</p>
          </div>
        )}
        {assignmentPdfs.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {assignmentPdfs.length === 1 ? 'Assignment PDF' : 'Assignment PDFs'}
            </p>
            <div className="space-y-2">
              {assignmentPdfs.map((pdf) => (
                <FilePreviewLink key={pdf.path} url={assignmentPdfSigned.get(pdf.path) ?? null} name={pdf.name} />
              ))}
            </div>
          </div>
        )}
        {studioNotebook && (
          <StudentNotebookView notebook={studioNotebook} title={assignment.title} resources={studioDoc?.resources} />
        )}
        {assignmentDocument && (
          <div className="rounded-2xl border border-border bg-card p-6">
            <DocumentReadOnly content={studentDoc as unknown as JSONContent} />
          </div>
        )}
      </div>
    ) : null

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href={`/student/courses/${sectionId}/assignments`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Assignments
        </Link>

        <div>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{assignment.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {assignment.due_at ? `Due ${new Date(assignment.due_at).toLocaleString()}` : 'No due date'}
            </span>
            {assignment.is_graded !== false ? (
              <span className="tabular-nums">{assignment.points} points</span>
            ) : (
              <span>Ungraded</span>
            )}
          </div>
        </div>

        <AssessmentRunner
          sectionId={sectionId}
          assignmentId={assignmentId}
          config={assessment}
          fileTypes={fileTypes}
          initialStartedAt={assessmentStartedAt}
          initialWorkEndedAt={workEndedAt}
          initialPhase={timing.phase}
          submissionId={sub?.id ?? null}
          submitted={isSubmitted}
          briefSlot={briefSlot}
        />
      </div>
    )
  }

  // Submission object passed to the workspace.
  const submissionProp = submissionRow
    ? {
        id: submissionRow.id,
        // Until grades are published, a graded submission reads as "awaiting grade".
        //
        // An active reopen window ALSO unmasks it, for both the released and unreleased cases: the
        // workspace early-returns a read-only view whenever it sees status 'graded', so leaving a
        // reopened-and-released submission as 'graded' would show the student their old work with no
        // submit control — while the professor's reopen dialog promised they could submit again, and
        // submitAssignment would in fact accept it.
        status: (submissionRow.status === 'graded' && (!gradeReleased || reopenWindowActive)
          ? 'submitted'
          : submissionRow.status) as SubmissionStatus,
        // Locked (read-only, no submit button) when graded, UNLESS a reopen window is active
        // (item 3). Assessment submissions are always locked (single attempt).
        locked: (submissionRow.status === 'graded' && !reopenWindowActive) || assessment.enabled,
        text: submissionRow.text_content ?? '',
        files: existingFiles.map((f) => ({
          name: f.name,
          path: f.path,
          url: signed.get(f.path) ?? null,
        })),
        score: gradeReleased ? submissionRow.score : null,
        feedback: gradeReleased ? (submissionRow.feedback ?? '') : '',
      }
    : null

  // Deadline-gate props for the workspace.
  const workspaceDeadlineProps = {
    submissionsClosed,
    reopenWindowActive,
    resubmitUntil,
    dueAt: assignment.due_at ?? null,
  }

  // ── Verbal carve-out: keep exact existing single-column layout ──
  if (isVerbal) {
    const submissionSection = verbalDone ? (
      <div className="rounded-2xl border border-border bg-card p-6">
        <p className="text-sm font-semibold text-foreground">
          {gradeReleased ? 'Assessment graded' : 'Assessment submitted'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your recorded session was sent to your instructor.
          {gradeReleased && submissionRow!.score != null
            ? ` Score: ${submissionRow!.score} / ${assignment.points}.`
            : ''}
        </p>
        {gradeReleased && submissionRow!.feedback && (
          <p className="mt-3 whitespace-pre-wrap rounded-xl bg-muted/50 p-3 text-sm text-foreground">{submissionRow!.feedback}</p>
        )}
      </div>
    ) : (
      <VerbalAssessmentRunner
        sectionId={sectionId}
        assignmentId={assignmentId}
        studentName={studentName}
        topic={verbalConfig!.topic}
        cells={verbalConfig!.cells}
        timeLimitMinutes={verbalConfig!.timeLimitMinutes}
      />
    )

    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Link
          href={`/student/courses/${sectionId}/assignments`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Assignments
        </Link>

        <div>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">
            {assignment.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {assignment.is_graded !== false ? (
              <span className="tabular-nums">{assignment.points} points</span>
            ) : (
              <span>Ungraded</span>
            )}
          </div>
        </div>

        {gradeReleased && submissionSection}

        {assignment.description && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {assignment.description}
            </p>
          </div>
        )}

        {assignmentPdfs.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {assignmentPdfs.length === 1 ? 'Assignment PDF' : 'Assignment PDFs'}
            </p>
            <div className="space-y-2">
              {assignmentPdfs.map((pdf) => (
                <FilePreviewLink key={pdf.path} url={assignmentPdfSigned.get(pdf.path) ?? null} name={pdf.name} />
              ))}
            </div>
          </div>
        )}

        {!gradeReleased && submissionSection}
      </div>
    )
  }

  // ── Non-verbal: two-pane layout ──

  // Status for header chip + rail.
  const status = getStudentAssignmentStatus({
    dueAt: assignment.due_at,
    submissionStatus: submissionRow?.status as SubmissionStatus | undefined,
    gradesPublished: areGradesPublished(assignment.settings),
    hasOpenRegrade: (regradeRequests as RegradeRequestRow[]).some((r) => r.status === 'open'),
    resubmitUntil,
    // No assessmentClosed here on purpose: an enabled assessment with a started-but-unsubmitted
    // attempt always returns above via the AssessmentRunner branch, which owns that state and now
    // renders its own "window has closed" panel. Passing it would be dead code. The LIST is the
    // surface that needs the derived chip, and it uses the same shared helper.
  })
  const toneClasses = STATUS_TONE_CLASSES[status.tone]
  const StatusIcon = status.icon

  // CTA label for rail anchor button.
  const ctaLabel = (() => {
    if (!submissionRow) return 'Go to submission'
    if (submissionRow.status === 'returned') return 'Go to resubmit'
    return 'Go to your submission'
  })()

  const countdown = dueCountdown(assignment.due_at)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Full-width header */}
      <Link
        href={`/student/courses/${sectionId}/assignments`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Assignments
      </Link>

      <div>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">
          {assignment.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Status chip */}
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.chip}`}>
            <StatusIcon className="h-3.5 w-3.5" />
            {status.label}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            {assignment.is_graded !== false ? `${assignment.points} points` : 'Ungraded'}
          </span>
        </div>
      </div>

      {/* Two-pane grid */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">

        {/* RIGHT: sticky rail (DOM-first for mobile stacking) */}
        <aside className="space-y-4 lg:order-2 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100dvh-73px-3rem)] lg:overflow-y-auto">
          {/* StatusCard — server-rendered */}
          <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
            {/* Status chip (hidden on mobile — the header chip already shows it in-flow) */}
            <span className={`hidden lg:inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses.chip}`}>
              <StatusIcon className="h-3.5 w-3.5" />
              {status.label}
            </span>

            {/* Due countdown */}
            <p className={`text-sm ${
              countdown.tone === 'destructive'
                ? 'text-destructive'
                : countdown.tone === 'warning'
                ? 'text-warning-muted-foreground'
                : 'text-muted-foreground'
            }`}>
              {countdown.text}
            </p>

            {/* Meta rows */}
            <dl className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Points</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {assignment.is_graded !== false ? `${assignment.points} points` : 'Ungraded'}
                </dd>
              </div>
              {fileTypes.length > 0 && (
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Accepts</dt>
                  <dd className="font-medium text-foreground text-right">
                    {fileTypes.map(labelForKind).join(', ')}
                  </dd>
                </div>
              )}
              {submissionRow?.submitted_at && (
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Submitted</dt>
                  <dd className="font-medium text-foreground text-right">
                    {new Date(submissionRow.submitted_at).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Grade panel (grade released) */}
          {gradeReleased && submissionRow && (
            <StudentGradePanel
              sectionId={sectionId}
              assignmentId={assignmentId}
              points={Number(assignment.points)}
              score={submissionRow.score}
              feedback={submissionRow.feedback ?? ''}
              rubric={rubric}
              rubricScores={rubricScores}
              regradeRequests={regradeRequests as RegradeRequestRow[]}
              comments={submissionComments as unknown as SubmissionCommentRow[]}
              rubricComments={(submissionRow as { rubric_comments?: Record<string, string> | null }).rubric_comments ?? null}
            />
          )}

          {/* CTA anchor button (grade not yet released). Desktop-only: on mobile the
              single column reaches the workspace by scrolling, so the jump earns nothing.
              Outline, not filled, so it reads as navigation and does not impersonate the
              workspace's own submit button. */}
          {!gradeReleased && (
            <Button asChild variant="outline" size="lg" className="hidden w-full lg:flex">
              <a href="#submit">{ctaLabel}</a>
            </Button>
          )}
        </aside>

        {/* LEFT: content column */}
        <div className="min-w-0 space-y-6 lg:order-1">
          {assignment.description && (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {assignment.description}
              </p>
            </div>
          )}

          {assignmentPdfs.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {assignmentPdfs.length === 1 ? 'Assignment PDF' : 'Assignment PDFs'}
              </p>
              <div className="space-y-2">
                {assignmentPdfs.map((pdf) => (
                  <FilePreviewLink key={pdf.path} url={assignmentPdfSigned.get(pdf.path) ?? null} name={pdf.name} />
                ))}
              </div>
            </div>
          )}

          {studioNotebook && (
            <StudentNotebookView notebook={studioNotebook} title={assignment.title} resources={studioDoc?.resources} />
          )}

          {assignmentDocument && (
            <div className="rounded-2xl border border-border bg-card p-6">
              <div className="mb-3 flex justify-end">
                <DownloadDocumentButton doc={studentDoc as unknown as JSONContent} title={assignment.title} />
              </div>
              <DocumentReadOnly content={studentDoc as unknown as JSONContent} />
            </div>
          )}

          {/* Submission workspace */}
          <section id="submit" className="scroll-mt-6">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Your submission
            </h2>
            <StudentAssignmentWorkspace
              sectionId={sectionId}
              assignmentId={assignmentId}
              fileTypes={fileTypes}
              points={Number(assignment.points)}
              submission={submissionProp}
              heldComments={submissionRow?.status === 'returned' ? (submissionComments as unknown as SubmissionCommentRow[]) : []}
              submissionsClosed={workspaceDeadlineProps.submissionsClosed}
              reopenWindowActive={workspaceDeadlineProps.reopenWindowActive}
              resubmitUntil={workspaceDeadlineProps.resubmitUntil}
              lateRequestAt={lateRequestAt}
              // Only set when the student can actually SEE a released grade and has been reopened:
              // resubmitting clears score/graded_at, so the workspace confirms before replacing it.
              releasedScoreAtRisk={gradeReleased && reopenWindowActive ? (submissionRow?.score ?? null) : null}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
