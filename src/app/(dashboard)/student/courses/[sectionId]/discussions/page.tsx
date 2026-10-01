/**
 * Student Discussions Page — course-level channels for an enrolled section.
 * Team workspaces now live on each project's Discussions tab, not here.
 *
 * Type: Server Component
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { StudentDiscussionsPage } from '@/components/student/discussions/StudentDiscussionsPage'
import { verifyFeatureEnabled } from '@/lib/validations/features'

export default async function DiscussionsPage({
  params,
}: {
  params: Promise<{ sectionId: string }>
}) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'discussions')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  // Verify enrollment
  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed'])
    .single()

  if (!enrollment) notFound()

  // Fetch user profile
  const { data: profile } = await adminDb
    .from('profiles')
    .select('id, name, email, avatar_url')
    .eq('id', user.id)
    .single()

  return (
    <StudentDiscussionsPage
      sectionId={sectionId}
      userId={user.id}
      userProfile={profile || { id: user.id, name: null, email: user.email || '', avatar_url: null }}
    />
  )
}
