'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { toast } from 'sonner'
import { Loader2, PanelRight, Zap, MessageCircleQuestion, Clock, X, NotebookPen } from 'lucide-react'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  getRoomSnapshot,
  type RoomSnapshot,
} from '@/lib/live-classroom/snapshot'
import { useRoomChannel } from '@/lib/live-classroom/broadcast/use-room-channel'
import { usePresence } from '@/lib/live-classroom/broadcast/use-presence'
import { useInteractions } from '@/lib/live-classroom/broadcast/use-interactions'
import { useQuestions } from '@/lib/live-classroom/broadcast/use-questions'
import { StudentLiveView } from './StudentLiveView'
import { RecordingBanner } from './RecordingBanner'
import { StudentReactionBar } from './StudentReactionBar'
import { CatchMeUp } from './CatchMeUp'
import { markAttendance } from '@/lib/live-classroom/attendance/actions'
import { AttendanceCodePrompt } from './AttendanceCodePrompt'
import { InteractionResponder } from './InteractionResponder'
import { StudentQuizReviewList, type StudentQuizReviewItem } from './StudentQuizReviewList'
import { getSectionQuizHistory, type QuizHistoryEntry } from '@/lib/live-classroom/history/actions'
import { AskQuestionForm } from './AskQuestionForm'
import { QuestionList } from './QuestionList'
import { LiveNotesEditor } from './LiveNotesEditor'
import { useLiveNotes } from '@/lib/live-classroom/notes/use-notes'
import { SlideAnnotationLayer } from '@/components/live-classroom/shared/SlideAnnotationLayer'
import { RoomTimeline } from '@/components/live-classroom/shared/RoomTimeline'
import { computePendingFullscreenInteractions } from '@/lib/live-classroom/select-fullscreen-notice'
import { SPRING, TAB_FADE } from '@/lib/motion'

interface Props {
  roomId: string
  sectionId: string
  userId: string
  userName?: string
}

type SidebarTab = 'live' | 'qa' | 'activity' | 'notes'

export function StudentClassroomView({
  roomId,
  sectionId,
  userId,
  userName,
}: Props) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  /* Bumped by the retry button so the snapshot effect re-runs. A failed fetch used to leave
     this surface on its loading spinner forever, with no way out but a manual reload. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [respondedIds, setRespondedIds] = useState<Set<string>>(new Set())
  // Server-backed past quizzes (answered + closed), with server-gated answers.
  // Loaded on mount (survives refresh) and refetched when a quiz closes live.
  const [serverHistory, setServerHistory] = useState<QuizHistoryEntry[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  /* The mobile Participate surface. Controlled rather than left to its own
     trigger, so the Answer button below can open it too — see renderStatusItems. */
  const [sheetOpen, setSheetOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<SidebarTab>('notes')

  // Student's freeform notes for this session. Owned here (not in the editor)
  // so the draft + autosave survive the Notes tab unmounting on tab switch.
  const notes = useLiveNotes(roomId)

  useEffect(() => {
    let cancelled = false
    getRoomSnapshot(roomId)
      .then((result) => {
        if (cancelled) return
        if (result.snapshot) {
          setSnapshot(result.snapshot)
          setRespondedIds(new Set(result.snapshot.myResponses.map((r) => r.interaction_id)))
        } else {
          logger.warn('StudentClassroomView: snapshot failed', { error: result.error })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [roomId, loadAttempt])

  // Hydrate past quizzes from the server so the in-session list survives reload.
  useEffect(() => {
    let cancelled = false
    getSectionQuizHistory(sectionId).then((result) => {
      if (!cancelled) setServerHistory(result.entries)
    })
    return () => {
      cancelled = true
    }
  }, [sectionId])

  /* Attendance check-in (#82). 'needed' means the server asked for the code on the first
     heartbeat; 'dismissed' means the student chose to keep watching without checking in, which
     is allowed — the code gates the tick, not the class. 'present' is terminal: a heartbeat
     fired BEFORE the code was accepted can still land after it, carrying a NEEDS_CODE that is
     already out of date, and without a terminal state that stale answer pops the banner back
     up on a student who is correctly checked in. */
  const [codeState, setCodeState] = useState<'idle' | 'needed' | 'dismissed' | 'present'>('idle')
  /* When they dismissed. Dismissal used to be permanent for the session, so a mis-tap on a
     36px X sitting next to the Check in button cost a student their attendance mark with no
     way back and nothing on screen to say so. It now lapses, and the next heartbeat asks
     again. A student who really is remote dismisses it a second time and is no worse off. */
  const dismissedAt = useRef<number | null>(null)
  const DISMISS_MINUTES = 10

  const retryLoad = useCallback(() => {
    setLoading(true)
    setLoadAttempt((n) => n + 1)
  }, [])

  /* Absolute re-read of room state. Used after a reconnect and after a truncated replay,
     both of which leave the event cursor unable to repair what it never applied (#639). */
  const resyncSnapshot = useCallback(() => {
    getRoomSnapshot(roomId).then((result) => {
      if (result.snapshot) {
        setSnapshot(result.snapshot)
        setRespondedIds(new Set(result.snapshot.myResponses.map((r) => r.interaction_id)))
      }
    })
  }, [roomId])

  /* ONE channel for this page. StudentLiveView used to open a second one for the slide,
     and the two recovered independently, so a brief drop restored polls while the slide
     stayed frozen for the rest of the class (#639). It now receives this bus as a prop. */
  const channel = useRoomChannel({
    roomId,
    initialLastSeq: snapshot?.lastSeq ?? 0,
    onResync: resyncSnapshot,
    onReplayTruncated: resyncSnapshot,
  })

  // Announce this student on the room's presence topic so the professor's
  // dashboard can show a live "N students present" count. No student-facing UI.
  usePresence({
    roomId,
    state: { userId, role: 'student', name: userName ?? 'Student' },
  })

  // Durable attendance for the post-session report (presence above is
  // ephemeral): heartbeat on join + every 3 min. The coarse interval keeps
  // the per-student request volume low at scale; "minutes in class" only needs
  // approximate granularity. Fire-and-forget — the server verifies enrollment
  // and rejects ended rooms, so failures are ignorable.
  useEffect(() => {
    /* The first heartbeat is the one that can come back NEEDS_CODE (#82); later ones never do,
       because the server stops asking once the student is present. Still fire-and-forget for
       every other outcome — the server verifies enrollment and rejects ended rooms. */
    const beat = () =>
      markAttendance(roomId)
        .then((r) => {
          if (r?.error === 'NEEDS_CODE') {
            setCodeState((prev) => {
              if (prev === 'present') return prev
              if (prev === 'dismissed') {
                const since = Date.now() - (dismissedAt.current ?? 0)
                return since > DISMISS_MINUTES * 60_000 ? 'needed' : prev
              }
              return 'needed'
            })
          } else if (r?.success) {
            setCodeState('present')
          }
        })
        .catch(() => {})
    beat()
    const id = setInterval(beat, 180_000)
    // Stop heartbeating once the professor ends the class — otherwise the
    // interval keeps firing (the server rejects each) until the student
    // navigates away.
    const off = channel.bus.on('room_ended', () => clearInterval(id))
    return () => {
      clearInterval(id)
      off()
    }
  }, [roomId, channel.bus])

  useEffect(() => {
    const off = channel.bus.on('deck_ready', () => {
      getRoomSnapshot(roomId).then((result) => {
        if (result.snapshot) setSnapshot(result.snapshot)
      })
    })
    return off
  }, [channel.bus, roomId])

  const { openInteractions } = useInteractions({
    bus: channel.bus,
    initialOpenInteractions: snapshot?.openInteractions ?? [],
  })

  // A quiz closing live makes its answers available server-side → refetch so
  // the in-session "Past quizzes" review shows the just-closed quiz.
  useEffect(() => {
    const off = channel.bus.on('interaction_closed', () => {
      getSectionQuizHistory(sectionId).then((result) => setServerHistory(result.entries))
    })
    return off
  }, [channel.bus, sectionId])

  const pendingFullscreenInteractions = useMemo(
    () => computePendingFullscreenInteractions(openInteractions, respondedIds),
    [openInteractions, respondedIds],
  )

  const { questions } = useQuestions({
    bus: channel.bus,
    initialQuestions: snapshot?.recentQuestions ?? [],
  })

  // Only treat a prompt as "active" (pulsing Answer button) if the student
  // hasn't already responded. Once answered, they shouldn't be re-prompted —
  // they can still view their locked-in answers via the Live tab.
  const hasActivePrompt = openInteractions.some(
    (i) => i.status === 'open' && !respondedIds.has(i.id),
  )
  const hasOpenInteraction = openInteractions.some((i) => i.status === 'open')
  const questionCount = questions.length

  const [prevActive, setPrevActive] = useState(hasActivePrompt)
  if (hasActivePrompt !== prevActive) {
    setPrevActive(hasActivePrompt)
    if (hasActivePrompt && !prevActive) {
      setActiveTab('live')
    }
  }

  const renderSlideOverlay = useCallback(
    (slideIndex: number) =>
      snapshot && snapshot.room.deck_url && snapshot.activeDeckId ? (
        <SlideAnnotationLayer
          mode="view"
          roomId={roomId}
          deckId={snapshot.activeDeckId}
          slideIndex={slideIndex}
          slideUrl={snapshot.slideUrls[slideIndex] ?? ''}
          authorId={userId}
          bus={channel.bus}
          initialAnnotations={snapshot.slideAnnotations}
        />
      ) : null,
    [snapshot, roomId, userId, channel.bus],
  )

  /* A FAILED snapshot is not the same as a slow one. getRoomSnapshot returns { error }
     rather than throwing, so `loading` clears and `snapshot` stays null — and this gate used
     to render the joining spinner forever, with no error and no way out but a manual reload.
     A student stuck on "Joining classroom" and a professor stuck on "Connecting" are the
     same defect; the professor's is worse because they are mid-lecture. Surfaced when the
     parents took over the fetch and the children's error states went away with them. */
  if (!loading && !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-6">
        <p className="text-sm font-medium text-foreground">We couldn&apos;t load this classroom.</p>
        <p className="text-sm text-muted-foreground max-w-md">
          Your connection may have dropped. The class is still running, so try again.
        </p>
        <Button onClick={retryLoad} className="rounded-full px-6">Try again</Button>
      </div>
    )
  }

  if (loading || !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
          Joining classroom
        </p>
      </div>
    )
  }

  // Past quizzes the student answered (reveal-on-close). Sourced entirely from
  // the server (answers are server-gated and never in the live payload), loaded
  // on mount so it survives refresh and refetched when a quiz closes live.
  // Scoped to THIS lecture's room — the server action returns the whole
  // section's history (used by the landing page), so filter to the current room.
  const pastQuizzes: StudentQuizReviewItem[] = serverHistory
    .filter((e) => e.roomId === roomId)
    .map((e) => ({
      id: e.interactionId,
      title: e.title,
      closedAt: e.closedAt,
      payload: { title: e.title, questions: e.questions },
      answers: e.myAnswers,
    }))

  const tabs: { key: SidebarTab; label: string; icon: React.ReactNode; badge?: number; pulse?: boolean }[] = [
    { key: 'live', label: 'Live', icon: <Zap className="h-3.5 w-3.5" />, pulse: hasOpenInteraction },
    { key: 'qa', label: 'Q&A', icon: <MessageCircleQuestion className="h-3.5 w-3.5" />, badge: questionCount || undefined },
    { key: 'activity', label: 'Timeline', icon: <Clock className="h-3.5 w-3.5" /> },
    { key: 'notes', label: 'Notes', icon: <NotebookPen className="h-3.5 w-3.5" /> },
  ]

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Tab bar with inline close button */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="flex flex-1 rounded-full bg-muted/50 p-1 gap-0.5" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`relative flex-1 flex items-center justify-center gap-1.5 rounded-full py-2 px-3 text-xs font-medium transition duration-200 ease-out ${
                activeTab === tab.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.pulse && (
                <span className="lc-live-dot h-2 w-2 text-success" aria-hidden />
              )}
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
              {tab.badge && tab.badge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-none tabular-nums">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSidebarOpen(false)}
          className="hidden lg:inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          aria-label="Close sidebar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1 scrollbar-thin">
        <AnimatePresence mode="wait">
          {activeTab === 'live' && (
            <motion.div
              key="live"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <div className="space-y-5">
                {snapshot.room.lecture_summary_enabled !== false && <CatchMeUp roomId={roomId} />}
                <StudentReactionBar userId={userId} ephemeralChannel={channel.ephemeralChannel} />
                {hasOpenInteraction ? (
                  <InteractionResponder
                    interactions={openInteractions}
                    myResponses={snapshot.myResponses}
                    userId={userId}
                    onResponded={(id) =>
                      setRespondedIds((prev) => {
                        const next = new Set(prev)
                        next.add(id)
                        return next
                      })
                    }
                  />
                ) : pastQuizzes.length === 0 ? (
                  <EmptyState
                    variant="teaching"
                    icon={Zap}
                    title="No quiz or poll yet"
                    description="When your professor launches a poll or quiz, it'll appear here for you to answer."
                  />
                ) : (
                  <div className="flex items-center gap-2.5 px-1 py-1 text-xs text-muted-foreground">
                    <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Nothing live right now — review your past quizzes below.
                  </div>
                )}

                {pastQuizzes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
                      Past quizzes
                    </p>
                    <StudentQuizReviewList quizzes={pastQuizzes} />
                  </div>
                )}
              </div>
            </motion.div>
          )}
          {activeTab === 'qa' && (
            <motion.div
              key="qa"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
              className="space-y-5"
            >
              <AskQuestionForm roomId={roomId} />
              <QuestionList questions={questions} currentUserId={userId} />
            </motion.div>
          )}
          {activeTab === 'activity' && (
            <motion.div
              key="activity"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <RoomTimeline bus={channel.bus} snapshot={snapshot} />
            </motion.div>
          )}
          {activeTab === 'notes' && (
            <motion.div
              key="notes"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <LiveNotesEditor
                getInitialContent={notes.getInitialContent}
                onChange={notes.onChange}
                saveState={notes.saveState}
                loaded={notes.loaded}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )

  /* One skin, two triggers — the same lg:hidden / hidden lg:inline-flex split
     Participate below uses. Answer used to be a single button that only called
     setSidebarOpen(true), which is a no-op: sidebarOpen starts true, and below
     lg the panel it controls is `hidden lg:flex` while the mobile surface is
     the Sheet. So on a phone the one control the live pulse is drawing a
     student's eye to did nothing at all, and they had to find Participate
     instead. Desktop docks the wing; below lg the Sheet is the only thing that
     can actually show the prompt. */
  const answerCls =
    'items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 h-9 text-xs font-semibold transition-colors duration-200 ease-out hover:bg-primary/90'

  const renderStatusItems = () => (
    <>
      {hasActivePrompt && (
        <>
          <button
            onClick={() => { setSidebarOpen(true); setActiveTab('live') }}
            className={`hidden lg:inline-flex ${answerCls}`}
          >
            <span className="lc-live-dot h-2 w-2 text-success" aria-hidden />
            Answer
          </button>
          <button
            onClick={() => { setSheetOpen(true); setActiveTab('live') }}
            className={`inline-flex lg:hidden ${answerCls}`}
          >
            <span className="lc-live-dot h-2 w-2 text-success" aria-hidden />
            Answer
          </button>
        </>
      )}
      {!sidebarOpen && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          className="hidden lg:inline-flex rounded-full h-9 px-4 text-xs font-semibold border"
        >
          <PanelRight className="h-3.5 w-3.5 mr-1.5" />
          Participate
        </Button>
      )}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" className="lg:hidden rounded-full h-9 px-4 text-xs font-semibold border">
            <PanelRight className="h-3.5 w-3.5 mr-1.5" />
            Participate
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <SheetHeader className="px-5 py-4 border-b border-border">
            <SheetTitle className="text-base">Participate</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">{sidebarContent}</div>
        </SheetContent>
      </Sheet>
    </>
  )

  // reducedMotion="user" makes framer skip transform/layout animations for anyone
  // with the OS preference set, while keeping opacity ones — the right split, and
  // this surface earns it: a student sits in front of it for a whole lecture.
  // Declared once here rather than at ~48 call sites.
  return (
    <MotionConfig reducedMotion="user">
    <div className="relative h-full overflow-hidden">
      <RecordingBanner roomId={roomId} />
      {codeState === 'needed' && (
        /* Inset to match the stage, and z-30: the sidebar is also absolute at z-20 and comes
           later in the DOM, so at equal z it painted over the right-hand end of this banner —
           which is where the input and the Check in button live. On a laptop with the sidebar
           open (the default) the student was asked for a code with nowhere to type it. */
        /* `pt-14` clears the stage's own chip row, and `pointer-events-none`
           makes the wrapper inert. Both are about the same bug: the stage puts
           the connection chip, the session name and "Leave class" at top-3
           (y 12-48), this banner started at y=12 too, and at z-30 against
           Leave's z-10 it won outright. Leave was invisible AND unclickable —
           the wrapper's whole box, padding included, was a live hit target, so
           a student who wanted to leave had to dismiss the attendance prompt
           first. The card below re-enables pointer events for itself. This is
           exactly how RecordingBanner behaves at the same z-30, one component
           up. */
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-14 transition-[padding] duration-300 ease-out-expo ${
            sidebarOpen ? 'lg:pr-[492px]' : ''
          }`}
        >
          <AttendanceCodePrompt
            onSubmit={async (code) => {
              const r = await markAttendance(roomId, code)
              if (r?.success) {
                setCodeState('present')
                /* Without this, a correct code and a dismissed banner look exactly the same:
                   the banner disappears either way, and the one thing the student wants to
                   know is whether they are marked present. */
                toast.success("You're marked present.")
                return null
              }
              if (r?.error === 'NEEDS_CODE') return 'Enter the code shown in class.'
              return r?.error ?? 'Could not check you in.'
            }}
            onDismiss={() => {
              dismissedAt.current = Date.now()
              setCodeState('dismissed')
            }}
          />
        </div>
      )}
      {/* Stage — insets to the left when the sidebar is open so the deck and
          its control bar reflow beside the wing instead of under it. */}
      <div
        className={`h-full overflow-hidden transition-[padding] duration-300 ease-out-expo ${
          sidebarOpen ? 'lg:pr-[480px]' : ''
        }`}
      >
        <StudentLiveView
          roomId={roomId}
          sectionId={sectionId}
          bus={channel.bus}
          initialRoom={snapshot.room}
          initialSlideUrls={snapshot.slideUrls}
          connectionStatus={channel.status}
          renderSlideOverlay={renderSlideOverlay}
          pendingInteractions={pendingFullscreenInteractions}
          statusSlot={renderStatusItems}
        />
      </div>

      {/* Floating sidebar — desktop only */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ x: 480 }}
            animate={{ x: 0 }}
            exit={{ x: 480 }}
            transition={SPRING}
            className="hidden lg:flex flex-col absolute right-0 top-0 bottom-0 w-[480px] z-20 bg-background/95 backdrop-blur-xl border-l border-border/50 shadow-[-8px_0_32px_-8px_rgba(0,0,0,0.08)] overflow-hidden"
            aria-label="Classroom sidebar"
          >
            {sidebarContent}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  )
}
