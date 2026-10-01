/**
 * Browser-side Supabase client factory — singleton.
 *
 * Returns the SAME SupabaseClient instance across every call within a
 * given browser tab. This matters for the Live Classroom broadcast
 * architecture: useRealtimeAuth calls supabase.realtime.setAuth(token)
 * on the JWT, and useRoomChannel subscribes to a private channel. If
 * each call returned a fresh client, setAuth would land on instance A
 * and the channel would subscribe on instance B — private-channel RLS
 * would silently reject every event, and the only fix would be a hard
 * refresh.
 *
 * Used in: login/page.tsx and any client-side hook (useRealtimeAuth,
 * useRoomChannel, usePresence, every chat/dm hook).
 *
 * For server components, server actions, and API routes, use server.ts.
 *
 * Usage:
 *   const supabase = createClient()
 *   const { data, error } = await supabase.auth.signInWithPassword({ email, password })
 */

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTH_COOKIE_OPTIONS } from './cookie-options'

let client: SupabaseClient | null = null

export function createClient(): SupabaseClient {
  if (client) return client
  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: AUTH_COOKIE_OPTIONS }
  )
  return client
}
