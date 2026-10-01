// One-off script: creates 5 dummy team-chat test students in the "Scholera Dev"
// institution on the prod Supabase project. Idempotent — if a user already
// exists, the profile is upserted but the auth user is left alone.
//
// Usage:
//   npx tsx -r dotenv/config scripts/seed-dev-students.ts dotenv_config_path=.env.local

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const SCHOLERA_DEV_INSTITUTION_ID = '00000000-0000-0000-0000-000000000002'
// Read from the environment, never hardcoded: unlike its siblings this script is
// meant to run against PROD (Scholera Dev institution), so a literal here would be a
// working production credential committed to the repo. Lives in .env.local only.
const PASSWORD = process.env.TEST_TEAM_MEMBERS_PASSWORD ?? ''

const STUDENTS = [
  { email: 'emily.chen@scholera.dev', name: 'Emily Chen' },
  { email: 'marcus.johnson@scholera.dev', name: 'Marcus Johnson' },
  { email: 'priya.patel@scholera.dev', name: 'Priya Patel' },
  { email: 'alex.rodriguez@scholera.dev', name: 'Alex Rodriguez' },
  { email: 'jordan.kim@scholera.dev', name: 'Jordan Kim' },
]

function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set. Run with dotenv_config_path=.env.local')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set.')
if (!PASSWORD) abort('TEST_TEAM_MEMBERS_PASSWORD is not set. Add it to .env.local — it is deliberately not committed.')

console.log(`\n  Target: \x1b[36m${SUPABASE_URL}\x1b[0m`)
console.log(`  Institution: Scholera Dev (${SCHOLERA_DEV_INSTITUTION_ID})\n`)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function findExistingUserId(email: string): Promise<string | null> {
  // listUsers paginates; for a tiny number of expected users we can scan page 1.
  // For safety, page through up to 5 pages of 1000.
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (hit) return hit.id
    if (data.users.length < 1000) break
  }
  return null
}

async function upsertProfile(userId: string, email: string, name: string) {
  const [first_name, ...rest] = name.split(' ')
  const last_name = rest.join(' ') || null

  const { error } = await supabase.from('profiles').upsert(
    {
      id: userId,
      email,
      name,
      first_name,
      last_name,
      role: 'student',
      institution_id: SCHOLERA_DEV_INSTITUTION_ID,
      status: 'active',
      invite_status: 'active',
      onboarding_completed: true,
    },
    { onConflict: 'id' },
  )

  if (error) throw error
}

async function main() {
  let created = 0
  let existing = 0

  for (const s of STUDENTS) {
    process.stdout.write(`  • ${s.email.padEnd(40)} `)

    let userId = await findExistingUserId(s.email)

    if (userId) {
      existing++
      process.stdout.write(`\x1b[33mexists\x1b[0m  (${userId.slice(0, 8)}…)`)
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: s.email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { name: s.name },
      })
      if (error || !data.user) {
        console.log(`\n\x1b[31m✗\x1b[0m createUser failed: ${error?.message}`)
        continue
      }
      userId = data.user.id
      created++
      process.stdout.write(`\x1b[32mcreated\x1b[0m (${userId.slice(0, 8)}…)`)
    }

    try {
      await upsertProfile(userId, s.email, s.name)
      process.stdout.write(' \x1b[32m✓ profile\x1b[0m\n')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stdout.write(` \x1b[31m✗ profile: ${msg}\x1b[0m\n`)
    }
  }

  console.log(`\n  Done. created=${created} existing=${existing} total=${STUDENTS.length}\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
