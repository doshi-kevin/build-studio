/**
 * Student Course Container Layout — wraps all pages within an enrolled course.
 *
 * Verifies the student is enrolled (not professor ownership), then renders
 * a read-only course sidebar alongside the page content.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/*
 */

import { notFound } from 'next/navigation'
import { resolveAllEntitlementsBySection } from '@/lib/entitlements/check'
import { ENTITLED_FEATURE_KEYS, evaluateEntitlement } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { parseInstitutionSettings } from '@/lib/validations/institution-settings'
import { withinAddDropWindow, parseAddDropPolicy } from '@/lib/validations/institution'
import { parseInstitutionAiPolicy, parseAiPolicyLayer, evaluateAiFeature } from '@/lib/ai/ai-features'
import { logger } from '@/lib/logger'
import { StudentCourseSidebar } from '@/components/student/courses/StudentCourseSidebar'
import { AthenaCourseBeacon } from '@/components/student/athena/AthenaCourseBeacon'

export default async function StudentCourseContainerLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ sectionId: string }>
}) {
  const { sectionId } = await (params as Promise<{ sectionId: string }>)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await studentCatalogQueries.getStudentSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    logger.warn('StudentCourseContainerLayout: Not found or not enrolled', { sectionId, userId: user.id })
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const course = Array.isArray(section.course) ? (section.course as any)[0] : section.course
  const courseName = course?.title || 'Untitled Course'
  const courseCode = course?.code || ''

  // Extract enabled features from settings JSONB. `sidebarOrder` is the
  // professor's drag order, shared by both sidebars.
  const settings = (section.settings as Record<string, unknown>) || {}
  const enabledFeatures: string[] = Array.isArray(settings.enabledFeatures)
    ? settings.enabledFeatures
    : []
  const sidebarOrder: string[] = Array.isArray(settings.sidebarOrder)
    ? settings.sidebarOrder
    : []

  // Unread announcement count for the nav badge: published announcements visible
  // to this student (public, or ones they're mentioned in) that they haven't read.
  // Alongside: the facts the self-unenroll window needs (institution policy +
  // this enrollment's enrolled_at — the window is per-enrollment).
  const [{ data: pubAnnouncements }, { data: mentionRows }, { data: readRows }, { data: institution }, { data: sectionRow }, { data: enrollmentRow }, { data: platformRow }] = await Promise.all([
    adminDb
      .from('announcements')
      .select('id, visibility')
      .eq('section_id', sectionId)
      .eq('status', 'published'),
    adminDb.from('announcement_mentions').select('announcement_id').eq('student_id', user.id),
    adminDb.from('announcement_reads').select('announcement_id').eq('student_id', user.id),
    adminDb.from('institutions').select('settings, add_drop_deadline_days').eq('id', section.institution_id).maybeSingle(),
    adminDb.from('course_sections').select('start_date').eq('id', sectionId).maybeSingle(),
    adminDb
      .from('enrollments')
      .select('enrolled_at, status')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .eq('status', 'enrolled')
      .maybeSingle(),
    adminDb.from('platform_settings').select('settings').eq('id', true).maybeSingle(),
  ])
  const { selfUnenroll } = parseInstitutionSettings(institution?.settings)

  /* Institution/platform AI kill switch: when athena-student is disabled, drop
     the AI Tutor from the student nav and don't mount the Athena beacon — the
     feature reads as OFF, not broken. The /api/chat route enforces it too; this
     is the visible half. */
  const aiPolicy = parseInstitutionAiPolicy(institution?.settings)
  const globalAiLayer = parseAiPolicyLayer(
    (platformRow?.settings as Record<string, unknown> | null | undefined)?.ai,
  )
  const aiTutorKilled = !evaluateAiFeature(globalAiLayer, aiPolicy, 'athena-student').allowed
  /* Filters the 'athena' key, NOT the retired 'ai-tutor' one. athena-core renamed
     it (migration 20260806023200), and this filter is what makes the kill switch
     visible — left on the old key it matches nothing, so a disabled institution
     would still get the beacon and the nav entry. Silent, because the route-level
     enforcement in /api/chat would still refuse: the feature would look available
     and fail on use, which is the exact "broken, not off" state the comment above
     says this avoids. */
  /* The institution ceiling, for the same reason as the athena filter above and
     found the same way: a nav entry for a feature the school does not have looks
     available and dead-ends on click, which is the "broken, not off" state that
     comment exists to prevent. The professor's own sidebar already does this in
     professor/courses/[sectionId]/layout.tsx; the student's was missed. */
  const entitlements = await resolveAllEntitlementsBySection(adminDb, sectionId)
  const entitlementNow = new Date()
  const unentitled = new Set<string>(
    ENTITLED_FEATURE_KEYS.filter(
      (key) => !evaluateEntitlement(entitlements, key, entitlementNow).entitled,
    ),
  )
  const entitledFeatures = enabledFeatures.filter((f) => !unentitled.has(f))
  const visibleFeatures = aiTutorKilled
    ? entitledFeatures.filter((f) => f !== 'athena')
    : entitledFeatures
  /* MUST match dropSection's gate exactly (#744). If the button shows when the action
     refuses, the student gets an action guaranteed to fail — the same shape as #712 and
     #713 part 7. Both sides now read the section-start deadline rather than the student's
     own enrolled_at, which gave two people in one course two different deadlines. */
  const canUnenroll =
    !!enrollmentRow &&
    selfUnenroll.enabled &&
    withinAddDropWindow(parseAddDropPolicy(institution), sectionRow?.start_date)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentionedIds = new Set(((mentionRows || []) as any[]).map((m) => m.announcement_id))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readIds = new Set(((readRows || []) as any[]).map((r) => r.announcement_id))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unreadAnnouncements = ((pubAnnouncements || []) as any[]).filter(
    (a) => (a.visibility === 'all' || mentionedIds.has(a.id)) && !readIds.has(a.id),
  ).length

  /* The Athena shell itself lives in /student/layout.tsx so it survives a drive
     to a non-course page (design doc §14.7 D1). This layout still owns the
     section-scoped facts, so it announces them upward rather than the shell
     fetching them back down. A fragment, deliberately: the shell's scroll
     placemark looks for its own `> main`, and a wrapper element here would
     break that. */
  return (
    <>
      <AthenaCourseBeacon
        sectionId={sectionId}
        courseCode={courseCode || courseName}
        enabled={visibleFeatures.includes('athena')}
      />
      <StudentCourseSidebar
        sectionId={sectionId}
        courseName={courseName}
        courseCode={courseCode}
        sectionCode={section.section_code || ''}
        semester={section.semester || ''}
        year={section.year || 0}
        enabledFeatures={visibleFeatures}
        sidebarOrder={sidebarOrder}
        unreadAnnouncements={unreadAnnouncements}
        canUnenroll={canUnenroll}
      />
      <main className="flex-1 p-6 min-w-0 overflow-y-auto">
        {children}
      </main>
    </>
  )
}
