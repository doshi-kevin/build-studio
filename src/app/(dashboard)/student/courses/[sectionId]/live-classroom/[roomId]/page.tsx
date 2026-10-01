// Live Classroom student viewer page — hosts the unified StudentClassroomView
// (deck + active poll/quiz responder + Q&A list + ask form).

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { StudentClassroomView } from '@/components/student/live-classroom/StudentClassroomView'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface StudentViewerPageProps {
  params: Promise<{ sectionId: string; roomId: string }>
}

export default async function StudentViewerPage({ params }: StudentViewerPageProps) {
  const { sectionId, roomId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'live-classroom')
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // Verify enrollment
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()

  if (!enrollment) notFound()

  // Verify room exists and belongs to this section
  const room = await liveClassroomQueries.getRoomById(supabase, roomId)
  if (!room || room.section_id !== sectionId) notFound()

  const { data: profile } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', user.id)
    .maybeSingle()
  const userName = profile?.name || profile?.email || 'Student'

  return (
    <div className="h-full overflow-hidden">
      <StudentClassroomView
        roomId={roomId}
        sectionId={sectionId}
        userId={user.id}
        userName={userName}
      />
    </div>
  )
}
