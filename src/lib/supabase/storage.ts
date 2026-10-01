/**
 * Supabase Storage Utilities — upload, delete, and get URLs for files.
 *
 * Uses the browser client for uploads from client components.
 * Bucket: "course-materials" for all module item files.
 *
 * Storage isolation status (after migration 48):
 * - course-materials is PRIVATE — public URLs no longer resolve.
 *   Uploads now mint a short-lived signed URL for the immediate upload-preview.
 *   Persisted DB rows store the `path` only; readers mint fresh signed URLs
 *   at render time via `signOne` / `signMany` in `signed-urls.ts`.
 *
 * File path format: {sectionId}/{moduleId}/{itemId}/{filename}
 */

import { createClient } from '@/lib/supabase/client'

export const COURSE_MATERIALS_BUCKET = 'course-materials'
export const ASSIGNMENT_SUBMISSIONS_BUCKET = 'assignment-submissions'
/** PUBLIC bucket for professor-uploaded notebook/verbal cell images. Public because
 *  the reference is persisted in the doc and must resolve in the offline HTML export
 *  (see docs/designs/assignments-grading/assignment-studio-consolidated.md). */
export const ASSIGNMENT_CELL_IMAGES_BUCKET = 'assignment-cell-images'
export const PROJECT_VIDEOS_BUCKET = 'project-videos'
export const COURSE_RESOURCES_BUCKET = 'course-resources'
export const CHALLENGE_SUBMISSIONS_BUCKET = 'challenge-submissions'

/** TTL for the upload-time preview signed URL. Readers re-sign at render
 *  time, so this only needs to be long enough for the optimistic upload UI. */
const UPLOAD_PREVIEW_TTL_SECONDS = 60 * 60

export interface UploadResult {
  url: string
  path: string
  fileName: string
  fileSize: number
  mimeType: string
}

/**
 * Sanitize a filename for storage: keep extension, strip unsafe chars,
 * append a millisecond timestamp to prevent name collisions.
 */
function buildStoragePath(folder: string, file: File): string {
  const ext = file.name.split('.').pop() || ''
  const baseName = file.name
    .replace(`.${ext}`, '')
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .slice(0, 60)
  const timestamp = Date.now()
  return `${folder}/${baseName}_${timestamp}.${ext}`
}

/**
 * Upload to a private bucket and return a short-lived signed URL for
 * immediate preview. Persisted reads should re-sign from `path` at
 * render time — never trust the returned `url` past its TTL.
 */
async function uploadToPrivateBucket(
  bucket: string,
  filePath: string,
  file: File,
): Promise<{ data: UploadResult | null; error: string | null }> {
  const supabase = createClient()

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
    })

  if (uploadError) {
    return { data: null, error: uploadError.message }
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, UPLOAD_PREVIEW_TTL_SECONDS)

  if (signError || !signed?.signedUrl) {
    return { data: null, error: 'Upload succeeded but preview URL failed' }
  }

  return {
    data: {
      url: signed.signedUrl,
      path: filePath,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    },
    error: null,
  }
}

/**
 * Upload a file to the course-materials bucket (module items, formula sheets).
 * Path: `{folder}/{baseName}_{timestamp}.{ext}` where folder is typically
 * `{sectionId}/{moduleId}/{itemId}` for module items or
 * `formula-sheets/{sectionId}/{quizId}` for formula sheets.
 */
export async function uploadFile(
  file: File,
  folder: string,
): Promise<{ data: UploadResult | null; error: string | null }> {
  try {
    return await uploadToPrivateBucket(COURSE_MATERIALS_BUCKET, buildStoragePath(folder, file), file)
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Delete a file from Supabase Storage.
 */
export async function deleteFile(
  filePath: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase.storage
      .from(COURSE_MATERIALS_BUCKET)
      .remove([filePath])

    return { error: error?.message || null }
  } catch {
    return { error: 'Delete failed' }
  }
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Upload a resource file to the course-resources bucket.
 * Path: `{courseId}/{baseName}_{timestamp}.{ext}`
 *
 * Note: course-resources bucket is currently unused in production but kept
 * here for forward-compat. If/when it's enabled, follow the chat-attachments
 * pattern: private + RLS by course access + signed URLs.
 */
export async function uploadResourceFile(
  file: File,
  courseId: string,
): Promise<{ data: UploadResult | null; error: string | null }> {
  try {
    return await uploadToPrivateBucket(
      COURSE_RESOURCES_BUCKET,
      buildStoragePath(courseId, file),
      file,
    )
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Delete a resource file from the course-resources bucket.
 */
export async function deleteResourceFile(
  filePath: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase.storage
      .from(COURSE_RESOURCES_BUCKET)
      .remove([filePath])

    return { error: error?.message || null }
  } catch {
    return { error: 'Delete failed' }
  }
}

/**
 * Upload a challenge submission file. Path: `{sectionId}/{baseName}_{timestamp}.{ext}`.
 */
export async function uploadChallengeFile(
  file: File,
  sectionId: string,
): Promise<{ data: UploadResult | null; error: string | null }> {
  try {
    return await uploadToPrivateBucket(
      CHALLENGE_SUBMISSIONS_BUCKET,
      buildStoragePath(sectionId, file),
      file,
    )
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Delete a challenge submission file.
 */
export async function deleteChallengeFile(
  filePath: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase.storage
      .from(CHALLENGE_SUBMISSIONS_BUCKET)
      .remove([filePath])

    return { error: error?.message || null }
  } catch {
    return { error: 'Delete failed' }
  }
}

/**
 * Upload a file to the professor's warehouse. Path: `warehouse/{professorId}/...`
 * Lives in the course-materials bucket. The RLS policy on course-materials
 * gates warehouse paths to the owning professor only (mig 48).
 */
export async function uploadWarehouseFile(
  file: File,
  professorId: string,
): Promise<{ data: UploadResult | null; error: string | null }> {
  try {
    return await uploadToPrivateBucket(
      COURSE_MATERIALS_BUCKET,
      buildStoragePath(`warehouse/${professorId}`, file),
      file,
    )
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Accepted MIME types per item category.
 */
export const ACCEPTED_FILE_TYPES: Record<string, string> = {
  lecture: '.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg',
  video: '.mp4,.mov,.avi,.webm,.mkv',
  reference: '.pdf,.doc,.docx,.txt,.epub',
  image: '.png,.jpg,.jpeg,.gif,.webp,.svg',
}

/**
 * Infer a lecture's `fileType` from its filename extension. The format is the
 * file's own property — we read it instead of asking the professor to restate it
 * in a dropdown (which defaulted to 'pdf' and silently mis-routed a forgotten
 * .pptx to the PDF extractor). Returns the canonical fileType the extraction
 * dispatcher routes on; 'notes' is the fallback for text/unknown (no extractor).
 */
export type LectureFileType = 'pdf' | 'ppt' | 'docx' | 'xlsx' | 'image' | 'text' | 'notes'

export function inferLectureFileType(fileName: string): LectureFileType {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'pdf':
      return 'pdf'
    case 'ppt':
    case 'pptx':
      return 'ppt'
    case 'doc':
    case 'docx':
      return 'docx'
    case 'xls':
    case 'xlsx':
      return 'xlsx'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return 'image'
    case 'txt':
    case 'md':
      // Read by the plain-text extractor. Previously 'notes', which no
      // extractor handled — the file was stored and then ignored entirely.
      return 'text'
    default:
      return 'notes'
  }
}

/**
 * True if `path` is a safe storage key confined to `requiredPrefix`: no `..`
 * segments, not absolute, no backslashes, and actually under the prefix.
 * Callers authorize against the section encoded in the prefix and then read
 * the path with the RLS-bypassing admin client, so the path must not be able
 * to escape it — never rely on Supabase Storage treating keys literally
 * (it does today; that's an implementation detail, not a guarantee).
 */
export function isSafeStoragePath(path: string, requiredPrefix: string): boolean {
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false
  return path.startsWith(requiredPrefix)
}

/** Accepted file types for course intel resources. */
export const RESOURCE_FILE_TYPES = '.pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.zip'

/** Max resource file size in bytes (25 MB). */
export const MAX_RESOURCE_SIZE = 25 * 1024 * 1024

/**
 * Max file size in bytes (50 MB).
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024
