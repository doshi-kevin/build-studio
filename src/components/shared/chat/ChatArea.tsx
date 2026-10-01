/**
 * Shared ChatArea — Message feed with infinite scroll upward, auto-scroll on
 * new messages, and message grouping. Used by both project chat and discussions.
 *
 * Accepts messages, loading state, and callbacks as props so the parent controls
 * which hook and server actions to use.
 */
'use client'

import { useRef, useEffect, useMemo } from 'react'
import { Hash, Loader2, type LucideIcon } from 'lucide-react'
import { isToday, isYesterday, format } from 'date-fns'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageBubble, type ChatMessageData } from '@/components/shared/chat/MessageBubble'
import { SPRING, EXIT } from '@/lib/motion'
import { useMessageArrivals } from '@/lib/hooks/use-message-arrivals'
import type { ReactionSummary } from '@/components/shared/chat/ReactionBar'
import { TooltipProvider } from '@/components/ui/tooltip'

interface ChatAreaProps {
  channelName: string
  /** Optional context shown before the channel name (e.g. team name) */
  channelContext?: string
  messages: ChatMessageData[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  userId: string
  /** If true, hides the input area (e.g. archived channels) */
  archived?: boolean
  /** Header icon next to the title — defaults to Hash (#) for channels. */
  headerIcon?: LucideIcon
  /** Empty-state title override. Defaults to "Welcome to #{name}". */
  emptyTitle?: string
  /** Empty-state subtitle override. */
  emptySubtitle?: string
  /** Predicate: can the current viewer delete this message? The parent
   * encodes the per-surface rule (DM: author-only; course: author or
   * staff; etc). Returning false hides the "•••" menu. */
  canDeleteMessage?: (message: ChatMessageData) => boolean
  /** Fires after the viewer confirms delete on a bubble. Parent invokes
   * the right server action + flips optimistic `deleted_at`. */
  onDeleteMessage?: (messageId: string) => void | Promise<void>
  /** Returns aggregated reactions for a given message id. */
  getReactions?: (messageId: string) => ReactionSummary[]
  /** Toggle a reaction emoji on a message. */
  onReactionToggle?: (messageId: string, emoji: string) => void
  children?: React.ReactNode // Slot for ChatInput
}

export function ChatArea({
  channelName,
  channelContext,
  messages,
  loading,
  hasMore,
  onLoadMore,
  userId,
  archived,
  headerIcon: HeaderIcon = Hash,
  emptyTitle,
  emptySubtitle,
  canDeleteMessage,
  onDeleteMessage,
  getReactions,
  onReactionToggle,
  children,
}: ChatAreaProps) {
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

  /* Pin the feed to the newest message by scrolling the FEED, never by asking the
     browser to bring an element into view. `scrollIntoView` walks every scrollable
     ancestor, so on a thread longer than one screen it also scrolled the page: you
     landed on Discussions already past the page heading and the channel header,
     with nothing to tell you the page had moved. Same fix and same reason as
     AthenaChat.tsx. */
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
  }, [channelName])

  // Group consecutive messages by same author within 5 minutes
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])

  return (
    <TooltipProvider>
    <div className="flex flex-col h-full">
      {/* Channel header */}
      <div className="px-4 py-2.5 border-b flex items-center gap-2 shrink-0">
        {channelContext && (
          <>
            <span className="text-xs text-muted-foreground">{channelContext}</span>
            <span className="text-muted-foreground/40">/</span>
          </>
        )}
        <HeaderIcon className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">{channelName}</span>
        {archived && (
          <span className="text-xs text-muted-foreground ml-auto">Read-only (archived)</span>
        )}
      </div>

      {/* Messages area */}
      <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
        {/* Load more */}
        {hasMore && (
          <div className="flex justify-center pb-3">
            <button
              onClick={onLoadMore}
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
            <HeaderIcon className="h-8 w-8 mb-2" />
            <p className="text-sm font-medium">
              {emptyTitle ?? `Welcome to #${channelName}`}
            </p>
            <p className="text-xs mt-1">
              {emptySubtitle ?? 'This is the start of the conversation.'}
            </p>
          </div>
        ) : (
          (() => {
            let lastDateLabel = ''
            return groupedMessages.map((group) => {
              const dateLabel = getDateLabel(new Date(group[0].created_at))
              const showDivider = dateLabel !== lastDateLabel
              lastDateLabel = dateLabel
              return (
                <div key={group[0].id}>
                  {showDivider && <DateDivider label={dateLabel} />}
                  <div className="pt-1">
                    {/* A message from the other person arrives without the reader
                        doing anything, which is the one category of change that
                        earns motion. `initial={false}` means scrollback does not
                        replay on open — only genuinely new messages animate. */}
                    <AnimatePresence>
                      {group.map((msg, msgIdx) => (
                        <motion.div
                          key={msg.id}
                          /* No `layout` here, unlike the Live Classroom question
                             list this pattern comes from. That list is a handful
                             of rows; a chat thread runs to hundreds, and `layout`
                             measures every child on every change. Messages only
                             ever append at the bottom, so there is no reflow worth
                             animating and the measurement would be pure cost. */
                          initial={isArrival(msg.id, msg.author_id === userId) ? { opacity: 0, y: 6 } : false}
                          /* An unconfirmed message reads as provisional until the
                             server acknowledges it and the real id replaces it.
                             This has to live in `animate`, not in `style`: framer
                             drives opacity as an animated value, so an inline
                             style is overwritten on the first frame. */
                          animate={{ opacity: msg.id.startsWith('optimistic-') ? 0.6 : 1, y: 0 }}
                          exit={{ opacity: 0, y: -4, transition: EXIT }}
                          transition={SPRING}
                        >
                          <MessageBubble
                            message={msg}
                            isOwn={msg.author_id === userId}
                            showAuthor={msgIdx === 0}
                            canDelete={canDeleteMessage ? canDeleteMessage(msg) : false}
                            onDelete={onDeleteMessage}
                            reactions={getReactions?.(msg.id)}
                            onReactionToggle={onReactionToggle}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              )
            })
          })()
        )}
      </div>

      {/* Input slot — parent passes ChatInput or nothing for archived channels */}
      {!archived && children}
    </div>
    </TooltipProvider>
  )
}

/** Returns a human-readable date label for WhatsApp-style dividers */
function getDateLabel(date: Date): string {
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  if (date.getFullYear() === new Date().getFullYear()) {
    return format(date, 'EEEE, MMMM d')
  }
  return format(date, 'MMMM d, yyyy')
}

/** Horizontal date divider shown between message groups from different days */
function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-4 px-2">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[11px] font-medium text-muted-foreground bg-muted/60 px-3 py-0.5 rounded-full border border-border/40 shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  )
}

/**
 * Group consecutive messages from the same author within 5 minutes.
 */
function groupMessages(messages: ChatMessageData[]): ChatMessageData[][] {
  const groups: ChatMessageData[][] = []
  let current: ChatMessageData[] = []

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
