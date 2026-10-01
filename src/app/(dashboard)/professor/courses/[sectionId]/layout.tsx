/**
 * Course Container Layout — wraps all pages within a specific course section.
 *
 * Verifies the caller has section-level access (professor owner OR active
 * TA/grader) before fetching section data. Both roles see the same UI tree —
 * the sidebar and individual pages/actions adapt their write controls based
 * on the resolved role to keep the TA reuse minimal and avoid duplicating the
 * whole professor tree.
 *
 * Type: Server Component (fetches data, renders nested layout)
 * Route: /professor/courses/[sectionId]/*
 */

import { notFound } from 'next/navigation'
import { resolveAllEntitlementsBySection } from '@/lib/entitlements/check'
import { ENTITLED_FEATURE_KEYS, evaluateEntitlement } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { courseQueries } from '@/lib/supabase/queries'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { logger } from '@/lib/logger'
import { professorToolTabs } from '@/lib/studio/navigation'
import { CourseSidebar } from '@/components/professor/CourseSidebar'
import { CourseBreadcrumbs } from '@/components/professor/CourseBreadcrumbs'
import { DraftFeatureBanner } from '@/components/professor/DraftFeatureBanner'
import { SkillExtractionNotifier } from '@/components/professor/skills/SkillExtractionNotifier'
import { getUnconfirmedSkillCount } from './skills/actions'

export default async function CourseContainerLayout({
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

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) {
    logger.warn('CourseContainerLayout: Section access denied', { sectionId, userId: user.id })
    notFound()
  }

  // Studio plugins are the professor's own tabs: TAs and graders don't run them here.
  const [section, unconfirmedTopics, studioTools] = await Promise.all([
    courseQueries.getSectionDetail(access.adminDb, sectionId),
    getUnconfirmedSkillCount(sectionId),
    access.role === 'professor' ? professorToolTabs(sectionId) : Promise.resolve([]),
  ])
  if (!section) {
    logger.warn('CourseContainerLayout: Section not found', { sectionId, userId: user.id })
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const course = Array.isArray(section.course) ? (section.course as any)[0] : section.course
  const courseName = course?.title || 'Untitled Course'
  const courseCode = course?.code || ''

  // Feature configuration from settings JSONB. `enabledFeatures` is student
  // visibility; `sidebarHidden`/`sidebarOrder` shape the professor's own nav,
  // which shows every feature unless one is explicitly hidden.
  const settings = (section.settings as Record<string, unknown>) || {}
  const enabledFeatures: string[] = Array.isArray(settings.enabledFeatures)
    ? settings.enabledFeatures
    : []
  const sidebarHidden: string[] = Array.isArray(settings.sidebarHidden)
    ? settings.sidebarHidden
    : []
  const sidebarOrder: string[] = Array.isArray(settings.sidebarOrder)
    ? settings.sidebarOrder
    : []

  // What the institution has NOT bought. A ceiling above enabledFeatures: a
  // professor cannot switch on something the school does not have, so those
  // rows leave the nav and the Manage Features popover entirely.
  const entitlements = await resolveAllEntitlementsBySection(access.adminDb, sectionId)
  const now = new Date()
  const unentitledFeatures = ENTITLED_FEATURE_KEYS.filter(
    (key) => !evaluateEntitlement(entitlements, key, now).entitled,
  )

  return (
    <div className="flex -m-4 lg:-m-8 h-[calc(100dvh-73px)] overflow-hidden bg-background font-sans text-foreground">
      <CourseSidebar
        sectionId={sectionId}
        courseName={courseName}
        courseCode={courseCode}
        enabledFeatures={enabledFeatures}
        sidebarHidden={sidebarHidden}
        unentitledFeatures={unentitledFeatures}
        sidebarOrder={sidebarOrder}
        studioTools={studioTools}
        userRole={access.role}
      />
      {/* The breadcrumb sits OUTSIDE the scroll container so <main> holds nothing
          but the page. A page that fills the height with `h-full` then measures
          exactly the scroll container — with the breadcrumb inside it, page and
          breadcrumb each claimed 100% and the container overflowed by the
          breadcrumb's height, which let an inner pane's overscroll drag the page. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="mb-4 shrink-0 px-6 pt-6">
          <CourseBreadcrumbs
            sectionId={sectionId}
            courseName={courseName}
            courseCode={courseCode}
            userRole={access.role}
          />
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {/* Owner only: TAs can't release a feature, and only ever see released
              ones anyway. Renders nothing on pages with no student side. */}
          {/* unentitledFeatures matters here because the banner renders from the
              LAYOUT, outside the page's notFound() boundary — so it survived the
              dead end and offered "Release to students" for a product the school
              does not own. */}
          {access.role === 'professor' && (
            <DraftFeatureBanner
              sectionId={sectionId}
              enabledFeatures={enabledFeatures}
              unentitledFeatures={unentitledFeatures}
            />
          )}
          {children}
        </main>
      </div>
      <SkillExtractionNotifier sectionId={sectionId} initialUnconfirmedCount={unconfirmedTopics.count} />
    </div>
  )
}
