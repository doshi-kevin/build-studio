// Student Class Insights — post-class study pack: lecture summary, how you did
// vs the class, full quiz review with explanations, flashcards, and a practice
// quiz. PII-free; per-student numbers are the caller's own. The blob is
// fetched/generated client-side by StudentInsightsView so first-time
// generation gets a proper loading state.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { PageHeader } from '@/components/professor/PageHeader'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { StudentInsightsView } from '@/components/student/live-classroom/StudentInsightsView'
import { AnnotatedSlidesSection } from '@/components/student/live-classroom/AnnotatedSlidesSection'
import { loadAnnotatedSlides } from '@/lib/live-classroom/insights/annotated-slides'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface InsightsPageProps {
  params: Promise<{ sectionId: string; roomId: string }>
}

export default async function StudentInsightsPage({ params }: InsightsPageProps) {
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

  // Must be enrolled in the section.
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', user.id)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()
  if (!enrollment) notFound()

  // Room must exist, belong to this section, and be ended.
  const room = await liveClassroomQueries.getRoomById(supabase, roomId)
  if (!room || room.section_id !== sectionId) notFound()
  if (room.status !== 'ended') notFound()

  // Annotations are ready the instant class ends, so this loads independently of
  // the AI study pack (which StudentInsightsView generates client-side). Null →
  // nothing was annotated → the section simply isn't rendered (no empty box).
  const annotatedSlides = await loadAnnotatedSlides(roomId)

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
      <Link
        href={`/student/courses/${sectionId}/live-classroom`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Live Classroom
      </Link>

      <PageHeader
        title="Class Insights"
        description={<LiveClassName name={room.name} createdAt={room.created_at} />}
      />

      {annotatedSlides && <AnnotatedSlidesSection data={annotatedSlides} />}

      <StudentInsightsView roomId={roomId} />
    </div>
  )
}
