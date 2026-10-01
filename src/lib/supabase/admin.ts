/**
 * Admin Supabase Client — server-side only client that bypasses RLS.
 *
 * Uses the SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix, never exposed to browser)
 * to create a Supabase client with full database access, bypassing Row Level Security.
 *
 * IMPORTANT: Only use this client in server actions that have ALREADY verified
 * the caller is an institution_admin. Never expose this client to client components.
 *
 * Why this exists:
 * - The regular server client (server.ts) uses the anon key, which is subject to RLS
 * - Admin operations (create/update/delete departments) need full table access
 * - Rather than creating complex RLS policies for every admin table, we use the
 *   service role key server-side where we've already verified authorization
 *
 * Security model:
 * 1. Middleware verifies authentication (user is logged in)
 * 2. Admin layout verifies authorization (user is institution_admin)
 * 3. Server actions independently verify admin role before using this client
 * 4. This client then executes the query with full access
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Creates a Supabase admin client with the service role key.
 * This client bypasses RLS — only use after verifying the caller is authorized.
 *
 * Unlike the regular server client, this does NOT use cookies for auth
 * because it authenticates via the service role key directly.
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local from Supabase Dashboard > Settings > API.'
    )
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
