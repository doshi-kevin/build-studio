/**
 * Professor Challenges Page — server component that fetches challenges,
 * proposals, and badges, then renders the ChallengeBoard.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/challenges
 */

import { notFound } from 'next/navigation'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { courseQueries, challengeQueries, skillQueries, certificateQueries } from '@/lib/supabase/queries'
import { ChallengeBoard } from '@/components/professor/challenges/ChallengeBoard'

interface ChallengesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ChallengesPage({ params }: ChallengesPageProps) {
  const { sectionId } = await params

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page with buttons that fail (.claude/rules/dead-ends.md). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'challenges')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await courseQueries.getProfessorSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    notFound()
  }

  const [challenges, proposals, badges, allSkills, activitySkills, certificates] = await Promise.all([
    challengeQueries.getSectionChallenges(adminDb, sectionId),
    challengeQueries.getProposedChallenges(adminDb, sectionId),
    challengeQueries.getSectionBadges(adminDb, sectionId),
    skillQueries.listSectionSkills(adminDb, sectionId),
    skillQueries.getSectionActivitySkills(adminDb, sectionId),
    certificateQueries.getSectionCertificates(adminDb, sectionId),
  ])

  // Only tracked skills are linkable (skip excluded / suggested-but-unpromoted).
  const skillName = new Map(allSkills.map((s) => [s.id, s.name]))
  const skills = allSkills
    .filter((s) => !s.excluded && !s.suppressed)
    .map((s) => ({ id: s.id, name: s.name }))

  // challengeId → the skills it builds, derived from the shared activity_skills map.
  const challengeSkills: Record<string, { id: string; name: string }[]> = {}
  for (const link of activitySkills) {
    if (link.activity_type !== 'challenge') continue
    const name = skillName.get(link.skill_id)
    if (!name) continue
    ;(challengeSkills[link.activity_id] ??= []).push({ id: link.skill_id, name })
  }

  return (
    <ChallengeBoard
      sectionId={sectionId}
      challenges={challenges}
      proposals={proposals}
      badges={badges}
      skills={skills}
      challengeSkills={challengeSkills}
      certificates={certificates}
    />
  )
}
