/**
 * Server-side Supabase client factory.
 *
 * Creates a Supabase client for use in server components, server actions,
 * and API routes. Manages auth cookies via Next.js cookies() API.
 *
 * MUST be called with `await` because cookies() is async in Next.js 16:
 *   const supabase = await createClient()
 *
 * The setAll callback is wrapped in try-catch because it fails silently when
 * called from a Server Component (which has a read-only cookie context).
 * This is expected behavior — cookies can only be set from Server Actions
 * or Route Handlers.
 *
 * For client components ('use client'), use client.ts instead.
 * For middleware, use createServerClient directly (different cookie API).
 */

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { AUTH_COOKIE_OPTIONS } from './cookie-options'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        /** Read all auth cookies from the incoming request */
        getAll() {
          return cookieStore.getAll()
        },
        /** Write updated auth cookies back to the response (fails silently in Server Components) */
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Expected in Server Components — they have read-only cookie access.
            // Auth token refresh will be handled by middleware instead.
          }
        },
      },
    }
  )
}
