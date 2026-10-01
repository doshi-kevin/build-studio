/**
 * Chat attachment upload utilities — uploads to the private
 * `chat-attachments` bucket and returns a short-lived signed URL.
 *
 * Path layout: `{teamId}/{channelId}/{yyyy}/{mm}/{uuid}.{ext}`
 * The team_id prefix is what the storage.objects RLS policy checks
 * via `is_team_member()`, so the layout is load-bearing — do not
 * reorder the segments.
 *
 * Supported file types: PDF + images (png, jpg, webp, gif). Both the
 * bucket and the client input[accept] enforce this; the server action
 * does a final Zod-level check on mime type.
 */

import { createClient } from '@/lib/supabase/client'

export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments'

/**
 * Legacy public bucket historically used by course-level discussion
 * chat. Kept only as a constant for message rows that still reference
 * it — all new uploads go to the private `chat-attachments` bucket.
 */
export const LEGACY_DISCUSSION_BUCKET = 'project-chat'

/** Max attachment size: 25 MB — matches the bucket-level limit. */
export const MAX_CHAT_ATTACHMENT_SIZE = 25 * 1024 * 1024

/** Signed-URL TTL used for fresh uploads and batch reads (seconds). */
export const CHAT_SIGNED_URL_TTL_SECONDS = 900 // 15 minutes

/**
 * Accept filter for the file picker — PDFs and images only. The server
 * bucket is configured with the same allowlist via `allowed_mime_types`.
 */
export const CHAT_ACCEPTED_TYPES = '.pdf,.png,.jpg,.jpeg,.webp,.gif'

const ALLOWED_MIME_PREFIXES = ['image/']
const ALLOWED_MIME_EXACT = ['application/pdf']

export interface ChatUploadResult {
  /** Signed URL valid for `CHAT_SIGNED_URL_TTL_SECONDS`. Used for the optimistic preview only. */
  url: string
  /** Storage path — this is what we persist on the message record. */
  path: string
  fileName: string
  fileSize: number
  mimeType: string
}

function isAllowedMime(mime: string): boolean {
  return (
    ALLOWED_MIME_EXACT.includes(mime) ||
    ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))
  )
}

function randomFilename(ext: string): string {
  // crypto.randomUUID() is fine in all modern browsers; fall back to a
  // timestamp+rand id if it's missing.
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return ext ? `${id}.${ext}` : id
}

/**
 * Upload a chat attachment for project team chat.
 */
export async function uploadChatAttachment(
  file: File,
  teamId: string,
  channelId: string,
): Promise<{ data: ChatUploadResult | null; error: string | null }> {
  try {
    if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
      return { data: null, error: 'File is too large (max 25 MB)' }
    }
    if (!isAllowedMime(file.type)) {
      return {
        data: null,
        error: 'Only PDFs and images (PNG, JPG, WEBP, GIF) are supported',
      }
    }

    const supabase = createClient()

    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const now = new Date()
    const yyyy = String(now.getUTCFullYear())
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const filePath = `${teamId}/${channelId}/${yyyy}/${mm}/${randomFilename(ext)}`

    const { error: uploadError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      })

    if (uploadError) {
      return { data: null, error: uploadError.message }
    }

    // Sign immediately for the optimistic preview. Viewers reading
    // the message later call `signChatAttachmentPaths` to mint fresh
    // URLs — we never persist the signed URL.
    const { data: signed, error: signError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .createSignedUrl(filePath, CHAT_SIGNED_URL_TTL_SECONDS)

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
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Course-level discussion chat. Uploads land in the private
 * `chat-attachments` bucket under `discussions/{sectionId}/{channelId}/…`
 * so storage RLS (see migration 027) can gate reads/writes via
 * `is_enrolled_or_professor`. Rendering uses the batched signed-URL
 * resolver in `signed-urls.ts`.
 */
export async function uploadDiscussionAttachment(
  file: File,
  sectionId: string,
  channelId: string,
): Promise<{ data: ChatUploadResult | null; error: string | null }> {
  try {
    if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
      return { data: null, error: 'File is too large (max 25 MB)' }
    }
    if (!isAllowedMime(file.type)) {
      return {
        data: null,
        error: 'Only PDFs and images (PNG, JPG, WEBP, GIF) are supported',
      }
    }

    const supabase = createClient()

    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const now = new Date()
    const yyyy = String(now.getUTCFullYear())
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const filePath = `discussions/${sectionId}/${channelId}/${yyyy}/${mm}/${randomFilename(ext)}`

    const { error: uploadError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      })

    if (uploadError) {
      return { data: null, error: uploadError.message }
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .createSignedUrl(filePath, CHAT_SIGNED_URL_TTL_SECONDS)

    if (signError || !signed?.signedUrl) {
      return { data: null, error: 'Upload succeeded but preview URL failed' }
    }

    return {
      data: {
        // Signed URL is only for the optimistic preview — the persisted
        // row stores `attachment_path` and readers mint fresh URLs.
        url: signed.signedUrl,
        path: filePath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      },
      error: null,
    }
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * DM attachment upload. Path layout `dms/{channelId}/{yyyy}/{mm}/…`.
 * RLS on storage.objects (migration 027) gates by DM participant.
 */
export async function uploadDmAttachment(
  file: File,
  channelId: string,
): Promise<{ data: ChatUploadResult | null; error: string | null }> {
  try {
    if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
      return { data: null, error: 'File is too large (max 25 MB)' }
    }
    if (!isAllowedMime(file.type)) {
      return {
        data: null,
        error: 'Only PDFs and images (PNG, JPG, WEBP, GIF) are supported',
      }
    }

    const supabase = createClient()
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const now = new Date()
    const yyyy = String(now.getUTCFullYear())
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const filePath = `dms/${channelId}/${yyyy}/${mm}/${randomFilename(ext)}`

    const { error: uploadError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      })

    if (uploadError) {
      return { data: null, error: uploadError.message }
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(CHAT_ATTACHMENTS_BUCKET)
      .createSignedUrl(filePath, CHAT_SIGNED_URL_TTL_SECONDS)

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
  } catch {
    return { data: null, error: 'Upload failed' }
  }
}

/**
 * Batch-sign chat attachment paths. Used by MessageBubble to resolve
 * `attachment_path` values into displayable URLs. The TTL is short
 * (15 min) to limit the blast radius of leaked links.
 *
 * Returns a Map keyed by path; missing/failed paths are simply absent.
 */
export async function signChatAttachmentPaths(
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (paths.length === 0) return result

  const supabase = createClient()
  const { data, error } = await supabase.storage
    .from(CHAT_ATTACHMENTS_BUCKET)
    .createSignedUrls(paths, CHAT_SIGNED_URL_TTL_SECONDS)

  if (error || !data) return result
  for (const entry of data) {
    if (entry.path && entry.signedUrl) {
      result.set(entry.path, entry.signedUrl)
    }
  }
  return result
}
