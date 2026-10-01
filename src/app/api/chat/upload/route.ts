/**
 * Student attachment upload for Athena (the AI tutor dock) + Office→PDF conversion.
 *
 * The student-side twin of /api/professor-assistant/upload, over the same
 * private `athena-attachments` bucket and the same shared rules — only the
 * authorization gate and the path scope differ.
 *
 * One file per request (the composer uploads in parallel). Flow:
 *   auth (enrolled student) → validate against STUDENT_ATTACHMENTS → convert
 *   Office docs to PDF so Gemini can read them → upload with the service-role
 *   client. We return the storage PATH (persisted on the message) plus a
 *   short-lived signed URL for the optimistic composer preview.
 *
 * Path scope is `{institution}/{section}/{STUDENT}/…`, not the conversation the
 * professor route uses: a student's thread row is created lazily on their first
 * send, so from the greeting there is no conversation id to hang a file on. The
 * student is in fact the tighter binding — /api/chat rebuilds this exact prefix
 * and refuses any path outside it.
 *
 * Security: assume this is called unauthenticated by an attacker. getUser →
 * enrollment check before any storage write. Type/size are re-validated
 * server-side; the client's own checks are advisory.
 */

import { createClient } from '@/lib/supabase/server'
import { checkEntitlement } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import {
  ATHENA_ATTACHMENTS_BUCKET,
  ATHENA_SIGNED_URL_TTL_SECONDS,
  STUDENT_ATTACHMENTS,
  athenaAttachmentPath,
  validateAthenaUpload,
} from '@/lib/ai/athena-attachments'
import { convertOfficeToPdf, isPptxEnabled } from '@/lib/live-classroom/deck-converter'

export const runtime = 'nodejs'
export const maxDuration = 120 // headroom for LibreOffice conversion of big Office files

// Under maxDuration, so a slow conversion aborts while this handler is still alive
// and can return its own 422 — at the client's 120s default the two race and the
// caller gets a raw 504 instead.
const UPLOAD_CONVERT_TIMEOUT_MS = 100_000

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return bad('Invalid upload', 400)
  }

  const file = form.get('file')
  const sectionId = form.get('sectionId')

  if (!(file instanceof File)) return bad('No file provided')
  if (typeof sectionId !== 'string' || !sectionId) return bad('Missing sectionId')

  // 1. Authenticate
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return bad('Unauthorized', 401)

  // 2. Authorize — the caller must be enrolled in THIS section
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed', 'active'])
    .limit(1)
    .maybeSingle()
  if (!enrollment) return bad('Forbidden', 403)

  // 3. Validate against the student attachment limits (the server whitelist)
  const valid = validateAthenaUpload(file.name, file.size, STUDENT_ATTACHMENTS)
  if ('error' in valid) return bad(valid.error)

  // Institution id (for the tenant-scoped storage path) + the feature gate:
  // uploads are only reachable through Athena, so a professor who turned the
  // tutor off for this section must have this closed server-side too — not just
  // the dock hidden in the UI. Same `enabledFeatures` key the chat route checks.
  const { data: section } = await adminDb
    .from('course_sections')
    .select('institution_id, settings')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) return bad('Section not found', 404)
  const enabledFeatures = (section.settings as { enabledFeatures?: unknown } | null)?.enabledFeatures
  if (!Array.isArray(enabledFeatures) || !enabledFeatures.includes('athena')) {
    return bad('Athena is turned off for this course', 403)
  }

  // Institution/platform AI kill switch — uploads only exist to feed Athena.
  const aiVerdict = await checkAiFeature(adminDb, section.institution_id, 'athena-student')
  if (!aiVerdict.allowed) return bad(aiRefusalMessage(aiVerdict.lockedBy), 403)

  // Same split as the chat route: an upload exists only to feed Athena, so a
  // school without Athena must not be able to push bytes at it either.
  const entitlement = await checkEntitlement(adminDb, section.institution_id, 'athena')
  if (!entitlement.allowed) return bad(entitlementRefusalMessage('athena'), 403)

  // 4. Read bytes; convert Office → PDF if needed
  let bytes: Buffer = Buffer.from(await file.arrayBuffer())
  let storedExt = valid.ext
  if (valid.kind === 'office') {
    if (!isPptxEnabled()) return bad('Document conversion is temporarily unavailable', 503)
    try {
      bytes = await convertOfficeToPdf(bytes, file.name, { timeoutMs: UPLOAD_CONVERT_TIMEOUT_MS })
      storedExt = 'pdf'
    } catch (err) {
      logger.error('chat.upload: conversion failed', err, { sectionId, name: file.name })
      return bad('Could not convert that document — try exporting it as PDF', 422)
    }
  }

  // 5. Upload to the private bucket
  const path = athenaAttachmentPath({
    institutionId: section.institution_id,
    sectionId,
    scopeId: user.id,
    storedExt,
  })
  const { error: uploadError } = await adminDb.storage
    .from(ATHENA_ATTACHMENTS_BUCKET)
    .upload(path, bytes, { contentType: valid.storedContentType, upsert: false })
  if (uploadError) {
    logger.error('chat.upload: storage upload failed', uploadError, { sectionId })
    return bad('Upload failed — please try again', 500)
  }

  // Sign for the optimistic composer preview (the persisted message stores the path).
  const { data: signed } = await adminDb.storage
    .from(ATHENA_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, ATHENA_SIGNED_URL_TTL_SECONDS)

  logEvent({
    userId: user.id,
    eventType: 'ai_tutor.attachment_upload',
    eventCategory: 'student',
    metadata: { sectionId, kind: valid.kind, storedBytes: bytes.length, mediaType: valid.modelMediaType },
    sectionId,
  })

  return Response.json({
    path,
    displayName: file.name,
    mediaType: valid.modelMediaType,
    sizeBytes: bytes.length,
    signedUrl: signed?.signedUrl ?? '',
  })
}
