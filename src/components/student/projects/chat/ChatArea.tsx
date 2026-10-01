/**
 * ChatArea — Message feed + input bar for a single channel.
 *
 * Shows message history with infinite scroll upward, auto-scrolls to bottom
 * on new messages. Optimistically adds sent messages before server confirms.
 * Renders WhatsApp-style date separators between messages from different days.
 */
'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Hash, Loader2 } from 'lucide-react'
import { format, isToday, isYesterday } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useMessageReactions } from '@/lib/chat/reactions'
import { toggleProjectChatReaction } from '@/app/(dashboard)/chat-reactions/actions'
import { useChannelMessages, type ChatMessage, type AuthorProfile } from '@/lib/chat/hooks'
import {
  sendMessage,
  deleteMessage,
  listTeamDocsForMention,
  listTeamPhasesForMention,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageBubble } from '@/components/student/projects/chat/MessageBubble'
import { SPRING, EXIT } from '@/lib/motion'
import { useMessageArrivals } from '@/lib/hooks/use-message-arrivals'
import { ChatInput } from '@/components/student/projects/chat/ChatInput'
import type { ChatChannel } from '@/lib/chat/hooks'

interface ChatAreaProps {
  channel: ChatChannel
  sectionId: string
  teamId: string
  userId: string
  userProfile: AuthorProfile
}

export function ChatArea({ channel, sectionId, teamId, userId, userProfile }: ChatAreaProps) {
  const { messages, loading, hasMore, loadMore, addOptimisticMessage, removeOptimisticMessage, markMessageDeleted } =
    useChannelMessages(channel.id, userProfile)
  const [sending, setSending] = useState(false)

  const { getReactions, toggleOptimistic } = useMessageReactions(
    'project_chat_message_reactions',
    channel.id,
    userId,
    userProfile,
  )

  const handleReactionToggle = useCallback(
    (messageId: string, emoji: string) => {
      toggleOptimistic(messageId, emoji)
      toggleProjectChatReaction(messageId, emoji).then((res) => {
        if ('error' in res && res.error) toast.error(res.error)
      })
    },
    [toggleOptimistic],
  )
  // Viewer's role on this team — team leads can moderate anyone's post,
  // while regular members can only retract their own. Fetched once on
  // mount so the "•••" menu can decide whether to expose itself.
  const [viewerRole, setViewerRole] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const supabase = createClient()
    supabase
      .from('project_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setViewerRole((data as { role: string | null }).role)
      })
    return () => {
      active = false
    }
  }, [teamId, userId])
  // Map of phase id → title. Loaded for the team so MessageBubble
  // can recognize which `@token` substrings in a message body refer to
  // a phase mention (vs a user mention) and render the hover-card chip.
  const [phaseTitles, setPhaseTitles] = useState<Record<string, string>>({})
  // Same shape, same purpose — doc id → title — so MessageBubble can
  // render `@DocName` tokens as DocMentionChips.
  const [docTitles, setDocTitles] = useState<Record<string, string>>({})
  // Tracks which mentioned ids we've already issued a fetch for, so a
  // referenced-but-deleted entity (id present in chat history but absent
  // from the fresh fetch) doesn't trigger an infinite refetch loop.
  const triedMentionFetchRef = useRef<Set<string>>(new Set())
  /* Which messages were already on screen when this thread first loaded.
     Those are scrollback, not arrivals, and must not animate — replaying a
     hundred old messages every time you open a conversation is exactly the
     "everything fades in" reflex this system exists to avoid.
     AnimatePresence's own `initial={false}` was meant to do this and did not:
     its presence context is recreated as message groups change, so each new
     group re-entered its first render and suppressed the animation outright.
     Tracking it here is explicit and does not depend on that lifetime. */
  const isArrival = useMessageArrivals(messages, loading)

  const feedRef = useRef<HTMLDivElement>(null)
  const prevMessagesLengthRef = useRef(0)

  // Reset the title maps + "tried" memo when the team changes. Different
  // teams have a different universe of phase/doc ids, and a stale title
  // from the previous team would render incorrectly during the brief
  // window before the fresh fetch resolves.
  useEffect(() => {
    setPhaseTitles({})
    setDocTitles({})
    triedMentionFetchRef.current = new Set()
  }, [teamId])

  // Load team phase + doc titles. Re-runs whenever the message list
  // surfaces an id we don't have a title for — covers the case where a
  // teammate creates a phase or doc AFTER this chat mounted and then
  // someone references it, including in the sender's own optimistic
  // message. Without this, mentions to fresh entities render as
  // single-word `@X` fallbacks until a full page reload.
  useEffect(() => {
    // Initial mount loads everything (id list is empty but we still
    // want the maps populated). Subsequent runs only fetch when there's
    // an unknown id to chase.
    const unknownKeys: string[] = []
    for (const msg of messages) {
      for (const id of msg.mentioned_phase_ids ?? []) {
        if (!phaseTitles[id] && !triedMentionFetchRef.current.has(`p:${id}`)) {
          unknownKeys.push(`p:${id}`)
        }
      }
      for (const id of msg.mentioned_doc_ids ?? []) {
        if (!docTitles[id] && !triedMentionFetchRef.current.has(`d:${id}`)) {
          unknownKeys.push(`d:${id}`)
        }
      }
    }

    const isFirstRun = !triedMentionFetchRef.current.has('__init__')
    if (!isFirstRun && unknownKeys.length === 0) return

    triedMentionFetchRef.current.add('__init__')
    for (const k of unknownKeys) triedMentionFetchRef.current.add(k)

    let cancelled = false
    Promise.all([
      listTeamPhasesForMention(teamId, sectionId),
      listTeamDocsForMention(teamId, sectionId),
    ]).then(([phasesRes, docsRes]) => {
      if (cancelled) return
      const phasesData = phasesRes.data
      if (phasesData) {
        setPhaseTitles((prev) => {
          const next: Record<string, string> = { ...prev }
          for (const p of phasesData) next[p.id] = p.title
          return next
        })
      }
      const docsData = docsRes.data
      if (docsData) {
        setDocTitles((prev) => {
          const next: Record<string, string> = { ...prev }
          for (const d of docsData) next[d.id] = d.title
          return next
        })
      }
    })
    return () => {
      cancelled = true
    }
    // phaseTitles / docTitles intentionally omitted — they're read via
    // the closure but the effect re-runs only on messages/team change
    // and we guard against re-fetch via triedMentionFetchRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, sectionId, messages])

  /* Scroll the FEED, not an element into view — `scrollIntoView` walks every
     scrollable ancestor and drags the whole page with it. See ChatArea.tsx in
     shared/chat for the full reasoning. */
  useEffect(() => {
    const feed = feedRef.current
    if (feed && messages.length > prevMessagesLengthRef.current) {
      const isNewMessage = prevMessagesLengthRef.current > 0
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: isNewMessage && !reduceMotion ? 'smooth' : 'auto',
      })
    }
    prevMessagesLengthRef.current = messages.length
  }, [messages.length])

  // Reset scroll tracking when channel changes
  useEffect(() => {
    prevMessagesLengthRef.current = 0
  }, [channel.id])

  const handleSend = useCallback(async (
    content: string,
    attachment?: {
      url: string
      path: string
      name: string
      size: number
      type: string
    },
    mentionedUserIds?: string[],
    mentionedPhaseIds?: string[],
    mentionedDocIds?: string[],
  ) => {
    // Optimistically add the message immediately
    const optimisticMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      channel_id: channel.id,
      author_id: userId,
      content: content || '',
      attachment_url: attachment?.url || null,
      attachment_path: attachment?.path || null,
      attachment_name: attachment?.name || null,
      attachment_size: attachment?.size || null,
      attachment_type: attachment?.type || null,
      mentioned_user_ids: mentionedUserIds ?? [],
      mentioned_phase_ids: mentionedPhaseIds ?? [],
      mentioned_doc_ids: mentionedDocIds ?? [],
      kind: 'user',
      system_event: null,
      system_payload: null,
      created_at: new Date().toISOString(),
      author: userProfile,
    }
    addOptimisticMessage(optimisticMsg)

    setSending(true)
    try {
      // Don't persist the signed URL — it expires. Only the path is
      // durable; viewers re-sign on demand via `useChatAttachmentUrl`.
      const result = await sendMessage(channel.id, sectionId, {
        content: content || '',
        attachment_path: attachment?.path,
        attachment_name: attachment?.name,
        attachment_size: attachment?.size,
        attachment_type: attachment?.type,
        mentioned_user_ids: mentionedUserIds ?? [],
        mentioned_phase_ids: mentionedPhaseIds ?? [],
        mentioned_doc_ids: mentionedDocIds ?? [],
      })
      if (result.error) {
        // Same rollback as the DM and discussion surfaces — a rejected send must not keep
        // looking sent (#677/#681, same shared hook).
        removeOptimisticMessage(optimisticMsg.id)
        toast.error(result.error)
        return false
      }
    } catch {
      removeOptimisticMessage(optimisticMsg.id)
      toast.error('Failed to send message')
      return false
    } finally {
      setSending(false)
    }
  }, [channel.id, sectionId, userId, userProfile, addOptimisticMessage, removeOptimisticMessage])

  // Soft-delete a message. Server-side enforces the same author-or-lead
  // rule; the client-side trigger stays a hint so the UI stays snappy.
  const handleDelete = useCallback(
    async (messageId: string) => {
      markMessageDeleted(messageId, userId)
      const result = await deleteMessage(messageId, sectionId)
      if (result.error) toast.error(result.error)
    },
    [markMessageDeleted, userId, sectionId],
  )

  // Group consecutive messages by same author within 5 minutes
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])

  return (
    <TooltipProvider>
    <div className="flex flex-col h-full">
      {/* Channel header */}
      <div className="px-4 py-2.5 border-b flex items-center gap-2 shrink-0">
        <Hash className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">{channel.name}</span>
      </div>

      {/* Messages area */}
      <div ref={feedRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-3 space-y-1">
        {/* Load more */}
        {hasMore && (
          <div className="flex justify-center pb-3">
            <button
              onClick={loadMore}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Load older messages
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Hash className="h-8 w-8 mb-2" />
            <p className="text-sm font-medium">Welcome to #{channel.name}</p>
            <p className="text-xs mt-1">This is the start of the conversation.</p>
          </div>
        ) : (
          groupedMessages.map((group, groupIdx) => {
            const groupDate = new Date(group[0].created_at)
            const prevGroup = groupIdx > 0 ? groupedMessages[groupIdx - 1] : null
            const prevDate = prevGroup ? new Date(prevGroup[prevGroup.length - 1].created_at) : null
            const showDateSeparator = !prevDate || !isSameDay(groupDate, prevDate)

            return (
              <div key={group[0].id}>
                {showDateSeparator && (
                  <DateSeparator date={groupDate} />
                )}
                <div className={groupIdx > 0 && !showDateSeparator ? 'pt-3' : ''}>
                  {/* A teammate's message arrives unprompted, which is the one
                      change that earns an entrance. `initial={false}` keeps
                      scrollback from replaying every time the pane opens. */}
                  <AnimatePresence>
                  {group.map((msg, msgIdx) => {
                    const isAuthor = msg.author_id === userId
                    const isLead = viewerRole === 'lead'
                    const canDelete =
                      !msg.deleted_at && msg.kind !== 'system' && (isAuthor || isLead)
                    return (
                      <motion.div
                        key={msg.id}
                        /* No `layout` here, unlike the Live Classroom question
                           list this pattern comes from. That list is a handful
                           of rows; a chat thread runs to hundreds, and `layout`
                           measures every child on every change. Messages only
                           ever append at the bottom, so there is no reflow worth
                           animating and the measurement would be pure cost. */
                        initial={isArrival(msg.id, isAuthor) ? { opacity: 0, y: 6 } : false}
                        /* An unconfirmed send reads as provisional until the
                           server acknowledges it. Must live in `animate`, not
                           `style`: framer drives opacity as an animated value
                           and overwrites an inline style on the first frame. */
                        animate={{ opacity: msg.id.startsWith('optimistic-') ? 0.6 : 1, y: 0 }}
                        exit={{ opacity: 0, y: -4, transition: EXIT }}
                        transition={SPRING}
                      >
                      <MessageBubble
                        message={msg}
                        isOwn={isAuthor}
                        showAuthor={msgIdx === 0}
                        currentUserId={userId}
                        sectionId={sectionId}
                        phaseTitles={phaseTitles}
                        docTitles={docTitles}
                        canDelete={canDelete}
                        onDelete={handleDelete}
                        reactions={getReactions(msg.id)}
                        onReactionToggle={handleReactionToggle}
                      />
                      </motion.div>
                    )
                  })}
                  </AnimatePresence>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Input bar */}
      <ChatInput
        onSend={handleSend}
        sending={sending}
        teamId={teamId}
        sectionId={sectionId}
        channelId={channel.id}
      />
    </div>
    </TooltipProvider>
  )
}

// ── Date separator ───────────────────────────────────────────────

function DateSeparator({ date }: { date: Date }) {
  let label: string
  if (isToday(date)) {
    label = 'Today'
  } else if (isYesterday(date)) {
    label = 'Yesterday'
  } else {
    label = format(date, 'EEEE, MMMM d')
  }

  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-border" />
      <span className="text-[11px] font-medium text-muted-foreground bg-background px-2 shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Group consecutive messages from the same author within 5 minutes.
 */
function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  let current: ChatMessage[] = []

  for (const msg of messages) {
    if (current.length === 0) {
      current.push(msg)
      continue
    }

    const prev = current[current.length - 1]
    const sameAuthor = prev.author_id === msg.author_id
    const within5Min =
      new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000

    if (sameAuthor && within5Min) {
      current.push(msg)
    } else {
      groups.push(current)
      current = [msg]
    }
  }

  if (current.length > 0) groups.push(current)
  return groups
}
