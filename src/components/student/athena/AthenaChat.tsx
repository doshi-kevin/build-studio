// The Athena shell's conversational surface — dock v2 (prototype variant 01).
//
// One component, two poses. Docked it is a 24rem right-hand column with a
// controls-only header. Fullscreen it is a history rail plus a centred 45rem
// column on Athena's own canvas. Both share the thread, the run cards and the
// composer, so switching pose never remounts the conversation or drops a stream.
//
// IMPORTANT (inherited from the retired StudentAITutor): useChat (ai-sdk v5)
// does NOT swap its internal Chat instance when `transport` changes — only
// `id` or `chat` triggers a recreate. So the useChat call lives in ChatSession
// keyed on the active conversation id; switching threads remounts the session
// with a fresh transport (carrying the new conversationId) and fresh initial
// messages. Without this, sendMessage would forever dispatch to whichever
// conversation was active on first mount.

'use client'

import { useRef, useEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { useChat } from '@ai-sdk/react'
import { motion } from 'framer-motion'
import { TextStreamChatTransport, type UIMessage } from 'ai'
import { Loader2, AlertCircle, RotateCcw, X, Maximize2, Minimize2, SquarePen, Undo2, History } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ChatMessage,
  getMessageAttachments,
  getMessageText,
  type TutorDocument,
  type PreviewTarget,
} from './ChatMessage'
import { isStalledWithoutReply, type TurnMessage } from '@/lib/ai/athena-core/turn-state'
import { parseAthenaDirective, type AthenaRunEvent } from '@/lib/ai/athena-directive'
import { balanceStreamingBlocks } from '@/lib/ai/streaming-blocks'
import { studentRoute } from '@/lib/routes/student'
import type { AthenaBackState, AthenaDrive } from './AthenaShell'
import { AthenaComposer } from './AthenaComposer'
import type { AthenaFilePart } from '@/lib/hooks/use-athena-attachments'
import type { DriveMode } from '@/lib/hooks/use-athena-drive-mode'
import { AthenaHistoryRail } from './AthenaHistoryRail'
import { AthenaHistoryDrop } from '@/components/shared/athena/AthenaHistoryDrop'
import { AthenaRunCard, navigationPhase, phaseFromRun, planPhase } from './AthenaRunCard'
import {
  createConversation,
  getMessages,
  deleteConversation,
  generateConversationTitle,
  getAthenaContext,
} from '@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions'
import { ATHENA_NOTICE_PREFIX } from '@/lib/ai/config'
import {
  dbMessageToUIMessage,
  messageRun,
  dbConversationToSummary,
  type ConversationSummary,
} from '@/lib/ai/conversation-utils'

/** Asks she can actually answer today — retrieval over the course materials and
 *  the study-focus ranker. Deliberately NOT the prototype's calendar/quiz-review
 *  copy: a suggestion chip that leads to "I can't see that" is worse than none.
 *  Used twice: as the empty chat's ghost drafts, and as what she mulls over
 *  between turns. */
const SUGGESTED_QUESTIONS = [
  'What am I weak in?',
  'What should I focus on next?',
  'Explain the hardest concept from this week simply',
  'Quiz me on what I just studied',
]

/** How long after a reply settles before she offers a suggestion (a pause point,
 *  never mid-task — the line between an assistant and a nag). */
const MULL_DELAY_MS = 2400
function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export type AthenaPose = 'docked' | 'fullscreen'

/** A first message waiting for its thread to exist: text, files, or both. */
interface PendingPrompt {
  text: string
  files: AthenaFilePart[]
}

export interface AthenaChatProps {
  sectionId: string
  courseCode: string
  greetingName: string
  /** True once the shell has been opened — triggers the lazy context load. */
  active: boolean
  /** Docked column or the fullscreen canvas. */
  pose: AthenaPose
  /** Prompt from a `?athena-topic=` deep link or the entry pill; auto-sent into a
   *  fresh thread. Nonce'd so repeat sends (same text) fire again. */
  topicPrompt?: { text: string; nonce: number }
  onTopicConsumed?: () => void
  onOpenPreview: (target: PreviewTarget) => void
  /** ✕ releases the app (the shell owns open/closed). */
  onRelease: () => void
  /** ⤢ / ⤡ — the shell owns the pose. */
  onTogglePose: () => void
  /** Athena wants the app taken to a roadmap node, on behalf of one answer. The
   *  shell may refuse (the student can't see it); when it doesn't, it reports
   *  back via `drive`, tagged with the same `messageId`. */
  onDriveTo: (drive: AthenaDrive, force?: boolean) => void
  /** The most recent accepted drive, or null. The shell owns this: it holds the
   *  router and the placemark, so it is what knows the app actually moved.
   *  `messageId` is the answer that caused it, so the receipt renders in place. */
  drive: { nonce: number; messageId: string; label: string; said: string; back: AthenaBackState } | null
  /** A drive she prepared but didn't take — the shell decides, so the shell
   *  reports. Rendered as an offer the student can accept when they're ready. */
  declined: { messageId: string; drive: AthenaDrive } | null
  /** Restore the route + scroll position from before that drive. */
  onGoBack: () => void
  /** True while she's moving the app: fullscreen is off the table mid-drive. */
  driving: boolean
  /** Hand the shell this surface's Escape rung — a function that dismisses a
   *  mulled suggestion and reports whether there was one. The shell owns the whole
   *  ladder; see its handler for why this isn't a listener of our own. */
  registerEscapeRung: (rung: (() => boolean) | null) => void
  driveMode: DriveMode
  onDriveModeChange: (mode: DriveMode) => void
}

export function AthenaChat({
  sectionId,
  courseCode,
  greetingName,
  active,
  pose,
  topicPrompt,
  onTopicConsumed,
  onOpenPreview,
  onRelease,
  onTogglePose,
  onDriveTo,
  drive,
  declined,
  onGoBack,
  driving,
  registerEscapeRung,
  driveMode,
  onDriveModeChange,
}: AthenaChatProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [documents, setDocuments] = useState<TutorDocument[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Docked-pose history curtain. Fullscreen uses AthenaHistoryRail instead, which
  // has the width for a permanent list; docked has none, so it gets the drop.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  /* messageId → the rows Athena reported for that answer, for threads loaded
     from the database. Live answers carry theirs as markers inside the streamed
     text; a reopened one carries them here, off `metadata`. Kept beside the
     messages rather than stuffed into their parts, so the shape `useChat` and
     `convertToModelMessages` see is untouched. */
  const [storedRun, setStoredRun] = useState<Record<string, AthenaRunEvent[]>>({})
  const [isBooting, setIsBooting] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  // A prompt (text and/or uploaded files) to auto-send as soon as the (possibly
  // just-created) session mounts.
  const pendingPromptRef = useRef<PendingPrompt | undefined>(undefined)

  // Lazy bootstrap on first open — course pages never pay for this.
  // Extracted from the effect so the history curtain's "Try again" can re-run it:
  // a failed load must not leave the curtain claiming the student has no past chats,
  // which reads as data loss rather than as an error.
  const loadedRef = useRef(false)
  const loadContext = useCallback(async () => {
    setIsBooting(true)
    setHistoryError(null)
    try {
      const res = await getAthenaContext(sectionId)
      if (res.data) {
        // Opening Athena always starts at the greeting (prototype behavior);
        // past threads stay one click away in the fullscreen history rail.
        setConversations(res.data.conversations.map(dbConversationToSummary))
        setDocuments(res.data.documents)
        return
      }
      setHistoryError("Couldn't load your past chats.")
      loadedRef.current = false
      toast.error(res.error || 'Athena is unavailable right now')
    } catch {
      // A rejected request must still clear the boot state — otherwise the body
      // shows "Waking Athena…" forever with no way out. Retry on next open.
      setHistoryError("Couldn't load your past chats.")
      loadedRef.current = false
      toast.error('Athena is unavailable right now')
    } finally {
      setIsBooting(false)
    }
  }, [sectionId])

  useEffect(() => {
    if (!active || loadedRef.current) return
    loadedRef.current = true
    void loadContext()
  }, [active, loadContext])

  /** Create a thread and auto-send this prompt into it (first send of a fresh
   *  chat). Files are already uploaded by the time we get here — they're stored
   *  under the student, not the thread, so they survive this hand-off. */
  const startThreadWith = useCallback(
    async (text: string, files: AthenaFilePart[] = []) => {
      const result = await createConversation(sectionId)
      if (result.error || !result.data) {
        toast.error(result.error || 'Failed to start a chat')
        return
      }
      const data = result.data
      setConversations((prev) => [dbConversationToSummary(data), ...prev])
      pendingPromptRef.current = { text, files }
      setInitialMessages([])
      setStoredRun({})
      setActiveId(data.id)
    },
    [sectionId],
  )

  // `?athena-topic=` deep link, and the entry pill's typed send: once booted,
  // open a FRESH thread with the question auto-sent. Keyed on the nonce so each
  // send starts its own thread, even for the same text.
  const lastTopicNonceRef = useRef(0)
  useEffect(() => {
    if (!active || !topicPrompt || isBooting || !loadedRef.current) return
    if (topicPrompt.nonce === lastTopicNonceRef.current) return
    lastTopicNonceRef.current = topicPrompt.nonce
    onTopicConsumed?.()
    startThreadWith(topicPrompt.text)
  }, [active, topicPrompt, isBooting, onTopicConsumed, startThreadWith])

  const handleNewChat = useCallback(() => {
    // Lazy: no row until the first message is sent (greeting state handles it).
    setInitialMessages([])
    setActiveId(null)
  }, [])

  const handleSelect = useCallback(
    async (id: string) => {
      if (id === activeId || isSwitching) return
      setIsSwitching(true)
      try {
        const result = await getMessages(id)
        if (result.error) {
          toast.error(result.error)
          return
        }
        setInitialMessages(result.data.map(dbMessageToUIMessage))
        setStoredRun(
          Object.fromEntries(
            result.data.map((m) => [m.id, messageRun(m)]).filter(([, run]) => (run as []).length > 0),
          ),
        )
        setActiveId(id)
      } catch {
        toast.error('Failed to load conversation')
      } finally {
        setIsSwitching(false)
      }
    },
    [activeId, isSwitching],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deleteConversation(id)
      if (!result.success) {
        toast.error(result.error || 'Failed to delete conversation')
        return
      }
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (id === activeId) {
        setInitialMessages([])
        setActiveId(null)
      }
    },
    [activeId],
  )

  /* A thread that started empty gets its AI-generated title after the first
     exchange — patch it into local state so the rail updates live. */
  const handleTitleGenerated = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
  }, [])

  const isFullscreen = pose === 'fullscreen'

  /* Controls only. The orb, the name and the course sub-line are gone: the ring
     around the app already says whose frame this is, and a header that repeats it
     costs 40px of thread on a 24rem column. */
  /* The controls row and the history curtain are SIBLINGS inside a positioned wrapper.
     Nesting the curtain inside the row put it in that row's stacking context, where a
     positioned child paints over its parent's content — the closed curtain covered the
     controls, including the only visible way to close the dock. */
  const controls = (
    <div className="relative z-20 shrink-0">
    {/* Transparent while the curtain is shut, so the controls read as floating on
        the thread rather than as a white bar ruled across the top of the dock.
        It turns solid only while the curtain is down, where it has to: the
        curtain is a card, and a see-through header above it would leave the
        surface looking cut in half. Safe to be transparent now that the curtain
        is clipped and can no longer slide up behind these buttons — the opaque
        fill was there to hide it. */}
    <div
      className={`relative z-40 flex items-center justify-end gap-0.5 transition-colors duration-200 motion-reduce:transition-none ${
        historyOpen ? 'bg-card' : 'bg-transparent'
      } ${isFullscreen ? 'px-1 pb-1 pt-2.5' : 'pb-1.5 pt-1'}`}
    >
      {/* Docked only: fullscreen has the history rail, which carries its own. */}
      {!isFullscreen && (
        <button
          type="button"
          onClick={() => {
            setHistoryOpen(false)
            handleNewChat()
          }}
          aria-label="New chat"
          title="New chat"
          className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <SquarePen className="h-4.5 w-4.5" aria-hidden />
        </button>
      )}
      {/* Docked only, same reason — and the gap this fills: before it, a docked
          student could start a new chat but had no way back to an old one. */}
      {!isFullscreen && (
        <button
          type="button"
          ref={historyTriggerRef}
          onClick={() => setHistoryOpen((v) => !v)}
          aria-label="Chat history"
          aria-expanded={historyOpen}
          aria-controls="athena-student-history"
          title="Chat history"
          className={`flex h-8 w-8 items-center justify-center rounded-xl transition hover:bg-accent hover:text-foreground ${
            historyOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'
          }`}
        >
          <History className="h-4.5 w-4.5" aria-hidden />
        </button>
      )}
      <button
        type="button"
        onClick={onTogglePose}
        disabled={!isFullscreen && driving}
        aria-label={isFullscreen ? 'Back to the docked view' : 'Full screen'}
        title={
          !isFullscreen && driving
            ? 'Athena is showing you something — one moment'
            : isFullscreen
              ? 'Back to the docked view'
              : 'Full screen'
        }
        className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        {isFullscreen ? (
          <Minimize2 className="h-4.5 w-4.5" aria-hidden />
        ) : (
          <Maximize2 className="h-4.5 w-4.5" aria-hidden />
        )}
      </button>
      <button
        type="button"
        onClick={onRelease}
        aria-label="Close Athena — release the app"
        title="Release the app"
        className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        <X className="h-4.5 w-4.5" aria-hidden />
      </button>
      </div>
      {!isFullscreen && (
        <AthenaHistoryDrop
          id="athena-student-history"
          returnFocusRef={historyTriggerRef}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          // The bootstrap fetch owns this list. Without it the curtain claimed
          // "no past chats" while they were still loading.
          loading={isBooting}
          error={historyError}
          onRetry={() => void loadContext()}
          // Frontier is a professor-authoring concept, so no `mode` is passed and
          // no tag renders — the same curtain, minus a control that would mean
          // nothing to a student.
          items={conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))}
          activeId={activeId ?? ''}
          onSelect={(item) => {
            void handleSelect(item.id)
            setHistoryOpen(false)
          }}
          // Deliberately NO delete here. The student path is `deleteConversation`, a hard
          // cascade delete of the thread and every message, with no confirmation and no
          // undo — unlike the professor curtain, which archives and offers Undo. The
          // fullscreen rail keeps its existing (hover-gated) control; putting the same
          // irreversible action one tap away on a phone, flush against the row you tap to
          // OPEN a chat, is a new risk this feature should not introduce. Soft-delete for
          // students is a follow-up.
          emptyText="Your past chats with Athena will appear here."
        />
      )}
    </div>
  )

  const body = isBooting ? (
    <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Waking Athena…
    </div>
  ) : isSwitching && !activeId ? (
    // Reopening a past chat from the GREETING state: activeId stays null until the
    // messages land, so ChatSession — which owns the switching spinner — is not mounted
    // yet and the student was left staring at the greeting for as long as the fetch took.
    <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Opening that chat…
    </div>
  ) : activeId ? (
    <ChatSession
      key={activeId}
      sectionId={sectionId}
      conversationId={activeId}
      initialMessages={initialMessages}
      storedRun={storedRun}
      initialPrompt={pendingPromptRef.current}
      onPromptConsumed={() => {
        pendingPromptRef.current = undefined
      }}
      documents={documents}
      isSwitching={isSwitching}
      pose={pose}
      onDriveTo={onDriveTo}
      drive={drive}
      declined={declined}
      driving={driving}
      registerEscapeRung={registerEscapeRung}
      onGoBack={onGoBack}
      onOpenPreview={onOpenPreview}
      onTitleGenerated={handleTitleGenerated}
      driveMode={driveMode}
      onDriveModeChange={onDriveModeChange}
    />
  ) : (
    <Greeting
      sectionId={sectionId}
      courseCode={courseCode}
      greetingName={greetingName}
      pose={pose}
      onAsk={startThreadWith}
      driveMode={driveMode}
      onDriveModeChange={onDriveModeChange}
    />
  )

  // ONE tree for both poses. The rail's slot is held by `false` when docked and
  // the column keeps its position, so switching pose never remounts ChatSession
  // (which owns useChat — a remount kills an in-flight stream and drops the
  // thread). Branching on the whole return statement did exactly that.
  return (
    <div className={isFullscreen ? 'flex min-h-0 flex-1' : 'flex min-h-0 flex-1 flex-col'}>
      {isFullscreen && (
        <AthenaHistoryRail
          conversations={conversations}
          activeId={activeId}
          onSelect={handleSelect}
          onNew={handleNewChat}
          onDelete={handleDelete}
        />
      )}
      <div className={`flex min-h-0 flex-1 flex-col ${isFullscreen ? 'px-5' : ''}`}>
        {controls}
        {body}
      </div>
    </div>
  )
}

/** The centred column fullscreen puts the thread and composer in. */
function colClass(pose: AthenaPose): string {
  return pose === 'fullscreen' ? 'mx-auto w-full max-w-[45rem]' : ''
}

// ── Greeting — no thread yet; first send creates one ────────────────────────
//
// The suggestions ARE ghost messages here: a right-aligned stack of drafts you
// could send, in the same dashed shape her mulled suggestion takes over the
// composer later. One visual idea, two places.

function Greeting({
  sectionId,
  courseCode,
  greetingName,
  pose,
  onAsk,
  driveMode,
  onDriveModeChange,
}: {
  sectionId: string
  courseCode: string
  greetingName: string
  pose: AthenaPose
  onAsk: (text: string, files?: AthenaFilePart[]) => void
  driveMode: DriveMode
  onDriveModeChange: (mode: DriveMode) => void
}) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const ask = async (text: string, files: AthenaFilePart[] = []) => {
    const t = text.trim()
    if ((!t && files.length === 0) || sending) return
    setSending(true)
    // Clear in `finally`: if `onAsk` (thread creation) rejects, the composer and
    // suggestion buttons must not stay disabled until the component remounts.
    try {
      await onAsk(t, files)
    } finally {
      setSending(false)
    }
  }

  const col = colClass(pose)

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        <div className={`${col} ${pose === 'fullscreen' ? 'pt-[9vh]' : 'pt-11'} pb-5`}>
          <div className={`athena-serif text-center leading-tight ${pose === 'fullscreen' ? 'text-[32px]' : 'text-[26px]'}`}>
            {getGreeting()}, {greetingName}.
          </div>
          <p className="mb-4 mt-1.5 text-center text-sm text-muted-foreground">
            Tell me what you’re studying — I’ll explain it and quiz you on it.
          </p>
          <div className="flex flex-col items-end gap-2">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                disabled={sending}
                className="rounded-2xl rounded-br-md border-[1.5px] border-dashed border-primary/45 bg-primary/10 px-3 py-2 text-left text-sm leading-relaxed text-foreground/80 transition-colors hover:border-primary/70 hover:text-foreground disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* No bottom padding: the dock's own inset already matches the app core's,
          so the composer's lower edge lines up with the frame beside it. */}
      <div className={`${col} pt-2`}>
        <AthenaComposer
          sectionId={sectionId}
          value={input}
          onChange={setInput}
          onSend={(files) => ask(input, files)}
          onStop={() => {}}
          isLoading={sending}
          isStreaming={false}
          placeholder={`Ask Athena anything about ${courseCode}…`}
          driveMode={driveMode}
          onDriveModeChange={onDriveModeChange}
          mulling={null}
          onSendMulling={() => {}}
          onDismissMulling={() => {}}
          autoFocus
        />
      </div>
    </>
  )
}

// ── ChatSession — owns useChat for one conversation ─────────────────────────

function ChatSession({
  sectionId,
  conversationId,
  initialMessages,
  storedRun,
  initialPrompt,
  onPromptConsumed,
  documents,
  isSwitching,
  pose,
  onOpenPreview,
  onDriveTo,
  drive,
  declined,
  driving,
  registerEscapeRung,
  onGoBack,
  onTitleGenerated,
  driveMode,
  onDriveModeChange,
}: {
  sectionId: string
  conversationId: string
  initialMessages: UIMessage[]
  /** Rows recorded on answers loaded from the database, by message id. */
  storedRun: Record<string, AthenaRunEvent[]>
  initialPrompt?: PendingPrompt
  onPromptConsumed: () => void
  documents: TutorDocument[]
  isSwitching: boolean
  pose: AthenaPose
  onOpenPreview: (target: PreviewTarget) => void
  onDriveTo: (drive: AthenaDrive, force?: boolean) => void
  drive: { nonce: number; messageId: string; label: string; said: string; back: AthenaBackState } | null
  /** A drive she prepared but didn't take — the shell decides, so the shell
   *  reports. Rendered as an offer the student can accept when they're ready. */
  declined: { messageId: string; drive: AthenaDrive } | null
  driving: boolean
  registerEscapeRung: (rung: (() => boolean) | null) => void
  onGoBack: () => void
  onTitleGenerated: (id: string, title: string) => void
  driveMode: DriveMode
  onDriveModeChange: (mode: DriveMode) => void
}) {
  /** The thread's own scroller — the only thing that may move when a message
   *  lands. See the effect below for what happens when the browser picks. */
  const threadRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  /* Only auto-title threads that began empty in this session — existing
     threads keep their saved title. Guard so we generate exactly once. */
  const startedEmptyRef = useRef(initialMessages.length === 0)
  const titledRef = useRef(false)

  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: '/api/chat',
        // driveMode gates which tools the route exposes (copilot may leave
        // study artifacts on the roadmap). Advisory, not authority — the
        // server treats anything but 'chat' as the default.
        body: { sectionId, conversationId, driveMode },
      }),
    [sectionId, conversationId, driveMode],
  )

  const { messages, sendMessage, status, error, regenerate, stop } = useChat({
    id: conversationId,
    transport,
    messages: initialMessages,
    onError: (err: Error) => {
      // Same split as ErrorRow: the server's own sentence, or nothing raw.
      toast.error(
        err.message?.startsWith(ATHENA_NOTICE_PREFIX)
          ? err.message.slice(ATHENA_NOTICE_PREFIX.length)
          : 'Failed to get a response. Please try again.',
      )
    },
  })

  const isLoading = status === 'submitted' || status === 'streaming'
  /* Same transcript-read detector the other two surfaces use (#651). Not a step count:
     one server step can fire several tool calls, so counting chips would miss it. */
  const stalledWithoutReply = useMemo(
    () => isStalledWithoutReply(messages as TurnMessage[]),
    [messages],
  )
  const isStreaming = status === 'streaming'

  /* Keep the thread pinned to the newest message by scrolling the THREAD, never
     by asking the browser to bring an element into view.
     `scrollIntoView` walks every scrollable ancestor, and `.athena-host` is
     `overflow: hidden` — which is still a scrollport. So once the thread grew
     past a screen (reliably by the second answer) the browser satisfied the
     request by shifting the entire Athena frame upward, with no scrollbar
     anywhere to reveal what had happened. It read as "the whole page scrolled
     up and never came back", because nothing scrolls it back.
     Setting scrollTop on the one element that should move cannot touch an
     ancestor. */
  useEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    thread.scrollTo({
      top: thread.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [messages, status])

  // ── run chrome ────────────────────────────────────────────────────────────
  // Every card is DERIVED — the lookups from the run events the route streamed
  // alongside the answer, the navigation card from the shell's `drive` (it owns
  // the router and the placemark, so it is the thing that knows a drive
  // happened). Nothing here is stored, timed or invented on the client.
  /* Runs, then settles and stays — the same lifecycle as the lookup card. It is
     scoped to the answer that drove (see `drive.messageId`), so it never follows
     later turns down the thread; that was the actual problem with showing it
     always, not the fact that it persists. */
  const navRun = useMemo(
    () => navigationPhase(drive?.label ?? '', driving),
    [drive?.label, driving],
  )

  // Auto-send exactly once: a topic deep link, a pill send, or a greeting-state
  // first message.
  const autoSentRef = useRef(false)
  useEffect(() => {
    if (autoSentRef.current || !initialPrompt) return
    const text = initialPrompt.text.trim()
    const files = initialPrompt.files
    if (!text && files.length === 0) return
    autoSentRef.current = true
    onPromptConsumed()
    sendMessage(files.length ? { text, files } : { text })
  }, [initialPrompt, onPromptConsumed, sendMessage])

  /* Athena drives the app: the finished answer carries a node to open (appended
     by the route, never written by the model). Fired once per message — the ref
     guards a re-render.

     Chat-only mode is where the drive stops: the answer still names the material,
     and the student's screen doesn't move. Co-pilot IS the consent, so in that
     mode she goes and then offers the way back — one line in the chat, after the
     fact. Asking again before each move is a click tax on a decision already
     made, and nothing she does without you is irreversible.

     ONLY a message that streamed in this session may drive. The directive isn't
     persisted, so in principle a reopened thread has nothing to act on — but
     "in principle" was doing real work there: the route now scrubs before it
     persists, and this is the second lock, so that a stored marker (from a
     thread written before that fix, or by any future path that skips it) reads
     as text instead of teleporting the student every time they scroll back
     through their history. */
  const drivenRef = useRef<string | null>(null)
  const last = messages[messages.length - 1]
  /** Ids that streamed in THIS session — the only ones allowed to drive. */
  const streamedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!last) return
    if (status === 'streaming') {
      streamedRef.current.add(last.id)
      return
    }
    if (status !== 'ready' || last.role !== 'assistant') return
    if (drivenRef.current === last.id) return
    if (!streamedRef.current.has(last.id)) return
    const { gotoNode, proposal } = parseAthenaDirective(getMessageText(last))
    // One reducer, both directive kinds (§13.3). A proposal outranks a plain
    // node drive for the same reason the server ranks it higher: she was asked
    // to set something up, and landing anywhere else strands it.
    const target: Omit<AthenaDrive, 'messageId'> | null = proposal
      ? {
          route: proposal.route,
          label: proposal.label,
          // Each propose tool writes its own receipt sentence; the fallback is
          // only reachable for a thread persisted before that field existed.
          said: proposal.said || 'Set that up for you on the page you\'re on now.',
          prefill: proposal.prefill,
        }
      : gotoNode
        ? {
            route: studentRoute.roadmapNode(sectionId, gotoNode),
            label: 'Roadmap · the node she explained',
            said: 'Opened the roadmap and pointed at what I explained.',
          }
        : null
    if (!target) return
    drivenRef.current = last.id
    /* Always handed over. The shell decides whether to take it — chat-only mode,
       a closed dock, a background tab, or the student sitting in an editor we
       won't pull them out of — and reports back through `drive` or `declined`. */
    onDriveTo({ ...target, messageId: last.id })
  }, [status, last, onDriveTo, sectionId])

  /* After the first full exchange on a fresh thread, generate a concise
     AI title and patch it into the rail. Runs once per new conversation. */
  useEffect(() => {
    if (titledRef.current || !startedEmptyRef.current) return
    if (status !== 'ready' || messages.length < 2) return
    titledRef.current = true
    generateConversationTitle(conversationId).then((res) => {
      if (res.title) onTitleGenerated(conversationId, res.title)
    })
  }, [status, messages.length, conversationId, onTitleGenerated])

  // ── mulling ───────────────────────────────────────────────────────────────
  // ⚠️ MOCKED: which suggestion she offers is a rotation through the canned list,
  // not a read of the student's state. The proactive-delivery brief (design doc
  // X6) owns the real selection; the surface it renders into is finished.
  const [mullIndex, setMullIndex] = useState(0)
  const [mulling, setMulling] = useState<string | null>(null)
  /* Set once Escape has waved a suggestion away, and never unset for this chat.
     Without it the rung was unexhaustible (#662): dismissing bumped mullIndex, which
     changed mullCandidate, which re-armed the timer — so a new suggestion appeared
     2.4s later and the NEXT Escape was consumed by that one, forever. The rung
     therefore never returned false and never fell through to the rung that closes
     Athena, leaving a keyboard-only student with no way to dismiss her at all.
     Dismissing the suggestion is a statement about wanting it gone, not a request
     for a different one. */
  const [mullDismissed, setMullDismissed] = useState(false)
  /* Skip past anything the student just asked — offering back the question that
     is already answered on screen is the one suggestion guaranteed to be useless. */
  const mullCandidate = useMemo(() => {
    const lastAsk = messages.filter((m) => m.role === 'user').at(-1)
    const asked = lastAsk ? getMessageText(lastAsk).trim().toLowerCase() : ''
    for (let i = 0; i < SUGGESTED_QUESTIONS.length; i++) {
      const q = SUGGESTED_QUESTIONS[(mullIndex + i) % SUGGESTED_QUESTIONS.length]
      if (q.toLowerCase() !== asked) return q
    }
    return null
  }, [messages, mullIndex])

  useEffect(() => {
    // She only mulls at a pause, and never on an empty chat (the greeting stacks
    // its own drafts). The timeout is the only writer — the "not right now"
    // conditions are applied at render instead, so nothing has to be un-set.
    if (status !== 'ready' || messages.length === 0 || !mullCandidate || mullDismissed) return
    const timer = setTimeout(() => setMulling(mullCandidate), MULL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [status, messages.length, mullCandidate, mullDismissed])

  /* She dissolves the moment you start typing your own thing, and never shows
     while she's answering. Derived, so there is no state to race. */
  const shownMulling = status === 'ready' && !input.trim() ? mulling : null

  /* Advance to the NEXT suggestion. Correct for the ✕ and for sending one — those
     mean "not this one", and offering another is welcome. Escape is different: it is
     the dismiss-a-layer key, so it sets mullDismissed instead (see the rung below), or
     this rung could never be exhausted (#662). */
  const nextMull = () => {
    setMullIndex((i) => i + 1)
    setMulling(null)
  }

  /* Escape waves the suggestion away — but as a RUNG the shell calls, never a
     document listener of our own. Two listeners raced: whichever React had
     re-registered most recently ran first, so one press either closed two layers
     or the wrong one. Handing the shell a function puts the whole ladder in one
     readable place, with the suggestion correctly ranked below Radix's menus and
     the citation preview (it is invisible until you hover the box — closing what
     you can't see first is the surprising order) and above the pose changes. */
  useEffect(() => {
    registerEscapeRung(() => {
      if (!shownMulling) return false
      /* Stop offering suggestions for this chat rather than advancing to the next
         one — otherwise this rung can never be exhausted and Escape never reaches
         the rung below it (#662). */
      setMullDismissed(true)
      setMulling(null)
      return true
    })
    return () => registerEscapeRung(null)
  }, [registerEscapeRung, shownMulling])

  const handleSend = (files: AthenaFilePart[]) => {
    const text = input.trim()
    if ((!text && files.length === 0) || isLoading) return
    setInput('')
    sendMessage(files.length ? { text, files } : { text })
  }

  const col = colClass(pose)

  return (
    <>
      <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-1">
        <div className={`${col} flex flex-col gap-5 py-3 pr-1`}>
          {isSwitching ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading conversation…
            </div>
          ) : (
            messages.map((message, index) => {
              const parsed = parseAthenaDirective(getMessageText(message))
              // The turn is settled once she's stopped streaming it. A card on
              // the last message while `isLoading` may still gain rows.
              const settled = !(index === messages.length - 1 && isLoading)
              /* Live answers carry their rows as markers inside the streamed
                 text; an answer read back from the database carries them in
                 `metadata` instead, because the text is stored scrubbed. Same
                 rows either way, so the cards look identical — a thread you
                 reopen tomorrow still shows what she actually did. */
              const run = parsed.run.length > 0 ? parsed.run : (storedRun[message.id] ?? [])
              const attachments = getMessageAttachments(message)
              const streamingNow = isStreaming && index === messages.length - 1
              /* What the student will actually SEE this frame — an answer that
                 opens with a display formula has tokens but nothing visible yet,
                 because the balancer withholds the unclosed block below. */
              const shown = streamingNow ? balanceStreamingBlocks(parsed.text) : parsed.text
              /* A turn that failed before the model ran streams a NOTICE instead
                 of an answer (athena-core/stream.ts). It arrives as text rather
                 than as an error because erroring the body makes the client throw
                 away the partial stream, taking the lookup card's rows with it —
                 the student is then left watching a spinner that never resolves.
                 So it comes through here, and the marker has to come off: it is
                 the server talking to the student, not Athena's own words. */
              const notice = parsed.text.startsWith(ATHENA_NOTICE_PREFIX)
                ? parsed.text.slice(ATHENA_NOTICE_PREFIX.length)
                : null
              // The third argument is "has she said anything yet": the card holds
              // its spinner through the gap between the last lookup and the first
              // token, which is otherwise a dead-still thread.
              const lookups = phaseFromRun(run, settled, shown.length > 0)
              // A propose tool's declared steps, in their own card (§14.5).
              const planned = planPhase(run)
              return (
              <Fragment key={message.id}>
                {/* Above the answer: she looks things up, THEN speaks. */}
                {lookups && <AthenaRunCard phase={lookups} />}
                {planned && <AthenaRunCard phase={planned} />}
                {/* No bubble until there is something in it. The route now streams
                    the run markers BEFORE the answer, so an assistant message
                    exists — carrying only markers, which strip to nothing — for as
                    long as the lookups take. That is the whole point (the cards
                    tick live), but an empty bubble hanging above them for a second
                    is not. */}
                {notice && (
                  <div className="flex items-center gap-2 rounded-2xl border border-destructive/30 bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1">{notice}</span>
                  </div>
                )}
                {!notice && (parsed.text.length > 0 || attachments.length > 0) && (
                  <ChatMessage
                    role={message.role}
                    content={parsed.text}
                    attachments={attachments}
                    documents={documents}
                    onOpenPreview={onOpenPreview}
                    /* Only the answer currently arriving. Withholding an unclosed
                       block is right mid-stream and wrong once the turn settles. */
                    streaming={streamingNow}
                  />
                )}
                {/* She answered, she moved you, THEN the offer — in that order,
                    and anchored to the answer that DID the moving. Rendered at the
                    tail of the thread instead, the next question you asked slid in
                    above it and the receipt drifted to the bottom of a
                    conversation it had nothing to do with.
                    Only the most recent drive is offered back: an older placemark
                    is gone, and a stack of "back to where I was" buttons is a
                    maze, not a courtesy. */}
                {declined?.messageId === message.id && (
                  <DeclinedDriveLine
                    label={declined.drive.label}
                    onGo={() => onDriveTo(declined.drive, true)}
                  />
                )}
                {drive?.messageId === message.id && (
                  <Fragment key={drive.nonce}>
                    <AthenaRunCard phase={navRun} />
                    {!driving && (
                      <BackLine said={drive.said} state={drive.back} onBack={onGoBack} />
                    )}
                  </Fragment>
                )}
              </Fragment>
              )
            })
          )}
          {/* An ephemeral status row (never a chat message) while she works. It
              belongs IN the thread, right under the question — pinned above the
              composer instead, it read as chrome and sat a whole card away from
              the turn it described. */}
          {status === 'submitted' && <ThinkingRow />}
          {error && <ErrorRow error={error} onRetry={regenerate} />}
          {/* The step cap tripped: Athena used her whole budget looking things up and
              never answered. Found on the professor's in-builder dock (#651) and fixed
              only there; this surface runs the same loop against a 4-step cap and said
              nothing, which reads to a student as the tutor ignoring them. Her daily
              limit is spent either way, so an empty turn has to admit it. */}
          {stalledWithoutReply && !isLoading && (
            <div role="status" className="px-1 text-sm text-muted-foreground">
              I looked through your materials but didn&apos;t land on an answer. Ask me again,
              maybe a bit more specifically?
            </div>
          )}
          {/* Standing room under the last turn, so the suggestion she reveals on
              hover has somewhere to appear without covering the conversation. */}
          {/* Bottom padding so the composer never covers the last message. */}
          <div className="h-14 shrink-0" />
        </div>
      </div>

      <div className={`${col} pt-1`}>
        <AthenaComposer
          sectionId={sectionId}
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={stop}
          isLoading={isLoading}
          isStreaming={isStreaming}
          placeholder="Ask a follow-up…"
          driveMode={driveMode}
          onDriveModeChange={onDriveModeChange}
          mulling={shownMulling}
          onSendMulling={() => {
            const text = shownMulling
            nextMull()
            if (text) sendMessage({ text })
          }}
          onDismissMulling={nextMull}
        />
      </div>
    </>
  )
}

/** The way back — ONE line in the chat, offered after the fact.
 *
 *  The only thing Co-pilot costs the student is their place, and no undo restores
 *  attention. So the shell remembers where they were before moving, and this
 *  offers it back where the conversation already is. Two heavier designs (a
 *  confirmation before each move, a floating receipt card on the page she moved
 *  you to) were both considered and cut: one is redundant once Co-pilot is the
 *  consent, the other eats the app it just navigated to. */
function BackLine({
  said,
  state,
  onBack,
}: {
  /** What she actually did — carried with the drive, because a hard-coded
   *  sentence described the roadmap for every proposal, including the two that
   *  never touch it. A wrong receipt is worse than no receipt. */
  said: string
  state: AthenaBackState
  onBack: () => void
}) {
  const done = state === 'restored' || state === 'route-only'
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs leading-snug text-muted-foreground">
      {/* Live, because the outcome lands a navigation later than the click: a
          keyboard or screen-reader student otherwise gets no word either way. */}
      <span role="status">
        {state === 'restored'
          ? 'Took you back to where you were.'
          : state === 'route-only'
            ? /* The route came back and the place on it didn't — the page changed
                 under us, or the student took the scroll back mid-return. Saying
                 "where you were" here is the one claim they can catch us on. */
              'Took you back to the page you were on.'
            : said}
      </span>
      {!done && (
        <button
          type="button"
          onClick={onBack}
          /* Stays mounted while returning, disabled: unmounting it under the
             cursor on a slow route reads as a dead click, and drops focus to
             <body> for anyone navigating by keyboard. */
          disabled={state === 'returning'}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-border px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted-foreground"
        >
          <Undo2 className={`h-3 w-3 ${state === 'returning' ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
          {state === 'returning' ? 'Going back…' : 'Back to where I was'}
        </button>
      )}
    </div>
  )
}

/** A drive she prepared but didn't take, because taking it would have surprised
 *  the student (they're mid-assignment, the dock is closed, the tab is in the
 *  background) or because they've asked her not to move the screen at all.
 *
 *  The deferral is itself feedback: the alternative was a ticked plan card and
 *  prose describing a page that never opened. */
function DeclinedDriveLine({ label, onGo }: { label: string; onGo: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs leading-snug text-muted-foreground">
      <span>Didn&apos;t move you — it&apos;s ready when you are.</span>
      <button
        type="button"
        onClick={onGo}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        {label}
      </button>
    </div>
  )
}

/** A failed turn. A tagged notice (quiz lock, no materials, unavailable) is the
 *  server talking to the student: show that sentence, and no Retry — it can't
 *  succeed until the situation changes. Anything else is a real fault: stay
 *  generic (never surface raw error text) and offer the retry. */
function ErrorRow({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const notice = error.message?.startsWith(ATHENA_NOTICE_PREFIX)
    ? error.message.slice(ATHENA_NOTICE_PREFIX.length)
    : null

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-destructive/30 bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">{notice ?? 'Something went wrong. Please try again.'}</span>
      {!notice && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-7 gap-1 text-destructive-muted-foreground hover:text-destructive-muted-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </Button>
      )}
    </div>
  )
}

/**
 * The one place in the product with the longest wait and, until now, the least
 * to look at: a static string that gave no sign anything was still happening.
 *
 * The word stays real text because the row is `aria-live` — a screen reader
 * should hear "Thinking", not a description of three dots. The dots are marked
 * `aria-hidden` and carry the liveness for everyone else.
 *
 * Opacity only, and deliberately so. `MotionConfig reducedMotion="user"` drops
 * transform and layout animations while keeping opacity ones, which means a
 * reader who asked for less motion still sees that Athena is working rather
 * than a frozen label.
 */
function ThinkingRow() {
  return (
    <div className="px-1 flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
      <span>Thinking</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block h-1 w-1 rounded-full bg-current"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              ease: 'easeInOut',
              // Staggered so the three read as one travelling pulse rather
              // than three things blinking together.
              delay: i * 0.16,
            }}
          />
        ))}
      </span>
    </div>
  )
}
