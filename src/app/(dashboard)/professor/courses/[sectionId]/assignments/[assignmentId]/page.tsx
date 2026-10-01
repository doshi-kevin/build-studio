/**
 * Professor Assignment Detail: two views for a published assignment.
 *   - Assignment details: what the assignment is (meta, notebook/PDF, rubric) + the editor link.
 *   - Grading: roster analytics + the segmented submission grader.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/[assignmentId]
 */

import Link from 'next/link'
import { ChevronLeft, FileText, NotebookPen, PencilLine } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { assignmentQueries, enrollmentQueries } from '@/lib/supabase/queries'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { signMany } from '@/lib/supabase/signed-urls'
import { ASSIGNMENT_SUBMISSIONS_BUCKET, COURSE_MATERIALS_BUCKET } from '@/lib/supabase/storage'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { AssignmentDetailTabs } from '@/components/professor/assignments/AssignmentDetailTabs'
import { ProfessorAssignmentGrader, type StudentEntry } from '@/components/professor/assignments/ProfessorAssignmentGrader'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { AssignmentPdfCard } from '@/components/professor/assignments/AssignmentPdfCard'
import { AssignmentMetaEditor } from '@/components/professor/assignments/AssignmentMetaEditor'
import { AssignmentTitleEditor } from '@/components/professor/assignments/AssignmentTitleEditor'
import { StudentNotebookView } from '@/components/student/assignments/StudentNotebookView'
import { PublishGradesButton } from '@/components/professor/assignments/PublishGradesButton'
import { AssignmentAnswerKeyCard } from '@/components/professor/assignments/AssignmentAnswerKeyCard'
import { parseNotebookModel } from '@/lib/assignments/studio/notebook-model'
import { collectAnswerKeys } from '@/lib/assignments/studio/answer-keys'
import { parseAssignmentDocument } from '@/lib/validations/studio'
import { DocumentReadOnly } from '@/components/professor/assignments/studio/DocumentReadOnly'
import { DownloadDocumentButton } from '@/components/professor/assignments/studio/DownloadDocumentButton'
import type { JSONContent } from 'novel'
import { segmentRoster, isPastDue, isLateSubmission, type RosterStudent } from '@/lib/assignments/submissions'
import { parseAssignmentPdfs, parseRubricSources, mergeRubricAi, parseAnswerKeySource, parseRubric, parseRubricDraft, parseAssessment, areGradesPublished, parseAccepts, parseAiGradingState } from '@/lib/validations/assignment'
import { loadRubricAi, loadAnswerKeySource } from '@/lib/assignments/ai-grading/answer-key'
import type { SubmissionRow, SubmissionFile, SubmissionStatus, SubmissionCommentRow } from '@/lib/validations/assignment'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'
import { PlainAssignmentActions } from '@/components/professor/assignments/PlainAssignmentActions'
import type { ProctoringSnapshotView } from '@/components/professor/assignments/AssignmentProctoringReport'

interface PageProps {
  params: Promise<{ sectionId: string; assignmentId: string }>
  searchParams?: Promise<{ tab?: string }>
}

export default async function ProfessorAssignmentDetailPage({ params, searchParams }: PageProps) {
  const { sectionId, assignmentId } = await params
  const tabParam = (await searchParams)?.tab
  const activeTab = tabParam === 'grading' ? 'grading' : tabParam === 'rubrics' ? 'rubrics' : 'details'
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const access = user ? await verifySectionAccess(sectionId, user.id) : { ok: false as const }
  /* This header's editing controls were gated on publish STATUS only, never on role, so
     a grader was shown "Edit assignment", "Close submissions" and "Unpublish" — all of
     which the server refuses them, since setAssignmentStatus and the edit wizard gate on
     canWriteAsStaff. Same refused-control pattern as #749's menus and the "Create quiz"
     button. Found by browser QA noticing a grader appeared to have MORE than a TA;
     the TA was actually correct, its assignment simply wasn't in a state that renders
     Close/Unpublish. */
  const canAuthor = access.ok ? canWriteAsStaff(access.role) : false
  if (!access.ok) {
    return (
      <EmptyState
        icon={FileText}
        title="Not available"
        description="You don't have access to this assignment."
      />
    )
  }

  const assignment = await assignmentQueries.getAssignment(access.adminDb, assignmentId)
  if (!assignment || assignment.section_id !== sectionId) {
    return (
      <EmptyState icon={FileText} title="Assignment not found" description="It may have been deleted." />
    )
  }

  // Roster + submissions (staff-wide read via admin client, after access check).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rosterRows = (await enrollmentQueries.getSectionEnrollments(access.adminDb, sectionId)) as any[]
  // Only active enrollments (the same set finalize_overdue_assignments() auto-zeros) so
  // the roster (and "Not submitted") doesn't show withdrawn/dropped students.
  const ACTIVE_ENROLLMENT = new Set(['enrolled', 'active', 'completed'])
  const students: RosterStudent[] = rosterRows
    .filter((r) => ACTIVE_ENROLLMENT.has(r.status))
    .map((r) => {
      const p = resolveJoin(r.student)
      return p ? { id: p.id, name: p.name ?? 'Student', email: p.email ?? '' } : null
    })
    .filter((s): s is RosterStudent => s !== null)

  const submissions = (await assignmentQueries.listSubmissions(
    access.adminDb,
    assignmentId,
  )) as unknown as SubmissionRow[]

  // Sign every submitted file once.
  const allPaths = submissions.flatMap((s) => (s.files ?? []).map((f) => f.path))
  const signed = await signMany(ASSIGNMENT_SUBMISSIONS_BUCKET, allPaths)

  // Regrade requests + per-subquestion comments (staff-wide read via admin client, after access).
  const submissionIds = submissions.map((s) => s.id)
  const [regradeRows, commentRows] = await Promise.all([
    assignmentQueries.listRegradeRequests(access.adminDb, assignmentId),
    assignmentQueries.listSubmissionCommentsFor(access.adminDb, submissionIds),
  ])
  // Open regrade per submission, and the student ids to surface in the attention bucket.
  const subToStudent = new Map(submissions.map((s) => [s.id, s.student_id]))
  const openRegradeBySubmission = new Map<string, (typeof regradeRows)[number]>()
  const openRegradeStudentIds = new Set<string>()
  for (const r of regradeRows) {
    if (r.status !== 'open') continue
    openRegradeBySubmission.set(r.submission_id, r)
    const studentId = subToStudent.get(r.submission_id)
    if (studentId) openRegradeStudentIds.add(studentId)
  }
  const commentsBySubmission = new Map<string, SubmissionCommentRow[]>()
  for (const c of commentRows as unknown as SubmissionCommentRow[]) {
    const list = commentsBySubmission.get(c.submission_id) ?? []
    list.push(c)
    commentsBySubmission.set(c.submission_id, list)
  }

  // Assessment mode: fetch + sign violation snapshots (only exist when video proctoring is on),
  // grouped per submission for the proctoring report panel.
  const assessment = parseAssessment(assignment.settings)
  const snapshotsBySubmission = new Map<string, ProctoringSnapshotView[]>()
  if (assessment.enabled && assessment.proctoring.video) {
    const { data: snapRows } = await access.adminDb
      .from('assignment_proctoring_snapshots')
      .select('submission_id, violation_type, storage_path, timestamp_offset, face_count')
      .eq('assignment_id', assignmentId)
    const snaps = (snapRows ?? []) as {
      submission_id: string; violation_type: string; storage_path: string; timestamp_offset: number; face_count: number
    }[]
    const snapSigned = await signMany('proctoring-snapshots', snaps.map((r) => r.storage_path))
    for (const r of snaps) {
      const list = snapshotsBySubmission.get(r.submission_id) ?? []
      list.push({
        url: snapSigned.get(r.storage_path) ?? null,
        violationType: r.violation_type,
        timestampOffset: r.timestamp_offset,
        faceCount: r.face_count,
      })
      snapshotsBySubmission.set(r.submission_id, list)
    }
  }

  // Load AI grade suggestions (status='suggested' only) — professor-only, never student-facing.
  // Keyed by submission_id for O(1) lookup when building student entries.
  const aiGradingReady = parseAiGradingState(assignment.settings).status === 'ready'
  const suggestionBySubmissionId = new Map<
    string,
    { suggestion: AiGradeSuggestion; suggestionUpdatedAt: string }
  >()
  {
    const { data: suggRows } = await access.adminDb
      .from('assignment_ai_grade_suggestions')
      .select(
        'submission_id, suggested_rubric_scores, suggested_score, rationale, feedback, confidence, flagged_count, unmapped_questions, status, model, updated_at',
      )
      .eq('assignment_id', assignmentId)
      .eq('status', 'suggested')

    for (const row of suggRows ?? []) {
      suggestionBySubmissionId.set(row.submission_id, {
        suggestion: {
          criteria: (row.rationale ?? []) as AiGradeSuggestion['criteria'],
          suggestedRubricScores: (row.suggested_rubric_scores ?? []) as string[],
          suggestedScore: row.suggested_score,
          feedback: row.feedback ?? '',
          confidence: row.confidence as AiGradeSuggestion['confidence'],
          flaggedCount: row.flagged_count ?? 0,
          unmappedQuestionIndexes: (row.unmapped_questions ?? []) as number[],
          model: row.model,
        },
        // Draft version, echoed back on grade save (correction capture's ghost-diff guard).
        suggestionUpdatedAt: row.updated_at,
      })
    }
  }

  // AI-vs-professor agreement so far (calibration telemetry, shown in the grader banner).
  const aiAgreement = await assignmentQueries.getAiAgreementStats(access.adminDb, assignmentId)

  const dueAt = assignment.due_at ?? null
  const assignmentIsPastDue = isPastDue(dueAt)

  const toEntry = (s: (typeof segments.graded)[number]): StudentEntry => {
    const submissionId = s.submission?.id
    const regrade = submissionId ? openRegradeBySubmission.get(submissionId) : null
    const isLate = isLateSubmission(s.submission?.submitted_at, dueAt)
    const submissionRow = s.submission as SubmissionRow | null
    // Thread AI suggestion (professor-only — never passed to student-facing components)
    const suggested = submissionId ? suggestionBySubmissionId.get(submissionId) : undefined
    return {
      id: s.id,
      name: s.name,
      email: s.email,
      lateRequestAt: s.lateRequestAt ?? null,
      submission: submissionRow
        ? {
            id: submissionRow.id,
            status: submissionRow.status as SubmissionStatus,
            text: submissionRow.text_content ?? '',
            files: (submissionRow.files ?? []).map((f: SubmissionFile) => ({
              name: f.name,
              path: f.path,
              url: signed.get(f.path) ?? null,
            })),
            score: submissionRow.score,
            feedback: submissionRow.feedback ?? '',
            submittedAt: submissionRow.submitted_at,
            updatedAt: submissionRow.updated_at,
            rubricScores: (submissionRow.rubric_scores ?? []) as string[],
            gradedWithRubric: submissionRow.graded_with_rubric ?? false,
            rubricComments: (submissionRow.rubric_comments ?? null) as Record<string, string> | null,
            answers: submissionRow.answers ?? [],
            proctoring: submissionRow.proctoring_summary ?? null,
            snapshots: snapshotsBySubmission.get(submissionRow.id) ?? [],
            isLate,
            resubmitUntil: submissionRow.resubmit_until ?? null,
            suggestion: suggested?.suggestion,
            suggestionUpdatedAt: suggested?.suggestionUpdatedAt,
          }
        : null,
      gradedByOldRubric: s.gradedByOldRubric ?? false,
      scoreExceedsTotal: s.scoreExceedsTotal ?? false,
      regradeRequest: regrade
        ? {
            id: regrade.id,
            reason: regrade.reason,
            questions: (regrade.questions ?? []) as { index: number; label: string }[],
            oldScore: regrade.old_score,
            createdAt: regrade.created_at,
          }
        : null,
      comments: submissionId ? (commentsBySubmission.get(submissionId) ?? []) : [],
    }
  }

  const points = Number(assignment.points)
  const isGraded = assignment.is_graded !== false

  // The professor-uploaded assignment PDFs (course-materials bucket), signed for display.
  const assignmentPdfs = parseAssignmentPdfs(assignment.settings)
  const assignmentPdfSigned = await signMany(COURSE_MATERIALS_BUCKET, assignmentPdfs.map((p) => p.path))
  const assignmentPdfCards = assignmentPdfs.map((p) => ({
    name: p.name,
    path: p.path,
    url: assignmentPdfSigned.get(p.path) ?? null,
  }))
  // The answer-key AI fields (reference answers, keywords, scoring rules) + the key PDF pointer
  // live off settings in the staff-only assignment_answer_keys row (BLOCKER #1). Merge them back
  // for the professor's rubric editor / answer-key surfaces; students never receive them.
  const [rubricAi, answerKeySourceRow] = await Promise.all([
    loadRubricAi(access.adminDb, assignmentId),
    loadAnswerKeySource(access.adminDb, assignmentId),
  ])
  // Fall back to the legacy settings pointer only for pre-migration rows missing a source_path.
  const answerKeySource = answerKeySourceRow ?? parseAnswerKeySource(assignment.settings)
  const publicRubric = parseRubric(assignment.settings)
  const publicRubricDraft = parseRubricDraft(assignment.settings)
  const rubric = publicRubric ? mergeRubricAi(publicRubric, rubricAi.approved) : null
  const rubricDraft = publicRubricDraft ? mergeRubricAi(publicRubricDraft, rubricAi.draft) : null
  const assignmentRubricSources = parseRubricSources(assignment.settings)

  const segments = segmentRoster(students, submissions, openRegradeStudentIds, !!rubric, points)

  // Studio assignments (notebook / verbal) preview their content + link back to the editor.
  const settings = (assignment.settings ?? {}) as Record<string, unknown>
  const kind = (settings.kind as string | undefined)
    ?? (settings.studio ? 'notebook' : settings.verbalAssessment ? 'verbal' : 'file')
  const isVerbal = kind === 'verbal'
  const isNotebook = kind === 'notebook'
  const isDocument = kind === 'document'
  const isFileUpload = kind === 'file-upload'
  const assignmentDocument = isDocument ? parseAssignmentDocument(settings) : null
  const editorPath = isVerbal
    ? `/professor/courses/${sectionId}/assignments/${assignmentId}/verbal`
    : `/professor/courses/${sectionId}/assignments/${assignmentId}/studio`
  const studioDoc = settings.studio as {
    notebook?: unknown
    resources?: { moduleTags?: string[]; generatedLinks?: { label: string; url: string }[] }
  } | undefined
  const notebook = isNotebook && studioDoc?.notebook ? parseNotebookModel(studioDoc.notebook) : null
  // Professor-only answer keys (manual or Solver-generated), surfaced in the grading view.
  const answerKeys = notebook ? collectAnswerKeys(notebook) : []

  // Grading analytics — evidence-based, NOT bucket counts: grading a non-submitter must not
  // flip Submitted/Missing (the buckets move students around; the evidence doesn't change).
  const activeStudentIds = new Set(students.map((s) => s.id))
  const activeSubmissions = submissions.filter((s) => activeStudentIds.has(s.student_id))
  const submittedCount = activeSubmissions.filter((s) => s.submitted_at != null).length
  const gradedCount = activeSubmissions.filter((s) => s.score != null).length
  const missing = students.length - submittedCount
  // Grade release: graded submissions stay hidden from students until the professor publishes.
  const gradesPublished = areGradesPublished(assignment.settings)
  const unreleasedGraded = gradesPublished ? 0 : gradedCount
  const releasedGraded = gradesPublished ? gradedCount : 0
  const analytics: { label: string; value: string; danger?: boolean }[] = [
    { label: 'Enrolled', value: String(students.length) },
    { label: 'Submitted', value: String(submittedCount) },
    { label: 'Graded', value: String(gradedCount) },
    { label: 'Missing', value: String(missing), danger: missing > 0 },
  ]
  return (
    <div className="space-y-6">
      <Link
        href={`/professor/courses/${sectionId}/assignments`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Assignments
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <AssignmentTitleEditor sectionId={sectionId} assignmentId={assignmentId} title={assignment.title} canEdit={canAuthor} />
          <AssignmentMetaEditor
            sectionId={sectionId}
            assignmentId={assignmentId}
            dueAt={assignment.due_at}
            points={points}
            isGraded={isGraded}
            status={assignment.status}
            hasRubric={!!rubric}
            canEdit={canAuthor}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AthenaAskLine />
          {canAuthor && (isNotebook || isVerbal || isDocument || isFileUpload) && (
            <Button asChild variant="outline">
              <Link href={editorPath}>
                <PencilLine className="h-4 w-4" />
                Edit {isVerbal ? 'assessment' : isDocument ? 'document' : isFileUpload ? 'assignment' : 'notebook'}
              </Link>
            </Button>
          )}
          {canAuthor && !isNotebook && !isVerbal && !isDocument && !isFileUpload && (
            <PlainAssignmentActions
              sectionId={sectionId}
              assignmentId={assignmentId}
              status={assignment.status}
              editData={{
                id: assignmentId,
                title: assignment.title,
                instructions: assignment.description ?? '',
                dueAt: assignment.due_at,
                points,
                fileTypes: parseAccepts(assignment.settings).fileTypes,
                isGraded,
              }}
            />
          )}
        </div>
      </div>

      <AssignmentDetailTabs
        activeTab={activeTab}
        isGraded={isGraded}
        rubric={{
          sectionId,
          assignmentId,
          initialRubric: rubric,
          initialRubricDraft: rubricDraft,
          generateSources: {
            content: notebook ? 'notebook' : assignmentDocument ? 'document' : null,
            pdfs: assignmentPdfs,
            rubricSources: assignmentRubricSources,
            answerKeySource,
          },
          totalPoints: points,
        }}
        detailsContent={
          isDocument ? (
            <div className="rounded-2xl border border-border bg-card p-6">
              {assignmentDocument && assignmentDocument.doc.content?.length ? (
                <>
                  <div className="mb-4 flex items-center justify-end">
                    <DownloadDocumentButton doc={assignmentDocument.doc as unknown as JSONContent} title={assignment.title} />
                  </div>
                  <DocumentReadOnly content={assignmentDocument.doc as unknown as JSONContent} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">This document is empty. Open the editor to add content.</p>
              )}
            </div>
          ) : isNotebook || isVerbal ? (
            notebook ? (
              <StudentNotebookView notebook={notebook} title={assignment.title} resources={studioDoc?.resources} />
            ) : (
              <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <NotebookPen className="h-4 w-4" />
                </span>
                <div className="text-sm">
                  <p className="font-medium text-foreground">{isVerbal ? 'Verbal assessment' : 'Notebook'}</p>
                  <p className="text-muted-foreground">Open the editor to view and change the content.</p>
                </div>
              </div>
            )
          ) : (
            <AssignmentPdfCard
              sectionId={sectionId}
              assignmentId={assignmentId}
              pdfs={assignmentPdfCards}
            />
          )
        }
        gradingContent={
          <>
            <AssignmentAnswerKeyCard entries={answerKeys} />

          {isGraded && (
            <PublishGradesButton
              sectionId={sectionId}
              assignmentId={assignmentId}
              unreleased={unreleasedGraded}
              released={releasedGraded}
              /* Who the release would leave out, counted from the DATA (`score != null`)
                 rather than by adding buckets up. The bucket sum omitted `segments.returned`
                 — work sent back for changes, normally ungraded — so the confirmation
                 under-reported who was excluded. Bucket arithmetic is also the wrong tool
                 here: a graded student with an open regrade sits in `returned`, and
                 gradedCount correctly still counts them as graded. */
              ungraded={students.length - gradedCount}
            />
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {analytics.map((a) => (
              <div
                key={a.label}
                className={`rounded-2xl border p-4 ${a.danger ? 'border-destructive/20 bg-destructive/5' : 'border-border bg-card'}`}
              >
                <p className="text-xs text-muted-foreground">{a.label}</p>
                <p className={`mt-1 text-2xl font-semibold tabular-nums ${a.danger ? 'text-destructive' : 'text-foreground'}`}>
                  {a.value}
                </p>
              </div>
            ))}
          </div>

          <ProfessorAssignmentGrader
            sectionId={sectionId}
            assignmentId={assignmentId}
            points={points}
            isGraded={isGraded}
            isPastDue={assignmentIsPastDue}
            rubric={rubric}
            studioPath={editorPath}
            aiGradingReady={aiGradingReady}
            aiAgreement={aiAgreement}
            gradesPublished={gradesPublished}
            isAssessment={assessment.enabled}
            segments={{
              needsGrading: segments.needsGrading.map(toEntry),
              returned: segments.returned.map(toEntry),
              graded: segments.graded.map(toEntry),
              notSubmitted: segments.notSubmitted.map(toEntry),
            }}
          />
          </>
        }
      />
    </div>
  )
}
