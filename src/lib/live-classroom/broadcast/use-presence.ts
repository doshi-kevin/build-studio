// Presence hook — uses the Supabase Realtime presence extension on the room's
// dedicated `:presence` topic (NOT the shared broadcast channels — realtime-js
// dedups by topic, so presence needs its own to avoid a config collision).
// Each connected client tracks { userId, role, name }; the hook returns the
// de-duplicated roster + count for rendering "23 students present".

'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { presenceTopic } from './types'

export interface PresenceState {
  userId: string
  role: 'professor' | 'student' | 'ta' | 'grader'
  name: string
}

interface Options {
  roomId: string
  state: PresenceState
}

/**
 * Collapse Supabase's raw presence map into one entry per user. The raw shape
 * is `{ [presenceKey]: PresenceState[] }`; we key by userId, so a user with
 * several open tabs occupies one key with multiple entries — we keep the last
 * (most recent) so each unique user is counted exactly once.
 */
export function flattenPresenceState(
  raw: Record<string, unknown[]>,
): PresenceState[] {
  const out: PresenceState[] = []
  for (const key of Object.keys(raw)) {
    const entries = raw[key]
    const last = entries?.[entries.length - 1] as PresenceState | undefined
    if (last && typeof last.userId === 'string') out.push(last)
  }
  return out
}

export function usePresence({ roomId, state }: Options) {
  const [presentUsers, setPresentUsers] = useState<PresenceState[]>([])
  const { userId, role, name } = state

  useEffect(() => {
    let cancelled = false
    let channel: RealtimeChannel | null = null
    const supabase = createClient()

    const setup = async () => {
      // Same race-proof setAuth pattern as useRoomChannel — a private channel's
      // RLS on realtime.messages needs the JWT set before subscribe.
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token)
        }
      } catch {
        // Ignore — channel will surface CHANNEL_ERROR if auth is broken.
      }
      if (cancelled) return

      channel = supabase.channel(presenceTopic(roomId), {
        config: { private: true, presence: { key: userId } },
      })

      channel.on('presence', { event: 'sync' }, () => {
        if (!channel) return
        setPresentUsers(flattenPresenceState(channel.presenceState()))
      })

      channel.subscribe(async (status) => {
        // Supabase does NOT auto re-track on reconnect — re-announce on every
        // (re)subscribe so a dropped client reappears in the roster.
        if (status === 'SUBSCRIBED' && channel) {
          await channel.track({ userId, role, name })
        }
      })
    }

    void setup()

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel).catch(() => {})
    }
  }, [roomId, userId, role, name])

  return { presentUsers, count: presentUsers.length }
}
