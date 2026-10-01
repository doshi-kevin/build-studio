// Post-session report page — professor-only view of how a live classroom
// session went (attendance, participation, quiz/poll results, Q&A, AI
// narrative). The report itself is fetched/generated client-side by
// SessionReportView so first-time generation gets a proper loading state.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { PageHeader } from '@/components/professor/PageHeader'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { SessionReportView } from '@/components/professor/live-classroom/SessionReportView'

interface ReportPageProps {
  params: Promise<{ sectionId: string; roomId: string }>
}

export default async function SessionReportPage({ params }: ReportPageProps) {
  const { sectionId, roomId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  // Room must exist, belong to this section and professor, and be ended.
  const room = await liveClassroomQueries.getRoomById(supabase, roomId)
  if (!room || room.section_id !== sectionId) notFound()
  if (room.prof_id !== user.id) notFound()
  if (room.status !== 'ended') notFound()

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
      <Link
        href={`/professor/courses/${sectionId}/live-classroom`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Live Classroom
      </Link>

      <PageHeader
        title="Class Insights"
        description={<LiveClassName name={room.name} createdAt={room.created_at} />}
      />

      <SessionReportView roomId={roomId} />
    </div>
  )
}
