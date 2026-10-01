/**
 * Student-side actions for ASSESSMENT-mode assignments (timed + proctored).
 *
 * Trust model matches submitAssignment: every action re-checks auth + enrolment +
 * ownership with the admin client, and NEVER trusts the client for phase or timing —
 * the phase is always recomputed server-side from assignment_submissions.assessment_started_at.
 * Proctoring evidence is advisory (a human reviews it); it never changes the grade.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import type { Json } from '@/lib/supabase/types'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { markFeedItemDone } from '@/lib/events/emit'
import { logger } from '@/lib/logger'
import { ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'
import { parseAccepts, parseAssessment, MAX_SUBMISSION_FILES, type SubmissionFile, type AssessmentConfig } from '@/lib/validations/assignment'
import { proctoringEventSchema, type ProctoringEvent, type ProctoringSummary } from '@/lib/validations/proctoring'
import { computeAssessmentTiming, canSubmitAssessmentAt } from '@/lib/assignments/assessment'
import { computeProctoringSummary } from '@/lib/proctoring/summary'
import { validateSubmissionFile, buildSubmissionPath } from '@/lib/assignments/files'
import { isReopenWindowActive, canSubmitPastDeadline } from '@/lib/assignments/submissions'

const PROCTORING_SNAPSHOTS_BUCKET = 'proctoring-snapshots'
/** Snapshots are 320x240 JPEGs (tens of KB); cap well above that to bound abuse. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

type StartResult = { error: string } | { success: true; submissionId: string; startedAt: string }
type ActionResult = { error: string } | { success: true }

type AdminDb = SupabaseClient<Database>

type AssessmentCtx =
  | { ok: false; error: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { ok: true; assignment: any; config: AssessmentConfig }

/** Load an assessment assignment + verify it's open, enrolled, and actually an assessment. */
async function loadAssessmentContext(
  adminDb: AdminDb,
  sectionId: string,
  assignmentId: string,
  userId: string,
): Promise<AssessmentCtx> {
  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, status, settings, institution_id, due_at')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { ok: false, error: 'Assignment not found.' }
  if (assignment.status !== 'published') return { ok: false, error: 'This assignment is not open.' }

  const config = parseAssessment(assignment.settings)
  if (!config.enabled) return { ok: false, error: 'This assignment is not an assessment.' }

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { ok: false, error: "You're not enrolled in this course." }

  return { ok: true, assignment, config }
}

/**
 * Begin the assessment: stamp assessment_started_at (the phase clock). Single attempt —
 * a submitted/graded row is locked, and an already-started row resumes at the same clock
 * (a refresh or second tab can never reset time or reopen the brief).
 */
export async function startAssessment(sectionId: string, assignmentId: string): Promise<StartResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient() as AdminDb
  const ctx = await loadAssessmentContext(adminDb, sectionId, assignmentId, user.id)
  if (!ctx.ok) return { error: ctx.error }
  const { assignment } = ctx

  const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  // Can't start once the deadline has passed — unless the professor granted a reopen window.
  if (assignment.due_at && Date.now() > new Date(assignment.due_at).getTime()) {
    const { data: existingForGate } = await adminDb
      .from('assignment_submissions')
      .select('resubmit_until')
      .eq('assignment_id', assignmentId)
      .eq('student_id', user.id)
      .maybeSingle()
    if (!isReopenWindowActive(existingForGate?.resubmit_until)) {
      return { error: 'The deadline for this assessment has passed.' }
    }
  }

  const { data: existing } = await adminDb
    .from('assignment_submissions')
    .select('id, status, assessment_started_at')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()

  if (existing?.status === 'submitted' || existing?.status === 'graded') {
    return { error: 'You have already completed this assessment.' }
  }
  // Resume: clock already running.
  if (existing?.assessment_started_at) {
    return { success: true, submissionId: existing.id, startedAt: existing.assessment_started_at }
  }

  const now = new Date().toISOString()

  if (existing) {
    // Guarded update: only the first concurrent start stamps the clock.
    const { data: updated } = await adminDb
      .from('assignment_submissions')
      .update({ assessment_started_at: now, updated_at: now })
      .eq('id', existing.id)
      .is('assessment_started_at', null)
      .select('id, assessment_started_at')
      .maybeSingle()
    if (updated?.assessment_started_at) {
      return { success: true, submissionId: updated.id, startedAt: updated.assessment_started_at }
    }
    // Lost the race — re-read the winning clock.
    const { data: reread } = await adminDb
      .from('assignment_submissions')
      .select('id, assessment_started_at')
      .eq('id', existing.id)
      .maybeSingle()
    if (reread?.assessment_started_at) {
      return { success: true, submissionId: reread.id, startedAt: reread.assessment_started_at }
    }
    return { error: 'Could not start the assessment. Please try again.' }
  }

  const { data: inserted, error } = await adminDb
    .from('assignment_submissions')
    .insert({
      assignment_id: assignmentId,
      student_id: user.id,
      institution_id: assignment.institution_id,
      status: 'draft',
      assessment_started_at: now,
      created_at: now,
      updated_at: now,
    })
    .select('id, assessment_started_at')
    .maybeSingle()

  if (error || !inserted) {
    // Unique (assignment_id, student_id) race — another tab inserted first.
    const { data: reread } = await adminDb
      .from('assignment_submissions')
      .select('id, assessment_started_at')
      .eq('assignment_id', assignmentId)
      .eq('student_id', user.id)
      .maybeSingle()
    if (reread?.assessment_started_at) {
      return { success: true, submissionId: reread.id, startedAt: reread.assessment_started_at }
    }
    logger.error('startAssessment: insert failed', error, { assignmentId })
    return { error: 'Could not start the assessment. Please try again.' }
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.assessment_started',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })
  return { success: true, submissionId: inserted.id, startedAt: inserted.assessment_started_at! }
}

/**
 * End the work phase early to jump to the upload window. Only valid while in the work
 * phase; can only shrink the window (guarded so it's set once).
 */
export async function finishAssessmentWorkEarly(sectionId: string, assignmentId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient() as AdminDb
  const ctx = await loadAssessmentContext(adminDb, sectionId, assignmentId, user.id)
  if (!ctx.ok) return { error: ctx.error }
  const { config } = ctx

  const { data: sub } = await adminDb
    .from('assignment_submissions')
    .select('id, status, assessment_started_at, assessment_work_ended_at')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()
  if (!sub || !sub.assessment_started_at) return { error: 'You have not started this assessment.' }
  if (sub.status !== 'draft') return { error: 'This assessment is already submitted.' }

  const timing = computeAssessmentTiming(sub.assessment_started_at, sub.assessment_work_ended_at, config, Date.now())
  if (timing.phase !== 'work') return { error: 'The work phase has already ended.' }

  const now = new Date().toISOString()
  await adminDb
    .from('assignment_submissions')
    .update({ assessment_work_ended_at: now, updated_at: now })
    .eq('id', sub.id)
    .is('assessment_work_ended_at', null)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/** Persist one batch of proctoring events for an in-progress assessment. */
export async function saveAssessmentProctoringBatch(
  submissionId: string,
  events: ProctoringEvent[],
  batchIndex: number,
  keystrokeCount = 0,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const parsed = proctoringEventSchema.array().max(500).safeParse(events)
  if (!parsed.success) return { error: 'Invalid proctoring data.' }

  const adminDb = createAdminClient() as AdminDb
  const { data: sub } = await adminDb
    .from('assignment_submissions')
    .select('id, student_id, status, assignment_id, institution_id, assignments(section_id)')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub || sub.student_id !== user.id) return { error: 'Submission not found.' }
  if (sub.status !== 'draft') return { error: 'This assessment is already submitted.' }
  const sectionId = Array.isArray(sub.assignments) ? sub.assignments[0]?.section_id : sub.assignments?.section_id
  if (!sectionId) return { error: 'Submission not found.' }

  const { error } = await adminDb.from('assignment_proctoring_logs').insert({
    submission_id: submissionId,
    student_id: user.id,
    assignment_id: sub.assignment_id,
    section_id: sectionId,
    institution_id: sub.institution_id,
    batch_index: batchIndex,
    events: parsed.data,
    keystroke_count: keystrokeCount,
  })
  if (error) {
    logger.error('saveAssessmentProctoringBatch: insert failed', error, { submissionId, batchIndex })
    return { error: 'Could not save proctoring data.' }
  }
  return { success: true }
}

/** Upload one violation snapshot (base64 JPEG) + store its metadata. */
export async function saveAssessmentProctoringSnapshot(
  submissionId: string,
  violationType: string,
  snapshotBase64: string,
  timestampOffset: number,
  faceCount: number,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  // Bound the client-supplied fields before any reach the storage path / DB: snapshots cover
  // video violations and the baseline probe; timestampOffset is a non-negative millisecond
  // count from assessment start (goes into the object key), bounded to 24 h of exam time.
  // faceCount is a small non-negative integer.
  if (violationType !== 'mf' && violationType !== 'ph' && violationType !== 'bl') return { error: 'Invalid snapshot.' }
  if (!Number.isInteger(timestampOffset) || timestampOffset < 0 || timestampOffset > 86_400_000) return { error: 'Invalid snapshot.' }
  if (!Number.isInteger(faceCount) || faceCount < 0 || faceCount > 100) return { error: 'Invalid snapshot.' }

  const adminDb = createAdminClient() as AdminDb
  const { data: sub } = await adminDb
    .from('assignment_submissions')
    .select('id, student_id, status, assignment_id, institution_id, assignments(section_id)')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub || sub.student_id !== user.id) return { error: 'Submission not found.' }
  if (sub.status !== 'draft') return { error: 'This assessment is already submitted.' }
  const sectionId = Array.isArray(sub.assignments) ? sub.assignments[0]?.section_id : sub.assignments?.section_id
  if (!sectionId) return { error: 'Submission not found.' }

  const buffer = Buffer.from(snapshotBase64, 'base64')
  if (buffer.length === 0 || buffer.length > MAX_SNAPSHOT_BYTES) return { error: 'Invalid snapshot.' }
  // Lead the path with the sectionId UUID so it matches the proctoring-snapshots bucket's
  // storage-RLS shape (foldername[1] = section). Reads still go through the admin client.
  const storagePath = `${sectionId}/${sub.assignment_id}/${submissionId}/${timestampOffset}.jpg`
  const { error: uploadError } = await adminDb.storage
    .from(PROCTORING_SNAPSHOTS_BUCKET)
    .upload(storagePath, buffer, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false })
  if (uploadError) {
    logger.error('saveAssessmentProctoringSnapshot: upload failed', uploadError, { submissionId })
    return { error: 'Could not upload snapshot.' }
  }

  const { data: urlData } = await adminDb.storage
    .from(PROCTORING_SNAPSHOTS_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7)

  const { error } = await adminDb.from('assignment_proctoring_snapshots').insert({
    submission_id: submissionId,
    student_id: user.id,
    assignment_id: sub.assignment_id,
    section_id: sectionId,
    institution_id: sub.institution_id,
    violation_type: violationType,
    storage_path: storagePath,
    snapshot_url: urlData?.signedUrl ?? storagePath,
    timestamp_offset: timestampOffset,
    face_count: faceCount,
  })
  if (error) {
    logger.error('saveAssessmentProctoringSnapshot: insert failed', error, { submissionId })
    return { error: 'Could not save snapshot.' }
  }
  return { success: true }
}

/**
 * Final submit of an assessment. Server recomputes the phase — a submit is only accepted
 * during the upload window or after it closes (auto-submit); the work phase must end first.
 * Single attempt: an already-submitted/graded assessment is locked. A proctoring_summary is
 * aggregated and stored for the professor (advisory only).
 */
export async function submitAssessment(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient() as AdminDb
  const ctx = await loadAssessmentContext(adminDb, sectionId, assignmentId, user.id)
  if (!ctx.ok) return { error: ctx.error }
  const { assignment, config } = ctx

  const { data: sub } = await adminDb
    .from('assignment_submissions')
    .select('id, status, files, assessment_started_at, assessment_work_ended_at, resubmit_until')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()
  if (!sub) return { error: 'You have not started this assessment.' }
  // Stale-tab guard: after a professor reopen, assessment_started_at is nulled so the student
  // must start fresh. A tab that was already open holds a stale clock and may auto-submit when
  // its countdown hits zero. Reject it here so it lands as a no-op on the fresh attempt.
  if (!sub.assessment_started_at) {
    return { error: 'This attempt was reset. Reload the page to start again.' }
  }
  if (sub.status === 'submitted' || sub.status === 'graded') {
    return { error: 'You have already completed this assessment.' }
  }

  // Phase guard — the work phase must be over before a final submit.
  const nowMs = Date.now()
  const timing = computeAssessmentTiming(sub.assessment_started_at, sub.assessment_work_ended_at, config, nowMs)
  if (timing.phase === 'work' || timing.phase === 'lobby') {
    return { error: 'Finish your work time before uploading.' }
  }

  // Closed-window guard — reuse the tested predicate (grace period + reopen override) so the
  // enforcement path can't drift from its unit tests.
  if (!canSubmitAssessmentAt(timing, nowMs, sub.resubmit_until)) {
    return { error: 'The assessment window has closed. Ask your professor to reopen it for you.' }
  }

  // Hard deadline gate: a submission can't land after due_at either, even inside a personal work
  // window that straddles the deadline (a student who started just before due_at). startAssessment
  // gates the start; this gates the submit. A professor reopen overrides it. Uses the same tested
  // predicate as submitAssignment so the deadline logic lives in one place.
  if (!canSubmitPastDeadline(assignment.due_at, sub.resubmit_until, nowMs)) {
    return { error: 'The deadline for this assessment has passed. Ask your professor to reopen it for you.' }
  }

  // Validate + upload files (professor's configured types; same rules as normal submit).
  const { fileTypes } = parseAccepts(assignment.settings)
  const incoming = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  if (incoming.length > MAX_SUBMISSION_FILES) {
    return { error: `You can attach at most ${MAX_SUBMISSION_FILES} files.` }
  }
  for (const file of incoming) {
    const check = validateSubmissionFile({ name: file.name, size: file.size, type: file.type }, fileTypes)
    if (!check.ok) return { error: check.error ?? 'That file type is not accepted.' }
  }

  const uploaded: SubmissionFile[] = []
  for (let i = 0; i < incoming.length; i++) {
    const file = incoming[i]
    const path = buildSubmissionPath(sectionId, assignmentId, user.id, file.name, `${Date.now()}-${i}`)
    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await adminDb.storage
      .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
      .upload(path, buffer, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (uploadError) {
      logger.error('submitAssessment: upload failed', uploadError, { assignmentId, path })
      return { error: 'Could not upload your file. Please try again.' }
    }
    uploaded.push({ path, name: file.name, size: file.size, type: file.type })
  }

  // Aggregate the proctoring summary (advisory) if any proctoring was on.
  let proctoringSummary: ProctoringSummary | null = null
  const anyProctoring = config.proctoring.activity || config.proctoring.fullscreen || config.proctoring.video
  if (anyProctoring) {
    const { data: logs } = await adminDb
      .from('assignment_proctoring_logs')
      .select('events, keystroke_count')
      .eq('submission_id', sub.id)
    let snapshotCount = 0
    if (config.proctoring.video) {
      const { count } = await adminDb
        .from('assignment_proctoring_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('submission_id', sub.id)
      snapshotCount = count ?? 0
    }
    const typedLogs = (logs as { events: ProctoringEvent[]; keystroke_count: number }[] | null) ?? []
    const allEvents = typedLogs.flatMap((l) => l.events ?? [])
    const keystrokeCount = typedLogs.reduce((s, l) => s + (l.keystroke_count ?? 0), 0)
    proctoringSummary = computeProctoringSummary(allEvents, {
      keystrokeCount,
      snapshotCount,
      videoEnabled: config.proctoring.video,
      startedAtMs: new Date(sub.assessment_started_at).getTime(),
    })
  }

  const now = new Date().toISOString()
  const { error: updateError } = await adminDb
    .from('assignment_submissions')
    .update({
      status: 'submitted',
      // Supabase types JSONB columns as Json; our domain types are structurally
      // compatible but don't satisfy the Json index signature, so bridge via unknown.
      files: uploaded as unknown as Json,
      proctoring_summary: proctoringSummary as unknown as Json | null,
      submitted_at: now,
      updated_at: now,
    })
    .eq('id', sub.id)
    .eq('status', 'draft') // single-attempt guard: only a draft can transition to submitted
  if (updateError) {
    logger.error('submitAssessment: update failed', updateError, { assignmentId })
    return { error: 'Could not save your submission. Please try again.' }
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.submitted',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'assessment', fileCount: uploaded.length, flags: proctoringSummary?.suspiciousFlags?.length ?? 0 },
  })
  void markFeedItemDone({ recipientId: user.id, entityType: 'assignment', entityId: assignmentId })
  revalidatePath(`/student/courses/${sectionId}/assignments`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}
