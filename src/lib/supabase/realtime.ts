/**
 * Supabase Realtime Hook — generic subscription for postgres_changes.
 *
 * This is the first Realtime feature in Scholera.
 * Uses the browser client from client.ts for subscriptions.
 */
'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

interface RealtimeSubscriptionOptions {
  table: string
  schema?: string
  event?: PostgresChangeEvent
  filter?: string
}

interface RealtimeChannelConfig {
  event: PostgresChangeEvent
  schema: string
  table: string
  filter?: string
}

/**
 * Subscribe to Supabase Realtime postgres_changes on a table.
 *
 * @param options - table name, optional schema/event/filter
 * @param callback - called with the change payload on each event
 *
 * Example:
 * ```
 * useRealtimeSubscription(
 *   { table: 'lc_interactions', filter: `room_id=eq.${roomId}` },
 *   (payload) => { ... }
 * )
 * ```
 */
export function useRealtimeSubscription<T extends Record<string, unknown>>(
  options: RealtimeSubscriptionOptions,
  callback: (payload: RealtimePostgresChangesPayload<T>) => void,
) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    const supabase = createClient()
    const channelName = `realtime:${options.table}:${options.filter || 'all'}`

    const channelConfig: RealtimeChannelConfig = {
      event: options.event || '*',
      schema: options.schema || 'public',
      table: options.table,
    }

    if (options.filter) {
      channelConfig.filter = options.filter
    }

    let channel: RealtimeChannel | null = null
    let cancelled = false

    const setup = async () => {
      // RLS-scoped postgres_changes bind the auth token at SUBSCRIBE time. If we
      // subscribe before the realtime socket carries the user's JWT, the server
      // evaluates our RLS as anon (auth.uid() = null) and silently delivers
      // nothing — and setAuth() does NOT re-bind an already-joined
      // postgres_changes subscription, so ordering matters. Push the JWT first.
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (session?.access_token) supabase.realtime.setAuth(session.access_token)
      } catch {
        // Non-fatal — subscribe anyway (e.g. public/unauthenticated tables).
      }
      if (cancelled) return

      channel = supabase
        .channel(channelName)
        .on('postgres_changes', channelConfig, (payload) => {
          callbackRef.current(payload as RealtimePostgresChangesPayload<T>)
        })
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            logger.warn('useRealtimeSubscription: channel not subscribed', {
              channel: channelName,
              status,
            })
          }
        })
    }

    void setup()

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [options.table, options.filter, options.event, options.schema])
}
