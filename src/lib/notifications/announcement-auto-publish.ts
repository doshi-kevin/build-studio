/**
 * Publish scheduled announcements that are past due — and notify the class.
 *
 * There is no cron for announcements: the flip happens on page load, and it used
 * to happen in THREE places (the professor page, the student page, and the
 * professor list action), each a bare UPDATE with no notification. So a
 * scheduled announcement went live and nobody heard, even though the code that
 * emits on a manual publish says in a comment that "scheduled ones notify when
 * they actually publish". Whichever surface loaded first silently consumed the
 * transition, and the student page was the likeliest.
 *
 * Mirrors autoPublishScheduledQuizzes: `.eq('status','scheduled')` makes the
 * UPDATE an atomic per-row claim, so `.select()` returns only the rows THIS call
 * flipped — the ones to notify about — even when several page loads race.
 *
 * Unlike quizzes there is no `publish_notified_at` column, and none is needed:
 * emitEvent upserts on (recipient_id, type, entity_id) with ignoreDuplicates,
 * backed by a full unique index, so a re-emit cannot double-notify.
 *
 * Server-only. Fire-and-forget, like the UPDATE it replaces: a notification
 * failure must never block rendering the page.
 */

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'
import { resolveAnnouncementAudience } from '@/lib/events/audience'

interface JustPublished {
  id: string
  title: string
  is_important: boolean | null
  /** Needed to honour per-student targeting when notifying (#665). */
  visibility: string | null
}

export async function autoPublishScheduledAnnouncements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
): Promise<void> {
  const now = new Date().toISOString()

  const { data, error } = await adminDb
    .from('announcements')
    .update({ status: 'published', published_at: now })
    .eq('section_id', sectionId)
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .select('id, title, is_important, visibility')

  if (error) {
    logger.error(
      'autoPublishScheduledAnnouncements: failed to publish scheduled announcements',
      error,
      { sectionId },
    )
    return
  }

  const rows = (data ?? []) as JustPublished[]
  if (rows.length === 0) return

  logger.info(
    `autoPublishScheduledAnnouncements: published ${rows.length} scheduled announcement(s)`,
    { sectionId },
  )

  // Time-based publish, so there is no actor. Matches the manual-publish emit.
  await Promise.all(
    rows.map(async (a) =>
      emitEvent({
        type: 'announcement_posted',
        sectionId,
        actorId: null,
        /* A SCHEDULED announcement can be targeted too, and this path published it
           without consulting that targeting at all — it did not even select
           `visibility`. Same leak as the manual publish, just on a timer (#665). */
        audience: await resolveAnnouncementAudience(adminDb, a.id, sectionId, a.visibility),
        entity: { type: 'announcement', id: a.id },
        title: `New announcement: ${a.title}`,
        /* The specific announcement, matching the manual-publish path (#694). This linked
           to the LIST with no id, so a student notified about a scheduled announcement
           landed on the index and had to work out which one it meant — the same
           notification type sending people to two different places depending on how it
           was published. */
        linkUrl: `/student/courses/${sectionId}/announcements/${a.id}`,
        metadata: a.is_important ? { important: true } : undefined,
      }),
    ),
  )
}
