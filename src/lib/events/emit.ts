/**
 * emitEvent — the ONE call at each event source (emit once, consume twice).
 *
 * Records a per-recipient row in feed_items for every member of the event's audience.
 * The notification bell and the dashboard to-do list both read those rows. Mirrors the
 * logEvent contract: fire-and-forget, never throws, creates its own admin client.
 *
 * Idempotent: upserts on the (recipient_id, type, entity_id) dedup key, so a re-emit or
 * a retried action won't create duplicates. Self-notify is dropped; ids de-duplicated.
 *
 * Completion (markFeedItemDone) flips an actionable to-do to done when the student acts
 * (submit/attempt) — that's what makes feed_items serve to-dos, not just notices.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { resolveAudience } from '@/lib/events/audience'
import {
  parseNotificationPreferences,
  isTypeMuted,
  isMutableNotificationType,
} from '@/lib/validations/notification-preferences'
import {
  FEED_TITLE_MAX,
  FEED_BODY_MAX,
  FEED_LINK_MAX,
  type EmitEventInput,
  type FeedEntityType,
} from '@/lib/events/types'

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

/**
 * Fan out an event to feed_items (one row per recipient). Fire-and-forget.
 */
export async function emitEvent(input: EmitEventInput): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Resolve tenant (institution) + the course label from the section in one lookup.
    // The course label rides along on each row (metadata.course_label) so every
    // surface — the bell, the realtime toast, the dashboard — can show WHICH course
    // a notification is for without a join or a client-side lookup.
    let institutionId = input.institutionId ?? null
    let courseLabel: string | null = null
    if (input.sectionId) {
      const { data: section } = await adminDb
        .from('course_sections')
        .select('institution_id, course:courses(code, title)')
        .eq('id', input.sectionId)
        .maybeSingle()
      institutionId = institutionId ?? (section?.institution_id as string | undefined) ?? null
      const course = Array.isArray(section?.course) ? section?.course[0] : section?.course
      courseLabel =
        (course?.code as string | undefined) || (course?.title as string | undefined) || null
    }
    // feed_items.institution_id is NOT NULL (tenant-scoped). If we can't resolve it
    // (e.g. a bad sectionId), skip rather than attempt a doomed insert.
    if (!institutionId) {
      logger.warn('emitEvent: no institution for section — skipping', {
        type: input.type,
        sectionId: input.sectionId,
      })
      return
    }

    const actorId = input.actorId ?? null
    const audience =
      input.audience ?? (input.sectionId ? await resolveAudience(adminDb, input.sectionId) : [])
    const recipients = Array.from(new Set(audience.filter(Boolean))).filter((id) => id !== actorId)
    if (recipients.length === 0) return

    // Preference filter: for an OPTIONAL notification type, drop recipients who've opted
    // out (must-have types skip this — a preference can't suppress them). One batched
    // settings read; no N+1.
    let targetRecipients = recipients
    if (isMutableNotificationType(input.type)) {
      const { data: prefRows } = await adminDb
        .from('profiles')
        .select('id, settings')
        .in('id', recipients)
      const muted = new Set(
        ((prefRows ?? []) as Array<{ id: string; settings: Record<string, unknown> | null }>)
          .filter((p) => isTypeMuted(parseNotificationPreferences(p.settings), input.type))
          .map((p) => p.id),
      )
      targetRecipients = recipients.filter((id) => !muted.has(id))
      if (targetRecipients.length === 0) return
    }

    // A 'refresh' emit (content change) re-surfaces an existing item — unread again and
    // bumped to now — so a repeated change (e.g. a second due-date edit) re-notifies,
    // instead of being silently deduped like a one-shot publish.
    const refresh = input.onDuplicate === 'refresh'
    const rows = targetRecipients.map((recipientId) => ({
      recipient_id: recipientId,
      actor_id: actorId,
      institution_id: institutionId,
      section_id: input.sectionId ?? null,
      type: input.type,
      title: cap(input.title, FEED_TITLE_MAX),
      body: input.body ? cap(input.body, FEED_BODY_MAX) : null,
      link_url: input.linkUrl ? cap(input.linkUrl, FEED_LINK_MAX) : null,
      entity_type: input.entity?.type ?? null,
      entity_id: input.entity?.id ?? null,
      is_actionable: input.actionable ?? false,
      due_at: input.dueAt ?? null,
      metadata: courseLabel
        ? { ...(input.metadata ?? {}), course_label: courseLabel }
        : (input.metadata ?? {}),
      // A 'refresh' re-emit re-surfaces the notice: mark it unread AND clear dismissed_at, so a
      // student who already dismissed the earlier one sees it again (e.g. assignment/module
      // unpublish → republish). The new created_at floats it back to the top of the bell.
      ...(refresh
        ? { is_read: false, read_at: null, dismissed_at: null, created_at: new Date().toISOString() }
        : {}),
    }))

    // Idempotent by default: skip rows that already exist for (recipient, type, entity).
    // 'refresh' instead UPDATEs the existing row, re-surfacing the change.
    const { error } = await adminDb
      .from('feed_items')
      .upsert(
        rows,
        refresh
          ? { onConflict: 'recipient_id,type,entity_id' }
          : { onConflict: 'recipient_id,type,entity_id', ignoreDuplicates: true },
      )

    if (error) {
      logger.warn('emitEvent: insert failed', {
        type: input.type,
        recipients: recipients.length,
        error: error.message,
      })
    }
  } catch (error) {
    logger.warn('emitEvent: unexpected error', {
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Completion — mark a recipient's actionable to-do(s) for an entity as done. Call at the
 * student submit/attempt action. Fire-and-forget; never throws. The realtime UPDATE
 * flows to both surfaces so the to-do disappears and the bell reconciles.
 */
export async function markFeedItemDone(params: {
  recipientId: string
  entityType: FeedEntityType
  entityId: string
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { error } = await adminDb
      .from('feed_items')
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq('recipient_id', params.recipientId)
      .eq('entity_type', params.entityType)
      .eq('entity_id', params.entityId)
      .eq('is_actionable', true)
      .eq('is_done', false)
    if (error) {
      logger.warn('markFeedItemDone: update failed', {
        entityType: params.entityType,
        entityId: params.entityId,
        error: error.message,
      })
    }
  } catch (error) {
    logger.warn('markFeedItemDone: unexpected error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
