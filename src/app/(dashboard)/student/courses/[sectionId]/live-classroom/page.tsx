// Live Classroom student list page — shows active room or waiting message.
// Students can join an active live class from here.

import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Airplay, BookOpen, ChevronRight, Play } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { getSectionQuizHistory } from '@/lib/live-classroom/history/actions'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { LocalDateTime } from '@/components/shared/LocalDateTime'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { SectionRoomWatcher } from '@/components/student/live-classroom/SectionRoomWatcher'
import { StudentQuizHistory } from '@/components/student/live-classroom/StudentQuizHistory'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface LiveClassroomPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function LiveClassroomPage({ params }: LiveClassroomPageProps) {
  const { sectionId } = await params

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

  // Check for active room
  const activeRoom = await liveClassroomQueries.getActiveRoomForSection(supabase, sectionId)

  // Ended sessions — each links to its Class Insights study pack. Require
  // setup_completed so cancelled / never-started scheduled sessions (soft-ended
  // with setup_completed=false) don't surface to students as phantom classes.
  // Mirrors the professor hub's filter.
  const allRooms = await liveClassroomQueries.listRoomsForSection(supabase, sectionId)
  const endedRooms = (
    allRooms as Array<{ id: string; name: string | null; status: string; created_at: string; setup_completed: boolean }>
  ).filter((r) => r.status === 'ended' && r.setup_completed)

  // Past quizzes the student answered (review correct/wrong + reasoning)
  const { entries: quizHistory } = await getSectionQuizHistory(sectionId)

  return (
    <Suspense
      fallback={
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-8">
          <Skeleton className="h-9 w-48 rounded-xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      }
    >
      {/* Tiny client island that listens for `room_started` on the
          section topic and triggers a router.refresh() so the active
          room card appears without a manual reload. */}
      <SectionRoomWatcher sectionId={sectionId} />
      <div className="max-w-4xl mx-auto py-8 px-6">
        <PageHeader
          title="Live Classroom"
          description="Follow along with your professor's live presentation in real time."
          className="mb-8"
        />

        {/* Active room card */}
        {activeRoom ? (
          <div className="rounded-2xl border border-border bg-card p-6 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="lc-live-dot h-2.5 w-2.5 text-success" aria-hidden />
                  <p className="text-xs font-semibold uppercase tracking-widest text-success-muted-foreground">
                    Live now
                  </p>
                </div>
                <p className="text-lg font-semibold text-foreground truncate">
                  <LiveClassName name={activeRoom.name} createdAt={activeRoom.created_at} />
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {activeRoom.deck_page_count ? `${activeRoom.deck_page_count} slides · ` : ''}
                  <LocalDateTime iso={activeRoom.created_at} mode="datetime" prefix="Started" />
                </p>
              </div>
              <Button asChild className="rounded-full px-8 shrink-0 font-semibold">
                <Link href={`/student/courses/${sectionId}/live-classroom/${activeRoom.id}`}>
                  <Play className="h-4 w-4 mr-2" />
                  Join Class
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState
            variant="teaching"
            icon={Airplay}
            title="Waiting for class to start"
            description="When your professor starts a live session, you'll be able to join from here and follow along with their presentation."
          />
        )}

        {/* Past sessions — Class Insights study packs */}
        {endedRooms.length > 0 && (
          <div className="mt-8">
            <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              Past sessions
            </p>
            <AnimatedList className="space-y-2">
              {endedRooms.map((room) => (
                <AnimatedItem key={room.id}>
                  <Link
                    href={`/student/courses/${sectionId}/live-classroom/${room.id}/insights`}
                    className="group flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <BookOpen className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          <LiveClassName name={room.name} createdAt={room.created_at} />
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          <LocalDateTime iso={room.created_at} mode="datetime" />
                        </span>
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
                  </Link>
                </AnimatedItem>
              ))}
            </AnimatedList>
          </div>
        )}

        <StudentQuizHistory entries={quizHistory} />
      </div>
    </Suspense>
  )
}
