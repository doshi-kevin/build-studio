// Projector View page — a standalone, chrome-less window the professor drags
// onto the projector. Renders the passive, student-safe ProjectorView of the
// live session. Auth mirrors the presenter page: only the room's own
// professor can open it.

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { ProjectorView } from '@/components/professor/live-classroom/ProjectorView'

interface ProjectorPageProps {
  params: Promise<{ sectionId: string; roomId: string }>
}

export default async function ProjectorPage({ params }: ProjectorPageProps) {
  const { sectionId, roomId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // Verify section access, then room ownership (mirrors the presenter page).
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  const room = await liveClassroomQueries.getRoomById(supabase, roomId)
  if (!room || room.section_id !== sectionId) notFound()
  if (room.prof_id !== user.id) notFound()

  /* Read the code HERE, in a page that has already checked room.prof_id === user.id, rather
     than through getRoomSnapshot — students call that, and it must never carry the code (#82). */
  const joinCode = await liveClassroomQueries.getRoomJoinCode(supabase, roomId)

  return <ProjectorView roomId={roomId} userId={user.id} joinCode={joinCode} />
}
