/**
 * StudentDiscussionsPage — course-level channels + direct messages.
 *
 * Team-scoped channels have moved to the per-project Discussions tab
 * (see StudentTeamDetail). This page now renders course channels plus
 * a People panel that opens 1:1 DMs with classmates and the professor.
 */
'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  Hash,
  MessageCircle,
  Loader2,
  Archive,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMessageReactions } from '@/lib/chat/reactions'
import { toggleDiscussionReaction } from '@/app/(dashboard)/chat-reactions/actions'
import { ChatArea } from '@/components/shared/chat/ChatArea'
import {
  ChatInput,
  type ChatAttachment,
} from '@/components/shared/chat/ChatInput'
import { DmView } from '@/components/shared/chat/DmView'
import { PeoplePanel } from '@/components/shared/chat/PeoplePanel'
import {
  useDiscussionChannels,
  useDiscussionMessages,
  type DiscussionChannel,
} from '@/lib/discussion/hooks'
import type {
  MessageAuthor,
  ChatMessageData,
} from '@/components/shared/chat/MessageBubble'
import { uploadDiscussionAttachment } from '@/lib/supabase/chat-storage'
import {
  sendDiscussionMessage,
  deleteDiscussionMessage,
} from '@/app/(dashboard)/student/courses/[sectionId]/discussions/actions'
import {
  listSectionPeople,
  openOrCreateDm,
  getDmUnreadCounts,
  type PersonOption,
  type DmUnreadEntry,
} from '@/app/(dashboard)/dms/actions'

interface StudentDiscussionsPageProps {
  sectionId: string
  userId: string
  userProfile: MessageAuthor
}

type ActiveView =
  | { kind: 'channel'; channel: DiscussionChannel }
  | { kind: 'dm'; channelId: string; other: PersonOption }

export function StudentDiscussionsPage({
  sectionId,
  userId,
  userProfile,
}: StudentDiscussionsPageProps) {
  const searchParams = useSearchParams()
  /* `?dm=<userId>` deep-links straight into a conversation. The professor page has
   * read this since the Course Assistants "Message" link shipped; the student side
   * had the same DM machinery but no way in, which is why a DM notification could
   * not link anywhere (#693). Read once on mount: after that the view is client
   * state, so a later channel click must not be yanked back to the DM. */
  const [dmDeepLinkUserId] = useState(() => searchParams.get('dm'))
  const [dmDeepLinkPending, setDmDeepLinkPending] = useState(Boolean(dmDeepLinkUserId))

  const [view, setView] = useState<ActiveView | null>(null)
  const [sending, setSending] = useState(false)

  const [people, setPeople] = useState<PersonOption[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [openingDm, setOpeningDm] = useState(false)
  const [dmMeta, setDmMeta] = useState<DmUnreadEntry[]>([])

  const { channels: courseChannels, loading: courseLoading } =
    useDiscussionChannels(sectionId, 'course')

  /* Resolve the open channel against the LIVE list rather than trusting the copy held in
     `view` (#675). Deleting the channel you are reading left the pane showing — and
     letting you interact with — a channel that no longer exists, because `view` holds a
     channel object captured at selection time. Reconciling here means a delete (or an
     archive, from another professor's session) drops the pane to the "select a channel"
     state instead of firing requests at a dead id.

     Falls back to `view.channel` while the list is still loading, so a refresh does not
     blank the pane mid-fetch. */
  const heldChannel = view?.kind === 'channel' ? view.channel : null
  const activeChannel = heldChannel
    ? (courseLoading
        ? heldChannel
        : (courseChannels.find((c) => c.id === heldChannel.id) ?? null))
    : null
  const activeDmOtherId = view?.kind === 'dm' ? view.other.id : null

  const {
    messages,
    loading: messagesLoading,
    hasMore,
    loadMore,
    addOptimisticMessage,
    removeOptimisticMessage,
    markMessageDeleted,
  } = useDiscussionMessages(activeChannel?.id || null, userProfile)

  const { getReactions, toggleOptimistic } = useMessageReactions(
    'discussion_message_reactions',
    activeChannel?.id || null,
    userId,
    userProfile,
  )

  const handleReactionToggle = useCallback(
    (messageId: string, emoji: string) => {
      toggleOptimistic(messageId, emoji)
      toggleDiscussionReaction(messageId, emoji).then((res) => {
        if (res.error) toast.error(res.error)
      })
    },
    [toggleOptimistic],
  )

  // Fetch section people + DM unread counts once on mount.
  useEffect(() => {
    let cancelled = false
    setPeopleLoading(true)
    Promise.all([listSectionPeople(sectionId), getDmUnreadCounts()]).then(
      ([peopleRes, unreadRes]) => {
        if (cancelled) return
        if (peopleRes.data) setPeople(peopleRes.data)
        if (unreadRes.data) setDmMeta(unreadRes.data)
        setPeopleLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [sectionId])

  const enrichedPeople = useMemo(() => {
    if (dmMeta.length === 0) return people
    const metaMap = new Map(dmMeta.map((m) => [m.other_user_id, m]))
    return people.map((p) => {
      const meta = metaMap.get(p.id)
      if (!meta) return p
      return { ...p, unread_count: meta.unread_count, last_dm_at: meta.last_message_at }
    })
  }, [people, dmMeta])

  const handleDmRead = useCallback(() => {
    if (!view || view.kind !== 'dm') return
    setDmMeta((prev) =>
      prev.map((m) =>
        m.other_user_id === view.other.id ? { ...m, unread_count: 0 } : m,
      ),
    )
  }, [view])

  // Auto-select first course channel when channels load.
  useEffect(() => {
    // Hold off while a ?dm= deep link is resolving, otherwise the channel renders
    // first and is replaced a tick later.
    if (!view && !dmDeepLinkPending && courseChannels.length > 0) {
      const defaultCh =
        courseChannels.find((c) => c.is_default) || courseChannels[0]
      setView({ kind: 'channel', channel: defaultCh })
    }
  }, [courseChannels, view, dmDeepLinkPending])

  const handleChannelSelect = useCallback((channel: DiscussionChannel) => {
    setView({ kind: 'channel', channel })
  }, [])

  const handlePersonSelect = useCallback(
    async (otherUserId: string) => {
      if (openingDm) return
      const other = people.find((p) => p.id === otherUserId)
      if (!other) return
      setOpeningDm(true)
      try {
        const result = await openOrCreateDm(otherUserId)
        if (result.error || !result.data) {
          toast.error(result.error || 'Could not open DM')
          return
        }
        setView({ kind: 'dm', channelId: result.data.channelId, other })
      } finally {
        setOpeningDm(false)
      }
    },
    [people, openingDm],
  )

  /* Resolve the ?dm= deep link once the people list has landed — before that there is
     nothing to match the id against. The ref makes it fire exactly once, so a
     re-render mid-open cannot start a second DM. */
  const dmDeepLinkAttempted = useRef(false)
  useEffect(() => {
    if (dmDeepLinkAttempted.current || !dmDeepLinkUserId || peopleLoading) return
    dmDeepLinkAttempted.current = true
    if (!people.some((p) => p.id === dmDeepLinkUserId)) {
      setDmDeepLinkPending(false)
      toast.error('That person is no longer on this course.')
      return
    }
    void handlePersonSelect(dmDeepLinkUserId).finally(() => setDmDeepLinkPending(false))
  }, [dmDeepLinkUserId, peopleLoading, people, handlePersonSelect])

  const handleSend = useCallback(
    async (content: string, attachment?: ChatAttachment) => {
      if (!activeChannel) return

      const optimisticMsg: ChatMessageData = {
        id: `optimistic-${Date.now()}`,
        channel_id: activeChannel.id,
        author_id: userId,
        content: content || '',
        attachment_url: attachment?.url || null,
        attachment_path: attachment?.path || null,
        attachment_name: attachment?.name || null,
        attachment_size: attachment?.size || null,
        attachment_type: attachment?.type || null,
        created_at: new Date().toISOString(),
        author: userProfile,
      }
      addOptimisticMessage(optimisticMsg)

      setSending(true)
      try {
        const result = await sendDiscussionMessage(activeChannel.id, sectionId, {
          content: content || '',
          // Do NOT persist the signed URL — it expires (short TTL) and would
          // 404 on later views. Only the path is stored; MessageBubble mints a
          // fresh signed URL per view from it. (The optimistic message above
          // keeps `url` for instant local preview.)
          attachment_path: attachment?.path,
          attachment_name: attachment?.name,
          attachment_size: attachment?.size,
          attachment_type: attachment?.type,
        })
        if (result.error) {
          /* Roll the bubble back (#677). Confirmed on three rejection paths — over-length,
             archived channel, and the same under concurrency — where the row was never
             persisted but the message stayed on screen looking sent. */
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
    },
    [
      activeChannel,
      sectionId,
      userId,
      userProfile,
      addOptimisticMessage,
      removeOptimisticMessage,
    ],
  )

  const handleUpload = useCallback(
    async (file: File) => {
      if (!activeChannel)
        return { data: null, error: 'No channel selected' }
      return uploadDiscussionAttachment(file, sectionId, activeChannel.id)
    },
    [activeChannel, sectionId],
  )

  // Students can only delete their own course-channel posts. Staff
  // moderation is handled in ProfessorDiscussionsPage.
  const handleDelete = useCallback(
    async (messageId: string) => {
      markMessageDeleted(messageId, userId)
      const result = await deleteDiscussionMessage(messageId, sectionId)
      if (result.error) {
        toast.error(result.error)
      }
    },
    [markMessageDeleted, userId, sectionId],
  )

  const canDelete = useCallback(
    (msg: ChatMessageData) => msg.author_id === userId && !msg.deleted_at,
    [userId],
  )

  const isArchived = activeChannel?.status === 'archived'
  const [courseSectionOpen, setCourseSectionOpen] = useState(true)

  return (
    <div className="border border-border rounded-xl overflow-hidden flex h-[calc(100vh-180px)] min-h-[500px]">
      {/* ── Left sidebar: channels + people ─────────────────────── */}
      <div className="w-64 border-r bg-muted/20 flex flex-col shrink-0">
        <div className="px-4 py-3.5 border-b bg-background/60">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold tracking-tight">Discussions</h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="pt-3 pb-1">
            <button
              onClick={() => setCourseSectionOpen(!courseSectionOpen)}
              className="w-full px-3 mb-1 flex items-center gap-1 group cursor-pointer"
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 text-foreground/50 transition-transform duration-200',
                  !courseSectionOpen && '-rotate-90',
                )}
              />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70 group-hover:text-foreground transition-colors">
                Channels
              </span>
              <span className="ml-auto text-[10px] text-foreground/40">
                {courseChannels.length}
              </span>
            </button>

            {courseSectionOpen && (
              <>
                {courseLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : courseChannels.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-4 py-2">
                    No channels yet
                  </p>
                ) : (
                  <div className="px-2 mt-0.5 space-y-px">
                    {courseChannels.map((channel) => (
                      <ChannelItem
                        key={channel.id}
                        channel={channel}
                        isActive={
                          view?.kind === 'channel' &&
                          channel.id === view.channel.id
                        }
                        onClick={() => handleChannelSelect(channel)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="border-t border-border/60 mt-2">
            <PeoplePanel
              people={enrichedPeople}
              loading={peopleLoading}
              activeUserId={activeDmOtherId}
              onSelect={handlePersonSelect}
              label="People"
              emptyText="No classmates here yet."
            />
          </div>
        </div>
      </div>

      {/* ── Right side: chat area ───────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {view?.kind === 'dm' ? (
          <DmView
            channelId={view.channelId}
            userId={userId}
            userProfile={userProfile}
            otherUser={view.other}
            onRead={handleDmRead}
          />
        ) : activeChannel ? (
          <ChatArea
            channelName={activeChannel.name}
            messages={messages}
            loading={messagesLoading}
            hasMore={hasMore}
            onLoadMore={loadMore}
            userId={userId}
            archived={isArchived}
            canDeleteMessage={canDelete}
            onDeleteMessage={handleDelete}
            getReactions={getReactions}
            onReactionToggle={handleReactionToggle}
          >
            <ChatInput
              onSend={handleSend}
              onUpload={handleUpload}
              sending={sending}
              disabled={isArchived}
            />
          </ChatArea>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground">
            <MessageCircle className="h-10 w-10 mb-3" />
            <p className="text-sm font-medium">Select a channel or person</p>
            <p className="text-xs mt-1">
              Pick a channel to chat with the class, or a person for a private DM.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Channel list item ──────────────────────────────────────────

function ChannelItem({
  channel,
  isActive,
  onClick,
}: {
  channel: DiscussionChannel
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-[13px] transition duration-150 ease-out',
        isActive
          ? 'bg-primary/10 text-primary font-semibold shadow-sm ring-1 ring-primary/10'
          : 'text-foreground/70 hover:bg-muted hover:text-foreground',
        channel.status === 'archived' && 'opacity-50',
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          'w-0.5 h-4 rounded-full shrink-0 transition-colors',
          isActive ? 'bg-primary' : 'bg-transparent',
        )}
      />
      {channel.status === 'archived' ? (
        <Archive className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Hash
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            isActive ? 'text-primary' : 'text-foreground/50',
          )}
        />
      )}
      <span className="truncate flex-1 text-left">{channel.name}</span>
    </button>
  )
}
