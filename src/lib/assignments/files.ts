/**
 * Server-side helpers for assignment submission files.
 *
 * Uploads and downloads go through the admin client in server actions
 * (authorization is checked upstream), so these helpers focus on validating
 * untrusted uploads and building safe, predictable storage paths.
 */

import {
  extensionsForKinds,
  mimesForKinds,
  MAX_SUBMISSION_FILE_SIZE,
  type FileTypeKind,
} from '@/lib/validations/assignment'

export interface FileValidationResult {
  ok: boolean
  error?: string
  /** Why it failed, so callers can decide whether naming the accepted types helps. Appending
   *  "Accepted: PDF" to a SIZE failure misdirects a student whose format was already right. */
  reason?: 'no-uploads' | 'empty' | 'too-large' | 'wrong-type'
}

/** Lowercased extension without the dot, or '' if none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase()
}

/**
 * Validate one uploaded file against the assignment's allowed kinds + size cap.
 * Checks extension primarily; rejects a present-but-mismatched MIME type
 * (browsers sometimes omit the type, which we tolerate and fall back to ext).
 */
export function validateSubmissionFile(
  file: { name: string; size: number; type: string },
  allowedKinds: FileTypeKind[],
): FileValidationResult {
  if (allowedKinds.length === 0) {
    return { ok: false, error: 'This assignment does not accept file uploads.', reason: 'no-uploads' }
  }
  if (file.size <= 0) {
    return { ok: false, error: `"${file.name}" is empty.`, reason: 'empty' }
  }
  if (file.size > MAX_SUBMISSION_FILE_SIZE) {
    return { ok: false, error: `"${file.name}" is larger than 25 MB.`, reason: 'too-large' }
  }
  const ext = extensionOf(file.name)
  const allowedExts = extensionsForKinds(allowedKinds)
  if (!ext || !allowedExts.includes(ext)) {
    return { ok: false, error: `"${file.name}" is not an accepted file type.`, reason: 'wrong-type' }
  }
  // Some browsers report archives/odd types as the generic octet-stream — treat
  // that (and a missing type) as unknown and fall back to the extension check.
  const allowedMimes = mimesForKinds(allowedKinds)
  const genericMime = file.type === 'application/octet-stream'
  if (file.type && !genericMime && !allowedMimes.includes(file.type)) {
    return { ok: false, error: `"${file.name}" doesn't match an accepted file type.`, reason: 'wrong-type' }
  }
  return { ok: true }
}

/** Strip path separators and odd characters from a user-supplied file name. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_')
  return cleaned.slice(0, 120) || 'file'
}

/**
 * Storage path for a submission file in the `assignment-submissions` bucket.
 * Layout `{sectionId}/{assignmentId}/{studentId}/{file}` — segment 1 (section)
 * and segment 3 (student) drive the bucket's owner/staff RLS. `unique` keeps
 * same-named re-uploads from colliding.
 */
export function buildSubmissionPath(
  sectionId: string,
  assignmentId: string,
  studentId: string,
  fileName: string,
  unique: string,
): string {
  return `${sectionId}/${assignmentId}/${studentId}/${unique}-${sanitizeFileName(fileName)}`
}
