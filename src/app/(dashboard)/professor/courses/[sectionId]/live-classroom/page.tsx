// Live Classroom hub — three tabs: Live (active room / start CTA),
// Reports (gallery of every ended session → its class report), and
// Quizzes (past quiz history with stored results).

import { Suspense } from 'react'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Airplay, FileText, History, Play } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { liveClassroomQueries } from '@/lib/supabase/queries'
import { getSectionQuizHistory } from '@/lib/live-classroom/history/actions'
import { type LcRoom } from '@/lib/validations/live-classroom'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/professor/PageHeader'
import { LocalDateTime } from '@/components/shared/LocalDateTime'
import { LiveClassName } from '@/components/live-classroom/shared/LiveClassName'
import { LiveClassroomStartButton } from './LiveClassroomStartButton'
import { ProfessorQuizHistory } from '@/components/professor/live-classroom/ProfessorQuizHistory'
import { ScheduleSessionDialog } from '@/components/professor/live-classroom/ScheduleSessionDialog'
import { UpcomingSessions } from '@/components/professor/live-classroom/UpcomingSessions'
import { ReportsGallery } from './ReportsGallery'
import { getDeckUploadConfig } from './actions'

interface LiveClassroomPageProps {
  params: Promise<{ sectionId: string }>
  searchParams?: Promise<{ tab?: string }>
}

const LIVE_CLASSROOM_TABS = ['live', 'reports', 'quizzes'] as const
type LiveClassroomTab = (typeof LIVE_CLASSROOM_TABS)[number]

function resolveTab(tab: string | undefined): LiveClassroomTab {
  return (LIVE_CLASSROOM_TABS as readonly string[]).includes(tab ?? '') ? (tab as LiveClassroomTab) : 'live'
}

// A session that was never cleanly ended gets swept / marked ended much later,
// producing an implausible span (e.g. "12h 7m"). Past this bound ended_at can't
// be trusted, so omit the duration rather than render a bogus one.
const MAX_PLAUSIBLE_SESSION_MINUTES = 6 * 60

function formatDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null
  const minutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000))
  if (minutes > MAX_PLAUSIBLE_SESSION_MINUTES) return null
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export default async function LiveClassroomPage({ params, searchParams }: LiveClassroomPageProps) {
  const { sectionId } = await params

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page whose buttons happen to fail (.claude/rules/dead-ends.md). Runs
     before anything else on this page, including the write-on-GET branch below.
     Existing rows stay readable through their own detail routes and Grades. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'live-classroom')
  const activeTab = resolveTab((await searchParams)?.tab)
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // Verify access
  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok) notFound()

  // Check for active room
  const activeRoom = await liveClassroomQueries.getActiveRoomForSection(supabase, sectionId)

  // Ended sessions for the Reports gallery. Exclude cancelled scheduled rooms
  // (soft-ended, never started → setup_completed is false), which carry no
  // report and would otherwise clutter the gallery.
  const allRooms = await liveClassroomQueries.listRoomsForSection(supabase, sectionId)
  const endedRooms = allRooms.filter((r: LcRoom) => r.status === 'ended' && r.setup_completed)
  const reportedRoomIds = await liveClassroomQueries.getReportedRoomIds(
    supabase,
    endedRooms.map((r: LcRoom) => r.id),
  )

  // Upcoming scheduled sessions + whether PowerPoint upload is available.
  const [upcoming, deckConfig] = await Promise.all([
    liveClassroomQueries.getUpcomingScheduledRooms(supabase, sectionId),
    getDeckUploadConfig(),
  ])

  // Past quizzes across the section's sessions (results report on click)
  const { entries: quizHistory } = await getSectionQuizHistory(sectionId)

  return (
    <Suspense
      fallback={
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
          <Skeleton className="h-9 w-48 rounded-xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      }
    >
      <div className="max-w-4xl mx-auto py-8 px-6 space-y-8">
        <PageHeader
          title="Live Classroom"
          description="Present slides in real time. Students follow along as you advance through your deck."
        />

        {/* `defaultValue` is the resolved `?tab=` param, so the dashboard's
            "N class reports ready" to-do can deep-link straight to Class
            Insights. Kept main's header shape from #509 — the Schedule action
            now lives inside the Live tab rather than on this line. */}
        <Tabs defaultValue={activeTab}>
          <TabsList>
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="reports">Class Insights</TabsTrigger>
            <TabsTrigger value="quizzes">Quizzes</TabsTrigger>
          </TabsList>

          {/* ── Live ── */}
          <TabsContent value="live" className="mt-6 space-y-6">
            {activeRoom ? (
              <div className="bg-card border border-border rounded-2xl p-6 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="lc-live-dot h-2.5 w-2.5 text-success" aria-hidden />
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-success-muted-foreground">
                        Live now
                      </p>
                      <p className="text-lg font-semibold mt-1 truncate max-w-xs">
                        <LiveClassName name={activeRoom.name} createdAt={activeRoom.created_at} />
                      </p>
                      <p className="text-3xl font-semibold tabular-nums mt-1">
                        {activeRoom.deck_page_count
                          ? `Slide ${activeRoom.current_slide + 1}`
                          : 'No deck yet'}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {activeRoom.deck_page_count
                          ? `${activeRoom.deck_page_count} slides · `
                          : 'Waiting for deck upload · '}
                        <LocalDateTime iso={activeRoom.created_at} mode="datetime" prefix="started" />
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Scheduling only makes sense for the Live tab — Class
                        Insights and Quizzes have nothing to schedule. */}
                    <ScheduleSessionDialog sectionId={sectionId} pptxEnabled={deckConfig.pptxEnabled} />
                    <Button asChild>
                      <Link href={`/professor/courses/${sectionId}/live-classroom/${activeRoom.id}`}>
                        <Play className="h-4 w-4" />
                        Resume class
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                variant="teaching"
                icon={Airplay}
                title="No active class"
                description="Start a live classroom session now, or schedule one for later. Enrolled students join once you start."
              >
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <LiveClassroomStartButton sectionId={sectionId} />
                  <ScheduleSessionDialog sectionId={sectionId} pptxEnabled={deckConfig.pptxEnabled} />
                </div>
              </EmptyState>
            )}

            <UpcomingSessions sectionId={sectionId} sessions={upcoming} />
          </TabsContent>

          {/* ── Reports ── */}
          <TabsContent value="reports" className="mt-6">
            {endedRooms.length === 0 ? (
              <EmptyState
                variant="teaching"
                icon={FileText}
                title="No class insights yet"
                description="When a live session ends, its insights land here — attendance, quiz results, struggle areas, and an AI summary of the lecture."
              />
            ) : (
              <ReportsGallery
                sectionId={sectionId}
                reports={endedRooms.map((room: LcRoom) => ({
                  id: room.id,
                  name: room.name,
                  createdAt: room.created_at,
                  duration: formatDuration(room.created_at, room.ended_at),
                  deckPageCount: room.deck_page_count,
                  reported: reportedRoomIds.has(room.id),
                }))}
              />
            )}
          </TabsContent>

          {/* ── Quizzes ── */}
          <TabsContent value="quizzes" className="mt-6">
            {quizHistory.length === 0 ? (
              <EmptyState
                variant="teaching"
                icon={History}
                title="No quizzes yet"
                description="Quizzes you run during live sessions show up here with their results."
              />
            ) : (
              <ProfessorQuizHistory entries={quizHistory} />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Suspense>
  )
}
