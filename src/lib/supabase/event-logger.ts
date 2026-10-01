/**
 * Event Logger — writes admin/user actions to the events table.
 *
 * Used inside server actions to record what happened and who did it.
 * The events table is queried by the admin dashboard's "Recent Activity" feed.
 *
 * Design: Fire-and-forget (non-blocking). Logging should never slow down
 * the primary action or cause it to fail.
 *
 * Requires the admin client (service role) to bypass RLS.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

interface LogEventInput {
  /** Who performed the action. `null` ONLY for genuinely actorless work — a cron
   *  or scheduled job — so the audit row still exists instead of being skipped
   *  (events.user_id is nullable). Name the actor in `metadata` when you pass null. */
  userId: string | null
  eventType: string
  eventCategory?: string
  metadata?: Record<string, unknown>
  sectionId?: string
}

/**
 * Logs an event to the events table. Fire-and-forget — never throws.
 *
 * @param input.userId — who performed the action; null for a system/cron actor
 * @param input.eventType — e.g. 'department.created', 'student.created'
 * @param input.eventCategory — e.g. 'admin', 'auth' (defaults to 'admin')
 * @param input.metadata — optional extra data (entity name, id, etc.)
 * @param input.sectionId — optional course section reference
 */
/** Only touch profiles.last_active_at when the stamp is at least this stale —
 *  one cheap UPDATE per user per window instead of a write per action. */
const ACTIVITY_TOUCH_MINUTES = 10

export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb.from('events').insert({
      user_id: input.userId,
      event_type: input.eventType,
      event_category: input.eventCategory || 'admin',
      metadata: input.metadata || {},
      section_id: input.sectionId || null,
    })

    if (error) {
      logger.error('logEvent: Insert failed', error, { eventType: input.eventType })
    }

    // Piggybacked activity stamp: every meaningful user action already funnels
    // through here, so this is the "last active" signal (dossier card, rosters)
    // without a new callsite anywhere. Throttled via the WHERE — a fresh stamp
    // makes this a no-op — and guarded like the insert: never throws.
    if (input.userId) {
      const staleBefore = new Date(Date.now() - ACTIVITY_TOUCH_MINUTES * 60_000).toISOString()
      const { error: touchError } = await adminDb
        .from('profiles')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', input.userId)
        .or(`last_active_at.is.null,last_active_at.lt.${staleBefore}`)
      if (touchError) {
        logger.error('logEvent: activity touch failed', touchError, { eventType: input.eventType })
      }
    }
  } catch (error) {
    // Never throw from event logging — it's non-critical
    logger.error('logEvent: Unexpected error', error, { eventType: input.eventType })
  }
}
