// Backfill script — enqueue 'backfill-concepts' jobs for legacy lecture
// module_items that have a completed extraction but no stored quiz concepts
// (module_items.content.concepts, design §11a). The worker then runs ONE
// cheap concept-extraction LLM call per item over the already-stored pages —
// no re-download, no re-parse, no vision — so multi-file quiz generation can
// plan from ~all concepts instead of the runtime 20-concept extraction ceiling
// (tmp/quiz-cost-optimization/benchmark/REPORT.md §11a / REPORT-gated.md).
//
// One-shot, run manually via:
//   dotenv -e .env.local -- tsx scripts/backfill-concepts.ts
//
// Safety:
//   - Reads directly from Supabase via the admin client (service role).
//   - Dry-run by default: prints what it WOULD enqueue. Pass --apply
//     to actually insert extraction_jobs rows.
//   - Items with a pending/running extraction job are SKIPPED (never
//     superseded) — a professor's in-flight upload wins; re-run the script
//     later for those. The worker is also idempotent: items that gained
//     concepts since the scan complete as no-ops.
//
// No auto-triggering from CI — always invoked by a human who just
// confirmed they want to touch the target DB.

import { createClient } from '@supabase/supabase-js'

const DRY_RUN = !process.argv.includes('--apply')
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? '200')
/** Keep in sync with CONCEPT_MIN_CONCEPTS (src/lib/ai/llm-client.ts) — the
 *  bar both the worker and quiz generation apply to a stored list. */
const MIN_CONCEPTS = 3

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

  // Pull candidate lecture items with their section id in one query (no N+1).
  // Criteria (completed extraction, missing/thin concepts) are jsonb-shaped,
  // so filter client-side like the sibling backfill-extraction script.
  const { data: items, error } = await admin
    .from('module_items')
    .select('id, content, created_at, modules!inner(section_id)')
    .eq('item_type', 'lecture')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Fetch failed:', error.message)
    process.exit(1)
  }

  const candidates = (items ?? []).flatMap((row) => {
    const content = (row.content ?? {}) as Record<string, unknown>
    const extraction = content.extraction as { status?: string; pages?: unknown[] } | undefined
    // Needs a completed/partial extraction with pages — anything else is a
    // job for backfill-extraction, not this script.
    if (!extraction || (extraction.status !== 'completed' && extraction.status !== 'partial')) return []
    if (!Array.isArray(extraction.pages) || extraction.pages.length === 0) return []
    // Already has a usable stored list → nothing to do.
    const concepts = content.concepts
    if (Array.isArray(concepts) && concepts.length >= MIN_CONCEPTS) return []
    const mod = Array.isArray(row.modules) ? row.modules[0] : row.modules
    const sectionId = (mod as { section_id?: string } | null)?.section_id
    if (!sectionId) return []
    return [{ id: row.id as string, sectionId }]
  })

  console.log(`Scanned ${items?.length ?? 0} lecture items; ${candidates.length} need concept backfill.`)
  if (candidates.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const slice = candidates.slice(0, LIMIT)

  // Skip anything with an in-flight extraction job — the fresh extraction will
  // store its own concepts, and racing it risks writing stale ones.
  const { data: activeJobs, error: jobsError } = await admin
    .from('extraction_jobs')
    .select('module_item_id')
    .in('module_item_id', slice.map((c) => c.id))
    .in('status', ['pending', 'running'])
  if (jobsError) {
    console.error('Active-jobs check failed:', jobsError.message)
    process.exit(1)
  }
  const busy = new Set((activeJobs ?? []).map((j) => j.module_item_id as string))
  const toEnqueue = slice.filter((c) => !busy.has(c.id))
  const skippedBusy = slice.length - toEnqueue.length
  if (skippedBusy > 0) console.log(`Skipping ${skippedBusy} item(s) with an in-flight extraction job.`)

  if (DRY_RUN) {
    for (const c of toEnqueue) console.log(`  WOULD enqueue  item=${c.id}  section=${c.sectionId}`)
    console.log(`\nDry run done. Would enqueue: ${toEnqueue.length}. Pass --apply to insert.`)
    return
  }

  const { error: insertError } = await admin.from('extraction_jobs').insert(
    toEnqueue.map((c) => ({
      kind: 'backfill-concepts',
      module_item_id: c.id,
      status: 'pending',
      payload: { sectionId: c.sectionId, source: 'backfill-concepts script' },
    })),
  )
  if (insertError) {
    console.error('Bulk insert failed:', insertError.message)
    process.exit(1)
  }

  console.log(`\nDone. Enqueued: ${toEnqueue.length}  Skipped (busy): ${skippedBusy}`)
  console.log('\nTrigger the worker by POST-ing to /api/extraction-worker/kick with the secret header,')
  console.log('or wait up to 5 minutes for the GHA sweep cron to drain the queue.')
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
