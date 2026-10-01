// One-off operational script: ends all currently-live lc_rooms in
// production by setting status='ended' and ended_at=now(). Use only
// when you're sure no real classes are mid-session — call
// list-live-rooms.ts first.

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
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('status', 'live')
    .select('id, section_id, prof_id, created_at')

  if (error) {
    console.error('Update failed:', error)
    process.exit(1)
  }

  console.log(`Ended ${data.length} room(s):`)
  for (const r of data) {
    console.log(`- ${r.id}  section=${r.section_id}  prof=${r.prof_id}  created=${r.created_at}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
