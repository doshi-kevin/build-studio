// Admin Supabase client + seed-id loader. Used by specs for direct DB
// assertions (e.g. "was an announcement_reads row inserted?") and by the
// invite helper for generateLink.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  throw new Error('E2E admin client: env not set. Expected NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.test.')
}

export const admin: SupabaseClient = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

export interface SeedIds {
  generatedAt: string
  users: Record<string, string>
  department: string
  program: string
  course: string
  section: string
  enrollment: string
}

let cached: SeedIds | null = null
export function seedIds(): SeedIds {
  if (cached) return cached
  const p = path.resolve(__dirname, '..', 'fixtures', 'seed-ids.json')
  if (!fs.existsSync(p)) {
    throw new Error(`seed-ids.json not found at ${p} — run 'npm run db:seed:e2e' first.`)
  }
  cached = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return cached!
}

/** Delete a user (auth + cascade via FK) by email. Used to reset signup flows. */
export async function deleteUserByEmail(email: string): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (error) throw error
  const match = data.users.find((u) => u.email === email)
  if (!match) return
  const { error: delErr } = await admin.auth.admin.deleteUser(match.id)
  if (delErr) throw delErr
}
