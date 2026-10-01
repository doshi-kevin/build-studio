// Shared authorization for the source-document preview routes: resolve a request
// param to a storage path, and decide whether THIS user may see its bytes.
//
// Extracted verbatim from /api/extraction/page when /api/extraction/pdf was added
// (which serves the whole converted deck to the material viewer). Two routes both
// hand a storage path to the RLS-BYPASSING admin client, so the decision has to
// live in one place: a second copy would let the two drift, and the drift would be
// an IDOR on course material.
//
// Assume every caller is an attacker with arbitrary ids/paths. Both modes resolve
// the section FROM the id/path and authorize against it before Storage is touched.
//
// SERVER-ONLY.

import 'server-only'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { isSafeStoragePath } from '@/lib/supabase/storage'
import { isUnlockPending } from '@/lib/modules/unlock'
import { logger } from '@/lib/logger'

// The admin Supabase client is intentionally loosely typed across the codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type PreviewSource =
  | {
      ok: true
      filePath: string
      /** The item's STORED extraction, for resolving asset refs. Absent in path mode. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      itemExtraction?: any
    }
  | { ok: false; status: 400 | 403 | 404; message: string }

const deny = (status: 400 | 403 | 404, message: string): PreviewSource => ({ ok: false, status, message })

/**
 * Resolve + authorize a preview source.
 *
 *   itemId   — a module file. Enrolled student of the item's section OR its
 *              professor/TA/grader.
 *   filePath — an ad-hoc quiz upload under `{sectionId}/quiz-ai-uploads/`.
 *              Section staff ONLY (it's a professor-only aid and may contain
 *              answer material).
 *
 * Exactly one of the two must be supplied.
 */
export async function resolvePreviewSource(
  adminDb: AdminDb,
  userId: string,
  params: { itemId?: string | null; filePath?: string | null },
): Promise<PreviewSource> {
  const { itemId, filePath: filePathParam } = params
  if (!itemId && !filePathParam) return deny(400, 'Bad request')

  if (filePathParam) {
    // ── Upload mode: section is the path's first segment; staff-only. ──
    const sectionId = filePathParam.split('/')[0] || undefined
    if (!sectionId) return deny(400, 'Bad request')
    // The dialog only ever uploads under this prefix — reject anything else, plus
    // any `..` traversal, so the authz decision on `sectionId` can't be decoupled
    // from the bytes we then read (and the derived-PDF path we write) with the
    // RLS-bypassing admin client.
    if (!isSafeStoragePath(filePathParam, `${sectionId}/quiz-ai-uploads/`)) {
      return deny(403, 'Forbidden')
    }
    const access = await verifySectionAccess(sectionId, userId)
    if (!access.ok) return deny(403, 'Forbidden')
    return { ok: true, filePath: filePathParam }
  }

  // ── Module-item mode: resolve item → section; enrolled student OR staff. ──
  const { data: item } = await adminDb
    .from('module_items')
    .select('id, module_id, content, is_visible')
    .eq('id', itemId)
    .maybeSingle()
  if (!item) return deny(404, 'Not found')

  const { data: mod } = await adminDb
    .from('modules')
    .select('section_id, is_published, unlock_date')
    .eq('id', item.module_id)
    .maybeSingle()
  const sectionId: string | undefined = mod?.section_id
  if (!sectionId) return deny(404, 'Not found')

  /* Hidden items / unpublished modules (e.g. ad-hoc "Quiz Uploads", which may
     contain answer material) are staff-only — enrollment isn't enough. A module
     that hasn't reached its `unlock_date` joins them: these routes return the
     source file's pages, and the item ids are not secret (the AI-tutor page ships
     them to the browser), so enrollment alone would make an unopened week's
     slides directly addressable.

     `=== true`, not `!== false`: both columns are nullable, and NULL is not a
     claim that students may see it. */
  const studentRenderable =
    item.is_visible === true && mod?.is_published === true && !isUnlockPending(mod?.unlock_date)
  let authorized = false
  if (studentRenderable) {
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', userId)
      .in('status', ['enrolled', 'completed', 'active'])
      .maybeSingle()
    authorized = !!enrollment
  }
  if (!authorized) {
    const access = await verifySectionAccess(sectionId, userId)
    authorized = access.ok
  }
  if (!authorized) return deny(403, 'Forbidden')

  const content = (item.content ?? {}) as { filePath?: string }
  if (!content.filePath) return deny(404, 'Not found')
  /* Bind the stored path to the section we just authorized against. The item is
     tenant-scoped but `content.filePath` is a free-form string a professor set when
     creating the item, and it is about to be read with the RLS-bypassing admin
     client — without this, an item in a section you own can name another
     institution's object and we render it back to you. */
  if (!isSafeStoragePath(content.filePath, `${sectionId}/`)) {
    logger.warn('resolvePreviewSource: stored filePath outside section prefix', {
      source: 'extraction.resolvePreviewSource',
      itemId,
      sectionId,
      userId,
    })
    return deny(404, 'Not found')
  }

  return {
    ok: true,
    filePath: content.filePath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itemExtraction: (item.content as any)?.extraction,
  }
}
