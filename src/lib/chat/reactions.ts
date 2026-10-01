// Shared client-side hook for message reactions. Works with both
// discussion_message_reactions and project_chat_message_reactions
// tables — the caller specifies which table to query.
'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import type {
  ReactionSummary,
  ReactionUser,
} from '@/components/shared/chat/ReactionBar'

export type ReactionTable =
  | 'discussion_message_reactions'
  | 'project_chat_message_reactions'

interface RawReaction {
  id: string
  message_id: string
  user_id: string
  emoji: string
}

/**
 * Fetches all reactions for messages in a given channel and subscribes
 * to realtime changes. Returns a Map<messageId, ReactionSummary[]> and
 * an optimistic toggle helper. Each summary carries the list of
 * reactors (id + name + avatar) so the UI can show a WhatsApp-style
 * reactor sheet on click.
 */
export function useMessageReactions(
  table: ReactionTable,
  channelId: string | null,
  userId: string,
  // The viewer's own profile. Seeded into the cache up front so a freshly
  // placed (optimistic) reaction never renders as "Unknown" — `ensureProfiles`
  // only fetches reactors that appear in fetched data, which never covers the
  // viewer's own brand-new reaction until it round-trips.
  currentUser?: ReactionUser,
) {
  const [raw, setRaw] = useState<RawReaction[]>([])
  // Profile cache keyed by user_id. Realtime payloads only carry the
  // raw row, so we lazy-fetch the reactor profile when one shows up
  // that we haven't seen before.
  const [profiles, setProfiles] = useState<Record<string, ReactionUser>>(() =>
    currentUser ? { [currentUser.id]: currentUser } : {},
  )
  // Mirror profiles into a ref so ensureProfiles can dedupe lookups
  // without re-creating its closure on every profile change.
  const profilesRef = useRef(profiles)
  useEffect(() => {
    profilesRef.current = profiles
  }, [profiles])
  const messageTableRef = useRef(
    table === 'discussion_message_reactions'
      ? 'discussion_messages'
      : 'project_chat_messages',
  )

  const ensureProfiles = useCallback(async (userIds: string[]) => {
    const missing = Array.from(
      new Set(userIds.filter((id) => !profilesRef.current[id])),
    )
    if (missing.length === 0) return
    const supabase = createClient()
    const { data } = await supabase
      .from('profiles')
      .select('id, name, avatar_url')
      .in('id', missing)
    if (!data) return
    setProfiles((prev) => {
      const next = { ...prev }
      for (const p of data as ReactionUser[]) {
        next[p.id] = p
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!channelId) {
      // Empty channel: clearing here is the simplest way to drop stale
      // reactions when the channel switches. This is a reset boundary,
      // not a derived value, so the setState-in-effect warning is fine
      // to ignore here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRaw([])
      return
    }

    const supabase = createClient()
    const fetchReactions = async () => {
      const { data: messageIds } = await supabase
        .from(messageTableRef.current)
        .select('id')
        .eq('channel_id', channelId)

      if (!messageIds || messageIds.length === 0) {
        setRaw([])
        return
      }

      const ids = messageIds.map((m: { id: string }) => m.id)
      const { data } = await supabase
        .from(table)
        .select('id, message_id, user_id, emoji')
        .in('message_id', ids)

      if (data) {
        const rows = data as RawReaction[]
        setRaw(rows)
        ensureProfiles(rows.map((r) => r.user_id))
      }
    }
    fetchReactions()
  }, [channelId, table, ensureProfiles])

  // Realtime subscription for reaction changes. INSERT replaces any
  // optimistic placeholder for the same (message_id, user_id) so the
  // count doesn't double when our own reaction round-trips through
  // realtime. DELETE removes by id.
  useRealtimeSubscription(
    { table, filter: undefined },
    useCallback(
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        if (payload.eventType === 'INSERT') {
          const r = payload.new as unknown as RawReaction
          setRaw((prev) => {
            if (prev.some((x) => x.id === r.id)) return prev
            // Drop any prior reaction by the same user on the same
            // message — only one emoji per user per message is allowed,
            // and any optimistic placeholder needs to be cleared.
            const filtered = prev.filter(
              (x) => !(x.message_id === r.message_id && x.user_id === r.user_id),
            )
            return [...filtered, r]
          })
          ensureProfiles([r.user_id])
        } else if (payload.eventType === 'DELETE') {
          const r = payload.old as Partial<RawReaction>
          if (r.id) {
            setRaw((prev) => prev.filter((x) => x.id !== r.id))
          }
        }
      },
      [ensureProfiles],
    ),
  )

  const getReactions = useCallback(
    (messageId: string): ReactionSummary[] => {
      const forMsg = raw.filter((r) => r.message_id === messageId)
      const emojiMap = new Map<
        string,
        { count: number; reacted: boolean; users: ReactionUser[] }
      >()
      for (const r of forMsg) {
        const entry = emojiMap.get(r.emoji) || {
          count: 0,
          reacted: false,
          users: [],
        }
        entry.count++
        if (r.user_id === userId) entry.reacted = true
        const profile = profiles[r.user_id]
        entry.users.push(
          profile ?? { id: r.user_id, name: null, avatar_url: null },
        )
        emojiMap.set(r.emoji, entry)
      }
      return Array.from(emojiMap.entries()).map(
        ([emoji, { count, reacted, users }]) => ({
          emoji,
          count,
          reacted,
          users,
        }),
      )
    },
    [raw, userId, profiles],
  )

  // Single-reaction-per-user rule: clicking the same emoji clears it,
  // clicking a different emoji replaces the existing one.
  const toggleOptimistic = useCallback(
    (messageId: string, emoji: string) => {
      setRaw((prev) => {
        const mine = prev.find(
          (r) => r.message_id === messageId && r.user_id === userId,
        )
        if (mine && mine.emoji === emoji) {
          return prev.filter((r) => r.id !== mine.id)
        }
        const without = mine ? prev.filter((r) => r.id !== mine.id) : prev
        return [
          ...without,
          {
            id: `optimistic-${Date.now()}-${emoji}`,
            message_id: messageId,
            user_id: userId,
            emoji,
          },
        ]
      })
    },
    [userId],
  )

  return { getReactions, toggleOptimistic }
}
