/**
 * Announcements Page — server component that fetches announcements
 * and renders the AnnouncementList client component.
 *
 * Auto-publishes any scheduled announcements that are past due before fetching.
 * Wrapped in Suspense for useSearchParams() support in child components.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/announcements
 */

import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/server'
import { enrollmentQueries } from '@/lib/supabase/queries'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { signAnnouncementAttachments } from '@/lib/supabase/signed-urls'
import { AnnouncementList } from '@/components/professor/announcements/AnnouncementList'
import { getAnnouncementReadCounts } from './actions'
import type { CourseItem } from '@/lib/tiptap/course-mention-extension'
import { autoPublishScheduledAnnouncements } from '@/lib/notifications/announcement-auto-publish'

interface AnnouncementsPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function AnnouncementsPage({ params }: AnnouncementsPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const adminDb = access.adminDb

  // Auto-publish scheduled announcements that are past due, and notify the class.
  await autoPublishScheduledAnnouncements(adminDb, sectionId)

  // Current section (for tenant-scoping the "post to other sections" list)
  const { data: currentSection } = await adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()

  // Fetch announcements, enrolled students, read counts, course items, and the
  // professor's other sections (multi-section posting) in parallel
  const [
    { data: announcements },
    enrollments,
    readCountsResult,
    { data: quizzes },
    { data: moduleItems },
    { data: projects },
    { data: otherSectionRows },
  ] = await Promise.all([
    adminDb
      .from('announcements')
      .select('*')
      .eq('section_id', sectionId)
      .order('is_pinned', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false }),
    enrollmentQueries.getSectionEnrollments(adminDb, sectionId),
    getAnnouncementReadCounts(sectionId),
    adminDb
      .from('quizzes')
      .select('id, title')
      .eq('section_id', sectionId),
    adminDb
      .from('module_items')
      .select('id, title, modules!inner(section_id)')
      .eq('modules.section_id', sectionId),
    adminDb
      .from('projects')
      .select('id, title')
      .eq('section_id', sectionId),
    // Sections this professor also teaches (same institution), for multi-section posting
    adminDb
      .from('course_sections')
      .select('id, section_code, semester, year, course:courses(code, title)')
      .eq('professor_id', user.id)
      .eq('institution_id', currentSection?.institution_id ?? '')
      .neq('id', sectionId),
  ])

  // Map enrolled students to simple format for the form
  const enrolledStudents = (enrollments || []).map((e) => {
    const student = Array.isArray(e.student) ? e.student[0] : e.student
    return {
      id: student?.id ?? '',
      name: student?.name ?? null,
      email: student?.email ?? '',
    }
  }).filter((s: { id: string }) => s.id)

  const readCounts = readCountsResult.data || {}
  const ackCounts = readCountsResult.ackData || {}
  const totalStudents = readCountsResult.totalStudents || enrolledStudents.length

  // Which of this section's announcements belong to a multi-section group? A row
  // is grouped if it's a child (has a parent) or a parent (some row points at it).
  // Used to show the "apply to all sections" prompt only when it's meaningful.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const announcementRows = (announcements || []) as any[]
  const sectionAnnouncementIds = announcementRows.map((a) => a.id)
  let groupedIds: string[] = []
  if (sectionAnnouncementIds.length > 0) {
    const { data: childRefs } = await adminDb
      .from('announcements')
      .select('parent_announcement_id')
      .in('parent_announcement_id', sectionAnnouncementIds)
    const parentsWithChildren = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((childRefs || []) as any[]).map((c) => c.parent_announcement_id),
    )
    groupedIds = announcementRows
      .filter((a) => a.parent_announcement_id || parentsWithChildren.has(a.id))
      .map((a) => a.id)
  }

  // Shape the professor's other sections into simple options for the picker
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otherSections = ((otherSectionRows || []) as any[]).map((s) => {
    const course = Array.isArray(s.course) ? s.course[0] : s.course
    return {
      id: s.id as string,
      label: `${course?.code ?? 'Course'} · ${s.section_code}`,
      sublabel: `${course?.title ?? ''} · ${s.semester} ${s.year}`.trim(),
    }
  })

  // Attachment fileUrls persisted at upload time expire (private bucket) — re-sign
  // from filePath at render so previews/downloads don't 403.
  const signedAnnouncements = await signAnnouncementAttachments(announcementRows)

  const courseItems: CourseItem[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((quizzes || []) as any[]).map((q) => ({ id: q.id, type: 'quiz' as const, label: q.title })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((moduleItems || []) as any[]).map((m) => ({ id: m.id, type: 'module_item' as const, label: m.title })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((projects || []) as any[]).map((p) => ({ id: p.id, type: 'project' as const, label: p.title })),
  ]

  return (
    // Skeleton mirrors the list + reading-pane shape so the layout doesn't jump on load
    <Suspense fallback={
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="shrink-0 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-8 w-56 rounded-xl" />
              <Skeleton className="h-4 w-72 rounded-xl" />
            </div>
            <Skeleton className="h-9 w-44 rounded-xl" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-9 flex-1 rounded-xl" />
            <Skeleton className="h-9 w-72 rounded-xl" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
          <div className="w-full space-y-2 lg:max-w-sm lg:shrink-0">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="hidden min-h-64 flex-1 rounded-2xl lg:block" />
        </div>
      </div>
    }>
      <AnnouncementList
        sectionId={sectionId}
        announcements={signedAnnouncements}
        readCounts={readCounts}
        ackCounts={ackCounts}
        totalStudents={totalStudents}
        enrolledStudents={enrolledStudents}
        courseItems={courseItems}
        otherSections={otherSections}
        groupedIds={groupedIds}
      />
    </Suspense>
  )
}
