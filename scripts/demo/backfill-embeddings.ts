// One-time backfill: index the demo tenant's real lecture-handout PDFs into
// Pinecone, so Athena's course-material retrieval actually returns cited
// pages during a demo instead of "insufficient context."
//
// This is deliberately NOT part of seed-demo.ts's normal run. Every module
// item id here is a deterministic UUID v5 and the course content is static
// (scripts/demo/parts/curriculum.ts), so once a page is embedded its vector
// is valid forever — re-running seed-demo.sh doesn't change the underlying
// content, and seed-demo.ts never touches Pinecone. Run this once (or again
// only if curriculum.ts's content actually changes), and every future plain
// `seed-demo.sh` run demos with retrieval already working, no repeat API
// cost, no repeat write.
//
// Reuses the REAL production ingestion code, not a hand-rolled embedder:
// src/lib/jobs/pipelines/embed-material.ts is exactly what runs when a
// professor uploads course material. Calling it directly means the
// namespace derivation, vector ids, metadata whitelist, and content class
// are all guaranteed correct because they're the same code path production
// uses (.claude/rules/vector-db.md rule 1: all Pinecone access goes through
// the one wrapper — this calls into it via the pipeline, not around it).
//
// SAFETY: this WRITES to the one shared Pinecone index used by every
// environment including production (namespace-isolated to the Northcrest
// tenant, but still a real write to shared infrastructure), and calls the
// real gemini-embedding-2 API (small but nonzero cost). Locally this
// requires PINECONE_ALLOW_NONPROD_WRITES=true for this shell — the
// deliberate gate in src/lib/pinecone/client.ts. In a real production run
// (NODE_ENV=production) no override is needed.
//
// Run via the same environment setup as seed-demo.sh:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   PINECONE_ALLOW_NONPROD_WRITES=true \
//     npx tsx --tsconfig scripts/demo/tsconfig.json scripts/demo/backfill-embeddings.ts

import { db, INSTITUTION_ID, ok, warn, log } from './parts/context'
import { embedMaterialPipeline } from '@/lib/jobs/pipelines/embed-material'
import type { PipelineContext, BackgroundJobRow } from '@/lib/jobs/types'

interface LectureItem {
  id: string
  content: { filePath?: string } | null
  modules: { section_id: string } | { section_id: string }[] | null
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║  Backfilling course-material embeddings for the demo     ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  const { data: items, error } = await db
    .from('module_items')
    .select('id, content, modules!inner(section_id, course_sections!inner(institution_id))')
    .eq('item_type', 'lecture')
    .eq('modules.course_sections.institution_id', INSTITUTION_ID)
  if (error) throw new Error(`fetch module_items: ${error.message}`)

  const withFiles = (items ?? []).filter((it) => {
    const content = it.content as { filePath?: string } | null
    return !!content?.filePath
  }) as unknown as LectureItem[]

  if (withFiles.length === 0) {
    warn('No lecture items with a real file found — run seed-demo.sh first.')
    return
  }
  log(`Found ${withFiles.length} lecture handout(s) with real PDFs to index.`)

  let embedded = 0
  let skipped = 0
  let failed = 0

  for (const item of withFiles) {
    const mod = Array.isArray(item.modules) ? item.modules[0] : item.modules
    const sectionId = mod?.section_id
    if (!sectionId) {
      warn(`module item ${item.id} has no section — skipping`)
      continue
    }

    const job: BackgroundJobRow = {
      id: `demo-backfill-${item.id}`,
      type: 'embed_material',
      params: { moduleItemId: item.id },
      status: 'running',
      progress: [],
      result: null,
      summary: null,
      error: null,
      institution_id: INSTITUTION_ID,
      section_id: sectionId,
      created_by: null,
      attempts: 1,
      max_attempts: 1,
      claimed_by: null,
      claim_expires_at: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    }
    const ctx: PipelineContext = {
      adminDb: db,
      job,
      signal: new AbortController().signal,
      reportProgress: async () => {},
    }

    try {
      const result = await embedMaterialPipeline.run({ moduleItemId: item.id }, ctx)
      const counts = result.result as { embedded: number; skipped: number; failed: number }
      embedded += counts.embedded
      skipped += counts.skipped
      failed += counts.failed
      ok(`${item.id}: ${result.summary}`)
    } catch (err) {
      failed++
      warn(`${item.id}: ${(err as Error).message}`)
    }
  }

  console.log(
    `\n\x1b[42m\x1b[30m ✓ DONE \x1b[0m  ${embedded} page(s) embedded, ${skipped} unchanged, ${failed} failed\n`,
  )
}

main().catch((err) => {
  console.error(`\n\x1b[41m\x1b[37m ✗ BACKFILL FAILED \x1b[0m ${(err as Error).message}\n`)
  process.exit(1)
})
