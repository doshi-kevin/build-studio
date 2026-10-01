/**
 * Assignment Server Actions (Professor + TA).
 *
 * Access model:
 *   - create / publish / delete: professor + active TA (canWriteAsStaff)
 *   - grade: professor + active TA (graders read-only in v1, per section-access)
 *
 * Every action: resolve session → verifySectionAccess → admin DB write →
 * logEvent → revalidatePath. Actions return { error } or { success } — never throw.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { canGrade, canWriteAsProfessor, canWriteAsStaff, verifySectionAccess } from '@/lib/auth/section-access'
import { removeItemFromScheme } from '@/lib/grades/fetch'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { logEvent } from '@/lib/supabase/event-logger'
import { recordAiUsage } from '@/lib/ai/usage'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { emitEvent } from '@/lib/events/emit'
import { emitContentChange } from '@/lib/events/content-change'
import { sendResubmissionRequested } from '@/lib/email'
import { logger } from '@/lib/logger'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { after } from 'next/server'
import { applyGradeToSkillMastery } from '@/lib/skills/grade-hook'
import { getModuleSkillCandidates, ensureSectionSkills, canonicalizeName, matchInPool, suggestSkillsBySimilarity } from '@/lib/skills/reconcile'
import { writePlacementEdge } from '@/lib/roadmap/placement'
import { enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import {
  createAssignmentSchema,
  publishSettingsSchema,
  updateAssignmentMetaSchema,
  assignmentInstructionsSchema,
  gradeSubmissionSchema,
  gradeStudentInputSchema,
  submissionCommentSchema,
  reopenWindowSchema,
  resolveReopenUntil,
  parseAssessment,
  parseRubric,
  parseAssignmentPdfs,
  parseRubricSources,
  parseSkillModules,
  hasSkillModulesKey,
  MAX_ASSIGNMENT_PDF_SIZE,
  MAX_ASSIGNMENT_PDFS,
  validateAssignmentAttachment,
  GRADE_CONFLICT_MESSAGE,
  MAX_ASSIGNMENT_POINTS,
  MAX_CELL_IMAGE_SIZE,
  CELL_IMAGE_MIME_TYPES,
  assignmentRubricSchema,
  assignmentRubricDraftSchema,
  rubricPointIssues,
  isRubricQuestionGraded,
  MAX_SKILLS_PER_QUESTION,
  rubricTotalPoints,
  splitRubricAi,
  parseAiGradingState,
  type AssignmentRubric,
  type AssignmentPdf,
  type AssignmentRubricSourceFile,
  type RubricSource,
  type SubmissionCommentInput,
  type ReopenWindow,
  type SubmissionFile,
} from '@/lib/validations/assignment'
import { studioDocSchema, assignmentDocumentSchema, emptyAssignmentDocument, parseAssignmentDocument } from '@/lib/validations/studio'
import { getNotebookTemplate } from '@/lib/assignments/studio/notebook-templates'
import { runWolfram, type WolframTool, type WolframOutput } from '@/lib/wolfram/client'
import { emptyNotebook, parseNotebookModel } from '@/lib/assignments/studio/notebook-model'
import { verbalAssessmentSchema } from '@/lib/validations/verbal-assessment'
import { defaultVerbalAssessment } from '@/lib/assignments/verbal/config'
import { getVerbalTemplate } from '@/lib/assignments/verbal/verbal-templates'
import { synthesizeSpeech } from '@/lib/ai/elevenlabs/tts'
import { signOne } from '@/lib/supabase/signed-urls'
import { resolvePublishState } from '@/lib/assignments/submissions'
import { computeAssessmentTiming } from '@/lib/assignments/assessment'
import { sanitizeFileName } from '@/lib/assignments/files'
import { COURSE_MATERIALS_BUCKET, ASSIGNMENT_CELL_IMAGES_BUCKET, ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'
import { parseDocument, getTextForLLM } from '@/lib/document-parser'
import { generateRubricFromText, generateRubricFromAnswerKey } from '@/lib/assignments/rubric-ai'
import { parseAnswerKeyBuffer, storeAnswerKeyText, storeRubricAi } from '@/lib/assignments/ai-grading/answer-key'
import { studioNotebookToRubricText, studioDocumentToRubricText } from '@/lib/assignments/studio/rubric-source'
import { syncRubricReferenceVectors } from '@/lib/assignments/ai-grading/references'
import { deleteRubricReferenceVectors } from '@/lib/pinecone/data'
import { buildAndSaveSuggestion } from '@/lib/assignments/ai-grading/suggest'
import { supersedeAiSuggestions } from '@/lib/assignments/ai-grading/invalidate'
import { captureGradingCorrections } from '@/lib/assignments/ai-grading/corrections'
import type { AiGradeSuggestion } from '@/lib/assignments/ai-grading/types'

type ActionResult<T = unknown> = { error: string } | ({ success: true } & T)

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'Please check the form and try again.'
}

export async function createAssignment(
  sectionId: string,
  input: unknown,
  publish: boolean,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  const parsed = createAssignmentSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { title, instructions, dueAt, points, fileTypes, isGraded, scheduleAt } = parsed.data

  // A future scheduleAt → 'scheduled' (pg_cron publishes it); else publish-now or draft.
  const { status, scheduledPublishAt } = resolvePublishState(scheduleAt, publish)

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title,
      description: instructions ?? '',
      submission_type: fileTypes.length > 0 ? 'files' : 'written',
      status,
      points,
      is_graded: isGraded,
      settings: { accepts: { fileTypes } },
      due_at: dueAt || null,
      scheduled_publish_at: scheduledPublishAt,
      published_at: status === 'published' ? new Date().toISOString() : null,
      // Stamp when we notify inline (below) so the deferred-publish sweep skips
      // this row. A scheduled publish leaves this NULL for the sweep to claim.
      publish_notified_at: status === 'published' ? new Date().toISOString() : null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('createAssignment', error, { sectionId })
    return { error: 'Could not create the assignment. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, title, status, isGraded },
  })

  // Notify enrolled students when the assignment is created already-published.
  // (Draft→publish goes through setAssignmentStatus; scheduled publishes are caught
  // by the sweep.) emitEvent resolves the enrolled audience and writes the shared feed.
  if (status === 'published') {
    await emitEvent({
      type: 'assignment_published',
      sectionId,
      actorId: userId,
      institutionId: section.institution_id,
      entity: { type: 'assignment', id: data.id },
      title: `New assignment: ${title}`,
      linkUrl: `/student/courses/${sectionId}/assignments/${data.id}`,
      actionable: true,
      dueAt: dueAt || null,
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

export async function setAssignmentStatus(
  sectionId: string,
  assignmentId: string,
  status: 'published' | 'draft' | 'closed',
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to change this assignment." }
  }

  // Object-level authz: the assignment must belong to this section.
  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, title, due_at, published_at, publish_notified_at')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }

  /* Withdrawing to draft hides the assignment from students entirely (student reads are
     scoped to status IN ('published','closed')). If anyone has already submitted, that would
     strip them of access to their own work and to any grade or feedback on it, and a timed
     assessment in progress would be cut off mid-attempt. Refuse rather than warn: there is no
     version of that the professor can undo for the student.
     'closed' stays available and is the right tool here — it stops new submissions while
     leaving everything visible. */
  if (status === 'draft') {
    const [submitted, liveAssessments] = await Promise.all([
      access.adminDb
        .from('assignment_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('assignment_id', assignmentId)
        .neq('status', 'draft'),
      /* A 'draft' row is NOT automatically harmless. Two different things create one:
           - a late-request stub (student actions.ts) — files: [], no content, safe to withdraw;
           - an assessment IN PROGRESS (assessment-actions.ts), which stamps
             assessment_started_at and starts the clock.
         Withdrawing under a live assessment hides the assignment mid-attempt (student reads are
         scoped to status IN ('published','closed')) and leaves assessment_started_at set, so the
         student's clock has been running against work they can no longer reach. Excluding all
         drafts wholesale missed that; keying on assessment_started_at blocks only the case that
         actually costs a student something. */
      access.adminDb
        .from('assignment_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('assignment_id', assignmentId)
        .eq('status', 'draft')
        .not('assessment_started_at', 'is', null),
    ])
    if (submitted.error || liveAssessments.error) {
      logger.error('setAssignmentStatus: submission check failed', submitted.error ?? liveAssessments.error, { assignmentId })
      return { error: 'Could not check this assignment for submissions. Please try again.' }
    }
    const submittedCount = submitted.count ?? 0
    const liveCount = liveAssessments.count ?? 0
    if (submittedCount > 0) {
      return {
        error: `${submittedCount} student${submittedCount === 1 ? ' has' : 's have'} already submitted, so this can't go back to draft — they would lose access to their own work. Use "Close submissions" instead.`,
      }
    }
    if (liveCount > 0) {
      return {
        error: `${liveCount} student${liveCount === 1 ? ' is' : 's are'} part-way through this assessment right now — unpublishing would cut them off mid-attempt. Use "Close submissions" instead, or wait for them to finish.`,
      }
    }
  }

  const now = new Date().toISOString()
  /* Timestamps per transition, NOT "published ? now : null".
     The old form wiped published_at AND publish_notified_at on any non-publish transition.
     That was harmless only because the sole caller hardcoded 'published'; it becomes live
     the moment Close/Unpublish are reachable, and it is a data-loss bug:
       - published_at feeds COALESCE(published_at, created_at) ordering and "published on"
         display, so closing an assignment would erase when it went live.
       - the deferred-publish sweep claims rows on
         `status = 'published' AND publish_notified_at IS NULL`, so clearing that stamp
         re-arms a re-notification for work students were already told about.
     closed: keep both — the assignment WAS published, closing only stops new submissions.
     draft:  clear both — withdrawing means a later publish is a fresh one and SHOULD notify.
     published: preserve an existing published_at (a re-publish is not a new publication
         date) and stamp publish_notified_at, since this path notifies inline below. */
  const timestamps =
    status === 'published'
      ? { published_at: existing.published_at ?? now, publish_notified_at: now }
      : status === 'draft'
        ? { published_at: null, publish_notified_at: null }
        : {} // closed — leave the publication history alone

  const { error } = await access.adminDb
    .from('assignments')
    .update({
      status,
      ...timestamps,
      updated_at: now,
    })
    .eq('id', assignmentId)

  if (error) {
    logger.error('setAssignmentStatus', error, { assignmentId, status })
    return { error: 'Could not update the assignment. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.status_changed',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, status },
  })

  // Notify enrolled students when an assignment goes live. emitEvent resolves the
  // enrolled audience + institution and writes the shared feed.
  if (status === 'published') {
    await emitEvent({
      type: 'assignment_published',
      sectionId,
      actorId: userId,
      entity: { type: 'assignment', id: assignmentId },
      title: `New assignment: ${existing.title}`,
      linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
      actionable: true,
      dueAt: existing.due_at ?? null,
      // Re-announce on every publish transition (e.g. unpublish → republish) instead of
      // notifying once forever, so students see it whenever an assignment goes live.
      onDuplicate: 'refresh',
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

export async function deleteAssignment(
  sectionId: string,
  assignmentId: string,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* Professor only (#749). Deleting an assignment is unrecoverable and takes its
     submissions and grades with it, and quizzes/projects/live-classroom already
     reserved the equivalent — assignments were the outlier, not the standard. */
  if (!access.ok || !canWriteAsProfessor(access.role)) {
    return { error: 'Only the professor can delete an assignment.' }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, title')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }

  // Read the section's institution_id BEFORE the delete so we can prune the rubric reference
  // vectors afterwards (Pinecone erasure path — FLAG 8). Best-effort only.
  const { data: sectionForCleanup } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()

  const { error } = await access.adminDb.from('assignments').delete().eq('id', assignmentId)
  if (error) {
    logger.error('deleteAssignment', error, { assignmentId })
    return { error: 'Could not delete the assignment. Please try again.' }
  }

  // Best-effort erasure of AI-grading reference vectors — never block or fail the delete.
  if (sectionForCleanup?.institution_id) {
    deleteRubricReferenceVectors(
      { institutionId: sectionForCleanup.institution_id, sectionId },
      assignmentId,
    ).catch((err) =>
      logger.warn('deleteAssignment: rubric vector cleanup failed', {
        source: 'deleteAssignment',
        assignmentId,
        err: String(err),
      }),
    )
  }

  // Clear any grading-scheme membership/excuses for this now-deleted item (polymorphic, no FK cascade).
  await removeItemFromScheme(access.adminDb, sectionId, 'assignment', assignmentId)

  await logEvent({
    userId,
    eventType: 'assignment.deleted',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, title: existing.title },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true }
}

export async function gradeSubmission(
  sectionId: string,
  input: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* canGrade, not canWriteAsStaff (#746) — a role called grader can now grade. */
  if (!access.ok || !canGrade(access.role)) {
    return { error: "You don't have permission to grade here." }
  }

  const parsed = gradeSubmissionSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { submissionId, score, feedback, rubricScores, rubricComments, expectedUpdatedAt, suggestionUpdatedAt } = parsed.data

  // Object-level authz: the submission must belong to an assignment in this section.
  const { data: sub } = await access.adminDb
    .from('assignment_submissions')
    .select('id, assignment_id, student_id, status, score, feedback, updated_at, rubric_scores, rubric_comments, graded_with_rubric, assignment:assignments(section_id, points, title, settings)')
    .eq('id', submissionId)
    .maybeSingle()
  const subAssignment = sub ? resolveJoin(sub.assignment) : null
  if (!sub || subAssignment?.section_id !== sectionId) return { error: 'Submission not found.' }

  /* Optimistic concurrency. Two graders on one submission — a professor and a TA, or two
     graders splitting a pile — is the ordinary case, and the write below is a plain UPDATE
     by id, so the later save silently overwrote the earlier one and told nobody.

     The baseline has to come from the CLIENT, not from the select above: the losing
     grader's own read is fresh, so comparing against it would pass and still overwrite.
     `expectedUpdatedAt` is the row as the grader's page saw it, so a grade saved by anyone
     since that page loaded is detected. */
  const CONFLICT = GRADE_CONFLICT_MESSAGE

  /* Fail CLOSED when the row has a version but the caller sent no baseline. The guard below
     was written as `expectedUpdatedAt && ...`, which made it opt-OUT-able: the field is
     optional in the schema, so simply omitting it skipped the freshness check and allowed the
     silent overwrite #610 exists to prevent. Our own grader always sends it, but a stale
     deployed bundle or any direct caller would not — and "no token" must never mean "no
     conflict" on a check whose entire job is refusing unverified writes.
     A row with no updated_at at all has nothing to compare, so that case still proceeds. */
  if (sub.updated_at && !expectedUpdatedAt) {
    logger.warn('gradeSubmission: no concurrency baseline supplied, refusing blind write', { submissionId, userId })
    return {
      error: 'Couldn\'t confirm this grade was based on the latest version of the submission. '
        + 'Copy your feedback somewhere safe, then reload the submission and save again.',
    }
  }

  if (expectedUpdatedAt && sub.updated_at && expectedUpdatedAt !== sub.updated_at) {
    logger.warn('gradeSubmission: stale baseline, refusing overwrite', { submissionId, userId })
    return { error: CONFLICT }
  }

  // Business-rule check: the client guards this, but the server is the source of truth —
  // reject a score above the assignment's own points (prevents an inflated gradebook).
  const maxPoints = Number(subAssignment.points)
  if (Number.isFinite(maxPoints) && score > maxPoints) {
    return { error: `Score can't exceed this assignment's ${maxPoints} points.` }
  }

  // A returned submission is waiting on the student's revision, and grading it would flip the row
  // back to `graded` — silently cancelling the change request they were asked to act on. The grader
  // hides every save control in that state, but the invariant belongs here too: a stale second tab
  // (or a TA returning the work in parallel) would otherwise still land the write.
  if (sub.status === 'returned') {
    return { error: 'You asked this student to revise their work. Wait for them to resubmit before grading.' }
  }

  // (The old stale-client silent-zero guard was removed: the grader now makes pre-rubric intent
  // explicit via a "Keep this score / Grade with the rubric" choice, so a fresh client can't
  // silently zero a pre-rubric grade — and the guard would wrongly block a deliberate rubric 0.)

  // Strip empty / whitespace-only comments before persisting so clearing a box removes it.
  const cleanedComments: Record<string, string> | undefined = rubricComments
    ? Object.fromEntries(
        Object.entries(rubricComments).filter(([, v]) => v.trim().length > 0),
      )
    : undefined

  // No-op save: nothing changed, so don't re-stamp graded_at/graded_by or log a phantom
  // "graded" event (a same-values re-save must not rewrite the audit trail).
  // graded_with_rubric marks whether a rubric existed when this grade was saved — true for ANY
  // grade entered while the assignment has a rubric (manual score field OR ticked criteria), so an
  // intentional manual score after the rubric exists stays in Graded. Only grades saved before any
  // rubric existed read as false and get flagged for re-grade by segmentRoster.
  const gradedWithRubric = !!parseRubric(subAssignment.settings)
  const sameRubricScores =
    rubricScores === undefined ||
    JSON.stringify([...rubricScores].sort()) ===
      JSON.stringify([...((sub.rubric_scores ?? []) as string[])].sort())
  // Compare canonically (keys sorted): client comments keep insertion order while jsonb returns
  // keys normalized, so a plain stringify would false-negative with 2+ comments and wrongly
  // re-stamp graded_at/graded_by + log a phantom event on a genuine no-op re-save.
  const canonComments = (o: Record<string, string>) =>
    JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
  const sameComments =
    cleanedComments === undefined ||
    canonComments(cleanedComments) === canonComments((sub.rubric_comments ?? {}) as Record<string, string>)
  if (
    sub.status === 'graded' &&
    sub.score === score &&
    (sub.feedback ?? '') === (feedback ?? '') &&
    sameRubricScores &&
    sameComments &&
    sub.graded_with_rubric === gradedWithRubric
  ) {
    return { success: true }
  }

  const { data: written, error } = await access.adminDb
    .from('assignment_submissions')
    .update({
      score,
      feedback: feedback ?? '',
      status: 'graded',
      graded_by: userId,
      graded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Provenance: true when a rubric existed at grade time. segmentRoster keys off this column.
      graded_with_rubric: gradedWithRubric,
      ...(rubricScores ? { rubric_scores: rubricScores } : {}),
      ...(cleanedComments !== undefined ? { rubric_comments: cleanedComments } : {}),
    })
    .eq('id', submissionId)
    /* Second half of the guard, closing the window between the select above and this write:
       two requests that both passed the baseline check still race here. Conditional
       transitions belong in the WHERE, then branch on rows affected (data-access rules). */
    .eq('updated_at', sub.updated_at)
    .select('id')

  if (error) {
    logger.error('gradeSubmission', error, { submissionId })
    return { error: 'Could not save the grade. Please try again.' }
  }
  if (!written || written.length === 0) {
    logger.warn('gradeSubmission: lost the write race, no rows updated', { submissionId, userId })
    return { error: CONFLICT }
  }

  await logEvent({
    userId,
    eventType: 'assignment.graded',
    eventCategory: 'course',
    sectionId,
    metadata: { submissionId, assignmentId: sub.assignment_id, score },
  })

  // Calibration flywheel: persist the criterion-level diff between the AI draft the
  // professor reviewed and the ticks they committed — BEFORE the supersede flips the
  // suggestion's status. Only rubric-ticked commits carry a per-criterion signal; the
  // suggestionUpdatedAt guard inside skips capture when the draft was re-generated since
  // the page rendered. Best-effort (logs, never throws, never blocks the grade).
  if (rubricScores) {
    await captureGradingCorrections(access.adminDb, {
      submissionId,
      reviewedSuggestionUpdatedAt: suggestionUpdatedAt,
      committedRubricScores: rubricScores,
      graderId: userId,
      rubricVersion: parseAiGradingState(subAssignment.settings).embeddedAt ?? null,
    })
  }

  // The professor committed a real grade, so any AI suggestion for this submission is
  // spent — supersede it so it stops showing as pending. Awaited (not fire-and-forget):
  // a silent failure previously left the suggestion 'suggested', re-showing a stale draft
  // over the grade just saved. Best-effort inside the helper (logs, never throws).
  await supersedeAiSuggestions(access.adminDb, { submissionId }, 'graded')

  // Fold this grade into the student's topic mastery (best-effort, never throws).
  await applyGradeToSkillMastery({
    sectionId,
    studentId: sub.student_id,
    activityType: 'assignment',
    activityId: sub.assignment_id,
    pct: Number.isFinite(maxPoints) && maxPoints > 0 ? (score / maxPoints) * 100 : score,
    points: Number.isFinite(maxPoints) ? maxPoints : undefined,
  })
  // Authoritative reconcile of the whole section (handles re-grades / order /
  // config) in the background — coalesced, post-response.
  after(() => enqueueMasteryRecompute(sectionId))

  // Grades are NOT revealed to the student here — the professor publishes them
  // explicitly via publishGrades(), which is what notifies the student.

  revalidatePath(`/professor/courses/${sectionId}/assignments/${sub.assignment_id}`)
  return { success: true }
}

/**
 * Publish grades for an assignment: flip the assignment-level `settings.gradesPublished` flag so
 * students can finally see their score, feedback, and rubric breakdown. Grading is private until
 * this runs. Idempotent: if already published, it re-notifies nobody.
 */
export async function publishGrades(
  sectionId: string,
  assignmentId: string,
): Promise<{ error: string } | { success: true; released: number }> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to publish grades here." }
  }

  // Object-level authz: the assignment must belong to this section.
  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, title, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }

  const settings = (assignment.settings ?? {}) as Record<string, unknown>
  if (settings.gradesPublished === true) return { success: true, released: 0 } // already published

  // Key-scoped merge: patch only the gradesPublished flag/timestamp (see merge_assignment_settings)
  // so this can't clobber a concurrent settings write.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { gradesPublished: true, gradesPublishedAt: new Date().toISOString() },
  })

  if (error) {
    logger.error('publishGrades', error, { assignmentId })
    return { error: 'Could not publish grades. Please try again.' }
  }

  // Notify every student who has a graded submission (a notice, not a to-do).
  const { data: gradedRows } = await access.adminDb
    .from('assignment_submissions')
    .select('student_id')
    .eq('assignment_id', assignmentId)
    .eq('status', 'graded')
  const studentIds = ((gradedRows ?? []) as { student_id: string }[]).map((r) => r.student_id)

  if (studentIds.length > 0) {
    await emitEvent({
      type: 'assignment_graded',
      sectionId,
      actorId: userId,
      audience: studentIds,
      entity: { type: 'assignment', id: assignmentId },
      title: `Grade released: ${assignment.title}`,
      linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
      metadata: { assignment_id: assignmentId },
      // Re-notify on a grade re-release (e.g. a corrected grade): refresh re-surfaces the
      // notice past the one-shot dedup instead of silently swallowing the re-release.
      onDuplicate: 'refresh',
    })
  }

  await logEvent({
    userId,
    eventType: 'assignment.grades_published',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, released: studentIds.length },
  })

  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, released: studentIds.length }
}

/**
 * Withdraw a publish — hide released grades from students again.
 *
 * Publishing was a one-click, one-way door: the wrong assignment or a half-graded pile could
 * be released with no way back. This is the way back. It is NOT a full undo and does not
 * pretend to be: students who were notified stay notified, and anyone who already read their
 * score has seen it. What it does is stop the score, feedback and rubric being visible while
 * the professor fixes the mistake.
 */
export async function unpublishGrades(
  sectionId: string,
  assignmentId: string,
): Promise<{ error: string } | { success: true }> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to publish grades here." }
  }

  // Object-level authz: the assignment must belong to this section.
  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }

  const settings = (assignment.settings ?? {}) as Record<string, unknown>
  if (settings.gradesPublished !== true) return { success: true } // already hidden

  // Same key-scoped merge publishGrades uses, so this can't clobber a concurrent settings write.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { gradesPublished: false, gradesUnpublishedAt: new Date().toISOString() },
  })

  if (error) {
    logger.error('unpublishGrades', error, { assignmentId })
    return { error: 'Could not withdraw the grades. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.grades_unpublished',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })

  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Re-open a submitted/graded submission for changes. The student can then
 * resubmit. The feedback (the change request) is shown to the student.
 * Accepts an optional window; defaults to 24h when omitted so existing callers are unaffected.
 */
export async function requestChanges(
  sectionId: string,
  submissionId: string,
  feedback: string,
  window?: ReopenWindow,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  // Validate the optional window parameter.
  const windowParsed = reopenWindowSchema.safeParse(window)
  if (!windowParsed.success) return { error: 'Invalid reopen window.' }

  const { data: sub } = await access.adminDb
    .from('assignment_submissions')
    .select('id, assignment_id, student_id, assignment:assignments(section_id, title)')
    .eq('id', submissionId)
    .maybeSingle()
  const subAssignment = sub ? resolveJoin(sub.assignment) : null
  if (!sub || subAssignment?.section_id !== sectionId) return { error: 'Submission not found.' }

  const now = new Date()
  const resubmitUntil = resolveReopenUntil(windowParsed.data, now.getTime())
  const { error } = await access.adminDb
    .from('assignment_submissions')
    .update({
      status: 'returned',
      feedback: (feedback ?? '').slice(0, 10000),
      graded_at: null,
      resubmit_until: resubmitUntil,
      late_request_at: null,
      updated_at: now.toISOString(),
    })
    .eq('id', submissionId)

  if (error) {
    logger.error('requestChanges', error, { submissionId })
    return { error: 'Could not re-open the submission. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.changes_requested',
    eventCategory: 'course',
    sectionId,
    metadata: { submissionId, assignmentId: sub.assignment_id },
  })

  // Notify the student a resubmission is needed — an actionable to-do (cleared when
  // they resubmit) plus an immediate email (a time-sensitive "must" channel per the brief).
  await emitEvent({
    type: 'resubmit_requested',
    sectionId,
    actorId: userId,
    audience: [sub.student_id],
    entity: { type: 'assignment', id: sub.assignment_id },
    title: `Resubmission requested: ${subAssignment?.title ?? 'your assignment'}`,
    body: (feedback ?? '').trim().slice(0, 300) || null,
    linkUrl: `/student/courses/${sectionId}/assignments/${sub.assignment_id}`,
    actionable: true,
    metadata: { submission_id: submissionId },
    // Re-notify on a repeat change-request (round 2+): refresh re-surfaces the notice past the
    // one-shot dedup (the first request created the row and every later one was a no-op). The
    // dashboard to-do reopening also needs an is_done reset — tracked separately; the bell
    // notice + the immediate email below cover the student in the meantime.
    onDuplicate: 'refresh',
  })

  const { data: student } = await access.adminDb
    .from('profiles')
    .select('email, name')
    .eq('id', sub.student_id)
    .maybeSingle()
  if (student?.email) {
    void sendResubmissionRequested(student.email, student.name ?? 'there', {
      assignmentTitle: subAssignment?.title ?? 'your assignment',
      feedback: (feedback ?? '').trim() || null,
      link: `/student/courses/${sectionId}/assignments/${sub.assignment_id}`,
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments/${sub.assignment_id}`)
  return { success: true }
}

/** Edit an existing assignment's details (reuses the create form schema). */
export async function updateAssignment(
  sectionId: string,
  assignmentId: string,
  input: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings, status, title, due_at, description')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }

  const parsed = createAssignmentSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { title, instructions, dueAt, points, fileTypes, isGraded } = parsed.data

  // Key-scoped atomic merge: patch only settings.accepts (never clobber settings.pdf / rubric /
  // studio that other actions own), with the scalars on the same statement. Like updateAssignmentMeta,
  // ignore incoming points when a rubric exists — the rubric derives the total, and a stale edit
  // form must not overwrite it (which would then make the max-points guard reject full-rubric grades).
  const hasRubric = !!parseRubric(existing.settings)
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { accepts: { fileTypes } },
    p_cols: {
      title,
      description: instructions ?? '',
      submission_type: fileTypes.length > 0 ? 'files' : 'written',
      is_graded: isGraded,
      due_at: dueAt || null,
      ...(hasRubric ? {} : { points }),
    },
  })

  if (error) {
    logger.error('updateAssignment', error, { assignmentId })
    return { error: 'Could not save your changes. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, title },
  })

  // Notify enrolled students if this PUBLISHED assignment's due date or instructions changed.
  if (existing.status === 'published') {
    await emitContentChange({
      entityKind: 'assignment',
      sectionId,
      actorId: userId,
      entityId: assignmentId,
      title,
      linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
      oldDueAt: existing.due_at ?? null,
      newDueAt: dueAt || null,
      oldInstructions: existing.description ?? '',
      newInstructions: instructions ?? '',
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Edit just the due date + total points from the assignment detail header.
 * Touches only those two columns — leaves settings (PDF, rubric, schedule) intact.
 */
export async function updateAssignmentMeta(
  sectionId: string,
  assignmentId: string,
  input: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, status, title, due_at, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const parsed = updateAssignmentMetaSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { dueAt, points } = parsed.data

  // The rubric is the single source of the total. When one exists, saveAssignmentRubric owns
  // `points` (the sum of its criteria); the header points field is read-only, so ignore any
  // points a stale/crafted client sends here rather than clobbering the derived value.
  const hasRubric = !!parseRubric(existing.settings)
  const { error } = await access.adminDb
    .from('assignments')
    .update({
      due_at: dueAt || null,
      ...(hasRubric ? {} : { points }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', assignmentId)
  if (error) {
    logger.error('updateAssignmentMeta', error, { assignmentId })
    return { error: 'Could not save your changes. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, dueAt: dueAt ?? null, points: hasRubric ? undefined : points },
  })

  // Notify enrolled students if this PUBLISHED assignment's due date changed.
  if (existing.status === 'published') {
    await emitContentChange({
      entityKind: 'assignment',
      sectionId,
      actorId: userId,
      entityId: assignmentId,
      title: existing.title,
      linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
      oldDueAt: existing.due_at ?? null,
      newDueAt: dueAt || null,
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/** Save the assignment instructions (description) from the studio's supporting-files step. */
export async function saveAssignmentInstructions(
  sectionId: string,
  assignmentId: string,
  description: string,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, status, title, due_at, description')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const parsed = assignmentInstructionsSchema.safeParse({ description })
  if (!parsed.success) return { error: firstIssue(parsed.error) }

  const { error } = await access.adminDb
    .from('assignments')
    .update({ description: parsed.data.description, updated_at: new Date().toISOString() })
    .eq('id', assignmentId)
  if (error) {
    logger.error('saveAssignmentInstructions', error, { assignmentId })
    return { error: 'Could not save your instructions. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'instructions' },
  })

  // Notify enrolled students if this PUBLISHED assignment's instructions changed.
  if (existing.status === 'published') {
    await emitContentChange({
      entityKind: 'assignment',
      sectionId,
      actorId: userId,
      entityId: assignmentId,
      title: existing.title,
      linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
      oldDueAt: existing.due_at ?? null,
      newDueAt: existing.due_at ?? null,
      oldInstructions: existing.description ?? '',
      newInstructions: parsed.data.description,
    })
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Attach a PDF brief to the assignment. Stored in the section-readable `course-materials`
 * bucket so enrolled students can view it; the reference is appended to the `settings.pdfs`
 * array (a legacy single `settings.pdf` is migrated into it). Server-side via the admin
 * client after the staff check. Returns the full, updated PDF list.
 */
export async function uploadAssignmentPdf(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult<{ pdfs: AssignmentPdf[] }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const current = parseAssignmentPdfs(existing.settings)
  if (current.length >= MAX_ASSIGNMENT_PDFS) {
    return { error: `You can attach up to ${MAX_ASSIGNMENT_PDFS} PDFs.` }
  }

  const file = formData.get('pdf')
  if (!(file instanceof File) || file.size <= 0) return { error: 'Choose a PDF to upload.' }
  if (file.size > MAX_ASSIGNMENT_PDF_SIZE) return { error: 'That PDF is larger than 25 MB.' }
  const ext = file.name.split('.').pop()?.toLowerCase()
  const okMime = !file.type || file.type === 'application/pdf' || file.type === 'application/octet-stream'
  if (ext !== 'pdf' || !okMime) return { error: 'Upload a PDF file.' }

  const path = `${sectionId}/assignment-pdfs/${assignmentId}/${Date.now()}-${sanitizeFileName(file.name)}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await access.adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(path, buffer, { contentType: 'application/pdf', upsert: false })
  if (uploadError) {
    logger.error('uploadAssignmentPdf: upload failed', uploadError, { assignmentId, path })
    return { error: 'Could not upload the PDF. Please try again.' }
  }

  const pdfs = [...current, { path, name: file.name }]
  // Key-scoped merge: patch only settings.pdfs and drop the legacy single `pdf`, so a concurrent
  // rubric/studio autosave can't be clobbered (see merge_assignment_settings).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { pdfs },
    p_remove: ['pdf'],
  })
  if (error) {
    logger.error('uploadAssignmentPdf: update failed', error, { assignmentId })
    // Roll back the orphaned upload (best-effort) so storage doesn't drift from the row.
    await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove([path]).catch(() => undefined)
    return { error: 'Could not save the PDF. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.pdf_uploaded',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, pdfs }
}

/** Remove one PDF brief (by storage path) — file + settings reference. Returns the updated list. */
export async function removeAssignmentPdf(
  sectionId: string,
  assignmentId: string,
  path: string,
): Promise<ActionResult<{ pdfs: AssignmentPdf[] }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const current = parseAssignmentPdfs(existing.settings)
  const target = current.find((p) => p.path === path)
  const pdfs = current.filter((p) => p.path !== path)
  // Key-scoped merge: patch only settings.pdfs and drop the legacy single `pdf` (see
  // merge_assignment_settings) so a concurrent rubric/studio write is preserved.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { pdfs },
    p_remove: ['pdf'],
  })
  if (error) {
    logger.error('removeAssignmentPdf: update failed', error, { assignmentId })
    return { error: 'Could not remove the PDF. Please try again.' }
  }
  if (target?.path) {
    await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove([target.path]).catch(() => undefined)
  }

  await logEvent({
    userId,
    eventType: 'assignment.pdf_removed',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, pdfs }
}

/**
 * Attach a rubric-only PDF to the assignment. Stored in the `course-materials` bucket
 * under `assignment-rubric-sources/` — a path prefix that is NEVER signed or surfaced on
 * the student assignment page. The reference goes into `settings.rubricSources`, not
 * `settings.pdfs`, so it cannot leak through the existing PDF brief surfaces.
 * Returns the full updated rubricSources list.
 */
export async function uploadRubricSourcePdf(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult<{ rubricSources: AssignmentRubricSourceFile[]; answerKeySource?: AssignmentRubricSourceFile; warning?: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, institution_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const current = parseRubricSources(existing.settings)
  if (current.length >= MAX_ASSIGNMENT_PDFS) {
    return { error: `You can attach up to ${MAX_ASSIGNMENT_PDFS} rubric sources.` }
  }

  const file = formData.get('pdf')
  if (!(file instanceof File) || file.size <= 0) return { error: 'Choose a PDF to upload.' }
  if (file.size > MAX_ASSIGNMENT_PDF_SIZE) return { error: 'That PDF is larger than 25 MB.' }
  const ext = file.name.split('.').pop()?.toLowerCase()
  const okMime = !file.type || file.type === 'application/pdf' || file.type === 'application/octet-stream'
  if (ext !== 'pdf' || !okMime) return { error: 'Upload a PDF file.' }

  // Store under a distinct prefix so this path is never confused with student-visible briefs.
  const path = `${sectionId}/assignment-rubric-sources/${assignmentId}/${Date.now()}-${sanitizeFileName(file.name)}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await access.adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(path, buffer, { contentType: 'application/pdf', upsert: false })
  if (uploadError) {
    logger.error('uploadRubricSourcePdf: upload failed', uploadError, { assignmentId, path })
    return { error: 'Could not upload the PDF. Please try again.' }
  }

  const rubricSources = [...current, { path, name: file.name }]
  // Key-scoped merge: patch ONLY the keys this writer owns. This is the sharpest race in the
  // batch — uploading a rubric-source PDF and saving the rubric happen in the same panel, so a
  // full-blob write here would resurrect a deleted draft / drop the just-saved rubric (see
  // merge_assignment_settings). The answer-key POINTER no longer goes in settings (it leaked the
  // key's existence + filename to students via the full-row student SELECT) — it is persisted to
  // the staff-only assignment_answer_keys row below (BLOCKER #1).
  let answerKeyWarning: string | undefined
  const isAnswerKey = formData.get('answerKey') === '1'
  const answerKeySource: AssignmentRubricSourceFile | undefined = isAnswerKey
    ? { path, name: file.name }
    : undefined
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { rubricSources },
    p_remove: ['answerKeySource'],
  })
  if (error) {
    logger.error('uploadRubricSourcePdf: update failed', error, { assignmentId })
    await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove([path]).catch(() => undefined)
    return { error: 'Could not save the PDF. Please try again.' }
  }

  // Answer key: persist its source path/name to the staff-only row (source of truth for "is
  // there a key"), and parse it to text ONCE here (creation time) so the AI grader reads it
  // straight back instead of re-downloading + re-parsing every grading session. On a parse
  // failure the source is still stored with empty text so loadAnswerKeyText back-fills on
  // demand — it never blocks enabling AI grading.
  if (isAnswerKey) {
    let text = ''
    try {
      text = await parseAnswerKeyBuffer(buffer)
    } catch (err) {
      logger.warn('uploadRubricSourcePdf: answer-key pre-parse failed, will parse at grading', {
        source: 'uploadRubricSourcePdf',
        assignmentId,
        err: String(err),
      })
    }
    const { error: keyError } = await storeAnswerKeyText(access.adminDb, {
      assignmentId,
      institutionId: existing.institution_id,
      sectionId,
      sourcePath: path,
      sourceName: file.name,
      text,
    })
    /* SAY it rather than log it (#627). The PDF is in storage and settings.rubricSources
       points at it, so the upload genuinely succeeded — but the staff-only row that makes
       it usable as an answer key does not exist, and the AI grader reads that row, not the
       file. Reporting a clean success here is how a professor ends up grading against no
       answer key at all and only finding out through worse grades. */
    if (keyError) {
      answerKeyWarning =
        "The PDF uploaded, but saving it as the answer key didn't go through. AI grading won't use it until you upload it again."
    }
  }

  await logEvent({
    userId,
    eventType: 'assignment.rubric_source_uploaded',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, answerKey: isAnswerKey },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, rubricSources, ...(answerKeySource ? { answerKeySource } : {}), ...(answerKeyWarning ? { warning: answerKeyWarning } : {}) }
}

/** Remove one rubric-source PDF (by storage path) — file + settings reference.
 *  Returns the updated rubricSources list. */
export async function removeRubricSource(
  sectionId: string,
  assignmentId: string,
  path: string,
): Promise<ActionResult<{ rubricSources: AssignmentRubricSourceFile[] }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const current = parseRubricSources(existing.settings)
  const target = current.find((f) => f.path === path)
  const rubricSources = current.filter((f) => f.path !== path)
  // Key-scoped merge: patch ONLY settings.rubricSources so a concurrent rubric save is preserved.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { rubricSources },
  })
  if (error) {
    logger.error('removeRubricSource: update failed', error, { assignmentId })
    return { error: 'Could not remove the file. Please try again.' }
  }
  if (target?.path) {
    await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove([target.path]).catch(() => undefined)
  }

  await logEvent({
    userId,
    eventType: 'assignment.rubric_source_removed',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, rubricSources }
}

/**
 * Upload an attachment from the in-context Athena panel (PDF / PowerPoint / image, ≤25 MB)
 * into the section-readable `course-materials` bucket and reference it on the assignment
 * (same `settings.pdfs` list the "Add files & rubrics" step + student page already show).
 * Mirrors uploadAssignmentPdf's hardened path: staff check → object-ownership re-check →
 * type/size validation → upload → settings update (rollback on failure). Athena never
 * calls this; the professor picks the file — the client just forwards it here.
 */
export async function uploadAssignmentAttachment(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult<{ pdfs: AssignmentPdf[]; name: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const current = parseAssignmentPdfs(existing.settings)
  if (current.length >= MAX_ASSIGNMENT_PDFS) {
    return { error: `You can attach up to ${MAX_ASSIGNMENT_PDFS} files.` }
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return { error: 'Choose a file to upload.' }
  const check = validateAssignmentAttachment(file.name, file.size, file.type)
  if (!check.ok) return { error: check.error }

  const path = `${sectionId}/assignment-pdfs/${assignmentId}/${Date.now()}-${sanitizeFileName(file.name)}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await access.adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(path, buffer, { contentType: check.contentType, upsert: false })
  if (uploadError) {
    logger.error('uploadAssignmentAttachment: upload failed', uploadError, { assignmentId, path })
    return { error: 'Could not upload the file. Please try again.' }
  }

  const pdfs = [...current, { path, name: file.name }]
  // Key-scoped merge: patch only settings.pdfs and drop the legacy single `pdf` (see
  // merge_assignment_settings) so a concurrent rubric/studio write is preserved.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { pdfs },
    p_remove: ['pdf'],
  })
  if (error) {
    logger.error('uploadAssignmentAttachment: update failed', error, { assignmentId })
    await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove([path]).catch(() => undefined)
    return { error: 'Could not save the file. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.attachment_uploaded',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true, pdfs, name: file.name }
}

/**
 * Upload an image into the assignment's PUBLIC cell-images bucket and return its
 * stable public URL. The professor inserts the returned URL as `![alt](url)` into a
 * notebook/verbal cell; that reference is persisted in the doc and must resolve
 * everywhere it renders, including the offline HTML export (hence a public bucket —
 * see docs/designs/assignments-grading/assignment-studio-consolidated.md). Does not touch the doc itself;
 * autosave persists the inserted markdown. Server-side via the admin client after the
 * staff check; never trust a client-supplied path.
 */
export async function uploadCellImage(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult<{ url: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const file = formData.get('image')
  if (!(file instanceof File) || file.size <= 0) return { error: 'Choose an image to upload.' }
  if (file.size > MAX_CELL_IMAGE_SIZE) return { error: 'That image is larger than 5 MB.' }
  if (!CELL_IMAGE_MIME_TYPES.includes(file.type as (typeof CELL_IMAGE_MIME_TYPES)[number])) {
    return { error: 'Upload a PNG, JPEG, GIF, or WebP image.' }
  }

  const path = `${sectionId}/cell-images/${assignmentId}/${Date.now()}-${sanitizeFileName(file.name)}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await access.adminDb.storage
    .from(ASSIGNMENT_CELL_IMAGES_BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false })
  if (uploadError) {
    logger.error('uploadCellImage: upload failed', uploadError, { assignmentId, path })
    return { error: 'Could not upload the image. Please try again.' }
  }

  const { data: pub } = access.adminDb.storage.from(ASSIGNMENT_CELL_IMAGES_BUCKET).getPublicUrl(path)

  await logEvent({
    userId,
    eventType: 'assignment.cell_image_uploaded',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  return { success: true, url: pub.publicUrl }
}

// ── Module + skill tagging (settings.skillModules, rubric question skills) ──────────
// The assignment is tagged with ≥1 module on the "Add files & rubrics" step; those
// modules' skill pool is the ONLY source of per-question skill tags, and the first
// tagged module doubles as the roadmap placement. Compulsory (when the section has
// modules) for rubric generation/save and publish. Verbal assessments are exempt —
// they have no rubrics step.

const MODULE_TAG_REQUIRED_ERROR =
  'Tag at least one module first: skills are suggested from the tagged modules.'

/** The assignment's tagged modules (settings.skillModules ∩ section modules). ONLY an
 *  assignment that never went through tagging (no skillModules key at all) falls back to
 *  its current roadmap placement, so legacy assignments aren't dead-ended behind the
 *  compulsory-tagging gates. An explicit `skillModules: []` (professor untagged) sticks —
 *  never resurrect it from the edge (#553-2). `error` is set when the modules query
 *  itself failed: callers must fail closed (a transient DB error must not read as
 *  "this section has no modules" and waive the gates). */
async function resolveTaggedModules(
  adminDb: SupabaseClient,
  sectionId: string,
  assignmentId: string,
  settings: unknown,
): Promise<{ modules: Array<{ id: string; title: string; weekNumber: number | null }>; taggedIds: string[]; error?: string }> {
  const { data: mods, error: modsError } = await adminDb
    .from('modules')
    .select('id, title, week_number')
    .eq('section_id', sectionId)
    .order('position', { ascending: true })
  if (modsError) {
    logger.error('resolveTaggedModules: modules query failed', modsError, { sectionId, assignmentId })
    return { modules: [], taggedIds: [], error: 'Could not load the course modules. Please try again.' }
  }
  const modules = ((mods ?? []) as Array<{ id: string; title: string; week_number: number | null }>).map(
    (m) => ({ id: m.id, title: m.title, weekNumber: m.week_number }),
  )
  const valid = new Set(modules.map((m) => m.id))
  let taggedIds = parseSkillModules(settings).filter((id) => valid.has(id))
  if (!hasSkillModulesKey(settings)) {
    const { data: edge, error: edgeError } = await adminDb
      .from('roadmap_edges')
      .select('from_node_id')
      .eq('section_id', sectionId)
      .eq('from_node_type', 'module')
      .eq('to_node_type', 'assignment')
      .eq('to_node_id', assignmentId)
      .limit(1)
      .maybeSingle()
    if (edgeError) {
      logger.error('resolveTaggedModules: edge query failed', edgeError, { sectionId, assignmentId })
      return { modules: [], taggedIds: [], error: 'Could not load the course modules. Please try again.' }
    }
    if (edge?.from_node_id && valid.has(edge.from_node_id)) taggedIds = [edge.from_node_id]
  }
  return { modules, taggedIds }
}

/** Everything the rubric-step UI needs to render module + skill tagging in one round trip. */
export async function getAssignmentSkillTagging(
  sectionId: string,
  assignmentId: string,
): Promise<
  ActionResult<{
    modules: Array<{ id: string; title: string; weekNumber: number | null }>
    taggedIds: string[]
    skillOptions: Array<{ id: string; name: string }>
  }>
> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }

  const resolved = await resolveTaggedModules(access.adminDb, sectionId, assignmentId, assignment.settings)
  if (resolved.error) return { error: resolved.error }
  const { modules, taggedIds } = resolved
  // {id, name} only: getModuleSkillCandidates also carries a server-side embedding `context`.
  const skillOptions = (await getModuleSkillCandidates(access.adminDb, sectionId, taggedIds)).map((s) => ({ id: s.id, name: s.name }))
  return { success: true, modules, taggedIds, skillOptions }
}

/** Save the assignment's tagged modules (order preserved — the first one is the roadmap
 *  placement at publish). Returns the refreshed skill options for the new selection. */
export async function saveAssignmentSkillModules(
  sectionId: string,
  assignmentId: string,
  moduleIds: unknown,
): Promise<ActionResult<{ skillOptions: Array<{ id: string; name: string }> }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  if (!Array.isArray(moduleIds) || moduleIds.length > 50 || moduleIds.some((m) => typeof m !== 'string' || !m.trim())) {
    return { error: 'That module selection is not valid.' }
  }
  const requested = [...new Set(moduleIds as string[])]

  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }

  // Every id must be a module of THIS section (ids come from the client).
  if (requested.length) {
    const { data: mods } = await access.adminDb
      .from('modules')
      .select('id')
      .eq('section_id', sectionId)
      .in('id', requested)
    const valid = new Set(((mods ?? []) as Array<{ id: string }>).map((m) => m.id))
    if (requested.some((id) => !valid.has(id))) return { error: 'One of those modules is not in this course.' }
  }

  // Key-scoped merge: this panel sits on the same screen as the rubric editor's debounced
  // autosave, so a full-blob settings write here could clobber a just-saved rubricDraft
  // (see merge_assignment_settings).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { skillModules: requested },
  })
  if (error) {
    logger.error('saveAssignmentSkillModules: update failed', error, { assignmentId })
    return { error: 'Could not save the module tags. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'skillModules', count: requested.length },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)

  // {id, name} only: getModuleSkillCandidates also carries a server-side embedding `context`.
  const skillOptions = (await getModuleSkillCandidates(access.adminDb, sectionId, requested)).map((s) => ({ id: s.id, name: s.name }))
  return { success: true, skillOptions }
}

/**
 * Draft a Gradescope-style rubric using AI. The professor chooses the context via `source`:
 *  - `{ kind: 'content' }` — the assignment's own content: the studio notebook (cells + the full
 *    authoring pedagogy: points, difficulty, Bloom, concepts, hints, explanations, answer keys),
 *    or the Notion-style document. This is the default.
 *  - `{ kind: 'pdf', path }` — the text of one attached PDF brief.
 *  - `{ kind: 'rubric-source', path }` — a rubric-only uploaded file (settings.rubricSources);
 *    never signed or shown to students.
 * Reads everything server-side and returns the proposed rubric; does NOT save it (the professor
 * reviews/edits then calls saveAssignmentRubric). The AI never sees student work.
 */
export async function generateAssignmentRubric(
  sectionId: string,
  assignmentId: string,
  source?: RubricSource,
  targetPoints?: number,
): Promise<ActionResult<{ rubric: AssignmentRubric }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  // Institution/platform AI kill switch.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings, points')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }

  const settings = (assignment.settings ?? {}) as Record<string, unknown>
  const studioNotebook = (settings.studio as { notebook?: unknown } | undefined)?.notebook
  const document = parseAssignmentDocument(settings)
  const pdfs = parseAssignmentPdfs(settings)
  const rubricSources = parseRubricSources(settings)

  // Module tagging gates AI drafting: the tagged modules provide the candidate skill
  // pool the model tags each question from. Waived when the section has no modules.
  const tagging = await resolveTaggedModules(access.adminDb, sectionId, assignmentId, settings)
  if (tagging.error) return { error: tagging.error }
  const { modules: sectionModules, taggedIds } = tagging
  if (sectionModules.length > 0 && taggedIds.length === 0) return { error: MODULE_TAG_REQUIRED_ERROR }

  // Default: the assignment's own content when it has any, else the first attached PDF.
  const resolved: RubricSource =
    source ??
    (studioNotebook || document ? { kind: 'content' } : pdfs[0] ? { kind: 'pdf', path: pdfs[0].path } : { kind: 'content' })

  let text = ''
  if (resolved.kind === 'content') {
    if (studioNotebook) {
      const nb = parseNotebookModel(studioNotebook)
      text = nb ? studioNotebookToRubricText(nb) : ''
      if (!text.trim()) return { error: 'Add some content to the notebook before generating a rubric.' }
    } else if (document) {
      text = studioDocumentToRubricText(document.doc)
      if (!text.trim()) return { error: 'Add some content to the document before generating a rubric.' }
    } else {
      return { error: 'This assignment has no notebook or document content: attach a PDF to draft from it.' }
    }
  } else if (resolved.kind === 'rubric-source') {
    // IDOR guard: verify the path is actually in this assignment's rubricSources before downloading.
    const sourceFile = rubricSources.find((f) => f.path === resolved.path)
    if (!sourceFile) return { error: 'That file is no longer attached to this assignment.' }

    const { data: blob, error: dlError } = await access.adminDb.storage
      .from(COURSE_MATERIALS_BUCKET)
      .download(sourceFile.path)
    if (dlError || !blob) {
      logger.error('generateAssignmentRubric: rubric-source download failed', dlError, { assignmentId })
      return { error: 'Could not open that file.' }
    }

    try {
      const parsed = await parseDocument(Buffer.from(await blob.arrayBuffer()))
      text = getTextForLLM(parsed.pages, parsed.metadata)
    } catch (error) {
      logger.error('generateAssignmentRubric: rubric-source parse failed', error, { assignmentId })
      return { error: 'Could not read text from that PDF (it may be scanned images).' }
    }
    if (!text.trim()) {
      return { error: 'No text found in the PDF, a rubric needs a text-based PDF.' }
    }
  } else if (resolved.kind === 'answer-key') {
    // Answer keys are stored in rubricSources — same IDOR guard as the rubric-source branch.
    const sourceFile = rubricSources.find((f) => f.path === resolved.path)
    if (!sourceFile) return { error: 'That file is no longer attached to this assignment.' }

    const { data: blob, error: dlError } = await access.adminDb.storage
      .from(COURSE_MATERIALS_BUCKET)
      .download(sourceFile.path)
    if (dlError || !blob) {
      logger.error('generateAssignmentRubric: answer-key download failed', dlError, { assignmentId })
      return { error: 'Could not open that file.' }
    }

    try {
      const parsed = await parseDocument(Buffer.from(await blob.arrayBuffer()))
      text = getTextForLLM(parsed.pages, parsed.metadata)
    } catch (error) {
      logger.error('generateAssignmentRubric: answer-key parse failed', error, { assignmentId })
      return { error: 'Could not read text from that PDF (it may be scanned images).' }
    }
    if (!text.trim()) {
      return { error: 'No text found in the answer key PDF.' }
    }
  } else {
    // Validate the chosen PDF actually belongs to this assignment (never trust a client path).
    const pdf = pdfs.find((p) => p.path === resolved.path)
    if (!pdf) return { error: 'That PDF is no longer attached to this assignment.' }

    const { data: blob, error: dlError } = await access.adminDb.storage
      .from(COURSE_MATERIALS_BUCKET)
      .download(pdf.path)
    if (dlError || !blob) {
      logger.error('generateAssignmentRubric: download failed', dlError, { assignmentId })
      return { error: 'Could not open the assignment PDF.' }
    }

    try {
      const parsed = await parseDocument(Buffer.from(await blob.arrayBuffer()))
      text = getTextForLLM(parsed.pages, parsed.metadata)
    } catch (error) {
      logger.error('generateAssignmentRubric: parse failed', error, { assignmentId })
      return { error: 'Could not read text from that PDF (it may be scanned images).' }
    }
    if (!text.trim()) {
      return { error: 'No text found in the PDF, a rubric needs a text-based PDF.' }
    }
  }

  const skillOptions = await getModuleSkillCandidates(access.adminDb, sectionId, taggedIds)

  // The professor's chosen max score (#543) wins over the stored points; the saved rubric
  // re-derives the assignment total anyway. Out-of-range client values fall back silently —
  // this only steers the AI prompt, so there is nothing to protect beyond sanity bounds.
  const target =
    typeof targetPoints === 'number' && Number.isInteger(targetPoints) && targetPoints >= 1 && targetPoints <= 1000
      ? targetPoints
      : Number(assignment.points)
  // An answer key produces a rubric WITH per-criterion reference answers + keywords; every other
  // source produces the plain rubric (the model would hallucinate references with no key present).
  // BOTH passes also tag each question with skills from the tagged modules' pool (minting new
  // names when nothing fits), resolved to section skill ids below.
  const draft =
    resolved.kind === 'answer-key'
      ? await generateRubricFromAnswerKey(
          text,
          target,
          { sectionId, userId },
          skillOptions.map((s) => s.name),
        )
      : await generateRubricFromText(
          text,
          target,
          { sectionId, userId },
          skillOptions.map((s) => s.name),
        )
  if (!draft || draft.questions.length === 0) {
    return { error: 'Could not generate a rubric. Please try again or add one manually.' }
  }

  // Resolve model-emitted skill names into section skill tags. Names from the tagged
  // modules' pool resolve directly; genuinely new names are MINTED into the section
  // pool (junk-filtered + de-duped against the whole pool in ensureSectionSkills) so
  // the model can tag concepts the modules never taught.
  const pool = skillOptions.map((s) => ({ id: s.id, canonical: canonicalizeName(s.name) }))
  const nameById = new Map(skillOptions.map((s) => [s.id, s.name]))
  const unmatched = new Set<string>()
  for (const q of draft.questions) {
    for (const nm of q.skills ?? []) if (!matchInPool(nm, pool)) unmatched.add(nm)
  }
  const minted = unmatched.size
    ? await ensureSectionSkills(access.adminDb, sectionId, [...unmatched])
    : new Map<string, { id: string; name: string }>()
  const rubric: AssignmentRubric = {
    questions: draft.questions.map((q) => {
      // No candidates meant the model was never asked to tag (plain schema): omit the
      // skills key entirely so these questions stay in the similarity tier and get
      // retagged on a later save once the tagged modules gain skills. Writing skills: []
      // here would freeze them as a final "no tags" decision (#553-1 + #553-5).
      if (skillOptions.length === 0) {
        return { label: q.label, points: q.points, criteria: q.criteria }
      }
      const tags = new Map<string, string>()
      for (const nm of q.skills ?? []) {
        const id = matchInPool(nm, pool)
        if (id) {
          tags.set(id, nameById.get(id) ?? nm)
          continue
        }
        const created = minted.get(canonicalizeName(nm))
        if (created) tags.set(created.id, created.name)
      }
      return { label: q.label, points: q.points, criteria: q.criteria, skills: [...tags.entries()].map(([id, name]) => ({ id, name })) }
    }),
  }

  await logEvent({
    userId,
    eventType: 'assignment.rubric_generated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, questionCount: rubric.questions.length, source: resolved.kind, targetPoints: target },
  })
  return { success: true, rubric }
}

/** Save the professor-reviewed rubric onto the assignment (settings.rubric). Two-tier skill
 *  tagging: LLM-generated questions keep the generation call's tags exactly (sanitized against
 *  the section pool, never added to); hand-added questions (no skills field) get
 *  embedding-similarity tags above a calibrated bench, or none. Returns the rubric as saved. */
export async function saveAssignmentRubric(
  sectionId: string,
  assignmentId: string,
  rubricInput: unknown,
): Promise<
  ActionResult<{
    rubric: AssignmentRubric
    aiGrading?: { status: 'ready' | 'failed' | 'none'; refCount: number }
    points?: number
    /** Set when the rubric saved but its staff-only answer-key blob did not (#627). */
    warning?: string
  }>
> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  const parsed = assignmentRubricSchema.safeParse(rubricInput)
  if (!parsed.success) return { error: 'That rubric is not valid. Please check the points and labels.' }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, institution_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  // Per-question consistency: a question's criteria can't exceed that question's own points.
  const issues = rubricPointIssues(parsed.data.questions)
  if (issues.hasError) return { error: issues.perQuestion.find(Boolean) ?? 'Rubric points are invalid.' }

  // The rubric DEFINES the assignment total: sum of criteria over GRADED questions (100 fallback
  // when it carries no points). Graded-aware union of the two lineages — identical to the plain
  // criteria sum whenever no question is excluded, and excluded (graded===false) questions never
  // inflate the denominator.
  const derivedPoints = rubricTotalPoints(parsed.data.questions.filter((q) => isRubricQuestionGraded(q)))
  /* ONE ceiling check. #625 (AI grading) landed an equivalent one on main while this branch was
     open — `derivedPoints > 1000` with its own copy — so the merge briefly had two, the first
     making the second dead code and breaking this branch's test. Kept this version because it
     reads the shared MAX_ASSIGNMENT_POINTS instead of a second hardcoded 1000 (the drift the
     constant exists to prevent) and because it names the remedy, which is what #608 asked for.
     #625's graded-aware derivedPoints above is kept as-is — that part is a real improvement.

     Criterion points are unbounded in the rubric schema, but this derived total is written to
     assignments.points, which is capped. Left unchecked the write fails downstream and the
     professor is told "Could not save the rubric. Please try again." — a transient-sounding
     message for a validation problem, so retrying fails identically and nothing points at the
     offending field. Name the real cause here instead. */
  if (derivedPoints > MAX_ASSIGNMENT_POINTS) {
    return {
      error: `The rubric adds up to ${derivedPoints} points, over the ${MAX_ASSIGNMENT_POINTS} maximum for an assignment. Lower a criterion's points.`,
    }
  }

  // Compulsory module tagging (waived when the section has no modules).
  const tagging = await resolveTaggedModules(access.adminDb, sectionId, assignmentId, existing.settings)
  if (tagging.error) return { error: tagging.error }
  const { modules: sectionModules, taggedIds } = tagging
  if (sectionModules.length > 0 && taggedIds.length === 0) return { error: MODULE_TAG_REQUIRED_ERROR }

  // Sanitize skill tags — two-tier tagging rule:
  //   1. Questions that went through a rubric-generation LLM call carry a `skills` ARRAY
  //      (possibly empty). The LLM's decision is final: sanitize ids against the section
  //      pool (pool-wide, not module-wide, so generation-minted skills stay tagged) and
  //      never add to them. An empty array also covers "professor removed the tags".
  //   2. Hand-added questions carry NO skills field at all (the editors omit it on "Add
  //      question"). Those get embedding-similarity tags from the tagged modules' pool.
  //      Only a CONFIDENT result (≥1 tag above the bench) is persisted; below-bench,
  //      zero-candidate, and embed-failure outcomes all leave the key absent so the next
  //      save retries — persisting skills: [] here would read as a tier-1 final decision
  //      and permanently freeze the question out of retagging (#553-5).
  const { data: sectionSkillRows, error: sectionSkillsError } = await access.adminDb
    .from('skills')
    .select('id, name, excluded')
    .eq('section_id', sectionId)
  if (sectionSkillsError) {
    // Fail closed: proceeding with an empty map would silently strip every tier-1 tag
    // from the rubric we are about to persist.
    logger.error('saveAssignmentRubric: skills query failed', sectionSkillsError, { assignmentId })
    return { error: 'Could not save the rubric. Please try again.' }
  }
  const sectionSkillById = new Map(
    ((sectionSkillRows ?? []) as Array<{ id: string; name: string; excluded: boolean }>)
      .filter((s) => !s.excluded)
      .map((s) => [s.id, s.name]),
  )
  const untagged = parsed.data.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.skills === undefined)
  let simTags: Array<Array<{ id: string; name: string }> | null> = []
  if (untagged.length > 0) {
    const skillOptions = await getModuleSkillCandidates(access.adminDb, sectionId, taggedIds)
    simTags = await suggestSkillsBySimilarity(
      untagged.map(({ q }) => [q.label, ...q.criteria.map((c) => c.description)].join('\n')),
      skillOptions,
      { sectionId, userId },
    )
  }
  const simByIndex = new Map(untagged.map(({ i }, n) => [i, simTags[n] ?? null]))
  const questions = parsed.data.questions.map((q, i) => {
    const sim = simByIndex.get(i)
    // Embed failure (null) AND empty result (zero candidates / all below bench): keep the
    // question untagged — no skills key — so the next save retries similarity tagging
    // instead of freezing an empty decision (#553-5).
    if (sim === null || (sim && sim.length === 0)) return q
    if (sim) return { ...q, skills: sim.slice(0, MAX_SKILLS_PER_QUESTION) }
    const kept = new Map<string, string>()
    for (const t of q.skills ?? []) {
      const name = sectionSkillById.get(t.id)
      if (name) kept.set(t.id, name)
    }
    return { ...q, skills: [...kept.entries()].slice(0, MAX_SKILLS_PER_QUESTION).map(([id, name]) => ({ id, name })) }
  })
  // E1: enforce each question's points == its criteria sum. The grader awards CRITERION
  // points, so a question whose own points diverge silently caps the score (criteria <
  // points → a perfect answer can't reach full marks) or inflates it. Reconciling here
  // keeps gradedRubricTotal (which sums question.points, and is the grader's denominator)
  // exactly equal to what the grader can actually award.
  const rubric: AssignmentRubric = {
    questions: questions.map((q) => ({
      ...q,
      points: Math.round(q.criteria.reduce((s, c) => s + (c.points || 0), 0) * 100) / 100,
    })),
  }

  // BLOCKER #1: the answer-key AI fields (reference answers, keywords, scoring rules) must NOT
  // land in settings.rubric — the student RLS SELECT policy exposes settings as a full row and
  // Postgres can't mask JSONB sub-keys. Split the reconciled rubric into the PUBLIC rubric
  // (label/points/graded/skills only) for settings, and the AI blob for the staff-only
  // assignment_answer_keys.rubric_ai. The in-memory `rubric` (with AI fields) still feeds the
  // reference-vector sync below.
  const { publicRubric, rubricAi } = splitRubricAi(rubric)

  // Promote: patch in the approved (tagged) PUBLIC rubric and drop the autosaved draft, plus the
  // derived total. Key-scoped merge so a concurrent Publish-tab autosave can't drop the
  // rubric we just wrote (see merge_assignment_settings). answerKeySource is no longer stored in
  // settings (it moved to the staff-only row too) — drop any legacy copy on save.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { rubric: publicRubric },
    p_remove: ['rubricDraft', 'answerKeySource'],
    p_cols: { points: derivedPoints },
  })
  if (error) {
    logger.error('saveAssignmentRubric: update failed', error, { assignmentId })
    return { error: 'Could not save the rubric. Please try again.' }
  }

  // The rubric is now saved — nothing below may lose it (all best-effort). First persist the
  // answer-key AI fields to the staff-only row (BLOCKER #1): writes the APPROVED rubric_ai and
  // clears the now-stale draft AI, touching only those columns so the cached key text/source is
  // preserved. Uses the assignment's own institution_id so it never depends on the section fetch.
  const { error: rubricAiError } = await storeRubricAi(access.adminDb, {
    assignmentId,
    institutionId: existing.institution_id,
    sectionId,
    approved: rubricAi,
    clearDraft: true,
  })
  /* The public rubric is already saved at this point, deliberately — the surrounding
     comments choose "lose the AI fields, keep the rubric" over failing the whole save, and
     that trade-off stands. What changes is that the professor is told (#627). The lost data
     is the reference answers and scoring rules the AI grader depends on, so silence here
     degrades grading quality with no signal, which is far harder to notice than an error. */
  let rubricAiWarning: string | undefined
  if (rubricAiError) {
    logger.warn('saveAssignmentRubric: rubric_ai store failed', { source: 'saveAssignmentRubric', assignmentId, err: rubricAiError })
    rubricAiWarning =
      "The rubric saved, but its answer-key details didn't. AI grading will run without them until you save the rubric again."
  }

  // Then sync the AI-grading reference vectors (needs institution_id) and stamp settings.aiGrading
  // in a targeted write. Both best-effort: a failure degrades AI grading, never the rubric save.
  let aiGrading: { status: 'ready' | 'failed' | 'none'; refCount: number } | undefined
  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (section?.institution_id) {
    const syncResult = await syncRubricReferenceVectors({
      institutionId: section.institution_id,
      sectionId,
      assignmentId,
      rubric: parsed.data,
    })
    aiGrading = syncResult
    // Second write: stamp ONLY settings.aiGrading via the key-scoped merge — a peer write
    // landing between the two updates can no longer be clobbered.
    const { error: aiStampError } = await access.adminDb.rpc('merge_assignment_settings', {
      p_assignment_id: assignmentId,
      p_section_id: sectionId,
      p_patch: {
        aiGrading: { status: syncResult.status, refCount: syncResult.refCount, embeddedAt: new Date().toISOString() },
      },
    })
    if (aiStampError) {
      logger.warn('saveAssignmentRubric: aiGrading stamp failed', { source: 'saveAssignmentRubric', assignmentId, err: String(aiStampError) })
    }
  }

  // E7: supersede stale suggestions ONLY AFTER the reference vectors are re-synced, so the
  // professor's re-draft grades against the CURRENT answer-key vectors, not the old ones left
  // live in the gap. The rubric changed, so every old draft is stale regardless of sync outcome.
  await supersedeAiSuggestions(access.adminDb, { assignmentId }, 'rubric-changed')

  await logEvent({
    userId,
    eventType: 'assignment.rubric_saved',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, questionCount: rubric.questions.length, refCount: aiGrading?.refCount, aiGrading: aiGrading?.status, derivedPoints },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return {
    success: true,
    rubric,
    ...(aiGrading ? { aiGrading } : {}),
    points: derivedPoints,
    ...(rubricAiWarning ? { warning: rubricAiWarning } : {}),
  }
}

/**
 * Autosave the in-progress rubric to settings.rubricDraft so a generated/edited (but not yet
 * approved) rubric survives step navigation and leaving a draft assignment. Lenient validation
 * (a mid-edit draft may have blank fields or be over budget); the strict approval gate is
 * saveAssignmentRubric, which promotes the draft and clears it. Logs + revalidates like its
 * sibling saveStudioNotebook (a debounced autosave marker, not the meaningful approval event).
 */
export async function saveAssignmentRubricDraft(
  sectionId: string,
  assignmentId: string,
  rubricInput: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  const parsed = assignmentRubricDraftSchema.safeParse(rubricInput)
  if (!parsed.success) return { error: 'That rubric draft is not valid.' }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, institution_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  // BLOCKER #1: the draft carries the same answer-key AI fields, and settings.rubricDraft is in
  // the student-readable row — so split it too. The public draft goes to settings.rubricDraft;
  // its AI fields go to the staff-only assignment_answer_keys.rubric_ai_draft (isolated from the
  // approved rubric_ai the grader merges). splitRubricAi expects the strict type; the lenient
  // draft is structurally compatible for the split.
  const { publicRubric: publicDraft, rubricAi: draftAi } = splitRubricAi(parsed.data as AssignmentRubric)

  // Persist the draft AI to the staff-only row first (best-effort). A failure here must not lose
  // the public draft autosave below.
  const { error: draftAiError } = await storeRubricAi(access.adminDb, {
    assignmentId,
    institutionId: existing.institution_id,
    sectionId,
    draft: draftAi,
  })
  if (draftAiError) {
    /* Autosave only — a draft's AI fields are recoverable by editing again, and surfacing a
       toast on every debounced keystroke would be worse than the gap. Left as a log
       deliberately; the APPROVAL path above is the one that reports (#627). */
    logger.warn('saveAssignmentRubricDraft: rubric_ai_draft store failed', { source: 'saveAssignmentRubricDraft', assignmentId, err: draftAiError })
  }

  // Atomic key-scoped merge (see merge_assignment_settings): patch only rubricDraft (PUBLIC)
  // so a concurrent Publish-tab autosave can't clobber it (and vice versa).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { rubricDraft: publicDraft },
  })
  if (error) {
    logger.error('saveAssignmentRubricDraft: update failed', error, { assignmentId })
    return { error: 'Could not autosave the rubric draft.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'rubric.draft_autosave', questions: parsed.data.questions.length },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Discard the autosaved rubric draft (settings.rubricDraft), restoring the approved
 * rubric as what the editor shows. The escape hatch for a Generate (or edit session)
 * the professor doesn't want to keep — without it a stray draft outlived reloads and
 * made the saved, hand-curated rubric unreachable through the UI (#553-4).
 */
export async function discardAssignmentRubricDraft(
  sectionId: string,
  assignmentId: string,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  // Atomic key-scoped removal (see merge_assignment_settings): drops ONLY rubricDraft,
  // so the approved rubric and every other settings key are untouched.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: {},
    p_remove: ['rubricDraft'],
  })
  if (error) {
    logger.error('discardAssignmentRubricDraft: update failed', error, { assignmentId })
    return { error: 'Could not discard the draft. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'rubric.draft_discarded' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

// ── Notebook Studio (Milestone 2) ──────────────────────────────────────────
// The notebook lives in assignments.settings.studio (additive JSONB, no migration).
// Same auth sequence as every other action: session → verifySectionAccess (staff) →
// object-ownership → admin write → logEvent → revalidate. Never executes anything.

/** Create a draft assignment seeded with a template notebook, then open the studio on it. */
export async function createNotebookAssignment(
  sectionId: string,
  templateId: string,
  uploadedNotebook?: unknown,
  name?: string,
  questionCount?: number,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  let notebook
  let title: string
  let resolvedTemplateId: string | null
  if (templateId === 'upload') {
    // The uploaded .ipynb is untrusted external input: parse it, then re-validate the
    // whole doc against the schema (bounds on cells / source size / outputs) before storing.
    const parsed = parseNotebookModel(uploadedNotebook)
    if (!parsed) return { error: "That file isn't a valid .ipynb notebook." }
    const check = studioDocSchema.safeParse({ version: 1, templateId: 'upload', notebook: parsed })
    if (!check.success) return { error: 'That notebook is too large or malformed to import.' }
    notebook = check.data.notebook
    resolvedTemplateId = 'upload'
    title = 'Imported notebook'
    for (const c of notebook.cells) {
      if (c.cell_type === 'markdown') {
        const m = c.source.match(/^#{1,6}\s+(.+)$/m)
        if (m) { title = m[1].trim().slice(0, 120); break }
      }
    }
  } else {
    const template = getNotebookTemplate(templateId)
    notebook = template ? template.build({ questionCount }) : emptyNotebook()
    title = template ? template.title : 'Untitled notebook'
    resolvedTemplateId = template?.id ?? null
  }
  // A professor-supplied name (entered before picking a template) always wins.
  if (name?.trim()) title = name.trim().slice(0, 120)
  const doc = { version: 1, templateId: resolvedTemplateId, notebook }

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title,
      description: '',
      submission_type: 'files',
      status: 'draft',
      points: 100,
      is_graded: true,
      settings: { kind: 'notebook', studio: doc, accepts: { fileTypes: ['zip'] } },
      due_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('createNotebookAssignment', error, { sectionId, templateId })
    return { error: 'Could not create the notebook. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, title, kind: 'notebook', templateId: resolvedTemplateId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

const WOLFRAM_TOOLS: WolframTool[] = ['solve', 'worked', 'simplify', 'physics', 'plot', 'snapshot']

/**
 * Generate a maths/physics solution from the Solver for a studio cell. Read-only external
 * compute (no DB write) — the professor inserts the returned text/image into the notebook, which
 * autosaves through the vetted saveStudioNotebook path. Gated to section staff so the AppID (a
 * server-only secret) is never callable by students or other tenants.
 */
export async function generateWolframSolution(
  sectionId: string,
  tool: WolframTool,
  query: string,
): Promise<ActionResult<WolframOutput>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that here." }
  }

  // Institution/platform AI kill switch — Wolfram is a paid external AI service.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  if (!WOLFRAM_TOOLS.includes(tool)) return { error: 'Unknown tool.' }
  const q = query.trim()
  if (!q) return { error: 'Enter an expression or question first.' }
  if (q.length > 500) return { error: 'That query is too long (500 characters max).' }

  try {
    const out = await runWolfram(tool, q)
    // Solver images — both the standalone plot/snapshot imageUrl AND images embedded in the
    // worked-solution markdown (![Plot](url)) — come back as temporary Wolfram MSP URLs that
    // expire and often won't hotlink, breaking saved templates + the student view. Copy each into
    // our public cell-images bucket and swap in a permanent URL. Best-effort: fall back to source.
    let imgSeq = 0
    const persistImage = async (srcUrl: string): Promise<string | null> => {
      try {
        const res = await fetch(srcUrl, { signal: AbortSignal.timeout(20000) })
        if (!res.ok) return null
        const contentType = res.headers.get('content-type') ?? 'image/gif'
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length === 0 || buffer.length > MAX_CELL_IMAGE_SIZE) return null
        const ext = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'gif'
        const path = `${sectionId}/cell-images/solver/${Date.now()}-${imgSeq++}.${ext}`
        const { error: upErr } = await access.adminDb.storage
          .from(ASSIGNMENT_CELL_IMAGES_BUCKET)
          .upload(path, buffer, { contentType, upsert: false })
        if (upErr) {
          logger.error('generateWolframSolution: image persist failed', upErr, { sectionId })
          return null
        }
        const { data: pub } = access.adminDb.storage.from(ASSIGNMENT_CELL_IMAGES_BUCKET).getPublicUrl(path)
        return pub?.publicUrl ?? null
      } catch (imgErr) {
        logger.warn('generateWolframSolution: image persist skipped', { sectionId, reason: String(imgErr) })
        return null
      }
    }

    if (out.imageUrl) {
      const persisted = await persistImage(out.imageUrl)
      if (persisted) out.imageUrl = persisted
    }
    if (out.markdown) {
      const srcUrls = [...new Set([...out.markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))]
      for (const src of srcUrls) {
        const persisted = await persistImage(src)
        if (persisted) out.markdown = out.markdown.split(src).join(persisted)
      }
    }
    return { success: true, ...out }
  } catch (error) {
    logger.error('generateWolframSolution', error, { sectionId, tool })
    return { error: 'The solver could not answer that. Try rephrasing the expression.' }
  }
}

/**
 * Clone one of the professor's OWN prior assignments into a fresh draft in the target section —
 * the "template history" reuse path. Authz: staff on the target section, and the source must be
 * created_by the same user (you can only reuse your own templates), which also blocks IDOR.
 */
export async function cloneStudioAssignment(
  sectionId: string,
  sourceId: string,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  const { data: source } = await access.adminDb
    .from('assignments')
    .select('title, settings, submission_type, points, is_graded, created_by')
    .eq('id', sourceId)
    .maybeSingle()
  if (!source) return { error: 'That template no longer exists.' }
  if (source.created_by !== userId) return { error: 'You can only reuse templates you created.' }

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const title = `Copy of ${source.title}`.slice(0, 120)
  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title,
      description: '',
      submission_type: source.submission_type ?? 'files',
      status: 'draft',
      points: source.points ?? 100,
      is_graded: source.is_graded ?? true,
      settings: source.settings ?? {},
      due_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('cloneStudioAssignment', error, { sectionId, sourceId })
    return { error: 'Could not create the assignment from that template. Please try again.' }
  }

  // The settings blob we just copied carries the SOURCE's storage paths. Left as-is, the clone and
  // the original would share the same objects, and removeAssignmentPdf/removeRubricSource hard-
  // delete by path — so deleting a file on the clone would 404 the live original for every
  // enrolled student. Give the clone its own copies and repoint its settings at them. A copy that
  // fails is dropped from the clone rather than left pointing at the source's object.
  const copyInto = async (
    files: { path: string; name: string }[],
    prefix: 'assignment-pdfs' | 'assignment-rubric-sources',
  ) => {
    const copied: { path: string; name: string }[] = []
    for (const [i, f] of files.entries()) {
      // Index in the key: two files copied inside the same millisecond would otherwise collide and
      // the second upload would be silently dropped.
      const to = `${sectionId}/${prefix}/${data.id}/${Date.now()}-${i}-${sanitizeFileName(f.name)}`
      const { error: copyError } = await access.adminDb.storage
        .from(COURSE_MATERIALS_BUCKET)
        .copy(f.path, to)
      if (copyError) {
        logger.warn('cloneStudioAssignment: could not copy template file', {
          sourceId,
          assignmentId: data.id,
          from: f.path,
        })
        continue
      }
      copied.push({ path: to, name: f.name })
    }
    return copied
  }

  const sourcePdfs = parseAssignmentPdfs(source.settings)
  const sourceRubricSources = parseRubricSources(source.settings)
  if (sourcePdfs.length > 0 || sourceRubricSources.length > 0) {
    const pdfs = await copyInto(sourcePdfs, 'assignment-pdfs')
    const rubricSources = await copyInto(sourceRubricSources, 'assignment-rubric-sources')
    const { error: repointError } = await access.adminDb.rpc('merge_assignment_settings', {
      p_assignment_id: data.id,
      p_section_id: sectionId,
      p_patch: { pdfs, rubricSources },
      // Drop the legacy single `pdf` key so it can't keep pointing at the source's object.
      p_remove: ['pdf'],
    })
    if (repointError) {
      // Failing closed: a clone still pointing at the source's files is the data-loss case, so
      // delete the draft rather than hand back a booby-trapped copy. Remove the copies too — they
      // belong to a row that is about to stop existing. Only the CLONE's own paths are removed
      // here, never the source's.
      logger.error('cloneStudioAssignment: could not repoint copied files', repointError, {
        assignmentId: data.id,
      })
      const orphaned = [...pdfs, ...rubricSources].map((f) => f.path)
      if (orphaned.length > 0) {
        await access.adminDb.storage.from(COURSE_MATERIALS_BUCKET).remove(orphaned).catch(() => undefined)
      }
      await access.adminDb.from('assignments').delete().eq('id', data.id)
      return { error: 'Could not create the assignment from that template. Please try again.' }
    }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, title, clonedFrom: sourceId },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

/** Persist the edited notebook (autosave) into settings.studio — never clobbers peers. */
export async function saveStudioNotebook(
  sectionId: string,
  assignmentId: string,
  docInput: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this notebook." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const parsed = studioDocSchema.safeParse(docInput)
  if (!parsed.success) return { error: 'That notebook could not be saved.' }

  // Key-scoped atomic merge: this is the highest-frequency studio autosave, so a concurrent
  // Publish-tab autosave (accepts/assessment) must not be clobbered by a stale settings snapshot
  // read here — patch only settings.studio (see merge_assignment_settings).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { studio: parsed.data },
  })

  if (error) {
    logger.error('saveStudioNotebook', error, { assignmentId })
    return { error: 'Could not save your notebook. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'notebook.autosave', cells: parsed.data.notebook.cells.length },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/studio`)
  return { success: true }
}

/**
 * Toggle whether the current professor has saved a marketplace template. `saved` is the desired
 * end state, so the op is idempotent (no read-decide-write race on double-click). Writes go
 * through the admin client because saved_templates is RLS SELECT-only — there is no client
 * write path. template_id is a built-in id ('ml-assignment') or a past assignment's uuid.
 */
export async function setTemplateSaved(
  sectionId: string,
  templateId: string,
  saved: boolean,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to save templates here." }
  }

  const id = templateId.trim()
  if (!id || id.length > 128) return { error: 'That template could not be found.' }

  if (saved) {
    const { data: section } = await access.adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section) return { error: 'Course section not found.' }

    const { error } = await access.adminDb
      .from('saved_templates')
      .upsert(
        { user_id: userId, institution_id: section.institution_id, template_id: id },
        { onConflict: 'user_id,template_id', ignoreDuplicates: true },
      )
    if (error) {
      logger.error('setTemplateSaved.save', error, { userId, templateId: id })
      return { error: 'Could not save the template. Please try again.' }
    }
  } else {
    const { error } = await access.adminDb
      .from('saved_templates')
      .delete()
      .eq('user_id', userId)
      .eq('template_id', id)
    if (error) {
      logger.error('setTemplateSaved.unsave', error, { userId, templateId: id })
      return { error: 'Could not remove the template. Please try again.' }
    }
  }

  await logEvent({
    userId,
    eventType: saved ? 'assignment_template.saved' : 'assignment_template.unsaved',
    eventCategory: 'course',
    sectionId,
    metadata: { templateId: id },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/new`)
  return { success: true }
}

/**
 * Create a Notion-style DOCUMENT assignment (the "Blank" template). Unlike the notebook
 * studio it has no cells — the professor writes a free-form rich-text document, stored at
 * `settings.document`. Opens straight into the document studio.
 */
export async function createDocumentAssignment(
  sectionId: string,
  name?: string,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const title = name?.trim() ? name.trim().slice(0, 120) : 'Untitled document'
  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title,
      description: '',
      submission_type: 'written',
      status: 'draft',
      points: 100,
      is_graded: true,
      // Empty file-type list ⇒ students get the written-response box; the professor can add
      // file submissions at publish. `document` holds the authored rich-text content.
      settings: { kind: 'document', document: emptyAssignmentDocument(), accepts: { fileTypes: [] } },
      due_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('createDocumentAssignment', error, { sectionId })
    return { error: 'Could not create the document. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, title, status: 'draft', kind: 'document' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

/**
 * Create a File Upload assignment that opens into the guided file-upload studio.
 * Unlike the wizard path this inserts a draft immediately and redirects into the studio
 * where the professor sets files, rubric, and publish settings (no document content).
 */
export async function createFileUploadAssignment(
  sectionId: string,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title: 'Untitled assignment',
      description: '',
      submission_type: 'files',
      status: 'draft',
      points: 100,
      is_graded: true,
      settings: { kind: 'file-upload', accepts: { fileTypes: [] } },
      due_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('createFileUploadAssignment', error, { sectionId })
    return { error: 'Could not create the assignment. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, title: 'Untitled assignment', status: 'draft', kind: 'file-upload' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

/** Autosave the document assignment's rich-text content to `settings.document`. */
export async function saveAssignmentDocument(
  sectionId: string,
  assignmentId: string,
  docInput: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this document." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const parsed = assignmentDocumentSchema.safeParse(docInput)
  if (!parsed.success) return { error: 'That document could not be saved.' }

  // Key-scoped atomic merge: document autosave is high-frequency and shares the studio flow with
  // the Publish-tab autosave, so patch only settings.document — a stale full-blob write here would
  // otherwise revert a concurrent accepts/assessment patch (see merge_assignment_settings).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { document: parsed.data },
  })

  if (error) {
    logger.error('saveAssignmentDocument', error, { assignmentId })
    return { error: 'Could not save your document. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'document.autosave' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/studio`)
  return { success: true }
}

/**
 * SEAM (inert): suggest reference links for the studio Resources panel from the professor's
 * concept tags (e.g. "pytorch" -> the PyTorch docs). Athena (Harshil) wires the real model
 * call here; for now it returns no suggestions so the UI shows the "coming soon" state.
 * Read-only, so no DB write / logEvent / revalidate — just authenticate + authorize.
 */
export async function suggestResourceLinks(
  sectionId: string,
  tags: string[],
): Promise<{ links: { label: string; url: string }[]; note?: string } | { error: string }> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this notebook." }
  }

  // Inert seam: Athena will turn `tags` into suggested links here.
  void tags
  return { links: [], note: 'AI link suggestions are coming soon.' }
}

/**
 * Publish (or schedule) a studio assignment from the fixed Publish dialog — sets the
 * submission deadline + allowed file types and flips status. Updates the existing draft.
 */
export async function publishStudioAssignment(
  sectionId: string,
  assignmentId: string,
  input: unknown,
  publish: boolean,
): Promise<ActionResult<{ placed: boolean }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to publish this assignment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, title, status, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }
  const existingSettings = (existing.settings ?? {}) as Record<string, unknown>

  const parsed = publishSettingsSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { dueAt, fileTypes, scheduleAt, assessment, isGraded, pickerModuleId } = parsed.data

  const { status, scheduledPublishAt } = resolvePublishState(scheduleAt, publish)

  // Compulsory module tagging before anything goes live (client gate mirrored server-side).
  // Waived for verbal assessments (no rubrics step) and zero-module sections. Dual predicate:
  // legacy verbal rows lack settings.kind and carry only settings.verbalAssessment.
  // The FIRST tagged module is also the roadmap placement, written server-side below —
  // resolved here (fresh) rather than trusted from a client mount-time snapshot (#553-3).
  const isVerbal = existingSettings.kind === 'verbal' || !!existingSettings.verbalAssessment
  let placementModuleId: string | null = null
  if (!isVerbal) {
    const tagging = await resolveTaggedModules(access.adminDb, sectionId, assignmentId, existingSettings)
    if (tagging.error) return { error: tagging.error }
    if (tagging.modules.length > 0 && tagging.taggedIds.length === 0) {
      return { error: 'Tag at least one module in the Add files & rubrics step before publishing.' }
    }
    placementModuleId = tagging.taggedIds[0] ?? null
  } else if (pickerModuleId) {
    // Picker mode (verbal): the module id comes from the client — verify it is this
    // section's before writing the edge (mirrors setResourcePlacement's endpoint check).
    const { data: mod } = await access.adminDb
      .from('modules')
      .select('id')
      .eq('id', pickerModuleId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!mod) return { error: 'That module is not in this course.' }
    placementModuleId = pickerModuleId
  }
  const publishedStamp = status === 'published' ? new Date().toISOString() : null

  // Key-scoped atomic merge (see merge_assignment_settings): patch only accepts + assessment;
  // a concurrent Rubrics-tab autosave keeps its keys. NOTE: points is intentionally NOT written
  // here — the rubric is the single source of the total (saveAssignmentRubric owns it), so a
  // stale Publish payload can't overwrite the derived value.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { accepts: { fileTypes }, ...(assessment ? { assessment } : {}) },
    p_cols: {
      submission_type: fileTypes.length > 0 ? 'files' : 'written',
      due_at: dueAt || null,
      status,
      scheduled_publish_at: scheduledPublishAt,
      // Immediate publish notifies inline (below); stamp so the deferred sweep skips it.
      // A SCHEDULED publish stays draft with this NULL — the sweep notifies when pg_cron
      // flips it live at the scheduled time.
      published_at: publishedStamp,
      publish_notified_at: publishedStamp,
      // Graded flag is optional: only include when the dialog provides it.
      ...(isGraded !== undefined ? { is_graded: isGraded } : {}),
    },
  })

  if (error) {
    logger.error('publishStudioAssignment', error, { assignmentId })
    return { error: 'Could not publish. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: status === 'published' ? 'assignment.published' : 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, status, kind: 'studio.publish' },
  })

  // Roadmap placement, atomically upserted server-side in the same action as the publish
  // write (place_roadmap_edge RPC) — no client round trip, no stale snapshot, and it runs
  // under this action's staff gate (a TA's publish no longer strands an unplaced
  // assignment). Scheduled publishes place now too: draft-time edges are already the norm
  // (the create wizards place on creation) and the student roadmap filters on status.
  // A placement failure is reported but never unpublishes — the assignment itself is live
  // and correct; the professor can place it from the roadmap.
  let placed = true
  if (placementModuleId) {
    placed = await writePlacementEdge(access.adminDb, sectionId, 'assignment', assignmentId, placementModuleId)
    if (placed) {
      revalidatePath(`/professor/courses/${sectionId}/roadmap`)
      revalidatePath(`/student/courses/${sectionId}/roadmap`)
    }
  }

  // Immediate publish → notify enrolled students NOW (mirrors createAssignment /
  // setAssignmentStatus); only a scheduled publish is left to the sweep. Re-saving an
  // ALREADY-published assignment (editing it live in the studio) sends a "changed"
  // notice instead of re-announcing it as new — consistent with publishQuiz. A first
  // publish or an unpublish→republish (existing.status !== 'published') re-announces.
  if (status === 'published') {
    if (existing.status === 'published') {
      await emitEvent({
        type: 'assignment_updated',
        sectionId,
        actorId: userId,
        entity: { type: 'assignment', id: assignmentId },
        title: `Assignment updated: ${existing.title}`,
        body: 'This assignment was updated — check the latest.',
        linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
        actionable: false,
        dueAt: dueAt || null,
        onDuplicate: 'refresh',
      })
    } else {
      await emitEvent({
        type: 'assignment_published',
        sectionId,
        actorId: userId,
        entity: { type: 'assignment', id: assignmentId },
        title: `New assignment: ${existing.title}`,
        linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
        actionable: true,
        dueAt: dueAt || null,
        // Re-announce on every publish (e.g. unpublish → republish), not once forever.
        onDuplicate: 'refresh',
      })
    }
  }

  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/studio`)
  return { success: true, placed }
}

// ── Verbal Assessment (AI-led spoken Q&A; professor grades) ─────────────────
// Config lives in assignments.settings.verbalAssessment (JSONB, no migration).
// TTS for fixed questions is generated ONCE and cached in course-materials, then
// served to every student (no per-student TTS for fixed questions).

/** Create a draft Verbal Assessment seeded from a preset (or the default), then open the editor. */
export async function createVerbalAssessment(
  sectionId: string,
  templateId?: string,
  name?: string,
): Promise<ActionResult<{ assignmentId: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to create assignments here." }
  }

  const entitlement = await checkEntitlementBySection(access.adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section) return { error: 'Course section not found.' }

  const template = templateId ? getVerbalTemplate(templateId) : null
  const config = template ? template.build() : defaultVerbalAssessment()

  const { data, error } = await access.adminDb
    .from('assignments')
    .insert({
      section_id: sectionId,
      institution_id: section.institution_id,
      created_by: userId,
      title: name?.trim() ? name.trim().slice(0, 120) : 'Verbal Assessment',
      description: '',
      submission_type: 'files',
      status: 'draft',
      points: 100,
      is_graded: true,
      settings: { kind: 'verbal', verbalAssessment: config, verbalTemplateId: template?.id ?? null },
      due_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('createVerbalAssessment', error, { sectionId, templateId })
    return { error: 'Could not create the assessment. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.created',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId: data.id, kind: 'verbal-assessment', templateId: template?.id ?? null },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  return { success: true, assignmentId: data.id }
}

/** Autosave the Verbal Assessment config (interview, voice, settings, questions). */
export async function saveVerbalAssessment(
  sectionId: string,
  assignmentId: string,
  input: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assessment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const parsed = verbalAssessmentSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }

  // Key-scoped merge: patch only settings.verbalAssessment (see merge_assignment_settings).
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { verbalAssessment: parsed.data },
  })

  if (error) {
    logger.error('saveVerbalAssessment', error, { assignmentId })
    return { error: 'Could not save. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'verbal-assessment.autosave' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/verbal`)
  return { success: true }
}

/**
 * Generate (once) and cache the TTS audio for a FIXED question, then store its path on the
 * config. Cached in course-materials (section-readable) so every student gets the same file.
 */
export async function generateVerbalQuestionAudio(
  sectionId: string,
  assignmentId: string,
  questionId: string,
): Promise<ActionResult<{ audioPath: string; audioUrl: string | null }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assessment." }
  }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const existingSettings = (existing.settings ?? {}) as Record<string, unknown>
  const config = verbalAssessmentSchema.safeParse(existingSettings.verbalAssessment)
  if (!config.success) return { error: 'This assessment is not set up yet.' }

  const cell = config.data.cells.find((c) => c.id === questionId)
  if (!cell) return { error: 'Question not found.' }
  if (cell.type !== 'question' && cell.type !== 'mcq') {
    return { error: 'Only question or MCQ cells can have cached audio.' }
  }
  if (!cell.prompt.trim()) return { error: 'Add the question text before generating audio.' }

  // Institution/platform AI kill switch — TTS is an AI service.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  const tts = await synthesizeSpeech(cell.prompt, config.data.voiceId, { sectionId, userId })
  if (!tts.ok) return { error: tts.error }

  const path = `${sectionId}/verbal-questions/${assignmentId}/${questionId}.mp3`
  const { error: uploadError } = await access.adminDb.storage
    .from(COURSE_MATERIALS_BUCKET)
    .upload(path, tts.audio, { contentType: tts.contentType, upsert: true })
  if (uploadError) {
    logger.error('generateVerbalQuestionAudio.upload', uploadError, { assignmentId, questionId })
    return { error: 'Could not save the generated audio. Please try again.' }
  }

  const nextConfig = {
    ...config.data,
    cells: config.data.cells.map((c) => (c.id === questionId ? { ...c, audioPath: path } : c)),
  }
  // Key-scoped merge: patch only settings.verbalAssessment (see merge_assignment_settings).
  const { error: saveError } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { verbalAssessment: nextConfig },
  })
  if (saveError) {
    logger.error('generateVerbalQuestionAudio.save', saveError, { assignmentId })
    return { error: 'Audio was generated but could not be linked. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'verbal-assessment.audio', questionId },
  })

  const audioUrl = await signOne(COURSE_MATERIALS_BUCKET, path)
  return { success: true, audioPath: path, audioUrl }
}

/** Rename the assignment from the studio top bar (title only). */
export async function renameAssignment(
  sectionId: string,
  assignmentId: string,
  titleInput: unknown,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to rename this." }
  }

  const title = typeof titleInput === 'string' ? titleInput.trim() : ''
  if (!title || title.length > 200) return { error: 'Enter a title (up to 200 characters).' }

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  const { error } = await access.adminDb
    .from('assignments')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', assignmentId)

  if (error) {
    logger.error('renameAssignment', error, { assignmentId })
    return { error: 'Could not rename. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, title, kind: 'rename' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/studio`)
  return { success: true }
}

/** Generate reference links from concept tags using AI. Returns up to 4 link suggestions. */
export async function generateReferenceLinks(
  sectionId: string,
  conceptTags: string[],
): Promise<{ error: string } | { links: { label: string; url: string }[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) return { error: 'Access denied.' }

  // Institution/platform AI kill switch.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  if (!conceptTags.length) return { links: [] }

  try {
    const { text, usage } = await generateText({
      model: google('gemini-3-flash-preview'),
      prompt: `You are helping a professor find reference links for an assignment. Given these concept tags: ${conceptTags.join(', ')}

Return a JSON array of up to 4 relevant reference links. Use real, stable URLs (Wikipedia, Khan Academy, official docs, or well-known educational sites). Format:
[{"label": "Title", "url": "https://..."}]

Only return the JSON array, no other text.`,
    })

    void recordAiUsage({
      feature: 'reference_links',
      model: 'gemini-3-flash-preview',
      sectionId,
      userId: user.id,
      usage: {
        inputTokens: usage?.inputTokens,
        cachedInputTokens: usage?.cachedInputTokens,
        outputTokens: usage?.outputTokens,
        reasoningTokens: usage?.reasoningTokens,
      },
    })

    const raw = text.trim().replace(/^```json\s*/, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { links: [] }
    const links = parsed
      .filter((x): x is { label: string; url: string } =>
        x && typeof x.label === 'string' && typeof x.url === 'string' && x.url.startsWith('http'))
      .slice(0, 4)
    return { links }
  } catch {
    return { error: 'Could not generate links. Please try again.' }
  }
}

// ── Regrade requests + per-subquestion comments (staff side) ─────
// The score itself changes (or not) beforehand via the existing gradeSubmission() → Save grade;
// resolveRegradeRequest only marks the appeal resolved and snapshots the resulting score. The
// regrade row is an audit log of the appeal, never a source of truth for the score.

/** Staff resolves a student's open regrade request (after re-grading through gradeSubmission). */
export async function resolveRegradeRequest(
  sectionId: string,
  requestId: string,
  resolutionNote?: string,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* Score/feedback write — canGrade admits graders (#746). */
  if (!access.ok || !canGrade(access.role)) {
    return { error: "You don't have permission to resolve regrades here." }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = access.adminDb as any
  const { data: req } = await db
    .from('assignment_regrade_requests')
    .select('id, section_id, student_id, assignment_id, status, submission:assignment_submissions(score), assignment:assignments(title)')
    .eq('id', requestId)
    .maybeSingle()
  if (!req || req.section_id !== sectionId) return { error: 'Regrade request not found.' }

  const newScore = resolveJoin(req.submission)?.score ?? null
  const assignmentTitle = resolveJoin(req.assignment)?.title ?? 'your assignment'
  const note = (resolutionNote ?? '').slice(0, 5000)

  // Guarded transition: only an OPEN request flips to resolved (two TAs can't both resolve it).
  const { data: updated } = await db
    .from('assignment_regrade_requests')
    .update({
      status: 'resolved',
      new_score: newScore,
      resolution_note: note,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'open')
    .select('id')
  if (!updated || updated.length === 0) return { error: 'This request was already resolved.' }

  await logEvent({
    userId,
    eventType: 'assignment.regrade_resolved',
    eventCategory: 'course',
    sectionId,
    metadata: { requestId, assignmentId: req.assignment_id, newScore },
  })
  // Notify the student. The publish gate holds by construction — a request can only exist after
  // grades were published, and publishGrades is one-way.
  void emitEvent({
    type: 'regrade_resolved',
    sectionId,
    actorId: userId,
    audience: [req.student_id],
    entity: { type: 'regrade_request', id: requestId },
    title: `Regrade reviewed: ${assignmentTitle}`,
    body: note ? note.slice(0, 300) : 'Your regrade request has been reviewed.',
    linkUrl: `/student/courses/${sectionId}/assignments/${req.assignment_id}`,
    actionable: false,
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${req.assignment_id}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${req.assignment_id}`)
  return { success: true }
}

/** Staff posts a comment on a rubric subquestion of a student's submission. */
export async function addSubmissionCommentAsStaff(
  sectionId: string,
  submissionId: string,
  input: SubmissionCommentInput,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* Score/feedback write — canGrade admits graders (#746). */
  if (!access.ok || !canGrade(access.role)) {
    return { error: "You don't have permission to comment here." }
  }

  const parsed = submissionCommentSchema.safeParse(input)
  if (!parsed.success) return { error: firstIssue(parsed.error) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = access.adminDb as any
  const { data: sub } = await db
    .from('assignment_submissions')
    .select('id, student_id, status, assignment:assignments(id, section_id, institution_id, settings, title)')
    .eq('id', submissionId)
    .maybeSingle()
  const assignment = sub ? resolveJoin(sub.assignment) : null
  if (!sub || assignment?.section_id !== sectionId) return { error: 'Submission not found.' }
  if (sub.status !== 'graded' && sub.status !== 'returned') {
    return { error: 'You can comment once the submission has been graded.' }
  }

  const rubric = parseRubric(assignment.settings)
  const q = rubric?.questions[parsed.data.questionIndex]
  if (!rubric || !q) return { error: 'That question no longer exists.' }
  const label = q.label || `Question ${parsed.data.questionIndex + 1}`

  const { error } = await db
    .from('assignment_submission_comments')
    .insert({
      submission_id: sub.id,
      section_id: assignment.section_id,
      institution_id: assignment.institution_id,
      question_index: parsed.data.questionIndex,
      question_label: label,
      author_id: userId,
      author_role: 'staff',
      body: parsed.data.body,
    })
  if (error) {
    logger.error('addSubmissionCommentAsStaff: insert failed', error, { submissionId })
    return { error: 'Could not post your comment. Please try again.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.submission_comment_posted',
    eventCategory: 'course',
    sectionId,
    metadata: { submissionId, assignmentId: assignment.id, questionIndex: parsed.data.questionIndex },
  })
  // Comment is stored but held — student is notified only when the professor takes a grade action
  // (publishGrades → assignment_graded, requestChanges → resubmit_requested). No instant notice here.
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignment.id}`)
  return { success: true }
}

/**
 * Grade a student who has not submitted (or upsert a grade onto any submission).
 * Same auth sequence as gradeSubmission, but keyed by studentId rather than submissionId so
 * the professor can grade non-submitters directly from the roster.
 */
// Active enrollment statuses (mirrors the roster filter on the grading page).
const ACTIVE_ENROLLMENT_STATUSES = ['enrolled', 'active', 'completed']

/** True when the student has an active enrollment in the section. Guards grading/reopen against
 *  a client-supplied studentId that isn't on the roster. */
async function isEnrolledInSection(adminDb: SupabaseClient, sectionId: string, studentId: string): Promise<boolean> {
  const { data } = await adminDb
    .from('enrollments')
    .select('status')
    .eq('section_id', sectionId)
    .eq('student_id', studentId)
    .maybeSingle()
  return !!data && ACTIVE_ENROLLMENT_STATUSES.includes(data.status as string)
}

export async function gradeStudent(
  sectionId: string,
  assignmentId: string,
  studentId: string,
  input: { score: number; feedback?: string; rubricScores?: string[]; rubricComments?: Record<string, string> },
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* Score/feedback write — canGrade admits graders (#746). */
  if (!access.ok || !canGrade(access.role)) {
    return { error: "You don't have permission to grade here." }
  }

  // Object-level authz: the assignment must belong to this section.
  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, institution_id, points, title, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }
  // graded_with_rubric marks whether a rubric existed when saved (see gradeSubmission). A
  // non-submitter scored while a rubric exists is intentional and stays in Graded.
  const gradedWithRubric = !!parseRubric(assignment.settings)

  // Object-level authz: the target student must be enrolled in this section
  // (studentId is client-supplied; never trust it).
  if (!(await isEnrolledInSection(access.adminDb, sectionId, studentId))) {
    return { error: 'That student is not enrolled in this section.' }
  }

  // Validate score/feedback/rubricScores (rejects NaN, over-cap, oversized feedback).
  const parsed = gradeStudentInputSchema.safeParse(input)
  if (!parsed.success) {
    return { error: 'Enter a valid score and feedback.' }
  }
  const { score, feedback, rubricScores, rubricComments } = parsed.data
  const maxPoints = Number(assignment.points)
  if (Number.isFinite(maxPoints) && score > maxPoints) {
    return { error: `Score can't exceed this assignment's ${maxPoints} points.` }
  }

  // Strip empty / whitespace-only comments before persisting.
  const cleanedComments: Record<string, string> | undefined = rubricComments
    ? Object.fromEntries(
        Object.entries(rubricComments).filter(([, v]) => v.trim().length > 0),
      )
    : undefined

  const now = new Date().toISOString()

  // Ensure a row exists without clobbering a real submission (ON CONFLICT DO NOTHING),
  // then apply the grade. Race-safe vs. a prior existence SELECT: concurrent calls can't
  // both insert. The update preserves files/submitted_at on an existing submission.
  const { error: stubError } = await access.adminDb
    .from('assignment_submissions')
    .upsert(
      {
        assignment_id: assignmentId,
        student_id: studentId,
        institution_id: assignment.institution_id,
        status: 'draft',
        files: [],
        created_at: now,
        updated_at: now,
      },
      { onConflict: 'assignment_id,student_id', ignoreDuplicates: true },
    )
  if (stubError) {
    logger.error('gradeStudent.stub', stubError, { assignmentId, studentId })
    return { error: 'Could not save the grade. Please try again.' }
  }

  const { error: gradeError } = await access.adminDb
    .from('assignment_submissions')
    .update({
      score,
      feedback: feedback ?? '',
      status: 'graded',
      graded_by: userId,
      graded_at: now,
      updated_at: now,
      graded_with_rubric: gradedWithRubric,
      ...(rubricScores ? { rubric_scores: rubricScores } : {}),
      ...(cleanedComments !== undefined ? { rubric_comments: cleanedComments } : {}),
    })
    .eq('assignment_id', assignmentId)
    .eq('student_id', studentId)
  if (gradeError) {
    logger.error('gradeStudent', gradeError, { assignmentId, studentId })
    return { error: 'Could not save the grade. Please try again.' }
  }

  // Fold this grade into the student's topic mastery (best-effort).
  await applyGradeToSkillMastery({
    sectionId,
    studentId,
    activityType: 'assignment',
    activityId: assignmentId,
    pct: Number.isFinite(maxPoints) && maxPoints > 0 ? (score / maxPoints) * 100 : score,
    points: Number.isFinite(maxPoints) ? maxPoints : undefined,
  })
  after(() => enqueueMasteryRecompute(sectionId))

  await logEvent({
    userId,
    eventType: 'assignment.graded',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, studentId, score },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Reopen a student's submission window, allowing them to submit past the deadline.
 * Accepts an optional window parameter (default 24h). Also resets a previously-graded row that
 * was never submitted (submitted_at IS NULL) so the student can actually turn in work.
 * Upserts the submission row so it works even when the student never submitted.
 */
export async function reopenSubmission(
  sectionId: string,
  assignmentId: string,
  studentId: string,
  window?: ReopenWindow,
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to do that." }
  }

  // Validate the optional window parameter.
  const windowParsed = reopenWindowSchema.safeParse(window)
  if (!windowParsed.success) return { error: 'Invalid reopen window.' }

  // Object-level authz: the assignment must belong to this section.
  const { data: assignment } = await access.adminDb
    .from('assignments')
    .select('id, section_id, institution_id, title, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }

  // Object-level authz: the target student must be enrolled in this section
  // (studentId is client-supplied; never trust it).
  if (!(await isEnrolledInSection(access.adminDb, sectionId, studentId))) {
    return { error: 'That student is not enrolled in this section.' }
  }

  const now = new Date()
  const reopenUntil = resolveReopenUntil(windowParsed.data, now.getTime())
  const isAssessment = parseAssessment(assignment.settings).enabled

  // Ensure a row exists (ON CONFLICT DO NOTHING inserts a draft stub only when the
  // student never submitted). Race-safe vs. a prior existence SELECT.
  const { error: stubError } = await access.adminDb
    .from('assignment_submissions')
    .upsert(
      {
        assignment_id: assignmentId,
        student_id: studentId,
        institution_id: assignment.institution_id,
        status: 'draft',
        files: [],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'assignment_id,student_id', ignoreDuplicates: true },
    )
  if (stubError) {
    logger.error('reopenSubmission.stub', stubError, { assignmentId, studentId })
    return { error: 'Could not reopen the submission. Please try again.' }
  }

  if (isAssessment) {
    // Assessment reopen: reset the attempt entirely so the student can start fresh.
    // Clears assessment_started_at so the phase doesn't compute 'closed' and auto-submit,
    // and clears score/grade so a reopened attempt isn't pre-graded.
    // Also clears rubric_scores/rubric_comments/graded_with_rubric so the grader panel
    // doesn't pre-select the previous attempt's ticks on the fresh submission.
    // Files are cleared and the storage objects are deleted (best-effort) to avoid orphans.
    // Applied regardless of current status (submitted/graded/draft) because all three
    // leave the student unable to re-enter without this reset.

    // Snapshot the files up front, but DELETE the storage objects only AFTER the row is safely
    // reset. If the reset UPDATE fails, we must not have deleted the files — otherwise the row
    // would keep pointing at deleted objects (unrecoverable) while the action reported success.
    const { data: existingSub } = await access.adminDb
      .from('assignment_submissions')
      .select('files, status, assessment_started_at, assessment_work_ended_at')
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .maybeSingle()

    // Never wipe a LIVE attempt out from under the student. Block only the genuinely in-progress
    // case (started, not yet submitted, window still open); a closed-but-never-submitted attempt
    // stuck in draft still needs Reopen to recover, so it's allowed through.
    if (
      existingSub?.status === 'draft' &&
      existingSub.assessment_started_at &&
      computeAssessmentTiming(
        existingSub.assessment_started_at,
        existingSub.assessment_work_ended_at,
        parseAssessment(assignment.settings),
        now.getTime(),
      ).phase !== 'closed'
    ) {
      return { error: 'This student is still taking the assessment. You can reopen it once their window closes.' }
    }

    const { error: resetError } = await access.adminDb
      .from('assignment_submissions')
      .update({
        status: 'draft',
        submitted_at: null,
        score: null,
        graded_at: null,
        graded_by: null,
        feedback: '',
        rubric_scores: [],
        rubric_comments: {},
        graded_with_rubric: false,
        assessment_started_at: null,
        assessment_work_ended_at: null,
        files: [],
        late_request_at: null,
        updated_at: now.toISOString(),
      })
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
    if (resetError) {
      logger.error('reopenSubmission.reset', resetError, { assignmentId, studentId })
      return { error: 'Could not reopen the submission. Please try again.' }
    }

    // Row no longer references these objects — safe to delete now (best-effort; a failure here
    // only orphans storage, it does not corrupt the submission).
    const existingPaths = ((existingSub?.files ?? []) as { path: string }[])
      .map((f) => f.path)
      .filter(Boolean)
    if (existingPaths.length > 0) {
      await access.adminDb.storage
        .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
        .remove(existingPaths)
        .catch(() => undefined)
    }
  } else {
    // Non-assessment reopen: if the existing row was never truly submitted
    // (submitted_at IS NULL) — e.g. an auto-zero stub or a direct-grade stub —
    // reset it to draft so the student can actually submit work.
    // We scope to submitted_at IS NULL + status=graded to avoid touching real submissions.
    await access.adminDb
      .from('assignment_submissions')
      .update({
        status: 'draft',
        score: null,
        graded_at: null,
        graded_by: null,
        feedback: '',
        assessment_started_at: null,
        assessment_work_ended_at: null,
        late_request_at: null,
        updated_at: now.toISOString(),
      })
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .is('submitted_at', null)
      // Only reset graded rows — leave draft/returned/submitted rows alone.
      .eq('status', 'graded')
  }

  // Stamp the reopen window on the row regardless of prior status.
  const { error: opError } = await access.adminDb
    .from('assignment_submissions')
    .update({ resubmit_until: reopenUntil, late_request_at: null, updated_at: now.toISOString() })
    .eq('assignment_id', assignmentId)
    .eq('student_id', studentId)
  if (opError) {
    logger.error('reopenSubmission', opError, { assignmentId, studentId })
    return { error: 'Could not reopen the submission. Please try again.' }
  }

  // Notify the student that their submission has been reopened.
  await emitEvent({
    type: 'resubmit_requested',
    sectionId,
    actorId: userId,
    audience: [studentId],
    entity: { type: 'assignment', id: assignmentId },
    title: `Submission reopened: ${assignment.title}`,
    body: `You can now submit until ${new Date(reopenUntil).toLocaleString()}.`,
    linkUrl: `/student/courses/${sectionId}/assignments/${assignmentId}`,
    actionable: true,
    metadata: { reopenUntil },
  })

  await logEvent({
    userId,
    eventType: 'assignment.reopened',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, studentId, reopenUntil },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Build and persist an AI grade suggestion for a single submission.
 * Only callable by staff (professor/TA). The suggestion is stored in
 * assignment_ai_grade_suggestions and NEVER written to the submission row —
 * the professor still saves the final grade via gradeSubmission.
 */
export async function suggestGrades(
  sectionId: string,
  submissionId: string,
): Promise<ActionResult<{ suggestion: AiGradeSuggestion; suggestionUpdatedAt: string }>> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  /* NOT canGrade: this one calls an LLM, so admitting graders would widen who
     can spend AI budget. Graders grade; they do not commission AI work. (#746) */
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to grade here." }
  }

  // Institution/platform AI kill switch.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  // Object-level authz: the submission must belong to an assignment in this section.
  const { data: sub } = await access.adminDb
    .from('assignment_submissions')
    .select(
      'id, student_id, text_content, files, assignment_id, status, updated_at, assignment:assignments(id, section_id, points, settings)',
    )
    .eq('id', submissionId)
    .maybeSingle()

  const subAssignment = sub ? resolveJoin(sub.assignment) : null
  // Explicit narrowing (not `subAssignment?.section_id !== sectionId`): the optional-chain form
  // never narrows subAssignment to non-null, so the later subAssignment.id/.points/.settings reads
  // would lean on an un-narrowed maybe-null. Guard both the row and the tenant match here.
  if (!sub || !subAssignment || subAssignment.section_id !== sectionId) {
    return { error: 'Submission not found.' }
  }

  // E4: only draft over a still-submitted attempt — never a returned or already-graded one
  // (the bulk path already filters status='submitted'; keep the single path consistent).
  if (sub.status !== 'submitted') {
    return { error: 'This submission has already been graded or returned. Reopen it to re-grade.' }
  }

  // Resolve institution_id from the section (never trust client).
  const { data: section } = await access.adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) return { error: 'Course section not found.' }

  const result = await buildAndSaveSuggestion({
    adminDb: access.adminDb,
    institutionId: section.institution_id,
    sectionId,
    assignment: {
      id: subAssignment.id,
      points: Number(subAssignment.points),
      settings: subAssignment.settings,
    },
    submission: {
      id: sub.id,
      student_id: sub.student_id,
      text_content: sub.text_content,
      files: (sub.files ?? []) as SubmissionFile[],
      updated_at: sub.updated_at,
    },
    userId,
  })

  if ('error' in result) return { error: result.error }

  const { suggestion, suggestionUpdatedAt } = result

  await logEvent({
    userId,
    eventType: 'assignment.grade_suggested',
    eventCategory: 'course',
    sectionId,
    metadata: {
      submissionId,
      assignmentId: subAssignment.id,
      confidence: suggestion.confidence,
      flaggedCount: suggestion.flaggedCount,
    },
  })

  revalidatePath(`/professor/courses/${sectionId}/assignments/${subAssignment.id}`)

  return { success: true, suggestion, suggestionUpdatedAt }
}



/**
 * Autosave the Publish-step settings (deadline, file types, assessment config, graded flag)
 * WITHOUT changing the assignment status. Called debounced from the PublishPanel so these
 * fields survive a reload — the professor can reload the studio and return to the Publish
 * step with their config intact. Does NOT touch points (derived from the rubric) or
 * gradesPublished. The final Publish/Schedule click still calls publishStudioAssignment,
 * which writes the same fields plus flips the status.
 */
export async function savePublishSettings(
  sectionId: string,
  assignmentId: string,
  input: {
    dueAt: string | null
    fileTypes: string[]
    assessment: unknown
    /** Omitted when the studio renders no Ungraded control — see the p_cols note below. */
    isGraded?: boolean
  },
): Promise<ActionResult> {
  const userId = await currentUserId()
  if (!userId) return { error: 'You need to sign in again.' }

  const access = await verifySectionAccess(sectionId, userId)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { error: "You don't have permission to edit this assignment." }
  }

  // Validate with publishSettingsSchema (minus status/scheduleAt — we never touch those here).
  const parsed = publishSettingsSchema.safeParse({
    dueAt: input.dueAt,
    fileTypes: input.fileTypes,
    assessment: input.assessment,
    isGraded: input.isGraded,
  })
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const { dueAt, fileTypes, assessment, isGraded } = parsed.data

  const { data: existing } = await access.adminDb
    .from('assignments')
    .select('id, section_id, status')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!existing || existing.section_id !== sectionId) return { error: 'Assignment not found.' }

  // Never silently mutate a LIVE assignment. This debounced autosave only revalidates /studio and
  // skips student notification, so on a published assignment it would move the deadline invisibly,
  // drop it from the gradebook (is_graded=false), and enforce half-typed deadlines. Once published,
  // edits must go through the explicit Publish button (publishStudioAssignment → notify + full
  // revalidate). The client also stops autosaving when published; this is the trust-boundary guard.
  if (existing.status === 'published') {
    return { error: 'This assignment is live. Use Publish to send changes to students.' }
  }

  // Key-scoped atomic merge: patch ONLY accepts + assessment (the keys this tab owns)
  // so a concurrent Rubrics-tab autosave can't be clobbered — and this can't drop the
  // rubric it wrote (see merge_assignment_settings). Scalars ride the same statement.
  // is_graded is written ONLY when the studio actually rendered an Ungraded control. The notebook
  // and document studios don't, so their panel's `isGraded` is a local default (true) with no UI
  // behind it — writing it would silently re-add an ungraded assignment to the gradebook on the
  // next unrelated autosave (deadline tweak, file type). p_cols keys are applied selectively by the
  // RPC, so omitting it leaves the stored column untouched.
  const { error } = await access.adminDb.rpc('merge_assignment_settings', {
    p_assignment_id: assignmentId,
    p_section_id: sectionId,
    p_patch: { accepts: { fileTypes }, ...(assessment ? { assessment } : {}) },
    p_cols: { due_at: dueAt || null, ...(isGraded !== undefined ? { is_graded: isGraded } : {}) },
  })

  if (error) {
    logger.error('savePublishSettings', error, { assignmentId })
    return { error: 'Could not autosave publish settings.' }
  }

  await logEvent({
    userId,
    eventType: 'assignment.updated',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'publish_settings.autosave' },
  })
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}/studio`)
  return { success: true }
}
