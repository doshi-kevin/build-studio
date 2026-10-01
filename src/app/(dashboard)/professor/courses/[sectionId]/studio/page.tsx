import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { StudioLanding } from '@/components/studio/StudioLanding'
import { StudioWorkspace } from '@/components/studio/builder/StudioWorkspace'

interface StudioPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StudioPage({ params }: StudioPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  // The section layout checks this too, but layouts and pages render in
  // parallel, so the page must gate itself before any future data read.
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  // Only the professor builds (plugin rule 8.1); course assistants see the landing.
  return access.role === 'professor' ? <StudioWorkspace /> : <StudioLanding />
}
