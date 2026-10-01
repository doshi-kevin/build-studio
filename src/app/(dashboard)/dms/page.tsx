/**
 * DM resolver — the clickable destination of a direct-message notification (#693).
 *
 * A DM is GLOBAL: a `dm_channels` row is just (user_a_id, user_b_id) with no course
 * attached. But the DM pane only ever renders inside a section-scoped discussions
 * page, so a notification cannot name a fixed URL. Rather than compute one when the
 * message is SENT, this resolves at CLICK time and redirects.
 *
 * Resolving late is what makes it correct rather than merely convenient:
 *
 *  - A URL computed at send time goes stale. The professor can switch discussions off,
 *    or the student can be unenrolled, days after the notification was written — and
 *    the link would then land on a 404 the sender's code had no way to predict.
 *  - `sendDmMessage` is on the hot path of every message. Resolving there would add
 *    several joins per send for a link most recipients never click.
 *  - When a real standalone DM surface eventually exists, it is implemented HERE and
 *    every notification already in the table starts working. No backfill.
 *
 * Type: Server Component (redirects; renders only when nothing resolves)
 * Tables: dm_channels (read), enrollments (read), course_sections (read), section_staff (read)
 */

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { DeadEnd } from '@/components/ui/dead-end'
import { logger } from '@/lib/logger'

/** Enrollment statuses that still grant course access, matching the DM read paths. */
const ACTIVE_STATUSES = ['enrolled', 'completed']

interface Destination {
  sectionId: string
  role: 'student' | 'professor'
}

/**
 * The best section to show this conversation in, from the VIEWER's side.
 *
 * "Best" means one the viewer can actually open: their role decides the route prefix,
 * and `settings.enabledFeatures` decides whether the discussions page will serve them
 * at all. A section with discussions switched off is skipped rather than linked, since
 * sending someone to a 404 is worse than the notification simply not navigating.
 *
 * Any shared section shows the same conversation, so when there are several the choice
 * is arbitrary and a professor-taught one is preferred only because that role's page
 * has no feature gate to fail.
 */
async function resolveDestination(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  viewerId: string,
  otherUserId: string,
): Promise<Destination | null> {
  const [{ data: teaching }, { data: enrolled }, { data: otherEnrolled }, { data: otherTeaching }, { data: otherStaffing }] =
    await Promise.all([
      adminDb.from('course_sections').select('id, settings').eq('professor_id', viewerId),
      adminDb.from('enrollments').select('section_id').eq('student_id', viewerId).in('status', ACTIVE_STATUSES),
      adminDb.from('enrollments').select('section_id').eq('student_id', otherUserId).in('status', ACTIVE_STATUSES),
      adminDb.from('course_sections').select('id').eq('professor_id', otherUserId),
      adminDb.from('section_staff').select('section_id').eq('staff_id', otherUserId).eq('status', 'active'),
    ])

  // Everywhere the counterparty is reachable, so a shared section is one of these.
  const theirs = new Set<string>()
  for (const r of (otherEnrolled ?? []) as Array<{ section_id: string }>) theirs.add(r.section_id)
  for (const r of (otherTeaching ?? []) as Array<{ id: string }>) theirs.add(r.id)
  for (const r of (otherStaffing ?? []) as Array<{ section_id: string }>) theirs.add(r.section_id)

  /* Professor first: /professor/courses/[id]/discussions has no student feature gate,
     so it cannot 404 on a toggle the way the student page can. */
  for (const s of (teaching ?? []) as Array<{ id: string }>) {
    if (theirs.has(s.id)) return { sectionId: s.id, role: 'professor' }
  }

  const mineAsStudent = ((enrolled ?? []) as Array<{ section_id: string }>)
    .map((r) => r.section_id)
    .filter((id) => theirs.has(id))
  if (mineAsStudent.length === 0) return null

  const { data: sections } = await adminDb
    .from('course_sections')
    .select('id, settings')
    .in('id', mineAsStudent)

  for (const row of (sections ?? []) as Array<{ id: string; settings: unknown }>) {
    const settings = (row.settings ?? {}) as { enabledFeatures?: unknown }
    const features = Array.isArray(settings.enabledFeatures) ? settings.enabledFeatures : []
    if (features.includes('discussions')) return { sectionId: row.id, role: 'student' }
  }

  return null
}

export default async function DmResolverPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  const { c: channelId } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // Auth redirects live in middleware.ts, which now protects /dms. Rendering the
  // dead end rather than redirecting keeps that rule intact if we ever arrive here
  // without a session.
  if (!user || !channelId) {
    return (
      <DeadEnd action={{ label: 'Back to notifications', href: '/notifications' }} />
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: channel } = await adminDb
    .from('dm_channels')
    .select('user_a_id, user_b_id')
    .eq('id', channelId)
    .maybeSingle()

  /* Not a participant reads exactly like a nonexistent channel. Distinguishing them
     would confirm that a given channel id is real, which is a membership oracle over
     the whole institution — the same reason openOrCreateDm returns one refusal for
     both cases. Hence the DEFAULT `missing` copy, not `no-access`: this route is keyed
     by a resource id, so per the dead-ends rule it must not say the thing exists. */
  const participants: string[] = channel ? [channel.user_a_id, channel.user_b_id] : []
  if (!channel || !participants.includes(user.id)) {
    return <DeadEnd action={{ label: 'Back to notifications', href: '/notifications' }} />
  }

  const otherUserId = participants.find((id) => id !== user.id)
  if (!otherUserId) {
    // A self-DM cannot be created (openOrCreateDm refuses it), so this is corrupt data.
    logger.warn('DmResolverPage: channel has no counterparty', { channelId })
    return <DeadEnd action={{ label: 'Back to notifications', href: '/notifications' }} />
  }

  const destination = await resolveDestination(adminDb, user.id, otherUserId)

  if (!destination) {
    /* Safe to be specific here: they own this channel, so the copy confirms nothing
       they don't already know. This is the honest end state for a conversation whose
       only shared course has ended, been unenrolled, or had discussions switched off. */
    return (
      <DeadEnd
        title="This conversation has no home right now"
        description="Direct messages open inside a course you share. You and this person no longer share one with discussions turned on, so there's nowhere to show the thread."
        action={{ label: 'Back to notifications', href: '/notifications' }}
        secondaryAction={{ label: 'Go to dashboard', href: '/dashboard' }}
      />
    )
  }

  redirect(`/${destination.role}/courses/${destination.sectionId}/discussions?dm=${otherUserId}`)
}
