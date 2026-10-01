// Realtime hooks for Direct Messages. Same shape as the discussion
// hooks — fetch page + subscribe to inserts. The DM messages table
// mirrors discussion_messages so we reuse the ChatMessageData type
// and the shared MessageBubble renders them unchanged.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import { createClient } from '@/lib/supabase/client'
import type {
  ChatMessageData,
  MessageAuthor,
} from '@/components/shared/chat/MessageBubble'
import {
  listMyDms,
  type DmChannelSummary,
} from '@/app/(dashboard)/dms/actions'

const MESSAGES_PER_PAGE = 50

/**
 * Fetch the caller's DM threads once and refresh on new DM inserts for
 * channels we already know about. The server action handles auth +
 * counterparty resolution; realtime just nudges us to refetch so the
 * preview + last_message_at stay fresh.
 */
export function useDmChannels(userId: string | undefined) {
  const [channels, setChannels] = useState<DmChannelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChannels([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    listMyDms().then((res) => {
      if (cancelled) return
      if (res.data) setChannels(res.data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [userId, refreshTick])

  // Nudge on new messages in any existing channel or new channels.
  useRealtimeSubscription(
    { table: 'dm_messages' },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        setRefreshTick((n) => n + 1)
      }
    }, []),
  )

  useRealtimeSubscription(
    { table: 'dm_channels' },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        setRefreshTick((n) => n + 1)
      }
    }, []),
  )

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), [])

  return { channels, loading, refresh }
}

/**
 * Messages hook for a single DM thread. Mirrors useDiscussionMessages.
 */
export function useDmMessages(
  channelId: string | null,
  currentUserProfile?: MessageAuthor,
) {
  const [messages, setMessages] = useState<ChatMessageData[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)

  const profileCacheRef = useRef<Map<string, MessageAuthor>>(new Map())

  useEffect(() => {
    if (currentUserProfile) {
      profileCacheRef.current.set(currentUserProfile.id, currentUserProfile)
    }
  }, [currentUserProfile])

  useEffect(() => {
    if (!channelId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessages([])
      setLoading(false)
      return
    }

    setLoading(true)
    const supabase = createClient()
    const fetchMessages = async () => {
      const { data } = await supabase
        .from('dm_messages')
        .select(
          '*, author:profiles!dm_messages_author_id_fkey(id, name, email, avatar_url)',
        )
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(MESSAGES_PER_PAGE)

      if (data) {
        const msgs = (data as unknown as ChatMessageData[]).reverse()
        for (const msg of msgs) {
          if (msg.author) {
            profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
          }
        }
        setMessages(msgs)
        setHasMore(data.length === MESSAGES_PER_PAGE)
      }
      setLoading(false)
    }
    fetchMessages()
  }, [channelId])

  useRealtimeSubscription(
    {
      table: 'dm_messages',
      filter: channelId ? `channel_id=eq.${channelId}` : undefined,
    },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const raw = payload.new as unknown as ChatMessageData

        const cachedProfile = profileCacheRef.current.get(raw.author_id)
        if (cachedProfile) {
          raw.author = cachedProfile
        }

        setMessages((prev) => {
          if (prev.some((m) => m.id === raw.id)) return prev
          const optimisticIdx = prev.findIndex(
            (m) => m.id.startsWith('optimistic-') && m.author_id === raw.author_id,
          )
          if (optimisticIdx >= 0) {
            const next = [...prev]
            next[optimisticIdx] = raw
            return next
          }
          return [...prev, raw]
        })

        // Missing author profile — fetch and backfill.
        if (!cachedProfile) {
          const supabase = createClient()
          supabase
            .from('profiles')
            .select('id, name, email, avatar_url')
            .eq('id', raw.author_id)
            .single()
            .then(({ data: profile }) => {
              if (profile) {
                const authorProfile = profile as unknown as MessageAuthor
                profileCacheRef.current.set(raw.author_id, authorProfile)
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === raw.id ? { ...m, author: authorProfile } : m,
                  ),
                )
              }
            })
        }
      } else if (payload.eventType === 'UPDATE') {
        // Soft-delete arrives as an UPDATE with deleted_at set. We only
        // merge the tombstone fields — author/body stay untouched so the
        // existing profile cache isn't disturbed.
        const raw = payload.new as unknown as ChatMessageData
        setMessages((prev) =>
          prev.map((m) =>
            m.id === raw.id
              ? {
                  ...m,
                  deleted_at: raw.deleted_at ?? null,
                  deleted_by_id: raw.deleted_by_id ?? null,
                }
              : m,
          ),
        )
      }
    }, []),
  )

  const addOptimisticMessage = useCallback((msg: ChatMessageData) => {
    if (msg.author) {
      profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
    }
    setMessages((prev) => [...prev, msg])
  }, [])

  /* Roll an optimistic message back when the send is REJECTED (#681). There was no way to
     un-add one, so a rejected DM stayed in the thread with a timestamp looking sent until
     the next page load — and the over-10k path showed no toast either, so nothing
     contradicted it. Verified in the report that the row never existed. */
  const removeOptimisticMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId))
  }, [])

  const markMessageDeleted = useCallback(
    (messageId: string, deletedById: string) => {
      const deletedAt = new Date().toISOString()
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, deleted_at: deletedAt, deleted_by_id: deletedById }
            : m,
        ),
      )
    },
    [],
  )

  const loadMore = useCallback(async () => {
    if (!channelId || messages.length === 0) return

    const supabase = createClient()
    const oldest = messages[0]
    const { data } = await supabase
      .from('dm_messages')
      .select(
        '*, author:profiles!dm_messages_author_id_fkey(id, name, email, avatar_url)',
      )
      .eq('channel_id', channelId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(MESSAGES_PER_PAGE)

    if (data) {
      const older = (data as unknown as ChatMessageData[]).reverse()
      for (const msg of older) {
        if (msg.author)
          profileCacheRef.current.set(msg.author_id, msg.author as MessageAuthor)
      }
      setMessages((prev) => [...older, ...prev])
      setHasMore(data.length === MESSAGES_PER_PAGE)
    }
  }, [channelId, messages])

  return {
    messages,
    loading,
    hasMore,
    loadMore,
    addOptimisticMessage,
    removeOptimisticMessage,
    markMessageDeleted,
  }
}
