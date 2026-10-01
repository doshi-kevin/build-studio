import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { verifyEntitled } from '@/lib/entitlements/check'
import { sectionToolCount } from '@/lib/studio/navigation'
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
  // The builder is new work: a school without Studio gets a dead end, not a builder
  // whose buttons fail. Installed plugins stay reachable read-only from the sidebar.
  await verifyEntitled(access.adminDb, sectionId, 'studio')

  // Only the professor builds (plugin rule 8.1); course assistants see the landing.
  if (access.role === 'professor') return <StudioWorkspace />
  return <StudioLanding toolCount={await sectionToolCount(sectionId)} />
}
