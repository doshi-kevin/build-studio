/**
 * Server-side counterpart to `chat-storage.ts`, which runs in the browser with the anon client
 * and therefore cannot delete anything.
 *
 * Exists for one job: when a chat message is soft-deleted, the FILE it carried has to go too.
 *
 * Why this is not handled by the same trigger that redacts the row (#678): the trigger blanks
 * `content` and all five attachment columns in Postgres, which is the right layer for the row
 * because no code path can bypass it. But Postgres cannot reach object storage, so the file it
 * just orphaned stays in the bucket, and a bucket object is readable by anyone who can construct
 * a signed URL for it. Blanking the pointer hid the reference, not the thing referenced.
 *
 * Deliberately BEST-EFFORT. A failure here is logged and swallowed, because the alternative —
 * failing the delete — would leave the message visible, which is strictly worse than leaving a
 * file that no longer has anything pointing at it. The row redaction is the guarantee; this is
 * the cleanup that follows it.
 *
 * Callers must read `attachment_path` BEFORE the soft-delete. The trigger nulls it during the
 * update, so reading afterwards always returns null and silently purges nothing.
 */

import { CHAT_ATTACHMENTS_BUCKET } from './chat-storage'
import { logger } from '@/lib/logger'

/**
 * Remove a soft-deleted message's attachment from the bucket.
 *
 * `path` is whatever was in `attachment_path`, which is always a key in
 * CHAT_ATTACHMENTS_BUCKET — the legacy `project-chat` bucket only ever held public
 * `attachment_url` values, never paths, so there is nothing to purge there.
 */
export async function purgeChatAttachment(
  // The admin client is loosely typed across this codebase; mirror that.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  path: string | null | undefined,
): Promise<void> {
  if (!path) return
  try {
    const { error } = await adminDb.storage.from(CHAT_ATTACHMENTS_BUCKET).remove([path])
    if (error) {
      logger.warn('purgeChatAttachment: remove failed', { path, error: String(error) })
    }
  } catch (error) {
    logger.warn('purgeChatAttachment: threw', { path, error: String(error) })
  }
}
