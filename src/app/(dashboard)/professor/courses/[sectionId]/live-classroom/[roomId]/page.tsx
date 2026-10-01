// Live Classroom presenter page — hosts the unified ClassroomDashboard
// (deck + interactions sidebar + Q&A panel + presence chip).

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { ClassroomDashboard } from '@/components/professor/live-classroom/ClassroomDashboard'

interface PresenterPageProps {
  params: Promise<{ sectionId: string; roomId: string }>
}

export default async function PresenterPage({ params }: PresenterPageProps) {
  const { sectionId, roomId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // Verify access
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  // Verify room exists and belongs to this section
  const room = await liveClassroomQueries.getRoomById(supabase, roomId)
  if (!room || room.section_id !== sectionId) notFound()

  // Verify ownership
  if (room.prof_id !== user.id) notFound()

  // Pull profile name for presence display (fall back to email).
  const { data: profile } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', user.id)
    .maybeSingle()
  const profName = profile?.name || profile?.email || 'Professor'

  /* Fetched here, after the prof_id ownership check above, and never through getRoomSnapshot —
     students call that, and the code has to stay off any student-reachable response (#82). */
  const joinCode = await liveClassroomQueries.getRoomJoinCode(supabase, roomId)

  return (
    <div className="h-full overflow-hidden">
      <ClassroomDashboard
        roomId={roomId}
        sectionId={sectionId}
        professorId={user.id}
        professorName={profName}
        joinCode={joinCode}
      />
    </div>
  )
}
