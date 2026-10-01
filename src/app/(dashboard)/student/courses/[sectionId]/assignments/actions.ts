/**
 * Student Assignment Submission action.
 *
 * Files are sent through the server action as FormData and uploaded with the
 * admin client (authorization checked here first) — the browser never writes to
 * storage directly, so no student-facing storage RLS is needed. Returns
 * { error } or { success } — never throws.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { supersedeAiSuggestions } from '@/lib/assignments/ai-grading/invalidate'
import { logEvent } from '@/lib/supabase/event-logger'
import { markFeedItemDone, emitEvent } from '@/lib/events/emit'
import { resolveStaffAudience } from '@/lib/events/audience'
import { isPastDue, isReopenWindowActive, canSubmitPastDeadline } from '@/lib/assignments/submissions'
import { logger } from '@/lib/logger'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { rateLimit } from '@/lib/quiz/rate-limit'
import { ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'
import {
  submitAssignmentTextSchema,
  parseAccepts,
  MAX_SUBMISSION_FILES,
  requestRegradeSchema,
  validateRegradeQuestions,
  parseRubric,
  areGradesPublished,
  type SubmissionFile,
  type RequestRegradeInput,
} from '@/lib/validations/assignment'
import { verbalSubmissionAnswersSchema, parseVerbalAssessment } from '@/lib/validations/verbal-assessment'
import { renderGreeting, spokenPrompt, resolveVerbalAnswers } from '@/lib/assignments/verbal/config'
import { synthesizeSpeech } from '@/lib/ai/elevenlabs/tts'
import { transcribeRecording, sliceByOffsets } from '@/lib/ai/elevenlabs/stt'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { validateSubmissionFile, buildSubmissionPath } from '@/lib/assignments/files'

type ActionResult = { error: string } | { success: true }

// A recorded verbal session is one continuous video. Capped below the server-action
// bodySizeLimit (260mb) with headroom for the answers payload.
const MAX_VERBAL_VIDEO_SIZE = 220 * 1024 * 1024

export async function submitAssignment(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient()

  // Assignment must exist, belong to this section, and be open for submission.
  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, status, settings, institution_id, due_at')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }
  if (assignment.status !== 'published') {
    return { error: 'This assignment is not open for submissions.' }
  }

  // Caller must be actively enrolled in the section.
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { error: "You're not enrolled in this course." }

  // Ring 2 (entitlements design doc): stop a revoked feature accruing new
  // evidence. Safe to sit on the submit here only because revocation is
  // deferred to a term boundary (4.4), by which point assignments are closed.
  // An immediate revocation would destroy in-flight student work.
  const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'assignments')
  if (!entitlement.allowed) return { error: entitlementRefusalMessage('assignments') }

  // Don't let a student overwrite a grade unless the professor has reopened the window.
  const { data: existing } = await adminDb
    .from('assignment_submissions')
    .select('id, status, files, resubmit_until')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()
  if (existing?.status === 'graded' && !isReopenWindowActive(existing.resubmit_until)) {
    return { error: "This submission can't be changed right now. Contact your instructor if you need to update it." }
  }

  // Hard deadline gate: past due_at, reject unless professor granted a reopen window.
  if (!canSubmitPastDeadline(assignment.due_at, existing?.resubmit_until)) {
    return { error: 'This assignment is closed. Ask your professor to reopen it for you.' }
  }

  // Validate the optional text response.
  const parsedText = submitAssignmentTextSchema.safeParse({
    text: (formData.get('text') as string | null) ?? '',
  })
  if (!parsedText.success) {
    return { error: parsedText.error.issues[0]?.message ?? 'Your response is too long.' }
  }
  const text = parsedText.data.text?.trim() ?? ''

  const { fileTypes } = parseAccepts(assignment.settings)
  const incoming = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)

  if (incoming.length > 0 && fileTypes.length === 0) {
    return { error: 'This assignment only accepts a text response.' }
  }
  if (incoming.length > MAX_SUBMISSION_FILES) {
    return { error: `You can attach at most ${MAX_SUBMISSION_FILES} files.` }
  }
  if (!text && incoming.length === 0) {
    return { error: 'Add a response or attach a file before submitting.' }
  }

  // Validate every file before uploading any of them.
  for (const file of incoming) {
    const check = validateSubmissionFile(
      { name: file.name, size: file.size, type: file.type },
      fileTypes,
    )
    if (!check.ok) return { error: check.error ?? 'That file type is not accepted.' }
  }

  // Upload files via the admin client.
  const uploaded: SubmissionFile[] = []
  for (let i = 0; i < incoming.length; i++) {
    const file = incoming[i]
    const path = buildSubmissionPath(
      sectionId,
      assignmentId,
      user.id,
      file.name,
      `${Date.now()}-${i}`,
    )
    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await adminDb.storage
      .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
      .upload(path, buffer, { contentType: file.type || 'application/octet-stream', upsert: false })
    if (uploadError) {
      logger.error('submitAssignment: upload failed', uploadError, { assignmentId, path })
      return { error: 'Could not upload your file. Please try again.' }
    }
    uploaded.push({ path, name: file.name, size: file.size, type: file.type })
  }

  // Re-check the gates at commit time. Uploading can take long enough for the deadline to pass (or
  // the professor to close a reopen window) between the checks above and this write, so re-read the
  // current window and re-run the same guards against the current clock — an upload that straddles
  // the deadline must not land a submission.
  {
    const { data: freshSub } = await adminDb
      .from('assignment_submissions')
      .select('status, resubmit_until')
      .eq('assignment_id', assignmentId)
      .eq('student_id', user.id)
      .maybeSingle()
    const stillClosed =
      (freshSub?.status === 'graded' && !isReopenWindowActive(freshSub.resubmit_until)) ||
      !canSubmitPastDeadline(assignment.due_at, freshSub?.resubmit_until)
    if (stillClosed) {
      // Don't orphan the files we just uploaded.
      if (uploaded.length > 0) {
        await adminDb.storage
          .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
          .remove(uploaded.map((u) => u.path))
          .catch(() => undefined)
      }
      return { error: 'This assignment closed while your submission was uploading. Ask your professor to reopen it for you.' }
    }
  }

  const now = new Date().toISOString()
  const { error: upsertError } = await adminDb.from('assignment_submissions').upsert(
    {
      assignment_id: assignmentId,
      student_id: user.id,
      institution_id: assignment.institution_id,
      status: 'submitted',
      text_content: text || null,
      files: uploaded,
      // Resubmitting (e.g. after a professor requested changes) clears any prior
      // grade so it returns to the "needs grading" queue.
      score: null,
      graded_at: null,
      // Clear any pending late request since the student is now submitting.
      late_request_at: null,
      submitted_at: now,
      updated_at: now,
    },
    { onConflict: 'assignment_id,student_id' },
  )
  if (upsertError) {
    logger.error('submitAssignment: upsert failed', upsertError, { assignmentId })
    return { error: 'Could not save your submission. Please try again.' }
  }

  // The submission content just changed, so any AI grade suggestion drafted against the OLD
  // submission is stale — supersede it (scoped to this student's row on this assignment; the
  // upsert keys on assignment+student, so we don't hold the submission id here). Best-effort.
  await supersedeAiSuggestions(adminDb, { assignmentId, studentId: user.id, institutionId: assignment.institution_id }, 'resubmitted')

  // Only after the row safely points at the new files do we remove the old ones
  // (best-effort). Ordering this after the upsert avoids orphaning a submission if the
  // write fails — the prior files stay intact and still referenced.
  const oldFiles = (existing?.files as SubmissionFile[] | undefined) ?? []
  const stalePaths = oldFiles.map((f) => f.path).filter((p) => !uploaded.some((u) => u.path === p))
  if (stalePaths.length > 0) {
    await adminDb.storage
      .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
      .remove(stalePaths)
      .catch(() => undefined)
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.submitted',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, fileCount: uploaded.length, hasText: Boolean(text) },
  })
  // Completion event: clear this assignment's to-do in the shared feed (best-effort).
  void markFeedItemDone({ recipientId: user.id, entityType: 'assignment', entityId: assignmentId })
  revalidatePath(`/student/courses/${sectionId}/assignments`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/**
 * Narrate one verbal cell's prompt with the assessment's configured voice. The text is taken
 * from the stored config by cellId (never arbitrary client text), the voice is the config's,
 * and the caller must be an enrolled student. Returns base64 MP3 for the browser to play.
 */
export async function narrateVerbalPrompt(
  sectionId: string,
  assignmentId: string,
  cellId: string,
  branch?: 'correct' | 'incorrect',
): Promise<{ audio: string } | { error: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  /* Every call bills ElevenLabs TTS (up to 1500 chars) on the single platform-wide
     ELEVENLABS_API_KEY, and this action is a plain POST a student can replay from the
     network tab at will. Unbounded, one student can both run up real spend and exhaust
     the shared account quota — which would take verbal narration, Scribe transcription
     and Pre-Class Primer audio down for every institution, not just theirs. Same coarse
     limiter the LLM-calling quiz actions use. */
  if (!rateLimit(`narrateVerbal:${user.id}`, 30, 60_000)) {
    return { error: 'Too many requests — please slow down.' }
  }

  const adminDb = createAdminClient()

  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, status, settings')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId || assignment.status !== 'published') {
    return { error: 'Assignment not available.' }
  }

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { error: "You're not enrolled in this course." }

  const config = parseVerbalAssessment(assignment.settings)
  const cell = config?.cells.find((c) => c.id === cellId)
  if (!config || !cell) return { error: 'Question not found.' }

  // A branched follow-up: narrate the MCQ cell's authored correct/incorrect prompt. Resolved
  // server-side from config, so the client can never make TTS speak arbitrary text.
  let text = cell.prompt
  if (branch) {
    if (cell.type !== 'mcq') return { error: 'Question not found.' }
    text = cell.followUps?.[branch] ?? ''
  } else if (cell.type === 'greeting') {
    const { data: profile } = await adminDb.from('profiles').select('name').eq('id', user.id).maybeSingle()
    const firstName = (profile?.name as string | undefined)?.split(' ')[0] ?? 'there'
    text = renderGreeting(cell.prompt, { name: firstName, topic: config.topic })
  }
  // Never read math/code/images aloud: substitute a spoken cue.
  text = spokenPrompt(text)
  if (!text.trim()) return { error: 'Nothing to narrate.' }

  // Institution/platform AI kill switch — narration is AI-generated audio.
  const aiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'assignment-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  const tts = await synthesizeSpeech(text, config.voiceId, { sectionId, userId: user.id })
  if (!tts.ok) return { error: tts.error }
  return { audio: tts.audio.toString('base64') }
}

/**
 * Submit a Verbal Assessment: one recorded video (authoritative) + per-cell transcript/MCQ
 * answers. Same trust sequence as submitAssignment: auth -> verify published + enrolled +
 * not-already-graded -> admin upload -> upsert -> log -> revalidate.
 */
export async function submitVerbalAssessment(
  sectionId: string,
  assignmentId: string,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient()

  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, status, settings, institution_id, due_at')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) return { error: 'Assignment not found.' }
  if (assignment.status !== 'published') return { error: 'This assignment is not open for submissions.' }
  const settings = (assignment.settings ?? {}) as Record<string, unknown>
  if (settings.kind !== 'verbal' && !settings.verbalAssessment) {
    return { error: 'This is not a verbal assessment.' }
  }

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { error: "You're not enrolled in this course." }

  const { data: existing } = await adminDb
    .from('assignment_submissions')
    .select('id, status, files, resubmit_until')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()
  // Same gate as submitAssignment: a graded submission stays locked unless the professor
  // granted a reopen window that is still active.
  if (existing?.status === 'graded' && !isReopenWindowActive(existing.resubmit_until)) {
    return { error: "This submission can't be changed right now. Contact your instructor if you need to update it." }
  }
  // Deadline gate — the same shared predicate submitAssignment uses, so verbal work can't be handed
  // in after the due date when file/text work can't. A professor reopen window overrides it.
  if (!canSubmitPastDeadline(assignment.due_at, existing?.resubmit_until)) {
    return { error: 'The deadline for this assignment has passed. Ask your instructor to reopen it for you.' }
  }

  // Per-cell answers (transcripts + MCQ picks).
  let answers
  try {
    answers = verbalSubmissionAnswersSchema.parse(JSON.parse((formData.get('answers') as string) || '[]'))
  } catch {
    return { error: 'Your answers could not be saved. Please try again.' }
  }

  // Re-derive each answer's prompt + type from the SERVER-stored config; never trust the client
  // copy (it is rendered as markdown to the professor, so a forged prompt would be stored XSS).
  const config = parseVerbalAssessment(assignment.settings)
  answers = resolveVerbalAnswers(config?.cells ?? [], answers)

  // The recorded video. We don't validate the MIME type: Next.js server-action serialization
  // drops the Blob's type (it arrives as text/plain), and it's always our own .webm recorder
  // output. Validate by presence + size only; store as video/webm so the player works.
  const video = formData.get('video')
  if (!(video instanceof File) || video.size === 0) {
    return { error: 'No recording was captured. Please try again.' }
  }
  if (video.size > MAX_VERBAL_VIDEO_SIZE) {
    return { error: 'Your recording is too large. Try a shorter answer or lower video quality.' }
  }

  const path = buildSubmissionPath(sectionId, assignmentId, user.id, 'verbal-recording.webm', String(Date.now()))
  const buffer = Buffer.from(await video.arrayBuffer())
  const contentType = 'video/webm'
  const { error: uploadError } = await adminDb.storage
    .from(ASSIGNMENT_SUBMISSIONS_BUCKET)
    .upload(path, buffer, { contentType, upsert: false })
  if (uploadError) {
    logger.error('submitVerbalAssessment: upload failed', uploadError, { assignmentId, path })
    return { error: 'Could not upload your recording. Please try again.' }
  }
  const uploaded: SubmissionFile = { path, name: 'verbal-recording.webm', size: video.size, type: contentType }

  // Authoritative transcript: in-browser Web Speech is unreliable, so we transcribe the
  // recording server-side and slice it per question by each answer's recording offset. If
  // transcription is unavailable or yields nothing for a window, keep the client's text.
  // Institution/platform AI kill switch: skip AI transcription but NEVER block the
  // submission itself — the recording is preserved and the client transcript kept,
  // exactly like the transcription-unavailable path below.
  const sttVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'assignment-ai')
  const stt = sttVerdict.allowed
    ? await transcribeRecording(buffer, contentType, { sectionId, userId: user.id })
    : ({ ok: false, error: 'AI features disabled for this institution' } as const)
  if (stt.ok) {
    const offsets = answers.map((a) => a.videoOffset ?? 0)
    const slices = sliceByOffsets(stt.words, offsets)
    answers = answers.map((a, i) => (slices[i] ? { ...a, transcript: slices[i] } : a))
  } else {
    logger.warn('submitVerbalAssessment: transcription unavailable', { assignmentId, reason: stt.error })
  }

  // Re-check the gates at commit time, the same way submitAssignment does. The window between the
  // pre-flight check and this write is LONGER here — a video upload plus a full server-side
  // transcription — so a submit started seconds before the deadline could otherwise land after it
  // closed. Re-read the current reopen window and re-run the same predicate against the clock now.
  {
    const { data: freshSub } = await adminDb
      .from('assignment_submissions')
      .select('status, resubmit_until')
      .eq('assignment_id', assignmentId)
      .eq('student_id', user.id)
      .maybeSingle()
    const stillClosed =
      (freshSub?.status === 'graded' && !isReopenWindowActive(freshSub.resubmit_until)) ||
      !canSubmitPastDeadline(assignment.due_at, freshSub?.resubmit_until)
    if (stillClosed) {
      // Don't orphan the recording we just uploaded.
      await adminDb.storage.from(ASSIGNMENT_SUBMISSIONS_BUCKET).remove([path]).catch(() => undefined)
      return { error: 'This assignment closed while your recording was uploading. Ask your instructor to reopen it for you.' }
    }
  }

  const now = new Date().toISOString()
  const { error: upsertError } = await adminDb.from('assignment_submissions').upsert(
    {
      assignment_id: assignmentId,
      student_id: user.id,
      institution_id: assignment.institution_id,
      status: 'submitted',
      files: [uploaded],
      answers,
      score: null,
      graded_at: null,
      submitted_at: now,
      updated_at: now,
    },
    { onConflict: 'assignment_id,student_id' },
  )
  if (upsertError) {
    logger.error('submitVerbalAssessment: upsert failed', upsertError, { assignmentId })
    return { error: 'Could not save your submission. Please try again.' }
  }

  // Remove a prior recording (best-effort) only after the new row is committed.
  const oldFiles = (existing?.files as SubmissionFile[] | undefined) ?? []
  const stalePaths = oldFiles.map((f) => f.path).filter((p) => p !== path)
  if (stalePaths.length > 0) {
    await adminDb.storage.from(ASSIGNMENT_SUBMISSIONS_BUCKET).remove(stalePaths).catch(() => undefined)
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.submitted',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, kind: 'verbal', answerCount: answers.length },
  })
  revalidatePath(`/student/courses/${sectionId}/assignments`)
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

// ── Regrade requests + per-subquestion comments ──────────────────
// All three actions require the caller to be an enrolled student whose submission is GRADED and
// RELEASED. The student page masks a graded-but-unpublished grade as 'submitted', but that is a
// UI concern only — the server independently re-checks status + areGradesPublished here.
// `requestRegrade` and `addSubmissionCommentAsStudent` take assignmentId (not submissionId) and
// derive the submission via student_id = user.id, so there is no submission id to forge (IDOR).

async function loadReleasedSubmissionContext(sectionId: string, assignmentId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: 'You need to sign in again.' }

  const adminDb = createAdminClient()

  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, institution_id, settings, title')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { ok: false as const, error: 'Assignment not found.' }
  }

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { ok: false as const, error: "You're not enrolled in this course." }

  const { data: submission } = await adminDb
    .from('assignment_submissions')
    .select('id, status, score')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()
  if (!submission || submission.status !== 'graded' || !areGradesPublished(assignment.settings)) {
    return { ok: false as const, error: 'Regrades open once your grade has been released.' }
  }

  return { ok: true as const, user, adminDb, assignment, submission }
}

/** Student files a regrade request against a released grade, targeting rubric subquestions. */
export async function requestRegrade(
  sectionId: string,
  assignmentId: string,
  input: RequestRegradeInput,
): Promise<ActionResult> {
  const parsed = requestRegradeSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' }

  const ctx = await loadReleasedSubmissionContext(sectionId, assignmentId)
  if (!ctx.ok) return { error: ctx.error }
  const { user, adminDb, assignment, submission } = ctx

  const check = validateRegradeQuestions(parseRubric(assignment.settings), parsed.data.questionIndexes)
  if (!check.ok) return { error: check.error }

  // Students request regrades per subquestion, but there is ONE open request per submission
  // (the partial unique index). So a request ACCUMULATES: if one is already open, merge the new
  // question(s) in and append the reason; otherwise create it. Prefix the reason with the
  // question label when a single subquestion is targeted so the professor's running log stays
  // legible.
  const now = new Date().toISOString()
  const entryReason =
    check.questions.length === 1
      ? `${check.questions[0].label}: ${parsed.data.reason}`
      : parsed.data.reason

  const { data: openReq } = await adminDb
    .from('assignment_regrade_requests')
    .select('id, questions, reason')
    .eq('submission_id', submission.id)
    .eq('status', 'open')
    .maybeSingle()

  let requestId: string
  let isNew = false
  if (openReq) {
    const existing = (openReq.questions ?? []) as { index: number; label: string }[]
    const have = new Set(existing.map((q) => q.index))
    const mergedQuestions = [...existing]
    for (const q of check.questions) if (!have.has(q.index)) mergedQuestions.push(q)
    const mergedReason = `${openReq.reason}\n\n${entryReason}`.slice(0, 5000)
    const { data: updated } = await adminDb
      .from('assignment_regrade_requests')
      .update({ questions: mergedQuestions, reason: mergedReason, updated_at: now })
      .eq('id', openReq.id)
      .eq('status', 'open')
      .select('id')
    if (!updated || updated.length === 0) {
      return { error: 'Could not update your regrade request. Please try again.' }
    }
    requestId = openReq.id
  } else {
    const { data: inserted, error } = await adminDb
      .from('assignment_regrade_requests')
      .insert({
        submission_id: submission.id,
        assignment_id: assignment.id,
        section_id: assignment.section_id,
        institution_id: assignment.institution_id,
        student_id: user.id,
        questions: check.questions,
        reason: entryReason,
        old_score: submission.score,
      })
      .select('id')
      .single()
    if (error) {
      // A concurrent click won the partial unique index — ask them to retry (it will merge).
      if (error.code === '23505') return { error: 'You just opened a request — try that question again.' }
      logger.error('requestRegrade: insert failed', error, { assignmentId })
      return { error: 'Could not send your regrade request. Please try again.' }
    }
    requestId = inserted.id
    isNew = true
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.regrade_requested',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId, submissionId: submission.id, questionCount: check.questions.length },
  })
  // Notify staff only when the request is first opened — the dedup index (recipient,type,entity)
  // would swallow repeats on the same request id anyway, and the revalidate refreshes their queue.
  if (isNew) {
    void emitEvent({
      type: 'regrade_requested',
      sectionId,
      actorId: user.id,
      audience: await resolveStaffAudience(adminDb, sectionId),
      entity: { type: 'regrade_request', id: requestId },
      title: `Regrade requested: ${assignment.title}`,
      body: entryReason.slice(0, 300),
      linkUrl: `/professor/courses/${sectionId}/assignments/${assignmentId}?tab=grading`,
      actionable: false,
    })
  }
  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

/** Student withdraws their own open regrade request. */
export async function withdrawRegradeRequest(sectionId: string, requestId: string): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient()

  const { data: row } = await adminDb
    .from('assignment_regrade_requests')
    .select('id, student_id, section_id, assignment_id, status')
    .eq('id', requestId)
    .maybeSingle()
  // IDOR guard — same message whether the row is missing or simply isn't the caller's.
  if (!row || row.student_id !== user.id || row.section_id !== sectionId) {
    return { error: 'Request not found.' }
  }

  // Guarded transition: only an OPEN request the caller owns can be withdrawn (TOCTOU-safe).
  const { data: updated } = await adminDb
    .from('assignment_regrade_requests')
    .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('student_id', user.id)
    .eq('status', 'open')
    .select('id')
  if (!updated || updated.length === 0) return { error: 'This request has already been handled.' }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.regrade_withdrawn',
    eventCategory: 'course',
    sectionId,
    metadata: { requestId },
  })
  revalidatePath(`/student/courses/${sectionId}/assignments/${row.assignment_id}`)
  return { success: true }
}

/**
 * Flag a student's intent to submit late. Idempotent: if already requested, returns success.
 * Guards: assignment must be past due, no active reopen window, student is enrolled, not already submitted.
 * Stamps late_request_at via admin client (students never write the submissions table directly).
 * Emits a staff notification so the professor sees the request in their feed.
 */
export async function requestLateSubmission(
  sectionId: string,
  assignmentId: string,
): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  const adminDb = createAdminClient()

  const { data: assignment } = await adminDb
    .from('assignments')
    .select('id, section_id, status, institution_id, due_at, title')
    .eq('id', assignmentId)
    .maybeSingle()
  if (!assignment || assignment.section_id !== sectionId) {
    return { error: 'Assignment not found.' }
  }
  if (assignment.status !== 'published') {
    return { error: 'This assignment is not open.' }
  }

  // Must be past due for a late request to make sense.
  if (!isPastDue(assignment.due_at)) {
    return { error: "The assignment isn't past due yet. You can still submit on time." }
  }

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'active', 'completed'])
    .maybeSingle()
  if (!enrollment) return { error: "You're not enrolled in this course." }

  const { data: existing } = await adminDb
    .from('assignment_submissions')
    .select('id, status, resubmit_until, late_request_at')
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .maybeSingle()

  // No active reopen window — this is the condition that makes a late request useful.
  if (isReopenWindowActive(existing?.resubmit_until)) {
    return { error: 'Your submission window is already open.' }
  }

  // Can't request late if already submitted.
  if (existing?.status === 'submitted' || existing?.status === 'graded') {
    return { error: 'You have already submitted.' }
  }

  // Idempotent: if already requested, treat as success.
  if (existing?.late_request_at) {
    return { success: true }
  }

  const now = new Date().toISOString()

  // Upsert a draft stub (ignoreDuplicates — no-op if row exists), then stamp late_request_at.
  // The stamp uses .is('late_request_at', null) so a concurrent request can't double-stamp.
  const { error: stubError } = await adminDb
    .from('assignment_submissions')
    .upsert(
      {
        assignment_id: assignmentId,
        student_id: user.id,
        institution_id: assignment.institution_id,
        status: 'draft',
        files: [],
        created_at: now,
        updated_at: now,
      },
      { onConflict: 'assignment_id,student_id', ignoreDuplicates: true },
    )
  if (stubError) {
    logger.error('requestLateSubmission.stub', stubError, { assignmentId })
    return { error: 'Could not send your request. Please try again.' }
  }

  const { data: stamped } = await adminDb
    .from('assignment_submissions')
    .update({ late_request_at: now, updated_at: now })
    .eq('assignment_id', assignmentId)
    .eq('student_id', user.id)
    .is('late_request_at', null)
    .select('id')
  // 0 rows affected = already requested by a concurrent call — idempotent success.
  if (!stamped || stamped.length === 0) {
    return { success: true }
  }

  await logEvent({
    userId: user.id,
    eventType: 'assignment.late_submission_requested',
    eventCategory: 'course',
    sectionId,
    metadata: { assignmentId },
  })

  // Notify section staff.
  void emitEvent({
    type: 'late_submission_requested',
    sectionId,
    actorId: user.id,
    audience: await resolveStaffAudience(adminDb, sectionId),
    entity: { type: 'assignment', id: assignmentId },
    title: `Late submission requested: ${assignment.title}`,
    linkUrl: `/professor/courses/${sectionId}/assignments/${assignmentId}?tab=grading`,
    actionable: false,
  })

  revalidatePath(`/student/courses/${sectionId}/assignments/${assignmentId}`)
  // Also revalidate the professor grader: without this a withdrawn request keeps showing in their
  // "needs attention" bucket until something else revalidates, and clicking Resolve then errors
  // with "already resolved". The other three regrade/comment actions already revalidate both roles.
  revalidatePath(`/professor/courses/${sectionId}/assignments/${assignmentId}`)
  return { success: true }
}

// Students no longer post free-text comments — their per-subquestion action is "Request regrade"
// (see requestRegrade). Only staff comment on submissions (addSubmissionCommentAsStaff).
