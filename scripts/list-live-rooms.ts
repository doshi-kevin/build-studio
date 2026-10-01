// One-off operational script: lists all currently-live lc_rooms in
// production so we can decide which to end. Read-only.

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
  const { data, error } = await supabase
    .from('lc_rooms')
    .select('id, section_id, prof_id, status, deck_url, deck_page_count, current_slide, created_at')
    .eq('status', 'live')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Query failed:', error)
    process.exit(1)
  }

  console.log(`Found ${data.length} live room(s):\n`)
  for (const r of data) {
    console.log(`- id=${r.id}`)
    console.log(`  section_id=${r.section_id}`)
    console.log(`  prof_id=${r.prof_id}`)
    console.log(`  created_at=${r.created_at}`)
    console.log(`  deck_url=${r.deck_url ?? '(none)'}`)
    console.log(`  deck_page_count=${r.deck_page_count ?? '(none)'}`)
    console.log(`  current_slide=${r.current_slide}\n`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
