'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { Loader2, PanelRight, MessageCircleQuestion, Clock, X, Mic, MonitorUp, Zap, KeyRound } from 'lucide-react'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getRoomSnapshot, type RoomSnapshot } from '@/lib/live-classroom/snapshot'
import { useRoomChannel } from '@/lib/live-classroom/broadcast/use-room-channel'
import { usePresence } from '@/lib/live-classroom/broadcast/use-presence'
import { useReactions } from '@/lib/live-classroom/broadcast/use-reactions'
import { useInteractions } from '@/lib/live-classroom/broadcast/use-interactions'
import { useQuestions } from '@/lib/live-classroom/broadcast/use-questions'
import { LivePresenter } from './LivePresenter'
import { InteractionComposer } from './InteractionComposer'
import { QuizConceptAnalytics } from './QuizConceptAnalytics'
import { closeQuizWithReport, type QuizReport } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import { QuestionPanel } from './QuestionPanel'
import { PresenceChip } from './PresenceChip'
import { ReactionBadges } from './ReactionBadges'
import { REACTION_KINDS } from '@/lib/live-classroom/reactions/reaction-kinds'
import { toast } from 'sonner'
import { TranscriptionIndicator, TranscriptionMicMenu } from './TranscriptionIndicator'
import { RecordingControl } from './RecordingControl'
import { useRecordingCapture } from '@/lib/live-classroom/recording/use-recording-capture'
import { TranscriptionPanel } from './TranscriptionPanel'
import { SlideAnnotationLayer } from '@/components/live-classroom/shared/SlideAnnotationLayer'
import { RoomTimeline } from '@/components/live-classroom/shared/RoomTimeline'
import { useTranscription } from '@/lib/live-classroom/transcription/use-transcription'
import { useVoiceActivity } from '@/lib/live-classroom/transcription/use-voice-activity'
import { SPRING, TAB_FADE } from '@/lib/motion'

interface Props {
  roomId: string
  sectionId: string
  professorId: string
  professorName: string
  /** Attendance code (#82). Shown here as well as on the projector, because a professor who
   *  never opens the projector window would otherwise have no way to read the code out and
   *  nobody could check in. Null for sessions created before the feature. */
  joinCode: string | null
}

type SidebarTab = 'interactions' | 'qa' | 'transcript' | 'activity'

export function ClassroomDashboard({
  roomId,
  sectionId,
  professorId,
  professorName,
  joinCode,
}: Props) {
  const router = useRouter()
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  /* Bumped by the retry button so the snapshot effect re-runs. A failed fetch used to leave
     this surface on its loading spinner forever, with no way out but a manual reload. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [roomEnded, setRoomEnded] = useState(false)
  const [activeTab, setActiveTab] = useState<SidebarTab>('interactions')

  useEffect(() => {
    let cancelled = false
    getRoomSnapshot(roomId)
      .then((result) => {
        if (cancelled) return
        if (result.snapshot) setSnapshot(result.snapshot)
        else logger.warn('ClassroomDashboard: snapshot failed', { error: result.error })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [roomId, loadAttempt])

  const retryLoad = useCallback(() => {
    setLoading(true)
    setLoadAttempt((n) => n + 1)
  }, [])

  /* Absolute re-read of room state, for the two cases the event cursor cannot repair:
     after a reconnect, and after a truncated replay (#639). */
  const resyncSnapshot = useCallback(() => {
    getRoomSnapshot(roomId).then((result) => {
      if (result.snapshot) setSnapshot(result.snapshot)
    })
  }, [roomId])

  /* ONE channel for this page. LivePresenter used to open a second one for the slide,
     recovering on its own schedule; it now receives this bus as a prop (#639). */
  const channel = useRoomChannel({
    roomId,
    initialLastSeq: snapshot?.lastSeq ?? 0,
    onResync: resyncSnapshot,
    onReplayTruncated: resyncSnapshot,
  })

  // Live roster on the room's dedicated presence topic. Students track
  // themselves too (StudentClassroomView) — count only the students for the
  // "N present" chip.
  const { presentUsers } = usePresence({
    roomId,
    state: { userId: professorId, role: 'professor', name: professorName },
  })
  const studentCount = presentUsers.filter((u) => u.role === 'student').length

  // Live, decaying aggregate of student pacing reactions (confused / slow down
  // / got it / speed up). Ephemeral — nothing persisted.
  const reactionCounts = useReactions(channel.bus)
  const hasReactions = REACTION_KINDS.some((r) => reactionCounts[r.kind] > 0)

  useEffect(() => {
    const off = channel.bus.on('deck_ready', () => {
      getRoomSnapshot(roomId).then((result) => {
        if (result.snapshot) setSnapshot(result.snapshot)
      })
    })
    return off
  }, [channel.bus, roomId])

  const { openInteractions, closedInteractions, aggregatesById } = useInteractions({
    bus: channel.bus,
    initialOpenInteractions: snapshot?.openInteractions ?? [],
  })

  // Quiz report modal — opened on manual close, a past-quiz click, OR the
  // deadline auto-close below. Owned here (not in the composer) so it can
  // pop regardless of which sidebar tab is mounted.
  const [quizReport, setQuizReport] = useState<QuizReport | null>(null)

  // Authoritative quiz auto-close. When a timed quiz passes its deadline (plus
  // a short grace so students' time-up auto-submits land while it's still
  // open), close it server-side — which computes the report and broadcasts
  // interaction_closed to every client (closing it on the students too) — then
  // surface the report. Runs at the dashboard level so it fires no matter which
  // sidebar tab is open. Students also lock + auto-submit at the deadline on
  // their own via QuizCountdown.onExpire, independent of this.
  const closingQuizzesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const GRACE_MS = 2000
    const timedQuizzes = openInteractions.filter(
      (i) =>
        i.kind === 'quiz' &&
        i.status === 'open' &&
        i.opened_at &&
        typeof i.payload.timeLimitSeconds === 'number',
    )
    if (timedQuizzes.length === 0) return

    const sweep = () => {
      const now = Date.now()
      for (const i of timedQuizzes) {
        if (closingQuizzesRef.current.has(i.id)) continue
        const deadline =
          new Date(i.opened_at as string).getTime() +
          (i.payload.timeLimitSeconds as number) * 1000 +
          GRACE_MS
        if (now < deadline) continue
        closingQuizzesRef.current.add(i.id)
        closeQuizWithReport(i.id).then((result) => {
          if (result.error) {
            // Failed, or already closed elsewhere — allow a retry next sweep.
            closingQuizzesRef.current.delete(i.id)
            return
          }
          if (result.report) setQuizReport(result.report)
        })
      }
    }
    sweep()
    const id = setInterval(sweep, 1000)
    return () => clearInterval(id)
  }, [openInteractions])

  const { questions } = useQuestions({
    bus: channel.bus,
    initialQuestions: snapshot?.recentQuestions ?? [],
  })

  useEffect(() => {
    const off = channel.bus.on('room_ended', () => {
      setRoomEnded(true)
      transcription.stop()
      router.push(`/professor/courses/${sectionId}/live-classroom`)
    })
    return off
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.bus, sectionId, router])

  const [liveSlide, setLiveSlide] = useState(snapshot?.room.current_slide ?? 0)
  const snapshotSlide = snapshot?.room.current_slide ?? 0

  const lastSnapshotSlideRef = useRef(snapshotSlide)
  if (lastSnapshotSlideRef.current !== snapshotSlide) {
    lastSnapshotSlideRef.current = snapshotSlide
    if (liveSlide !== snapshotSlide) {
      setLiveSlide(snapshotSlide)
    }
  }

  useEffect(() => {
    const off = channel.bus.on('slide_changed', (evt: { data: { slideIndex: number } }) => {
      setLiveSlide(evt.data.slideIndex)
    })
    return off
  }, [channel.bus])

  const currentSlide = liveSlide
  const activeDeckId = snapshot?.activeDeckId ?? null
  const transcription = useTranscription({
    roomId,
    deckId: activeDeckId,
    currentSlide,
    enabled: snapshot?.room.status === 'live',
  })

  const { level: voiceLevel } = useVoiceActivity({
    stream: transcription.stream,
    enabled: transcription.isListening,
  })

  // Hydrate the transcript panel for the ACTIVE deck — on mount and whenever
  // the deck switches (use-transcription clears its display on switch, so this
  // refills it with the now-active deck's saved transcript).
  useEffect(() => {
    if (!activeDeckId) return
    let cancelled = false
    import('@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions')
      .then(({ getRoomTranscriptions }) => getRoomTranscriptions(roomId, activeDeckId))
      .then((result) => {
        if (!cancelled && result.data && result.data.length > 0) {
          transcription.hydrateTranscripts(result.data)
        }
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, activeDeckId])

  const handleTranscriptionToggle = useCallback(() => {
    if (transcription.isListening) {
      transcription.stop()
    } else {
      transcription.start()
    }
  }, [transcription])

  // Opt-in session recording (default off). Auto-stops when the room ends.
  const recording = useRecordingCapture({
    roomId,
    enabled: snapshot?.room.status !== 'ended',
  })
  const handleRecordingToggle = useCallback(() => {
    if (recording.isRecording) void recording.stop()
    else void recording.start()
  }, [recording])

  // Mic device changed in the picker — restart active captures so they
  // reacquire on the new device (the preference is read at start()).
  const handleMicDeviceChange = useCallback(() => {
    if (transcription.isListening) {
      transcription.stop()
      void transcription.start()
    }
    if (recording.isRecording) {
      void recording.stop().then(() => recording.start())
    }
  }, [transcription, recording])

  // Subtle one-time nudge: if the professor is a minute into class and hasn't
  // started recording, offer it once (never nags again).
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  const nudgedRef = useRef(false)
  // Read the LIVE room status the same way recordingRef reads live recording state:
  // the timer below is armed once and cleared only on unmount, so without this it
  // fired 60s after mount even if the class had been ended or cancelled in between —
  // offering to record a session that was already over.
  const roomStatusRef = useRef(snapshot?.room.status)
  roomStatusRef.current = snapshot?.room.status
  useEffect(() => {
    const timer = setTimeout(() => {
      if (recordingRef.current.isRecording || nudgedRef.current) return
      if (roomStatusRef.current !== 'live') return
      nudgedRef.current = true
      toast('Record this session?', {
        description: 'Capture the audio and slides so students can replay it later.',
        action: { label: 'Record', onClick: () => void recordingRef.current.start() },
      })
    }, 60_000)
    return () => clearTimeout(timer)
  }, [])

  void professorId
  void professorName

  const renderSlideOverlay = useCallback(
    (slideIndex: number) =>
      snapshot && snapshot.room.deck_url && snapshot.activeDeckId ? (
        <SlideAnnotationLayer
          mode="draw"
          roomId={roomId}
          deckId={snapshot.activeDeckId}
          slideIndex={slideIndex}
          slideUrl={snapshot.slideUrls[slideIndex] ?? ''}
          authorId={professorId}
          bus={channel.bus}
          initialAnnotations={snapshot.slideAnnotations}
        />
      ) : null,
    [snapshot, roomId, professorId, channel.bus],
  )

  /* Failed, not slow. See the note in StudentClassroomView: getRoomSnapshot returns
     { error } instead of throwing, so this gate span forever on a dropped fetch. A professor
     stranded on "Connecting to classroom" mid-lecture is the worst instance of it. */
  if (!loading && !snapshot) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-6">
        <p className="text-sm font-medium text-foreground">We couldn&apos;t load this classroom.</p>
        <p className="text-sm text-muted-foreground max-w-md">
          Your connection may have dropped. Your session is still running, so try again.
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
          Connecting to classroom
        </p>
      </div>
    )
  }

  const openCount = openInteractions.length
  const questionCount = questions.filter(
    (q) => !((q.payload.answered as boolean | undefined) ?? false),
  ).length
  const sidebarBadgeCount = openCount + questionCount

  const tabs: { key: SidebarTab; label: string; icon: React.ReactNode; badge?: number; pulse?: boolean }[] = [
    { key: 'interactions', label: 'Interactions', icon: <Zap className="h-3.5 w-3.5" />, badge: openCount || undefined },
    { key: 'qa', label: 'Q&A', icon: <MessageCircleQuestion className="h-3.5 w-3.5" />, badge: questionCount || undefined },
    { key: 'transcript', label: 'Transcript', icon: <Mic className="h-3.5 w-3.5" />, pulse: transcription.isListening },
    { key: 'activity', label: 'Timeline', icon: <Clock className="h-3.5 w-3.5" /> },
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
              /* The visible label is `hidden sm:inline`, and `display: none` drops it
                 from the accessibility tree — so below `sm` the icon is the button's
                 only content, and lucide marks icons aria-hidden. Without this the
                 four tabs announce as "tab, selected" and nothing else. */
              aria-label={tab.label}
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
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-none">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSidebarOpen(false)}
          className="hidden lg:inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          aria-label="Close sidebar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1 scrollbar-thin">
        <AnimatePresence mode="wait">
          {activeTab === 'interactions' && (
            <motion.div
              key="interactions"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <InteractionComposer
                roomId={roomId}
                openInteractions={openInteractions}
                closedInteractions={closedInteractions}
                aggregatesById={aggregatesById}
                hasTranscription={transcription.transcriptByPage.size > 0}
                bus={channel.bus}
                onViewReport={setQuizReport}
              />
            </motion.div>
          )}
          {activeTab === 'qa' && (
            <motion.div
              key="qa"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <QuestionPanel questions={questions} />
            </motion.div>
          )}
          {activeTab === 'transcript' && (
            <motion.div
              key="transcript"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={TAB_FADE}
            >
              <TranscriptionPanel
                transcriptByPage={transcription.transcriptByPage}
                partialText={transcription.partialText}
                currentSlide={currentSlide}
                isListening={transcription.isListening}
              />
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
        </AnimatePresence>
      </div>
    </div>
  )

  if (roomEnded) {
    return (
      <div className="relative h-full">
        <LivePresenter
          roomId={roomId}
          sectionId={sectionId}
          bus={channel.bus}
          initialRoom={snapshot.room}
          initialSlideUrls={snapshot.slideUrls}
          connectionStatus={channel.status}
          renderSlideOverlay={renderSlideOverlay}
          decks={snapshot.decks}
          activeDeckId={snapshot.activeDeckId}
        />
      </div>
    )
  }

  const hasDeck = Boolean(snapshot.room.deck_url && snapshot.room.deck_page_count)

  // Built as a function of isFullscreen: the control bar turns dark in
  // fullscreen, so the transcribe pill needs dark styling, and the "Engage"
  // sidebar toggle is hidden entirely (the sidebar can't open over a
  // fullscreen deck).
  const renderStatusItems = (isFullscreen: boolean) => {
    if (!hasDeck) return undefined
    // One divider treatment: `--border` is re-pointed by the `.lc-stage` scope on
    // the fullscreen stage, so this no longer forks on the surface.
    const dividerCls = 'h-4 w-px bg-border/40'
    return (
      <>
        {/* No leading divider: the status cluster is the right group of the
            control bar, so a divider before the first chip would float in the
            open space left of it. gap/whitespace separates it from the toolbar;
            dividers only sit *between* chips below. */}
        <PresenceChip count={studentCount} />
        {hasReactions && (
          <>
            <span className={dividerCls} aria-hidden />
            <ReactionBadges counts={reactionCounts} />
          </>
        )}
        <span className={dividerCls} aria-hidden />
        <TranscriptionIndicator
          isListening={transcription.isListening}
          isConnected={transcription.isConnected}
          voiceLevel={voiceLevel}
          error={transcription.error}
          onToggle={handleTranscriptionToggle}
          // Drop the label to icon-only when the sidebar insets the control bar
          // (desktop) so the status cluster doesn't overflow against the wing.
          compact={!isFullscreen && sidebarOpen}
        />
        <TranscriptionMicMenu onDeviceChange={handleMicDeviceChange} />
        <span className={dividerCls} aria-hidden />
        <RecordingControl
          isRecording={recording.isRecording}
          error={recording.error}
          onToggle={handleRecordingToggle}
          compact={!isFullscreen && sidebarOpen}
        />
        {joinCode && (
          <>
            <span className={dividerCls} aria-hidden />
            {/* Read-out fallback for the projector overlay. Kept as plain text with wide
                tracking so it survives being read aloud across a lecture hall. */}
            <span
              className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
              title="Attendance code — students enter this to be marked present"
            >
              {/* The icon carries the meaning where the word does not fit. On a phone this
                  used to be a bare "259Z" beside the annotation tools with nothing saying
                  what it was, and a title tooltip never fires on touch. */}
              <KeyRound className="h-3.5 w-3.5 shrink-0 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Code</span>
              <span className="font-mono text-sm font-semibold tracking-[0.2em] text-foreground">
                {joinCode}
              </span>
            </span>
          </>
        )}
        {/* Open Projector View — launches the student-safe projection in a
            standalone window the prof drags to the projector. Opens synchronously
            on the click (which avoids some popup blocking, though not all — see the
            null-return branch in the handler). The projector is fully independent
            (own room:{roomId} subscription), so the opener link is severed after
            opening rather than via the `noopener` feature — see the handler for why
            that distinction matters. */}
        <span className={dividerCls} aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                const path = `/projector/${sectionId}/${roomId}`
                /* NOT 'popup,noopener'. Per spec window.open() returns null whenever
                   `noopener` is set — no reference to the new window may be retained —
                   so the return value cannot double as a "did it open?" signal. Asking
                   it to made the success branch below unreachable and fired the
                   blocked-popup toast on every SUCCESSFUL launch, which is worse than
                   the silent failure it was meant to fix.

                   The back-reference is severed by hand instead: same-origin, so the
                   assignment is allowed, and the projector stays as independent as the
                   original `noopener` intended (it runs its own room:{roomId}
                   subscription and never talks to this window). */
                const win = window.open(path, '_blank', 'popup')
                if (win) {
                  win.opener = null
                  return
                }
                /* A blocked popup returns null, and this used to end there: no window,
                   no toast, nothing — on the most time-critical action in the product,
                   putting slides on the classroom wall as class starts. It has failed
                   this way in production once already.

                   Opening synchronously on the click (above) avoids SOME blocking, but
                   the `popup` window feature is exactly what blockers target, so
                   retrying without it would most likely just fail again. Hand over the
                   URL instead — the projector route serves fine by direct navigation,
                   which is the one fallback that works when popups are a browser
                   setting the professor can't change mid-class. */
                const url = `${window.location.origin}${path}`
                toast.error('Your browser blocked the projector window', {
                  description:
                    'Allow popups for this site, or open the projector link on the other screen.',
                  duration: 12000,
                  action: {
                    label: 'Copy link',
                    onClick: () => {
                      void navigator.clipboard.writeText(url).then(
                        () => toast.success('Projector link copied'),
                        () => toast.error("Couldn't copy the link — it's /projector in this course"),
                      )
                    },
                  },
                })
              }}
              className="rounded-full h-9 w-9 border shrink-0 bg-card border-border hover:bg-accent"
              aria-label="Open Projector View"
            >
              <MonitorUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Open Projector View — drag it to your projector screen</TooltipContent>
        </Tooltip>
        {/* Engage opens the sidebar — meaningless in fullscreen, so hide it there */}
        {!isFullscreen && !sidebarOpen && (
          <>
            <span className={`${dividerCls} hidden lg:block`} aria-hidden />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSidebarOpen(true)}
              className="hidden lg:inline-flex rounded-full h-9 px-4 text-xs font-semibold border"
            >
              <PanelRight className="h-3.5 w-3.5 mr-1.5" />
              Engage
              {sidebarBadgeCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-none">
                  {sidebarBadgeCount}
                </span>
              )}
            </Button>
          </>
        )}
        {!isFullscreen && (
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="lg:hidden rounded-full h-9 px-4 text-xs font-semibold border">
                <PanelRight className="h-3.5 w-3.5 mr-1.5" />
                Engage
                {sidebarBadgeCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-none">
                    {sidebarBadgeCount}
                  </span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
              <SheetHeader className="px-5 py-4 border-b border-border">
                <SheetTitle className="text-base">Engage</SheetTitle>
              </SheetHeader>
              <div className="flex-1 overflow-hidden">{sidebarContent}</div>
            </SheetContent>
          </Sheet>
        )}
      </>
    )
  }

  // reducedMotion="user" makes framer skip transform/layout animations for anyone
  // with the OS preference set, while keeping opacity ones — the right split, and
  // this surface earns it: a student sits in front of it for a whole lecture.
  // Declared once here rather than at ~48 call sites.
  return (
    <MotionConfig reducedMotion="user">
    {/* A lecture runs for long stretches with no input, and recording and
        transcript uploads need the session, so the idle timer stands down while
        the room is live (see IdleTimeout). */}
    <div className="relative h-full overflow-hidden" data-idle-exempt={snapshot.room.status === 'live' ? '' : undefined}>
      {/* Stage — insets to the left when the sidebar is open so the deck and
          its control bar (End Class / fullscreen on the right) reflow beside
          the wing instead of rendering underneath it. Only the live-presenting
          state (hasDeck) is a fixed single-screen stage; pre-class setup and
          the deckless recovery screen scroll instead, so their content (and
          the Start class button) is never clipped by this fixed-height box. */}
      <div
        className={`h-full transition-[padding] duration-300 ease-out-expo ${
          hasDeck ? 'overflow-hidden' : 'overflow-y-auto'
        } ${hasDeck && sidebarOpen ? 'lg:pr-[480px]' : ''}`}
      >
        <LivePresenter
          roomId={roomId}
          sectionId={sectionId}
          bus={channel.bus}
          initialRoom={snapshot.room}
          initialSlideUrls={snapshot.slideUrls}
          connectionStatus={channel.status}
          renderSlideOverlay={renderSlideOverlay}
          statusSlot={renderStatusItems}
          decks={snapshot.decks}
          activeDeckId={snapshot.activeDeckId}
        />
      </div>

      {/* Sidebar panel — desktop only, after deck uploaded */}
      {hasDeck && <AnimatePresence>
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
      </AnimatePresence>}

      {/* Quiz report — manual close, past-quiz click, or deadline auto-close */}
      {quizReport && (
        <QuizConceptAnalytics report={quizReport} onClose={() => setQuizReport(null)} />
      )}
    </div>
    </MotionConfig>
  )
}
