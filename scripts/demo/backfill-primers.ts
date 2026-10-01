// One-time backfill: generate a real pre-class primer (script + narrated audio)
// for every lecture in the demo tenant, so the primer player actually plays
// something instead of showing the "generate" affordance.
//
// This is deliberately NOT part of seed-demo.ts's normal run, for the same
// reason as backfill-embeddings.ts: every module item id here is a
// deterministic UUID v5 and the lecture content in curriculum.ts is static,
// so once a primer is generated its audio stays valid across every future
// re-run of seed-demo.sh. Run this once (or again only if curriculum.ts's
// week topics/blurbs actually change), and every future plain seed-demo.sh
// run demos with a working primer, no repeat API cost, no repeat write.
//
// Reuses the REAL production generator, not a hand-rolled TTS call:
// src/lib/preclass-audio/generate.ts's generatePrimer() is exactly what runs
// when a student opens a lecture's primer for the first time or a professor
// pre-warms one. It resolves the lecture's own section/institution, checks
// the tenant's AI kill-switch, and does its own admin-client reads/writes —
// no PipelineContext or job row needed, simpler to call standalone than the
// embeddings pipeline was.
//
// SAFETY: this calls two real external APIs per lecture — Gemini
// (gemini-3-flash-preview, for the script) and ElevenLabs (eleven_turbo_v2_5,
// for the narration) — small but nonzero cost per lecture, same category as
// the embeddings backfill. Needs GOOGLE_GENERATIVE_AI_API_KEY and
// ELEVENLABS_API_KEY in the shell. Northcrest's AI policy has no override
// (institutions.settings has no ai-kill-switch key), so 'preclass-ai'
// resolves to the enabled default — nothing to toggle before running.
//
// Run via the same environment setup as seed-demo.sh:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   GOOGLE_GENERATIVE_AI_API_KEY=... ELEVENLABS_API_KEY=... \
//     npx tsx --tsconfig scripts/demo/tsconfig.json scripts/demo/backfill-primers.ts

import { db, INSTITUTION_ID, ok, warn, log } from './parts/context'
import { generatePrimer } from '@/lib/preclass-audio/generate'

interface LectureItem {
  id: string
  title: string
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║  Backfilling pre-class primers for the demo               ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  const { data: items, error } = await db
    .from('module_items')
    .select('id, title, modules!inner(section_id, course_sections!inner(institution_id))')
    .eq('item_type', 'lecture')
    .eq('is_visible', true)
    .eq('modules.course_sections.institution_id', INSTITUTION_ID)
  if (error) throw new Error(`fetch module_items: ${error.message}`)

  const lectures = (items ?? []) as unknown as LectureItem[]
  if (lectures.length === 0) {
    warn('No visible lecture items found — run seed-demo.sh first.')
    return
  }
  log(`Found ${lectures.length} lecture(s) to generate a primer for.`)

  let generated = 0
  let skipped = 0
  let failed = 0

  for (const item of lectures) {
    try {
      const result = await generatePrimer(item.id)
      if (!result.ok) {
        failed++
        warn(`${item.title}: ${result.error}`)
        continue
      }
      if (result.skipped) {
        skipped++
        ok(`${item.title}: already fresh, skipped`)
        continue
      }
      generated++
      ok(`${item.title}: primer generated`)
    } catch (err) {
      failed++
      warn(`${item.title}: ${(err as Error).message}`)
    }
  }

  console.log(
    `\n\x1b[42m\x1b[30m ✓ DONE \x1b[0m  ${generated} primer(s) generated, ${skipped} already fresh, ${failed} failed\n`,
  )
}

main().catch((err) => {
  console.error(`\n\x1b[41m\x1b[37m ✗ BACKFILL FAILED \x1b[0m ${(err as Error).message}\n`)
  process.exit(1)
})
