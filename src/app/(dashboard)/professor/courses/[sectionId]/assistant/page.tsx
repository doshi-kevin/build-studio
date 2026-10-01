/**
 * Athena — dedicated assistant tab for a course section.
 *
 * Section access is verified by the parent course layout; we re-verify here to
 * get the admin client for the section lookup (defense in depth). Renders the
 * full-page console.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assistant
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { verifyEntitled } from '@/lib/entitlements/check'
import { courseQueries, profileQueries } from '@/lib/supabase/queries'
import { AssistantConsole } from '@/components/professor/assistant/AssistantConsole'
import { EmptyState } from '@/components/ui/empty-state'
import { Sparkles } from 'lucide-react'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'

export default async function AssistantPage({ params }: { params: Promise<{ sectionId: string }> }) {
  const { sectionId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  // The institution ceiling. A school without Athena gets the standard dead
  // end here, same as the sibling assignments/quizzes/live-classroom pages
  // (.claude/rules/dead-ends.md) — this runs BEFORE the kill switch below,
  // since not owning the product is permanent and commercial, while the kill
  // switch is a temporary safety state that still deserves the friendly panel.
  await verifyEntitled(access.adminDb, sectionId, 'athena')

  // Institution/platform AI kill switch — the tab stays reachable but renders
  // an honest disabled state instead of the console (never a bare 404: the
  // professor should see WHY Athena is gone). The chat route refuses too.
  const aiVerdict = await checkAiFeatureBySection(access.adminDb, sectionId, 'athena-professor')
  if (!aiVerdict.allowed) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Athena is unavailable"
        description={aiRefusalMessage(aiVerdict.lockedBy)}
        action={{ label: 'Back to course', href: `/professor/courses/${sectionId}` }}
      />
    )
  }

  const [section, profile] = await Promise.all([
    courseQueries.getSectionDetail(access.adminDb, sectionId),
    profileQueries.getProfileById(access.adminDb, user.id),
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const course = Array.isArray(section?.course) ? (section?.course as any)[0] : section?.course

  // First name for the personalized empty-state greeting ("Back at it, …").
  const professorFirstName =
    profile?.first_name?.trim() || profile?.name?.trim().split(/\s+/)[0] || ''

  return (
    <AssistantConsole
      sectionId={sectionId}
      courseName={course?.title || 'this course'}
      courseCode={course?.code || ''}
      professorFirstName={professorFirstName}
    />
  )
}
