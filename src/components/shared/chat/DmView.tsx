// Direct-message conversation pane. Wraps ChatArea + ChatInput with
// the DM hooks + DM upload helpers so it can drop into any sidebar
// layout (course discussions, team workspace) with one prop.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { TAB_FADE, SLIDE_FADE } from '@/lib/motion'
import { MessageCircle } from 'lucide-react'
import { ChatArea } from '@/components/shared/chat/ChatArea'
import {
  ChatInput,
  type ChatAttachment,
} from '@/components/shared/chat/ChatInput'
import type {
  ChatMessageData,
  MessageAuthor,
} from '@/components/shared/chat/MessageBubble'
import { useDmMessages } from '@/lib/dm/hooks'
import { uploadDmAttachment } from '@/lib/supabase/chat-storage'
import { sendDmMessage, deleteDmMessage, markDmRead } from '@/app/(dashboard)/dms/actions'

interface DmViewProps {
  channelId: string
  userId: string
  userProfile: MessageAuthor
  otherUser: MessageAuthor
  /** Called after the cursor is updated so the parent can zero the
   *  unread badge in the people list without a full refetch. */
  onRead?: () => void
}

export function DmView({
  channelId,
  userId,
  userProfile,
  otherUser,
  onRead,
}: DmViewProps) {
  const [sending, setSending] = useState(false)
  const {
    messages,
    loading,
    hasMore,
    loadMore,
    addOptimisticMessage,
    removeOptimisticMessage,
    markMessageDeleted,
  } = useDmMessages(channelId, userProfile)

  // Mark channel read on open and when new messages arrive from the
  // other party while the pane is visible.
  const prevCountRef = useRef(messages.length)
  useEffect(() => {
    if (!channelId) return
    markDmRead(channelId).then(() => onRead?.())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      markDmRead(channelId).then(() => onRead?.())
    }
    prevCountRef.current = messages.length
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, channelId])

  const handleSend = useCallback(
    async (content: string, attachment?: ChatAttachment) => {
      const optimistic: ChatMessageData = {
        id: `optimistic-${Date.now()}`,
        channel_id: channelId,
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
      addOptimisticMessage(optimistic)

      setSending(true)
      try {
        const result = await sendDmMessage(channelId, {
          content: content || '',
          // Don't persist the signed URL — it expires. Only the path is
          // durable; viewers re-sign on demand via `useChatAttachmentUrl`.
          attachment_path: attachment?.path,
          attachment_name: attachment?.name,
          attachment_size: attachment?.size,
          attachment_type: attachment?.type,
        })
        if (result.error) {
          /* Roll the bubble back — a rejected send must not keep looking sent (#681).
             The over-10k path returned an error with no toast at all, so the user saw
             their message in the thread with nothing to contradict it. */
          removeOptimisticMessage(optimistic.id)
          toast.error(result.error)
          return false
        }
      } catch {
        removeOptimisticMessage(optimistic.id)
        toast.error('Failed to send message')
        return false
      } finally {
        setSending(false)
      }
    },
    [channelId, userId, userProfile, addOptimisticMessage, removeOptimisticMessage],
  )

  const handleUpload = useCallback(
    (file: File) => uploadDmAttachment(file, channelId),
    [channelId],
  )

  // Author-only delete. Flip optimistic tombstone first, then persist;
  // realtime UPDATE reconciles the canonical timestamp. Roll back on
  // error so the bubble body reappears.
  const handleDelete = useCallback(
    async (messageId: string) => {
      markMessageDeleted(messageId, userId)
      const result = await deleteDmMessage(messageId)
      if (result.error) {
        toast.error(result.error)
      }
    },
    [markMessageDeleted, userId],
  )

  const canDelete = useCallback(
    (msg: ChatMessageData) => msg.author_id === userId && !msg.deleted_at,
    [userId],
  )

  const displayName = otherUser.name || otherUser.email

  return (
    /* Switching conversations used to swap the whole pane in one frame, which
       reads as a glitch rather than as a change of subject. Keyed on channelId
       so each thread is its own element.
       Deliberately NOT mode="wait": serialising exit then enter cost ~290ms on
       an action people repeat dozens of times in a sitting, which is the band
       the frequency rule says to reduce hard. Overlapping them halves it. (An
       earlier comment here claimed mode="wait" stopped two realtime
       subscriptions existing at once; that was wrong — the subscription lives
       in this component, which does not remount.) */
    <AnimatePresence initial={false}>
    <motion.div
      key={channelId}
      className="flex h-full min-h-0 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: SLIDE_FADE }}
      transition={TAB_FADE}
    >
    <ChatArea
      channelName={displayName}
      channelContext="Direct message"
      headerIcon={MessageCircle}
      messages={messages}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={loadMore}
      userId={userId}
      canDeleteMessage={canDelete}
      onDeleteMessage={handleDelete}
      emptyTitle={`Say hi to ${displayName}`}
      emptySubtitle="This is a private conversation. Only the two of you can see these messages."
    >
      <ChatInput onSend={handleSend} onUpload={handleUpload} sending={sending} />
    </ChatArea>
    </motion.div>
    </AnimatePresence>
  )
}
