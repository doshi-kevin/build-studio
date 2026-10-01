/**
 * Course Settings Page — manage dates, capacity, status, and import content.
 * Feature toggles are handled via the sidebar "Manage Features" popover.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/settings
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { PageHeader } from '@/components/professor/PageHeader'
import { CourseSettingsForm } from '@/components/professor/settings/CourseSettingsForm'

export default async function CourseSettingsPage({
  params,
}: {
  params: Promise<{ sectionId: string }>
}) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await courseQueries.getProfessorSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    logger.warn('CourseSettingsPage: Section not found', { sectionId, userId: user.id })
    return (
      <div className="text-center py-12 text-muted-foreground">
        Section not found or you do not have access.
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <PageHeader
        title="Course settings"
        description="Manage dates, capacity, and visibility for this section."
      />

      <CourseSettingsForm
        sectionId={sectionId}
        initialData={{
          start_date: section.start_date || null,
          end_date: section.end_date || null,
          max_students: section.max_students || null,
          modality: section.modality || null,
          location: section.location || null,
          status: section.status || 'active',
        }}
      />
    </div>
  )
}
