/**
 * Server-only bootstrap for a section's default #general discussion channel.
 *
 * Discussions now sits in the professor sidebar by default rather than only
 * after the feature is toggled on, so the channel can no longer be created
 * solely at toggle time — a professor who never toggled it would land on a
 * permanent "channels are warming up" empty state. Both the toggle action and
 * the professor discussions page call this, so it must be idempotent.
 *
 * Concurrency: the partial unique index
 * `discussion_channels_one_default_per_section` makes the insert safe against
 * two simultaneous page loads — the loser gets 23505, which we swallow because
 * the row it wanted already exists.
 */

import type { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'

const UNIQUE_VIOLATION = '23505'

/** Same shape queries.ts uses for its client param — see its `SupabaseClient` alias. */
type AdminClient = ReturnType<typeof createAdminClient>

export async function ensureDefaultCourseChannel(
  adminDb: AdminClient,
  sectionId: string,
  userId: string,
) {
  const { data: existing } = await adminDb
    .from('discussion_channels')
    .select('id')
    .eq('section_id', sectionId)
    .eq('scope', 'course')
    .eq('is_default', true)
    .maybeSingle()

  if (existing) return

  const { error } = await adminDb.from('discussion_channels').insert({
    section_id: sectionId,
    scope: 'course',
    name: 'general',
    created_by: userId,
    is_default: true,
    position: 0,
  })

  // A concurrent request won the race and created it first — that's success.
  if (error && error.code !== UNIQUE_VIOLATION) {
    logger.error('ensureDefaultCourseChannel: insert failed', error, { sectionId })
  }
}
