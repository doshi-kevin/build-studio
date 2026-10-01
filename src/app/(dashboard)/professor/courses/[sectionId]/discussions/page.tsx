/**
 * Professor Discussions Page — course-level channels only.
 * Professors can only see and interact with course-scope channels;
 * team workspaces are private to each project's team.
 *
 * Type: Server Component
 */

import { notFound } from 'next/navigation'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { ensureDefaultCourseChannel } from '@/lib/discussion/default-channel'
import { ProfessorDiscussionsPage } from '@/components/professor/discussions/ProfessorDiscussionsPage'

export default async function DiscussionsPage({
  params,
}: {
  params: Promise<{ sectionId: string }>
}) {
  const { sectionId } = await params

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page with buttons that fail (.claude/rules/dead-ends.md). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'discussions')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()
  const { adminDb } = access

  // Discussions sits in the sidebar whether or not it's been released to
  // students, so #general can't rely on the toggle to exist. Without this the
  // page would sit on "channels are warming up" forever. Idempotent.
  //
  // Owner only: verifySectionAccess also admits graders, who are read-only in
  // v1 — they shouldn't author a row (nor have it stamped with their id) just
  // by loading the page. TAs and graders can only reach Discussions once it's
  // published, and publishing already creates the channel, so they never land
  // on the empty state this guards against.
  if (access.role === 'professor') {
    await ensureDefaultCourseChannel(adminDb, sectionId, user.id)
  }

  // Fetch user profile
  const { data: profile } = await adminDb
    .from('profiles')
    .select('id, name, email, avatar_url')
    .eq('id', user.id)
    .single()

  return (
    <ProfessorDiscussionsPage
      sectionId={sectionId}
      userId={user.id}
      userProfile={profile || { id: user.id, name: null, email: user.email || '', avatar_url: null }}
    />
  )
}
