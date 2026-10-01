'use client'

/**
 * AssistantConsole — Athena's dedicated full-page tab (Claude/ChatGPT-style).
 *
 * Multi-chat: a left rail lists the professor's saved conversations for this
 * section (new / switch / rename / archive); the main pane is one chat. Each
 * chat is keyed by a client-generated UUID and persisted server-side — every
 * turn (text, reasoning, tool & draft calls, web-search sources) is saved by
 * the /api/professor-assistant route, so history survives refresh + device.
 *
 * ChatPane remounts on conversation switch (React key), giving a clean useChat
 * instance hydrated with that chat's stored messages. See
 * docs/designs/athena/athena-chat-persistence-design.md.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  Send,
  Square,
  Loader2,
  Trash2,
  Pencil,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
  X,
  ChevronRight,
  Check,
  AlertCircle,
  ListChecks,
  Megaphone,
  MessageSquareReply,
  LayoutList,
  FolderKanban,
  BarChart3,
  Brain,
  MessagesSquare,
  Globe,
  ExternalLink,
  UserRound,
  Paperclip,
  Trophy,
  ClipboardList,
  ClipboardCheck,
  MessageSquareHeart,
  Layers,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { normalizeAthenaTitle } from '@/lib/validations/athena-conversation'
import { athenaLimitMessage } from '@/components/professor/assignments/athena/AssignmentAthenaPanel'
import { isStalledWithoutReply, type TurnMessage } from '@/lib/ai/athena-core/turn-state'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ATHENA_MODELS,
  DEFAULT_ATHENA_MODEL_ID,
  failoverCandidates,
  type AthenaModelId,
  type AthenaUsageStatus,
} from '@/lib/ai/professor-assistant/models'
import { acceptAttribute } from '@/lib/ai/athena-attachments'
import { useAthenaAttachments, type PendingAttachment } from '@/lib/hooks/use-athena-attachments'
import { AttachmentChip, chipFromFilePart } from '@/components/shared/athena/AttachmentChip'
import { AthenaUsageNotice, ATHENA_USAGE_NOTICE_ID } from './AthenaUsageNotice'
import { DraftCardRouter } from './cards/DraftCardRouter'
import { AlignmentJobChip } from './cards/AlignmentJobChip'
import {
  listConversations,
  loadConversation,
  renameConversation,
  archiveConversation,
  unarchiveConversation,
  getAthenaUsage,
  type ConversationSummary,
} from './actions'

/**
 * Marker prefix for the hidden "job finished" nudge we send to Athena so it
 * announces the result (the task-notification pattern). The user turn carrying
 * it is never rendered — see MessageTurn.
 */
const JOB_NUDGE_MARKER = '⟦athena-alignment-ready⟧'

export const SUGGESTIONS: { icon: LucideIcon; label: string; prompt: string }[] = [
  { icon: BarChart3, label: 'Class status', prompt: 'How is my class doing so far?' },
  { icon: AlertCircle, label: 'At-risk students', prompt: 'Which students are falling behind, and on what?' },
  { icon: ListChecks, label: 'Draft an assignment', prompt: 'Draft an assignment on my most recent module' },
  { icon: Megaphone, label: 'Announcement', prompt: 'Write an announcement about the upcoming deadline' },
]

interface ToolMeta {
  icon: LucideIcon
  running: string
  done: string
}
const TOOL_META: Record<string, ToolMeta> = {
  'tool-draft_discussion': { icon: MessagesSquare, running: 'Drafting discussion questions', done: 'Discussion draft' },
  'tool-draft_announcement': { icon: Megaphone, running: 'Writing an announcement', done: 'Announcement draft' },
  'tool-draft_reply': { icon: MessageSquareReply, running: 'Drafting a reply', done: 'Reply draft' },
  'tool-draft_module_outline': { icon: LayoutList, running: 'Outlining a module', done: 'Module outline' },
  'tool-draft_project': { icon: FolderKanban, running: 'Drafting a project', done: 'Project draft' },
  'tool-draft_challenge': { icon: Trophy, running: 'Drafting a challenge', done: 'Challenge draft' },
  'tool-draft_rubric': { icon: ClipboardList, running: 'Drafting a rubric', done: 'Rubric draft' },
  'tool-draft_feedback': { icon: MessageSquareHeart, running: 'Drafting feedback', done: 'Feedback draft' },
  'tool-draft_differentiated_version': { icon: Layers, running: 'Adapting the content', done: 'Alternate version' },
  'tool-ask_course_insights': { icon: BarChart3, running: 'Reading your course', done: 'Course snapshot' },
  'tool-get_student_performance': { icon: UserRound, running: 'Looking up the student', done: 'Student performance' },
  'tool-get_live_class_report': { icon: ClipboardCheck, running: 'Pulling the live-class report', done: 'Live-class report' },
  'tool-show_outcome_coverage': { icon: ListChecks, running: 'Reading outcome coverage', done: 'Outcome coverage' },
  'tool-google_search': { icon: Globe, running: 'Searching the web', done: 'Searched the web' },
}

/** Tool parts whose output IS the answer on this surface: every draft/artifact producer.
 *  Derived from TOOL_META so a new draft tool is covered the moment it is registered. */
const REPLY_TOOL_TYPES: readonly string[] = Object.keys(TOOL_META).filter((t) =>
  t.startsWith('tool-draft_'),
)

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

// ── Parent: owns the active conversation id + the saved-chat list ──────
export function AssistantConsole({
  sectionId,
  courseName,
  courseCode,
  professorFirstName,
}: {
  sectionId: string
  courseName: string
  courseCode: string
  professorFirstName: string
}) {
  // A client-generated UUID identifies each chat; the first sent message lazily
  // creates the row server-side. Start on a fresh, unsaved chat.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [switching, setSwitching] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Keep the recents rail closed on small screens — side-by-side it crushes
  // the chat pane. Done via a media-query listener (not the state initializer)
  // to avoid an SSR hydration mismatch; the initial check is deferred a tick
  // because the linter forbids synchronous setState inside effects.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = (matches: boolean) => setSidebarOpen(matches)
    const t = setTimeout(() => {
      if (!mq.matches) apply(false)
    }, 0)
    const onChange = (e: MediaQueryListEvent) => apply(e.matches)
    mq.addEventListener('change', onChange)
    return () => {
      clearTimeout(t)
      mq.removeEventListener('change', onChange)
    }
  }, [])
  const closeSidebarOnMobile = useCallback(() => {
    if (window.matchMedia('(max-width: 639px)').matches) setSidebarOpen(false)
  }, [])

  const refreshList = useCallback(async () => {
    const res = await listConversations(sectionId)
    if (!res.error) setConversations(res.data)
  }, [sectionId])

  // Load the saved-chat list on mount (and when the section changes). setState
  // lives in the async callback, not the effect body, so it can't cascade.
  useEffect(() => {
    let active = true
    listConversations(sectionId).then((res) => {
      if (active && !res.error) setConversations(res.data)
    })
    return () => {
      active = false
    }
  }, [sectionId])

  const newChat = useCallback(() => {
    setConversationId(crypto.randomUUID())
    setInitialMessages([])
  }, [])

  const switchTo = useCallback(
    async (id: string) => {
      if (id === conversationId) return
      setSwitching(true)
      const res = await loadConversation(sectionId, id)
      setSwitching(false)
      if (res.error) {
        toast.error(res.error)
        return
      }
      setInitialMessages(res.messages)
      setConversationId(id)
    },
    [conversationId, sectionId],
  )

  const handleRename = useCallback(
    async (id: string, title: string) => {
      /* Optimistic — but showing the RAW input meant a >80-char rename displayed in
         full until a refresh revealed the truncated value the server had stored
         (#650). Same normalizer the action applies, so the rail can't disagree with
         the database. */
      const shown = normalizeAthenaTitle(title)
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: shown } : c)))
      const res = await renameConversation(sectionId, id, title)
      if (res.error) {
        toast.error(res.error)
        refreshList()
      }
    },
    [sectionId, refreshList],
  )

  const handleArchive = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (id === conversationId) newChat()
      const res = await archiveConversation(sectionId, id)
      if (res.error) {
        toast.error(res.error)
        refreshList()
        return
      }
      // Soft delete — let a misclick be undone (the chat + its history are retained).
      toast.success('Chat deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            const undo = await unarchiveConversation(sectionId, id)
            if (undo.error) toast.error(undo.error)
            refreshList()
          },
        },
      })
    },
    [sectionId, conversationId, newChat, refreshList],
  )

  // After a turn completes the chat may be newly created / freshly titled —
  // refresh now, then once more to catch the async auto-title.
  const onTurnComplete = useCallback(() => {
    refreshList()
    const t = setTimeout(refreshList, 2500)
    return () => clearTimeout(t)
  }, [refreshList])

  // ── Alignment-job watcher ─────────────────────────────────────────────
  // The pane's AlignmentJobChip unmounts with the pane on every chat switch, so
  // a job that finishes while another chat is open would end silently. This
  // console-level watcher survives switches: panes report their jobId up, and
  // when a watched job completes while none of its originating chats is on
  // screen, a toast offers to jump back to the chat that started it. When an
  // originating chat IS on screen, its own chip announces — no toast.
  const jobOriginsRef = useRef<Map<string, Set<string>>>(new Map())
  const jobSawActiveRef = useRef<Set<string>>(new Set())
  const jobNotifiedRef = useRef<Set<string>>(new Set())
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null)
  const conversationIdRef = useRef(conversationId)
  const switchToRef = useRef<(id: string) => void>(() => {})
  useEffect(() => {
    conversationIdRef.current = conversationId
    switchToRef.current = (id) => void switchTo(id)
  }, [conversationId, switchTo])

  const handleAlignmentJob = useCallback((jobId: string) => {
    const origins = jobOriginsRef.current.get(jobId) ?? new Set<string>()
    origins.add(conversationIdRef.current)
    jobOriginsRef.current.set(jobId, origins)
    setWatchedJobId(jobId)
  }, [])

  useEffect(() => {
    if (!watchedJobId || jobNotifiedRef.current.has(watchedJobId)) return
    const supabase = createClient()
    let mounted = true
    const timerRef = { current: null as ReturnType<typeof setInterval> | null }
    const tick = async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('background_jobs')
        .select('status')
        .eq('id', watchedJobId)
        .maybeSingle()
      if (!mounted || !data) return
      if (data.status === 'pending' || data.status === 'running') {
        jobSawActiveRef.current.add(watchedJobId)
        return
      }
      // Terminal — stop polling and notify at most once.
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      if (jobNotifiedRef.current.has(watchedJobId)) return
      jobNotifiedRef.current.add(watchedJobId)
      // Only jobs we observed running may announce — a finished job surfacing
      // from an old chat's history must stay quiet (the chip's CTA covers it).
      if (!jobSawActiveRef.current.has(watchedJobId)) return
      const origins = jobOriginsRef.current.get(watchedJobId)
      // An originating chat is on screen → its chip handles the announcement.
      if (origins?.has(conversationIdRef.current)) return
      if (data.status === 'failed') {
        toast.error("The ABET outcome analysis couldn't finish.")
        return
      }
      const origin = origins ? [...origins][0] : null
      toast.success(
        'ABET outcome analysis finished',
        origin ? { action: { label: 'View results', onClick: () => switchToRef.current(origin) } } : undefined,
      )
    }
    void tick()
    timerRef.current = setInterval(tick, 3000)
    return () => {
      mounted = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [watchedJobId])

  return (
    <div className="relative flex h-[calc(100dvh-130px)] min-h-[440px] overflow-hidden rounded-2xl border border-border/60">
      {sidebarOpen && (
        <>
          {/* Mobile: the rail overlays the pane instead of squeezing it. */}
          <div
            className="absolute inset-0 z-10 bg-foreground/20 sm:hidden"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
          <ChatSidebar
            conversations={conversations}
            activeId={conversationId}
            onNew={() => {
              closeSidebarOnMobile()
              newChat()
            }}
            onSwitch={(id) => {
              closeSidebarOnMobile()
              void switchTo(id)
            }}
            onRename={handleRename}
            onArchive={handleArchive}
            onCollapse={() => setSidebarOpen(false)}
          />
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col px-4">
        {switching ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <ChatPane
            key={conversationId}
            conversationId={conversationId}
            initialMessages={initialMessages}
            sectionId={sectionId}
            courseName={courseName}
            courseCode={courseCode}
            professorFirstName={professorFirstName}
            onTurnComplete={onTurnComplete}
            onAlignmentJob={handleAlignmentJob}
            sidebarOpen={sidebarOpen}
            onExpandSidebar={() => setSidebarOpen(true)}
            onNew={newChat}
          />
        )}
      </div>
    </div>
  )
}

// ── Left rail: saved conversations (Claude-style flat Recents list) ────
function ChatSidebar({
  conversations,
  activeId,
  onNew,
  onSwitch,
  onRename,
  onArchive,
  onCollapse,
}: {
  conversations: ConversationSummary[]
  activeId: string
  onNew: () => void
  onSwitch: (id: string) => void
  onRename: (id: string, title: string) => void
  onArchive: (id: string) => void
  onCollapse: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const activeIsSaved = conversations.some((c) => c.id === activeId)

  // Radix closes the dropdown on item-select, and the trailing `click` from that
  // same gesture retargets to whatever row button now sits under the cursor —
  // which would fire a chat switch ("Delete opens the chat"). Guard it: when an
  // item is selected, suppress row-switches until the next tick clears it.
  // Scoped to item-selects only, so ordinary row clicks are never affected.
  const suppressSwitch = useRef(false)
  const noteItemSelected = () => {
    suppressSwitch.current = true
    setTimeout(() => {
      suppressSwitch.current = false
    }, 350)
  }
  const guardedSwitch = (id: string) => {
    if (suppressSwitch.current) return
    onSwitch(id)
  }

  const startEdit = (c: ConversationSummary) => {
    setEditingId(c.id)
    setEditValue(c.title ?? '')
  }
  const commitEdit = () => {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim())
    setEditingId(null)
  }

  return (
    <aside className="absolute inset-y-0 left-0 z-20 flex w-60 shrink-0 flex-col border-r border-border/60 bg-background shadow-lg sm:static sm:z-auto sm:bg-muted/20 sm:shadow-none">
      {/* Header: New chat + collapse */}
      <div className="flex items-center gap-1 p-2">
        <button
          onClick={onNew}
          className="flex flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
        >
          <SquarePen className="h-4 w-4" />
          New chat
        </button>
        <button
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 && activeIsSaved ? null : (
          <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recents
          </p>
        )}
        <div className="flex flex-col gap-0.5">
          {/* Current unsaved chat shows as an active placeholder until its first message persists. */}
          {!activeIsSaved && <ChatRow active label="New chat" />}
          {conversations.map((c) =>
            editingId === c.id ? (
              <div key={c.id} className="flex items-center gap-1 px-1 py-0.5">
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="min-w-0 flex-1 rounded-xl border border-input bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                />
                <button onClick={commitEdit} aria-label="Save name" className="text-muted-foreground hover:text-foreground">
                  <Check className="h-4 w-4" />
                </button>
                <button onMouseDown={() => setEditingId(null)} aria-label="Cancel" className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <ChatRow
                key={c.id}
                active={c.id === activeId}
                label={c.title ?? 'Untitled chat'}
                onClick={() => guardedSwitch(c.id)}
                onRename={() => startEdit(c)}
                onArchive={() => onArchive(c.id)}
                onItemSelected={noteItemSelected}
              />
            ),
          )}
        </div>
        {conversations.length === 0 && (
          <p className="px-3 pt-6 text-center text-xs text-muted-foreground">
            Your saved chats with Athena will appear here.
          </p>
        )}
      </div>
    </aside>
  )
}

function ChatRow({
  active,
  label,
  onClick,
  onRename,
  onArchive,
  onItemSelected,
}: {
  active: boolean
  label: string
  /** Omit for a non-interactive row (e.g. the current unsaved "New chat" placeholder). */
  onClick?: () => void
  onRename?: () => void
  onArchive?: () => void
  /** Called the instant a menu item is selected, so the row-switch guard can arm. */
  onItemSelected?: () => void
}) {
  const hasMenu = !!(onRename || onArchive)
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-xl pr-1 text-sm transition',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {onClick ? (
        <button onClick={onClick} className="min-w-0 flex-1 truncate py-2 pl-2.5 pr-1 text-left">
          {label}
        </button>
      ) : (
        <div className="min-w-0 flex-1 truncate py-2 pl-2.5 pr-1">{label}</div>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Chat options"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'h-7 w-7 shrink-0 p-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                active && 'opacity-100',
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            {onRename && (
              <DropdownMenuItem onSelect={() => { onItemSelected?.(); onRename() }}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
            )}
            {onArchive && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => { onItemSelected?.(); onArchive() }}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

// ── Chat pane: one conversation (remounts on switch) ───────────────────
function ChatPane({
  conversationId,
  initialMessages,
  sectionId,
  courseName,
  courseCode,
  professorFirstName,
  onTurnComplete,
  onAlignmentJob,
  sidebarOpen,
  onExpandSidebar,
  onNew,
}: {
  conversationId: string
  initialMessages: UIMessage[]
  sectionId: string
  courseName: string
  courseCode: string
  professorFirstName: string
  onTurnComplete: () => void
  /** Reports the alignment jobId found in this chat's history to the console. */
  onAlignmentJob: (jobId: string) => void
  sidebarOpen: boolean
  onExpandSidebar: () => void
  onNew: () => void
}) {
  const [input, setInput] = useState('')
  /* No model picker: choosing a model is our job, not the professor's. The
     request still carries an id so the server's whitelist and per-model failover
     keep working unchanged — it is just always the default now. */
  const selectedModelId: AthenaModelId = DEFAULT_ATHENA_MODEL_ID
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const modelDef = ATHENA_MODELS.find((m) => m.id === selectedModelId) ?? ATHENA_MODELS[0]

  // Attachments: pick → validate → upload → chip. Shared with the student dock;
  // only the route, the limits and the extra form fields differ.
  const {
    attachments,
    addFiles,
    removeAttachment,
    clear: clearAttachments,
    uploading: attachmentsUploading,
    canAttach,
    readyFileParts,
  } = useAthenaAttachments({
    limits: modelDef.attachments,
    endpoint: '/api/professor-assistant/upload',
    fields: useMemo(
      () => ({ sectionId, conversationId, modelId: selectedModelId }),
      [sectionId, conversationId, selectedModelId],
    ),
  })

  // Per-model daily usage (server is authoritative; this only drives the calm
  // usage UI). Fetched on mount and after every turn (the count just changed).
  const [usage, setUsage] = useState<AthenaUsageStatus | null>(null)
  const refreshUsage = useCallback(async () => {
    const res = await getAthenaUsage(sectionId)
    if ('status' in res) setUsage(res.status)
  }, [sectionId])
  useEffect(() => {
    void refreshUsage()
  }, [refreshUsage])

  // Send is blocked only when EVERY model is exhausted (failover handles the
  // single-model case server-side). Derived from the same registry order.
  const allExhausted =
    !!usage && !failoverCandidates(selectedModelId).some((d) => !usage.models.find((m) => m.id === d.id)?.exhausted)

  const { messages, sendMessage, addToolResult, status, error, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/professor-assistant',
      // Send the professor's local timezone so Athena reasons about dates/times
      // in their zone (the server clock is UTC). Resolved client-side.
      body: { sectionId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    // Structured refusals (rate limit, AI kill switch) arrive as a JSON body —
    // surface the human sentence, never raw JSON or a misleading "try again".
    onError: (err: Error) =>
      toast.error(athenaLimitMessage(err.message) || err.message || 'Something went wrong. Please try again.'),
  })

  const isLoading = status === 'submitted' || status === 'streaming'
  /* Same detector the in-builder dock uses (#651), read from the transcript rather than a
     step count: one server step can fire many tool calls in parallel, so a turn can carry
     ~100 tool chips inside the 6-step budget and counting chips would miss it. */
  const stalledWithoutReply = useMemo(
    /* The draft tools ARE this surface's replies: they render an artifact card instead of
       trailing prose, so without declaring them the notice appeared directly beneath a
       finished draft, denying an answer that was on screen (#651). TOOL_META is already the
       list of tools this console renders, so the draft ones are taken from there rather than
       hand-maintained as a second copy that could drift. */
    () => isStalledWithoutReply(messages as TurnMessage[], { replyToolTypes: REPLY_TOOL_TYPES }),
    [messages],
  )
  const isStreaming = status === 'streaming'

  // Refresh the sidebar (new chat appears / auto-title lands) when a turn ends.
  const prevStatus = useRef(status)
  useEffect(() => {
    if (prevStatus.current === 'streaming' && status === 'ready') {
      onTurnComplete()
      void refreshUsage()
    }
    prevStatus.current = status
  }, [status, onTurnComplete, refreshUsage])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])

  // The most recent alignment job triggered in THIS chat. Its jobId lives in the
  // tool part's output, so it survives reload + switching back to this chat —
  // no separate state store. Drives the status dock above the composer.
  const activeAlignmentJobId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i].parts as AnyPart[]
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p?.type === 'tool-analyze_outcome_alignment' && p.state === 'output-available' && p.output?.jobId) {
          return p.output.jobId as string
        }
      }
    }
    return null
  }, [messages])

  // Whether the active job was triggered live in THIS pane session, as opposed
  // to restored from the chat's history on mount. A live-triggered job may
  // already be terminal on the chip's FIRST poll (the pipeline early-aborts in
  // ~1s when nothing changed), so `sawActive` never trips — this flag lets the
  // chip still announce the completion instead of leaving Athena's "I'll let
  // you know" hanging forever.
  const initialAlignmentJobIdRef = useRef<string | null | undefined>(undefined)
  if (initialAlignmentJobIdRef.current === undefined) initialAlignmentJobIdRef.current = activeAlignmentJobId
  const alignmentJustTriggered =
    activeAlignmentJobId !== null && activeAlignmentJobId !== initialAlignmentJobIdRef.current

  // Whether this chat already carries the completion announcement FOR THE ACTIVE
  // JOB (the nudge turn is persisted, so its presence means "announced here").
  // Gates the chip's "Review results" CTA when returning to a chat after the job
  // ended. Scoped per job via the ⟦job:id⟧ tag — a chat can hold several analyses,
  // and job A's announcement must not mask job B's. Legacy untagged nudges (chats
  // from before the tag existed) count for any job, preserving old-chat behavior.
  const hasAlignmentAnnouncement = useMemo(
    () =>
      messages.some((m) => {
        if (m.role !== 'user') return false
        const t = textOf(m)
        if (!t.startsWith(JOB_NUDGE_MARKER)) return false
        return t.includes('⟦job:') ? t.includes(`⟦job:${activeAlignmentJobId}⟧`) : true
      }),
    [messages, activeAlignmentJobId],
  )

  // Report this chat's job to the console so its watcher (which survives chat
  // switches, unlike this pane) can toast when the job finishes off-screen.
  useEffect(() => {
    if (activeAlignmentJobId) onAlignmentJob(activeAlignmentJobId)
  }, [activeAlignmentJobId, onAlignmentJob])

  // Task-notification: when a job finishes, nudge Athena to announce the result.
  // Deferred to an idle turn (status 'ready') so the hidden nudge can't interleave
  // with an in-flight response; dropped if usage is exhausted.
  const [pendingNudge, setPendingNudge] = useState<string | null>(null)
  const handleJobComplete = useCallback((summary: string | null) => {
    // The summary is pipeline-generated (LLM) text derived from course content, so
    // sanitize before splicing it into a synthetic prompt: drop the marker glyphs,
    // collapse whitespace, and cap length — defense-in-depth against prompt injection.
    const safe = summary ? summary.replace(/[⟦⟧]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) : null
    setPendingNudge(
      `${JOB_NUDGE_MARKER}⟦job:${activeAlignmentJobId}⟧ The ABET outcome-alignment analysis you started just finished${safe ? `: ${safe}` : '.'} FIRST call show_outcome_coverage to display the coverage card, THEN in a couple of sentences give the professor a substantive read of what you found — which outcomes are covered (and at what level) versus which are gaps — and invite them to dig into any outcome or start closing a gap. Do not list every indicator; keep it conversational.`,
    )
  }, [activeAlignmentJobId])
  const handleJobFailed = useCallback(() => {
    setPendingNudge(
      `${JOB_NUDGE_MARKER}⟦job:${activeAlignmentJobId}⟧ The ABET outcome-alignment analysis you started couldn't finish, so there are NO results. In one short sentence, let the professor know it didn't complete and offer to run it again. Do NOT call show_outcome_coverage and do NOT describe any coverage or gaps — there is nothing to show. Do not invent any results.`,
    )
  }, [activeAlignmentJobId])
  useEffect(() => {
    if (pendingNudge && status === 'ready' && !allExhausted) {
      const text = pendingNudge
      setPendingNudge(null)
      sendMessage({ text }, { body: { modelId: selectedModelId } })
    }
  }, [pendingNudge, status, allExhausted, sendMessage, selectedModelId])

  const send = (text: string) => {
    const trimmed = text.trim()
    if (isLoading) return
    if (allExhausted) {
      toast.error("You've reached today's Athena usage limit — it refreshes automatically.", {
        id: 'athena-limit',
      })
      return
    }
    if (attachmentsUploading) {
      toast.error('Hold on — attachments are still uploading')
      return
    }
    const files = readyFileParts()
    if (!trimmed && files.length === 0) return
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    clearAttachments()
    const opts = { body: { modelId: selectedModelId } }
    // Per-request body merges into the transport's static body ({ sectionId,
    // timeZone }); the server whitelists modelId and falls back to the default.
    if (files.length && !trimmed) sendMessage({ files }, opts)
    else if (files.length) sendMessage({ text: trimmed, files }, opts)
    else sendMessage({ text: trimmed }, opts)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/60 pb-3 pt-1">
        {!sidebarOpen && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={onExpandSidebar}
              aria-label="Open sidebar"
              title="Open sidebar"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <PanelLeftOpen className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={onNew}
              aria-label="New chat"
              title="New chat"
              className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <SquarePen className="h-[18px] w-[18px]" />
            </button>
          </div>
        )}
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10">
          <Bot className="h-[18px] w-[18px] text-primary" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">Athena</h1>
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
              Beta
            </span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {courseCode ? `${courseCode} — ` : ''}
            {courseName}
          </p>
        </div>
      </header>

      {messages.length === 0 ? (
        /* Fresh chat — greeting, centered composer, and suggestion chips. */
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pt-6 pb-32">
          <div className="w-full max-w-2xl">
            <div className="mb-7 flex flex-col items-center text-center">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                {professorFirstName ? `Back at it, ${professorFirstName}` : 'How can I help?'}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Ask how {courseName} is doing, or draft an assignment, announcement, project, reply, or module.
              </p>
            </div>
            <Composer
              input={input}
              setInput={setInput}
              onSend={send}
              onStop={stop}
              isLoading={isLoading}
              isStreaming={isStreaming}
              inputRef={inputRef}
              selectedModelId={selectedModelId}
              attachments={attachments}
              onAddFiles={addFiles}
              onRemoveAttachment={removeAttachment}
              accept={acceptAttribute(modelDef.attachments)}
              canAttach={canAttach}
              usage={usage}
              allExhausted={allExhausted}
              onUsageReset={refreshUsage}
            />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s.label}
                  onClick={() => send(s.prompt)}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[color,border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-ring/40 hover:text-foreground hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
                >
                  <s.icon className="h-3.5 w-3.5" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Conversation */}
          <div className="flex-1 overflow-y-auto py-6">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-7">
              {messages.map((message) => (
                <MessageTurn key={message.id} message={message} sectionId={sectionId} addToolResult={addToolResult} />
              ))}

              {status === 'submitted' && messages[messages.length - 1]?.role === 'user' && <ThinkingIndicator />}

              {error && (
                <p className="rounded-2xl border border-destructive/30 bg-destructive-muted px-3.5 py-2.5 text-sm text-destructive-muted-foreground">
                  {athenaLimitMessage(error.message) ?? 'Something went wrong. Please try again.'}
                </p>
              )}
              {/* The step cap tripped: Athena spent its whole budget on context tools and
                  never produced an answer. Found on the in-builder dock (#651) and fixed
                  only there; this console runs the same loop against the same 6-step cap
                  and said nothing at all, leaving the professor with a dead transcript.
                  Every looped call still bills their daily pool, so a turn that ends with
                  nothing has to admit it. */}
              {stalledWithoutReply && !isLoading && (
                <p role="status" className="rounded-2xl border border-border bg-muted/40 px-3.5 py-2.5 text-sm text-muted-foreground">
                  Athena looked things up but didn&apos;t get to an answer. Try asking again with
                  the specific thing you want.
                </p>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-border/60 pt-2 pb-1">
            <div className="mx-auto w-full max-w-4xl">
              <Composer
                input={input}
                setInput={setInput}
                onSend={send}
                onStop={stop}
                isLoading={isLoading}
                isStreaming={isStreaming}
                inputRef={inputRef}
                selectedModelId={selectedModelId}
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveAttachment={removeAttachment}
                accept={acceptAttribute(modelDef.attachments)}
                canAttach={canAttach}
                usage={usage}
                allExhausted={allExhausted}
                onUsageReset={refreshUsage}
                alignmentJobId={activeAlignmentJobId}
                alignmentJustTriggered={alignmentJustTriggered}
                alignmentAnnounced={hasAlignmentAnnouncement}
                onAlignmentComplete={handleJobComplete}
                onAlignmentFailed={handleJobFailed}
              />
              <p className="mt-1 text-center text-[11px] text-muted-foreground">
                Athena can make mistakes, so double-check every draft before you save it.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The input box: auto-growing textarea + a toolbar row (attach · send/stop).
 * Shared by the fresh-chat (centered) and the in-conversation (bottom) layouts
 * so the composer is identical in both.
 */

function Composer({
  input,
  setInput,
  onSend,
  onStop,
  isLoading,
  isStreaming,
  inputRef,
  selectedModelId,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  accept,
  canAttach,
  usage,
  allExhausted,
  onUsageReset,
  alignmentJobId,
  alignmentJustTriggered,
  alignmentAnnounced,
  onAlignmentComplete,
  onAlignmentFailed,
}: {
  input: string
  setInput: (v: string) => void
  onSend: (text: string) => void
  onStop: () => void
  isLoading: boolean
  isStreaming: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  selectedModelId: AthenaModelId
  attachments: PendingAttachment[]
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  accept: string
  canAttach: boolean
  usage: AthenaUsageStatus | null
  allExhausted: boolean
  onUsageReset: () => void
  /** Live ABET alignment job for this chat (null = none). Renders a status chip in the toolbar. */
  alignmentJobId?: string | null
  alignmentJustTriggered?: boolean
  alignmentAnnounced?: boolean
  onAlignmentComplete?: (summary: string | null) => void
  onAlignmentFailed?: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        if (canAttach) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onAddFiles(files)
      }}
      className={cn(
        'rounded-2xl border border-border/60 bg-card/70 px-2.5 py-2 shadow-sm transition focus-within:border-ring/50 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/20',
        dragOver && 'border-ring/60 ring-2 ring-ring/30',
      )}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} data={a} onRemove={() => onRemoveAttachment(a.id)} />
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend(input)
          }
        }}
        placeholder="Ask Athena to draft an assignment, announcement, reply…"
        rows={1}
        disabled={isLoading}
        className="max-h-40 min-h-8 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60"
      />
      <div className="mt-1 flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length) onAddFiles(files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={!canAttach || isLoading}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>
        </div>
        {/* Alignment status chip + usage notice sit inline in the toolbar (right-aligned,
            by Send) — the chip uses the otherwise-empty space in the toolbar. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {alignmentJobId && (
            <AlignmentJobChip
              // Remount per job: chip state (sawActive/notified/CTA) is per-job,
              // and a second analysis in the same chat must not inherit it.
              key={alignmentJobId}
              jobId={alignmentJobId}
              justTriggered={alignmentJustTriggered}
              hasAnnouncement={alignmentAnnounced}
              onComplete={onAlignmentComplete}
              onFailed={onAlignmentFailed}
            />
          )}
          <AthenaUsageNotice
            usage={usage}
            selectedModelId={selectedModelId}
            allExhausted={allExhausted}
            onUsageReset={onUsageReset}
          />
        </div>
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition hover:bg-secondary/80"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSend(input)}
            disabled={!input.trim() || isLoading || allExhausted}
            aria-label="Send"
            // Point the disabled button at the reason — otherwise a screen reader
            // announces only "Send, unavailable" with no explanation anywhere.
            aria-describedby={allExhausted ? ATHENA_USAGE_NOTICE_ID : undefined}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 pl-1 text-sm text-muted-foreground" aria-live="polite">
      <span className="athena-logo-shimmer h-5 w-5 shrink-0" aria-hidden="true" />
      Thinking…
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPart = any

const MessageTurn = memo(function MessageTurn({
  message,
  sectionId,
  addToolResult,
}: {
  message: UIMessage
  sectionId: string
  addToolResult: (args: { tool: string; toolCallId: string; output: unknown }) => void
}) {
  if (message.role === 'user') {
    const text = textOf(message)
    // The hidden "job finished" nudge is a user turn Athena replies to — never show it.
    if (text.startsWith(JOB_NUDGE_MARKER)) return null
    const fileParts = (message.parts as AnyPart[]).filter((p) => p.type === 'file')
    if (!text && fileParts.length === 0) return null
    return (
      <div className="flex flex-col items-end gap-2">
        {fileParts.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {fileParts.map((p, i) => (
              <AttachmentChip key={i} data={chipFromFilePart(p.filename, p.url)} />
            ))}
          </div>
        )}
        {text && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
            {text}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {(message.parts as AnyPart[]).map((part, i) => {
        if (part.type === 'text') {
          if (!part.text?.trim()) return null
          return <AssistantText key={i} text={part.text} />
        }
        if (part.type === 'reasoning') {
          if (!part.text?.trim()) return null
          return <ReasoningStep key={i} text={part.text} />
        }
        // Gemini Google-Search grounding surfaces as a provider tool part
        // (toolName "server:GOOGLE_SEARCH_WEB", or a dynamic-tool) — render it as
        // a clean "Searched the web" step. Must come before the generic tool- branch.
        if (isWebSearchPart(part)) return <WebSearchStep key={i} part={part} />
        if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
          // The alignment job is surfaced by the status dock above the composer,
          // not as a step in the transcript.
          if (part.type === 'tool-analyze_outcome_alignment') return null
          return <ToolStep key={i} part={part} sectionId={sectionId} addToolResult={addToolResult} />
        }
        return null
      })}
      <SourcesRow parts={message.parts as AnyPart[]} />
    </div>
  )
})

/** Citation chips for any Google Search grounding sources in the turn. */
function SourcesRow({ parts }: { parts: AnyPart[] }) {
  const seen = new Set<string>()
  const sources = parts
    .filter(
      (p): p is AnyPart & { url: string; title?: string } =>
        p.type === 'source-url' &&
        typeof p.url === 'string' &&
        // ^-anchored, no `m` flag: this is what keeps `javascript:` / `data:` out of the href.
        /^https?:\/\//i.test(p.url) &&
        // The type says `title?: string`, but this is PROVIDER data — asserting a type is
        // not checking one. A non-string title reaches React as a child, and an object
        // throws "Objects are not valid as a React child", taking out the entire message
        // list. The in-builder dock's groundingSources already guards this; the console
        // had identical exposure and no guard.
        (p.title === undefined || typeof p.title === 'string'),
    )
    .filter((p) => !seen.has(p.url) && seen.add(p.url))
  if (sources.length === 0) return null

  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
        Sources
      </span>
      {sources.map((s, i) => (
        <a
          key={i}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={s.title || s.url}
          className="inline-flex max-w-[14rem] items-center gap-1 truncate rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <span className="truncate">{s.title || hostOf(s.url)}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
        </a>
      ))}
    </div>
  )
}

/** True for a Gemini grounding (Google Search) tool part, whatever its exact shape. */
function isWebSearchPart(p: AnyPart): boolean {
  const probe = `${typeof p?.type === 'string' ? p.type : ''} ${p?.toolName ?? ''}`
  return /google.?search|google_search_web/i.test(probe)
}

/** A clean, self-contained "Searched the web" step (sources render in SourcesRow). */
function WebSearchStep({ part }: { part: AnyPart }) {
  /* Read the part's own state rather than hardcoding "done". The pill used to say
     Done from the step's first frame, which browser QA measured as 3.1 seconds of
     claiming a finished search before a single character of the answer existed.
     The in-builder panel already showed a running state, so the two professor
     surfaces disagreed about the same tool. This also makes TOOL_META's `running`
     label reachable — it was dead code while the status was a constant. */
  const done = part.state === 'output-available' || part.state === 'output-error'
  const meta = TOOL_META['tool-google_search']
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/50 px-3.5 py-2.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Globe className="h-3.5 w-3.5 text-primary" />
      </span>
      <span className="text-sm font-medium text-foreground">{done ? meta.done : meta.running}</span>
      <StatusPill status={done ? 'done' : 'working'} />
    </div>
  )
}

/** A draft the model wrongly emitted as a JSON code block instead of a tool call. */
function looksLikeDraftJsonDump(text: string): boolean {
  return /```/.test(text) && /"questionText"|"questions"\s*:|"announcement"|"reply"\s*:|"items"\s*:/.test(text)
}

const PROSE_CLASS =
  'prose prose-sm max-w-none break-words text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-pre:rounded-xl prose-pre:border prose-pre:border-border prose-pre:bg-muted'

/**
 * Assistant text. Normally just rendered markdown — but if the model fell back to
 * dumping a draft as a raw JSON code block (a known rough edge when grounding +
 * draft tools share a turn), we hide the wall of JSON behind a toggle and nudge a
 * retry, instead of splatting it into the thread.
 */
function AssistantText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (looksLikeDraftJsonDump(text)) {
    const prose = text.replace(/```[\s\S]*?```/g, '').trim()
    return (
      <div className="flex flex-col gap-2">
        {prose && (
          <div className={PROSE_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{prose}</ReactMarkdown>
          </div>
        )}
        <div className="rounded-xl border border-warning/30 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground">
          I wrote that draft as raw text instead of an editable card. Ask me to “make it a draft” and I’ll re-create it as a card you can edit and save.{' '}
          <button onClick={() => setOpen((v) => !v)} className="underline underline-offset-2">
            {open ? 'Hide' : 'Show'} raw
          </button>
          <Disclosure open={open}>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{text}</pre>
          </Disclosure>
        </div>
      </div>
    )
  }
  return (
    <div className={PROSE_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

/** Collapsible disclosure body using grid-rows for a clean height transition. */
function Disclosure({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}

function ReasoningStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-muted-foreground"
      >
        <Brain className="h-4 w-4 shrink-0 text-primary/70" />
        <span className="font-medium">Thought process</span>
        <ChevronRight className={cn('ml-auto h-4 w-4 transition-transform', open && 'rotate-90')} />
      </button>
      <Disclosure open={open}>
        <div className="prose prose-sm max-w-none px-3.5 pb-3 text-muted-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </Disclosure>
    </div>
  )
}

function ToolStep({
  part,
  sectionId,
  addToolResult,
}: {
  part: AnyPart
  sectionId: string
  addToolResult: (args: { tool: string; toolCallId: string; output: unknown }) => void
}) {
  const meta = TOOL_META[part.type] ?? { icon: ListChecks, running: 'Working', done: 'Result' }
  const Icon = meta.icon
  const state: string = part.state
  // Read-only tools (ask_course_insights, get_student_performance) have a server
  // execute, so `input-available` means they're WORKING. The draft tools have no
  // execute, so their input-available means the draft is READY for review.
  const isReadOnly =
    part.type === 'tool-ask_course_insights' ||
    part.type === 'tool-get_student_performance' ||
    part.type === 'tool-get_live_class_report' ||
    part.type === 'tool-show_outcome_coverage'
  const status: 'working' | 'review' | 'done' | 'error' =
    state === 'output-error'
      ? 'error'
      : state === 'input-streaming'
        ? 'working'
        : state === 'input-available'
          ? isReadOnly
            ? 'working'
            : 'review'
          : 'done'

  // Auto-open while a draft awaits a decision; collapse while working or once
  // resolved. The coverage card is the payoff of a finished analysis, so it
  // stays open. A manual click overrides the auto behavior.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const open = manualOpen ?? (status === 'review' || part.type === 'tool-show_outcome_coverage')

  const label = status === 'working' ? meta.running : meta.done

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/50">
      <button
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </span>
        <span className="text-sm font-medium text-foreground">{label}</span>
        <StatusPill status={status} />
        <ChevronRight className={cn('ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      <Disclosure open={open}>
        <div className="px-3.5 pb-3.5 pt-0.5">
          <DraftCardRouter part={part} sectionId={sectionId} addToolResult={addToolResult} />
        </div>
      </Disclosure>
    </div>
  )
}

function StatusPill({ status }: { status: 'working' | 'review' | 'done' | 'error' }) {
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive-muted px-2 py-0.5 text-[10px] font-medium text-destructive-muted-foreground">
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    )
  }
  if (status === 'working') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
        <Loader2 className="h-3 w-3 animate-spin" />
        Working
      </span>
    )
  }
  if (status === 'review') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning-muted px-2 py-0.5 text-[10px] font-medium text-warning-muted-foreground">
        Needs review
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-muted px-2 py-0.5 text-[10px] font-medium text-success-muted-foreground">
      <Check className="h-3 w-3" />
      Done
    </span>
  )
}
