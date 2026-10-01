// Backfill script — re-run the new extraction pipeline on existing
// lecture module_items that either (a) have no extraction stored,
// (b) have the old v1 extraction without images[], or (c) have a
// partial/failed status from an earlier run.
//
// One-shot, run manually via:
//   dotenv -e .env.local -- tsx scripts/backfill-extraction.ts
//
// Safety:
//   - Reads directly from Supabase via the admin client (service role).
//   - Dry-run by default: prints what it WOULD enqueue. Pass --apply
//     to actually insert extraction_jobs rows.
//   - Kind is 'backfill-extraction' so the queue can distinguish these
//     from professor-initiated jobs (see migration).
//
// No auto-triggering from CI — always invoked by a human who just
// confirmed they want to touch the target DB.

import { createClient } from '@supabase/supabase-js'

const DRY_RUN = !process.argv.includes('--apply')
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? '50')

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required')
    process.exit(1)
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })

  console.log(`Backfill target: ${url}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}   Limit: ${LIMIT}`)

  // Pull candidate lecture items. We fetch all lectures and filter
  // client-side because the criteria (missing images[] / failed /
  // partial) can't all be expressed in one Postgres query without
  // a jsonb GIN index.
  const { data: items, error } = await admin
    .from('module_items')
    .select('id, module_id, content, created_at')
    .eq('item_type', 'lecture')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Fetch failed:', error.message)
    process.exit(1)
  }

  const candidates = (items ?? []).filter((row) => {
    const content = (row.content ?? {}) as Record<string, unknown>
    const fileType = content.fileType as string | undefined
    if (fileType !== 'pdf' && fileType !== 'ppt') return false
    if (!content.filePath) return false

    const extraction = content.extraction as
      | { status?: string; images?: unknown[] }
      | undefined
    if (!extraction) return true // never extracted
    if (extraction.status === 'failed' || extraction.status === 'partial') return true
    // Completed but has NO images array: that's the v1 drift we want
    // to backfill so students see diagrams + formulas.
    if (!Array.isArray(extraction.images)) return true
    return false
  })

  console.log(
    `Scanned ${items?.length ?? 0} lecture items; ${candidates.length} need backfill.`,
  )
  if (candidates.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const slice = candidates.slice(0, LIMIT)
  console.log(`Processing up to ${slice.length} (LIMIT=${LIMIT}).`)

  let enqueued = 0
  let skipped = 0
  for (const row of slice) {
    // Need the section id for the job payload. Resolve via the module.
    const { data: mod } = await admin
      .from('modules')
      .select('section_id')
      .eq('id', row.module_id)
      .single()
    if (!mod) {
      console.warn(`  skip ${row.id}: cannot resolve module.section_id`)
      skipped += 1
      continue
    }

    if (DRY_RUN) {
      console.log(`  WOULD enqueue  item=${row.id}  section=${mod.section_id}`)
      enqueued += 1
      continue
    }

    // Cancel any existing pending/running first so re-runs don't race.
    await admin.rpc('cancel_pending_extraction_jobs', {
      p_module_item_id: row.id,
    })

    const { error: insertError } = await admin.from('extraction_jobs').insert({
      kind: 'backfill-extraction',
      module_item_id: row.id,
      status: 'pending',
      payload: {
        sectionId: mod.section_id,
        source: 'backfill-extraction script',
      },
    })
    if (insertError) {
      console.warn(`  skip ${row.id}: insert failed — ${insertError.message}`)
      skipped += 1
      continue
    }
    enqueued += 1
    console.log(`  enqueued  item=${row.id}  section=${mod.section_id}`)
  }

  console.log(`\nDone. Enqueued: ${enqueued}  Skipped: ${skipped}`)
  if (!DRY_RUN) {
    console.log(
      '\nTrigger the worker by POST-ing to /api/extraction-worker/kick with the secret header,',
    )
    console.log(
      'or wait up to 5 minutes for the GHA sweep cron to drain the queue.',
    )
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
