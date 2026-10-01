/**
 * Student Announcements Page — read-only list of published announcements.
 *
 * Only shows published announcements (no drafts/scheduled).
 * Filters by visibility — shows "all" announcements plus "mentioned_only"
 * announcements where the current student is mentioned.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/announcements
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { signAnnouncementAttachments } from '@/lib/supabase/signed-urls'
import { StudentAnnouncementList } from '@/components/student/announcements/StudentAnnouncementList'
import { autoPublishScheduledAnnouncements } from '@/lib/notifications/announcement-auto-publish'
import { notFound } from 'next/navigation'
import { studentCatalogQueries } from '@/lib/supabase/queries'

interface StudentAnnouncementsPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudentAnnouncementsPage({ params }: StudentAnnouncementsPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  /* Enrolment is gated by the ancestor layout, but App Router renders layout and
     page in PARALLEL: this body still runs when the layout calls notFound(), and
     a discarded render has already committed its writes. That was tolerable while
     the sweep below was a bare UPDATE; now that it also fans out notifications,
     any authenticated user hitting this URL for someone else's section would
     trigger them. Gate inline, with the same check the layout uses. */
  const section = await studentCatalogQueries.getStudentSectionDetail(adminDb, sectionId, user.id)
  if (!section) notFound()

  // Auto-publish scheduled announcements that are past due, and notify the class.
  await autoPublishScheduledAnnouncements(adminDb, sectionId)

  // Fetch published announcements, student's mentions, and read status in parallel
  const [{ data: announcements }, { data: mentions }, { data: reads }] = await Promise.all([
    adminDb
      .from('announcements')
      .select('*')
      .eq('section_id', sectionId)
      .eq('status', 'published')
      .order('is_pinned', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false }),
    adminDb
      .from('announcement_mentions')
      .select('announcement_id')
      .eq('student_id', user.id),
    adminDb
      .from('announcement_reads')
      .select('announcement_id')
      .eq('student_id', user.id),
  ])

  // Build sets for quick lookup
  const mentionedAnnouncementIds = new Set(
    (mentions || []).map((m: { announcement_id: string }) => m.announcement_id)
  )
  const readAnnouncementIds = new Set(
    (reads || []).map((r: { announcement_id: string }) => r.announcement_id)
  )

  // Filter by visibility: show "all" visibility OR student is mentioned
  const visibleAnnouncements = (announcements || []).filter(
    (a: { id: string; visibility: string }) =>
      a.visibility === 'all' || !a.visibility || mentionedAnnouncementIds.has(a.id)
  )

  // Re-sign attachment URLs from filePath (private bucket; persisted URLs expire).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signedAnnouncements = await signAnnouncementAttachments(visibleAnnouncements as any[])

  logger.info('StudentAnnouncementsPage: Loaded', {
    sectionId,
    total: (announcements || []).length,
    visible: visibleAnnouncements.length,
  })

  return (
    <StudentAnnouncementList
      announcements={signedAnnouncements}
      readAnnouncementIds={Array.from(readAnnouncementIds) as string[]}
      sectionId={sectionId}
    />
  )
}
