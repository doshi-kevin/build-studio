// Realtime auth wiring. Mounted once at the dashboard layout via
// <RealtimeAuthMount />. Pushes the current Supabase JWT into the
// realtime client so private-channel RLS (notably the room:<uuid>
// authorization on realtime.messages) sees auth.uid().
//
// Why this exists: postgres_changes subscriptions bind the JWT at
// subscribe time, but Broadcast's private channels rely on the realtime
// client carrying a fresh access token. Without setAuth(), all private
// channel subscribes fail silently with CHANNEL_ERROR after the first
// JWT rotation (default 1h).
//
// supabase.realtime.setAuth(token) reauthorizes already-subscribed
// channels in place — no resubscribe needed.

'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'

export function useRealtimeAuth() {
  useEffect(() => {
    const supabase = createClient()

    let cancelled = false

    const apply = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token)
        logger.debug('useRealtimeAuth: setAuth applied')
      }
    }

    void apply()

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (cancelled) return
        if (session?.access_token) {
          supabase.realtime.setAuth(session.access_token)
          logger.debug('useRealtimeAuth: setAuth on auth state change')
        }
      },
    )

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])
}

/** Mount-only component used to attach the hook from a server-rendered layout. */
export function RealtimeAuthMount() {
  useRealtimeAuth()
  return null
}
