/**
 * ProfessorDiscussionsPage — course-scope channels + direct messages.
 *
 * Team workspaces live on each project's Discussions tab; this page
 * covers the course-wide channel list plus 1:1 DMs with enrolled
 * students (and co-professors, once applicable).
 */
'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { TAB_FADE, SLIDE_FADE } from '@/lib/motion'
import { MessageCircle } from 'lucide-react'
import { PageHeader } from '@/components/professor/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageReactions } from '@/lib/chat/reactions'
import { toggleDiscussionReaction } from '@/app/(dashboard)/chat-reactions/actions'
import { ChatArea } from '@/components/shared/chat/ChatArea'
import {
  ChatInput,
  type ChatAttachment,
} from '@/components/shared/chat/ChatInput'
import { DmView } from '@/components/shared/chat/DmView'
import { PeoplePanel } from '@/components/shared/chat/PeoplePanel'
import { DiscussionChannelSidebar } from '@/components/student/discussions/DiscussionChannelSidebar'
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
  createCourseChannel,
  renameCourseChannel,
  deleteCourseChannel,
  deleteDiscussionMessage,
} from '@/app/(dashboard)/professor/courses/[sectionId]/discussions/actions'
import { MAX_COURSE_CHANNELS } from '@/lib/validations/discussion'
import {
  listSectionPeople,
  openOrCreateDm,
  getDmUnreadCounts,
  type PersonOption,
  type DmUnreadEntry,
} from '@/app/(dashboard)/dms/actions'

interface ProfessorDiscussionsPageProps {
  sectionId: string
  userId: string
  userProfile: MessageAuthor
}

type ActiveView =
  | { kind: 'channel'; channel: DiscussionChannel }
  | { kind: 'dm'; channelId: string; other: PersonOption }

export function ProfessorDiscussionsPage({
  sectionId,
  userId,
  userProfile,
}: ProfessorDiscussionsPageProps) {
  const searchParams = useSearchParams()
  /* `?dm=<userId>` deep-links straight into a conversation — the Course
   * Assistants page uses it to hand the professor a "Message" link for each
   * TA/grader. Read once on mount: after that the view is client state, so a
   * later channel click must not be yanked back to the DM. */
  const [dmDeepLinkUserId] = useState(() => searchParams.get('dm'))
  const [dmDeepLinkPending, setDmDeepLinkPending] = useState(Boolean(dmDeepLinkUserId))

  const [view, setView] = useState<ActiveView | null>(null)
  const [sending, setSending] = useState(false)

  const [people, setPeople] = useState<PersonOption[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [openingDm, setOpeningDm] = useState(false)
  const [dmMeta, setDmMeta] = useState<DmUnreadEntry[]>([])

  const { channels, loading: channelsLoading } = useDiscussionChannels(
    sectionId,
    'course',
  )

  /* Resolve the open channel against the LIVE list rather than the copy held in `view`
     (#675). This page is the ONLY place channels can be deleted, so leaving it out of the
     first pass meant the fix could not possibly help: the professor deleted a channel and
     went on reading it, with a working composer that returned "Channel not found".
     Falls back to the held copy while loading so a refresh does not blank the pane. */
  const heldChannel = view?.kind === 'channel' ? view.channel : null
  const activeChannel = heldChannel
    ? (channelsLoading ? heldChannel : (channels.find((c) => c.id === heldChannel.id) ?? null))
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

  useEffect(() => {
    // Hold off on the default channel while a ?dm= deep link is resolving,
    // otherwise the channel renders first and gets replaced a tick later.
    if (!view && !dmDeepLinkPending && channels.length > 0) {
      const defaultCh = channels.find((c) => c.is_default) || channels[0]
      setView({ kind: 'channel', channel: defaultCh })
    }
  }, [channels, view, dmDeepLinkPending])

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

  // Resolve the ?dm= deep link once the people list has landed — before that
  // there is nothing to match the id against. The ref makes this fire exactly
  // once, so a re-render mid-open can't kick off a second DM.
  const dmDeepLinkAttempted = useRef(false)
  useEffect(() => {
    if (dmDeepLinkAttempted.current || !dmDeepLinkUserId || peopleLoading) return
    dmDeepLinkAttempted.current = true
    if (!people.some((p) => p.id === dmDeepLinkUserId)) {
      setDmDeepLinkPending(false)
      toast.error('That person is no longer on this course.')
      return
    }
    handlePersonSelect(dmDeepLinkUserId).finally(() => setDmDeepLinkPending(false))
  }, [dmDeepLinkUserId, peopleLoading, people, handlePersonSelect])

  const handleCreateChannel = useCallback(
    async (name: string) => {
      const result = await createCourseChannel(sectionId, { name })
      return {
        error: result.error,
        data: result.data as { id: string } | undefined,
      }
    },
    [sectionId],
  )

  const handleRenameChannel = useCallback(
    async (channelId: string, name: string) => {
      return renameCourseChannel(channelId, sectionId, { name })
    },
    [sectionId],
  )

  const handleDeleteChannel = useCallback(
    async (channelId: string) => {
      return deleteCourseChannel(channelId, sectionId)
    },
    [sectionId],
  )

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
          // Don't persist the signed URL — it expires. Only the path is
          // durable; viewers re-sign on demand via `useChatAttachmentUrl`.
          attachment_path: attachment?.path,
          attachment_name: attachment?.name,
          attachment_size: attachment?.size,
          attachment_type: attachment?.type,
        })
        if (result.error) {
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
    [activeChannel, sectionId, userId, userProfile, addOptimisticMessage, removeOptimisticMessage],
  )

  const handleUpload = useCallback(
    async (file: File) => {
      if (!activeChannel)
        return { data: null, error: 'No channel selected' }
      return uploadDiscussionAttachment(file, sectionId, activeChannel.id)
    },
    [activeChannel, sectionId],
  )

  // Professors can clear their own messages AND moderate student posts
  // in any course channel they own. The server action enforces both via
  // `canWriteAsStaff`; here we just show the trigger on every message.
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
    (msg: ChatMessageData) => !msg.deleted_at,
    [],
  )

  // `people` also carries TAs/graders now, so count students explicitly
  // rather than labelling the whole list "students".
  const studentCount = people.filter((p) => p.role === 'student').length
  const summary = [
    `${channels.length} channel${channels.length !== 1 ? 's' : ''}`,
    `${studentCount} student${studentCount !== 1 ? 's' : ''}`,
  ].join('  ·  ')

  return (
    <div className="space-y-4">
      <PageHeader
        title="Discussions"
        description="Course-wide channels for your class, plus direct messages with individual students."
      />

      {!channelsLoading && channels.length > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>
      )}

      {channelsLoading ? (
        <div className="flex h-[600px] gap-0 overflow-hidden rounded-xl border border-border">
          <div className="hidden w-64 shrink-0 flex-col gap-2 border-r border-border p-3 sm:flex">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-xl" />
            ))}
          </div>
          <div className="flex flex-1 flex-col gap-3 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-3/4 rounded-xl" />
            ))}
          </div>
        </div>
      ) : channels.length === 0 ? (
        <EmptyState
          variant="teaching"
          icon={MessageCircle}
          title="Channels are warming up"
          description="Your #general channel is created automatically. If you don't see it yet, refresh the page in a moment."
        />
      ) : (
        <div className="flex h-[600px] overflow-hidden rounded-xl border border-border">
          <DiscussionChannelSidebar
            channels={channels}
            activeChannelId={activeChannel?.id || null}
            onSelectChannel={handleChannelSelect}
            canManageChannels={true}
            maxChannels={MAX_COURSE_CHANNELS}
            onCreateChannel={handleCreateChannel}
            onRenameChannel={handleRenameChannel}
            onDeleteChannel={handleDeleteChannel}
            footerSlot={
              <PeoplePanel
                people={enrichedPeople}
                loading={peopleLoading}
                activeUserId={activeDmOtherId}
                onSelect={handlePersonSelect}
                label="People"
                emptyText="No enrolled students yet."
              />
            }
          />
          <div className="flex-1 flex flex-col min-w-0">
            {/* Moving between a course channel and a direct message is a change
                of context, and today it swaps the whole pane in a single frame.
                Keyed on the KIND only, deliberately: channel-to-channel is a
                professor scanning a list many times in a sitting and correctly
                stays instant, and message-to-message inside a DM is already
                handled by DmView's own crossfade. */}
            <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view?.kind ?? 'none'}
              className="flex-1 flex flex-col min-w-0 min-h-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: SLIDE_FADE }}
              transition={TAB_FADE}
            >
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
                canDeleteMessage={canDelete}
                onDeleteMessage={handleDelete}
                getReactions={getReactions}
                onReactionToggle={handleReactionToggle}
              >
                <ChatInput
                  onSend={handleSend}
                  onUpload={handleUpload}
                  sending={sending}
                />
              </ChatArea>
            ) : (
              <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
                Select a channel or student to start chatting
              </div>
            )}
            </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  )
}
