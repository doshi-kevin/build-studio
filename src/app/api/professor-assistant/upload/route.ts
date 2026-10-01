/**
 * Athena attachment upload + Office→PDF conversion.
 *
 * One file per request (the composer uploads files in parallel). Flow:
 *   auth (section staff) → validate against the model's limits → upload to the
 *   private athena-attachments bucket. Office docs (docx/pptx/xlsx) are first
 *   converted to PDF via Gotenberg so Gemini can read them; PDFs/images/text
 *   pass through. We return the storage PATH (persisted on the message) plus a
 *   short-lived signed URL for the optimistic composer preview.
 *
 * Security: assume this is called unauthenticated by an attacker. getUser →
 * verifySectionAccess → canWriteAsStaff before any storage write. Type/size are
 * re-validated server-side against the model whitelist; the client is untrusted.
 */

import { createClient } from '@/lib/supabase/server'
import { checkEntitlement } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { checkAiFeature } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { resolveAthenaModelDef } from '@/lib/ai/professor-assistant/models'
import {
  ATHENA_ATTACHMENTS_BUCKET,
  ATHENA_SIGNED_URL_TTL_SECONDS,
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

// conversationId becomes a SEGMENT of the storage path, so pin its shape here
// rather than leaning on the uuid column cast in the ownership lookup to reject a
// malformed one. That rejection is a side effect of a column type: reorder the
// lookup below the path build and a raw client string silently becomes a path
// segment. Same pattern the chat route applies to the same value.
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return bad('Invalid upload', 400)
  }

  const file = form.get('file')
  const sectionId = form.get('sectionId')
  const conversationId = form.get('conversationId')
  const modelId = form.get('modelId')

  if (!(file instanceof File)) return bad('No file provided')
  if (typeof sectionId !== 'string' || !sectionId) return bad('Missing sectionId')
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    return bad('Missing or invalid conversation id')
  }

  // 1. Authenticate
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return bad('Unauthorized', 401)

  // 2. Authorize — section staff who can write (professor or TA)
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) return bad('Forbidden', 403)
  const adminDb = access.adminDb

  // 3. Validate against the (whitelisted) model's attachment limits
  const def = resolveAthenaModelDef(typeof modelId === 'string' ? modelId : undefined)
  const valid = validateAthenaUpload(file.name, file.size, def.attachments)
  if ('error' in valid) return bad(valid.error)

  // Ownership: if this conversation already exists, it must belong to this
  // user + section (a fresh chat hasn't been persisted yet → allowed).
  //
  // Fail CLOSED on a query error. `data` is null both when there is no row and
  // when the lookup itself failed, and only the first of those means "new chat".
  // Reading the second as new would let a transient DB blip wave through an
  // upload into someone else's conversation prefix, written with the
  // RLS-bypassing admin client and handed back as a signed URL. The chat route
  // resolves the same ambiguity the same way.
  const { data: convo, error: convoError } = await adminDb
    .from('athena_conversations')
    .select('section_id, user_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (convoError) {
    logger.error('professor-assistant.upload: conversation ownership lookup failed', convoError, {
      sectionId,
      conversationId,
    })
    return bad('Could not verify this conversation', 500)
  }
  if (convo && (convo.section_id !== sectionId || convo.user_id !== user.id)) {
    return bad('Forbidden', 403)
  }

  // Institution id (for the tenant-scoped storage path)
  const { data: section } = await adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section?.institution_id) return bad('Section not found', 404)

  // Institution/platform AI kill switch — uploads only exist to feed Athena.
  const aiVerdict = await checkAiFeature(adminDb, section.institution_id, 'athena-professor')
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
      logger.error('professor-assistant.upload: conversion failed', err, { sectionId, name: file.name })
      return bad('Could not convert that document — try exporting it as PDF', 422)
    }
  }

  // 5. Upload to the private bucket
  const path = athenaAttachmentPath({
    institutionId: section.institution_id,
    sectionId,
    scopeId: conversationId,
    storedExt,
  })
  const { error: uploadError } = await adminDb.storage
    .from(ATHENA_ATTACHMENTS_BUCKET)
    .upload(path, bytes, { contentType: valid.storedContentType, upsert: false })
  if (uploadError) {
    logger.error('professor-assistant.upload: storage upload failed', uploadError, { sectionId })
    return bad('Upload failed — please try again', 500)
  }

  // Sign for the optimistic composer preview (the persisted message stores the path).
  const { data: signed } = await adminDb.storage
    .from(ATHENA_ATTACHMENTS_BUCKET)
    .createSignedUrl(path, ATHENA_SIGNED_URL_TTL_SECONDS)

  logEvent({
    userId: user.id,
    eventType: 'professor_assistant.attachment_upload',
    eventCategory: 'professor',
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
