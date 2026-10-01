// Signed-URL helpers for the private course-materials bucket.
//
// Reads in the app go through one of these helpers, which mint a fresh
// signed URL with a short TTL each time the data is rendered. We never
// persist signed URLs — the DB stores the storage path, and signing
// happens at read time so URLs expire and can't be hot-linked.
//
// Tenant isolation is enforced at the storage RLS layer (see migration 48):
// these helpers use the admin client (bypasses RLS), so the caller's
// access verification must happen UPSTREAM in the action that calls them.
// Most callers wrap this in a server action that does verifySectionAccess
// or verifyEnrollment first. Server-only by convention — admin client
// imports the SUPABASE_SERVICE_ROLE_KEY which throws if read on the client.

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

export const COURSE_MATERIALS_SIGNED_URL_TTL = 60 * 60 // 1 hour
export const PROCTORING_SIGNED_URL_TTL = 60 * 60 // 1 hour
export const LIVE_CLASSROOM_SIGNED_URL_TTL = 60 * 60 * 6 // 6 hours (long sessions)
export const PROJECT_CHAT_SIGNED_URL_TTL = 60 * 15 // 15 minutes
// Announcement attachments: students may leave the feed open for a while, so
// sign long enough that a click doesn't 403 mid-session.
export const ANNOUNCEMENT_SIGNED_URL_TTL = 60 * 60 * 12 // 12 hours

/**
 * Mint a signed URL for a single storage path. Returns null on failure
 * (logged) or empty path. Caller MUST have verified access already.
 */
export async function signOne(
  bucket: string,
  path: string | null | undefined,
  ttl: number = COURSE_MATERIALS_SIGNED_URL_TTL,
): Promise<string | null> {
  if (!path) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb.storage.from(bucket).createSignedUrl(path, ttl)
  if (error) {
    logger.error('signOne: createSignedUrl failed', error, { bucket, path })
    return null
  }
  return data?.signedUrl ?? null
}

/**
 * Largest number of paths sent to createSignedUrls in one request.
 *
 * The whole set used to go in a single call, which was fine when the biggest
 * caller was one module (~10 paths). The Modules board signs an entire course
 * at once — 378 paths on a real section — and one oversized request that
 * errors takes down EVERY file link on the page at the same time. Chunking
 * bounds each request and contains the blast radius of a failure to its own
 * chunk.
 */
const SIGN_BATCH_SIZE = 100

/**
 * Mint signed URLs for many paths. Returns a Map keyed by path.
 * Paths that fail to sign are silently omitted (logged) — callers keep their
 * original values and a broken link surfaces per-item rather than blanking
 * the page.
 */
export async function signMany(
  bucket: string,
  paths: Array<string | null | undefined>,
  ttl: number = COURSE_MATERIALS_SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const cleanPaths = Array.from(new Set(paths.filter(Boolean) as string[]))
  if (cleanPaths.length === 0) return result

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const batches: string[][] = []
  for (let i = 0; i < cleanPaths.length; i += SIGN_BATCH_SIZE) {
    batches.push(cleanPaths.slice(i, i + SIGN_BATCH_SIZE))
  }

  const responses = await Promise.all(
    batches.map(async (batch) => {
      /* storage-js RETURNS StorageErrors but RETHROWS anything else (a fetch
         failure, a timeout). An uncaught throw here rejects Promise.all and
         loses every URL on the page — the exact outcome chunking exists to
         prevent — so a throw has to degrade the same way a returned error
         does: skip this chunk, keep the rest. */
      try {
        const { data, error } = await adminDb.storage.from(bucket).createSignedUrls(batch, ttl)
        if (error) {
          logger.error('signMany: createSignedUrls failed', error, {
            bucket,
            count: batch.length,
            totalPaths: cleanPaths.length,
          })
          return []
        }
        return data || []
      } catch (thrown) {
        logger.error('signMany: createSignedUrls threw', thrown, {
          bucket,
          count: batch.length,
          totalPaths: cleanPaths.length,
        })
        return []
      }
    }),
  )

  for (const rows of responses) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(rows as any[]).forEach((row) => {
      if (row?.path && row?.signedUrl) result.set(row.path, row.signedUrl)
    })
  }
  return result
}

/**
 * Best-effort: extract the storage path from a legacy public URL of the
 * form https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>.
 * Returns null if the URL doesn't match. Use as a fallback for rows whose
 * path column wasn't backfilled.
 */
export function extractPathFromPublicUrl(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null
  const marker = `/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return url.slice(idx + marker.length)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QuestionLike = { imageUrl?: string | null; imagePath?: string | null; [key: string]: any }

/**
 * Re-sign quiz-question images at read time. We store the signed URL the
 * professor first picked into `image_url` for legacy convenience, but its
 * TTL expires within an hour and the underlying bucket is private (mig 48),
 * so the persisted URL will eventually 403. The path in `image_path` (or
 * extractable from the legacy public URL) is the source of truth — we
 * mint a fresh short-TTL URL per render.
 *
 * Single batch round-trip even for a 100-question quiz. Falls back to the
 * stored URL when no path can be resolved (preserves test fixtures and
 * legitimately-public assets like prior code-snippet hosts).
 */
async function _signQuestionImagesImpl(questions: QuestionLike[]): Promise<QuestionLike[]> {
  if (questions.length === 0) return questions

  const paths: Array<string | null> = questions.map((q) => {
    if (typeof q.imagePath === 'string' && q.imagePath) return q.imagePath
    return extractPathFromPublicUrl(q.imageUrl ?? null, 'course-materials')
  })

  const hasAny = paths.some(Boolean)
  if (!hasAny) return questions

  const signed = await signMany('course-materials', paths)
  return questions.map((q, i) => {
    const path = paths[i]
    if (!path) return q
    const url = signed.get(path)
    if (!url) return q
    return { ...q, imageUrl: url, imagePath: path }
  })
}

export async function signQuestionImages<T extends QuestionLike>(questions: T[]): Promise<T[]> {
  // Cast around the internal implementation so call-sites passing the concrete
  // `Question` shape don't see their type widened to QuestionLike.
  return (await _signQuestionImagesImpl(questions)) as T[]
}

/** Singleton convenience — same pattern, returns the input unchanged on miss. */
export async function signQuestionImage<T extends QuestionLike>(question: T | null): Promise<T | null> {
  if (!question) return question
  const [signed] = await signQuestionImages([question])
  return signed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnnouncementRowLike = { attachments?: any; [key: string]: any }

/**
 * Re-sign announcement file attachments for browser consumption. Attachments
 * live in the private course-materials bucket (mig 48); the signed `fileUrl`
 * persisted at upload time expires within an hour, so a stored URL eventually
 * 403s. The `filePath` is the source of truth — we mint a fresh signed URL per
 * render (falling back to extracting the path from a legacy public `fileUrl`).
 *
 * One signMany round-trip for the whole page regardless of attachment count.
 * Rows/attachments whose path can't be resolved keep their original fields.
 * Server-only (admin client) — callers must verify section access upstream.
 */
export async function signAnnouncementAttachments<T extends AnnouncementRowLike>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows

  // Resolve a storage path for every attachment across every row.
  const resolvePath = (att: { filePath?: string; fileUrl?: string }): string | null => {
    if (typeof att.filePath === 'string' && att.filePath) return att.filePath
    return extractPathFromPublicUrl(att.fileUrl ?? null, 'course-materials')
  }

  const allPaths: string[] = []
  for (const row of rows) {
    const attachments = Array.isArray(row.attachments) ? row.attachments : []
    for (const att of attachments) {
      const path = resolvePath(att)
      if (path) allPaths.push(path)
    }
  }

  if (allPaths.length === 0) return rows

  const signed = await signMany('course-materials', allPaths, ANNOUNCEMENT_SIGNED_URL_TTL)

  return rows.map((row) => {
    const attachments = Array.isArray(row.attachments) ? row.attachments : null
    if (!attachments || attachments.length === 0) return row

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newAttachments = attachments.map((att: any) => {
      const path = resolvePath(att)
      const url = path ? signed.get(path) : undefined
      if (!url || !path) return att
      return { ...att, fileUrl: url, filePath: path }
    })
    return { ...row, attachments: newAttachments }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModuleItemLike = { id?: string; content?: any; [key: string]: any }

/**
 * Re-sign a batch of module_items for browser consumption. Replaces:
 *   • content.fileUrl                          ← from content.filePath
 *   • content.extraction.images[].storageUrl   ← from each image's storagePath
 *
 * One signMany round-trip regardless of how many images per item, so a
 * 50-image lecture costs one network call, not 51. Items whose paths can't
 * be resolved keep their original fields — the broken `<img>` will surface
 * via onError, but one bad row doesn't break the rest of the page.
 *
 * Used by professor `getModuleWithItems` and the student modules page so
 * both render extracted images correctly after course-materials went
 * private (mig 48).
 */
export async function signModuleItemContent<T extends ModuleItemLike>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items

  const filePaths: Array<string | null> = items.map((item) => {
    const c = item.content || {}
    if (typeof c.filePath === 'string' && c.filePath) return c.filePath
    if (typeof c.fileUrl === 'string' && c.fileUrl) {
      return extractPathFromPublicUrl(c.fileUrl, 'course-materials')
    }
    return null
  })

  const imagePaths: string[] = []
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgs = (item.content?.extraction?.images ?? []) as any[]
    for (const img of imgs) {
      if (img && typeof img.storagePath === 'string' && img.storagePath) {
        imagePaths.push(img.storagePath)
      }
    }
  }

  const signed = await signMany('course-materials', [...filePaths, ...imagePaths])

  return items.map((item, i) => {
    const filePath = filePaths[i]
    const fileSignedUrl = filePath ? signed.get(filePath) : undefined
    const content = { ...(item.content || {}) }

    if (fileSignedUrl && filePath) {
      content.fileUrl = fileSignedUrl
      content.filePath = filePath
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgs = content.extraction?.images as any[] | undefined
    if (Array.isArray(imgs) && imgs.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newImgs = imgs.map((img: any) => {
        if (!img || typeof img.storagePath !== 'string') return img
        const url = signed.get(img.storagePath)
        if (!url) return img
        return { ...img, storageUrl: url }
      })
      content.extraction = { ...(content.extraction || {}), images: newImgs }
    }

    return { ...item, content }
  })
}
