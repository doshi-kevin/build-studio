/**
 * Supabase clients bound to a specific seeded identity.
 *
 * The whole suite depends on these being what they claim. A client that silently fell back to
 * anon, or kept the service-role key, would make every "tenant A cannot see B" assertion pass
 * for the wrong reason — the strongest possible false green. So `asUser` signs in for real and
 * throws if the session it gets back is not the user it asked for.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { dbEnv } from './env'
import { PASSWORD } from './fixture'

const sessions = new Map<string, SupabaseClient>()

/** A client carrying a real JWT for the given seeded user. Cached per email. */
export async function asUser(email: string): Promise<SupabaseClient> {
  const cachedClient = sessions.get(email)
  if (cachedClient) return cachedClient

  const { url, anonKey } = dbEnv()
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`could not sign in ${email}: ${error.message}`)
  if (!data.session) throw new Error(`no session returned for ${email}`)

  // Guard against the failure that would quietly invalidate the suite.
  const { data: who } = await client.auth.getUser()
  if (who.user?.email !== email) {
    throw new Error(`session identity mismatch: asked for ${email}, got ${who.user?.email}`)
  }

  sessions.set(email, client)
  return client
}

/** The role the browser bundle ships with. Should reach nothing in this schema. */
export function asAnon(): SupabaseClient {
  const { url, anonKey } = dbEnv()
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
