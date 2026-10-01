/**
 * Student Challenges Page — server component that fetches published challenges,
 * student's claims, leaderboard, and badges, then renders the ChallengeBoard.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/challenges
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { challengeQueries, skillQueries, certificateQueries } from '@/lib/supabase/queries'
import { ChallengeBoard } from '@/components/student/challenges/ChallengeBoard'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface ChallengesPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function ChallengesPage({ params }: ChallengesPageProps) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'challenges')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const [challenges, myClaims, leaderboard, myBadges, allSkills, activitySkills, certificates] = await Promise.all([
    challengeQueries.getPublishedChallenges(adminDb, sectionId),
    challengeQueries.getStudentClaims(adminDb, sectionId, user.id),
    challengeQueries.getLeaderboard(adminDb, sectionId),
    challengeQueries.getUserBadges(adminDb, sectionId, user.id),
    skillQueries.listSectionSkills(adminDb, sectionId),
    skillQueries.getSectionActivitySkills(adminDb, sectionId),
    certificateQueries.getStudentCertificates(adminDb, sectionId, user.id),
  ])

  // challengeId → the skills it builds, derived from the shared activity_skills map.
  const skillName = new Map(allSkills.map((s) => [s.id, s.name]))
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
      myClaims={myClaims}
      leaderboard={leaderboard}
      myBadges={myBadges}
      userId={user.id}
      challengeSkills={challengeSkills}
      certificates={certificates}
    />
  )
}
