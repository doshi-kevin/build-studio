// One-off operational script: applies migration 59 to production by
// updating the live-classroom-decks bucket file_size_limit to 250 MB.
// Equivalent to running supabase/migrations/00000000000059_lc_decks_bucket_size.sql
// against the prod Supabase project. Use only after the migration file
// is committed; safe to re-run (idempotent UPDATE).

import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  // Read current value first. .schema() goes before .from() in supabase-js.
  const before = await supabase
    .schema('storage')
    .from('buckets')
    .select('id, file_size_limit')
    .eq('id', 'live-classroom-decks')
    .single()

  console.log('Before:', before.data ?? before.error)

  // Apply update
  const target = 262144000 // 250 MiB
  const { data, error } = await supabase
    .schema('storage')
    .from('buckets')
    .update({ file_size_limit: target })
    .eq('id', 'live-classroom-decks')
    .select('id, file_size_limit')

  if (error) {
    console.error('Update failed:', error)
    process.exit(1)
  }

  console.log('After:', data)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
