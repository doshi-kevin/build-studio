// Dev helper — seed the shared module/PDF fixture (scripts/dev-setup/fixtures/modules.ts)
// into an ARBITRARY local course section, for UI dev work on the student Modules page
// (list and tile view) where you need more shape than the canonical seed's one section.
//
// The canonical intern seed (seed-dev.ts) already runs this same fixture on its own
// CS101 section as part of ./scripts/dev-setup/setup-local.sh. Reach for this script only
// when you want the fixture on a DIFFERENT section (e.g. CS201, or one you made by hand).
//
// Run:
//   NEXT_PUBLIC_SUPABASE_URL=<local API URL> \
//   SUPABASE_SERVICE_ROLE_KEY=<local service_role key> \
//     npx tsx scripts/dev-setup/seed-modules-tile-fixtures.ts [sectionId]
//   (get both values from `npx supabase status`; with no sectionId it picks the local
//   section with the most enrolled students)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { seedModuleFixtures } from './fixtures/modules'

// ── Hard gate: local only (mirrors seed-dev.ts) ───────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set. See the run instructions above.')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set. See the run instructions above.')

const PROD_REF = 'ywdqaoahfmmzcsczxvxn'
if (SUPABASE_URL.includes(PROD_REF)) abort(`Target is PRODUCTION (${PROD_REF}). Refusing.`)

const isLocal =
  SUPABASE_URL.startsWith('http://127.0.0.1') || SUPABASE_URL.startsWith('http://localhost')
if (!isLocal) abort(`Target ${SUPABASE_URL} is not localhost. This dev helper only runs locally.`)

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ENROLLED = ['enrolled', 'active', 'completed']

async function main() {
  console.log('\n━━━ Seeding module fixtures for the student Modules page ━━━')

  // Which section? An explicit argument wins; otherwise the busiest one, which on a
  // standard local seed is the section every test student is enrolled in.
  const argSection = process.argv[2]
  let sectionId = argSection
  if (!sectionId) {
    const { data: enrollments, error } = await supabase
      .from('enrollments')
      .select('section_id')
      .in('status', ENROLLED)
    if (error) throw error
    const counts = new Map<string, number>()
    for (const e of enrollments ?? []) counts.set(e.section_id, (counts.get(e.section_id) ?? 0) + 1)
    sectionId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!sectionId) abort('No sections with enrolled students found. Run the local seed first.')
  }

  const { data: section, error: secErr } = await supabase
    .from('course_sections')
    .select('id, institution_id, section_code, settings, course:courses(code, title)')
    .eq('id', sectionId)
    .maybeSingle()
  if (secErr) throw secErr
  if (!section) abort(`Section ${sectionId} does not exist locally.`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const course = Array.isArray((section as any).course) ? (section as any).course[0] : (section as any).course
  console.log(`  section  ${sectionId}`)
  console.log(`  course   ${course?.code ?? '?'} — ${course?.title ?? '?'} (section ${section.section_code})`)

  /* Students only reach the page when the professor has enabled the feature, so say so
     rather than letting the reader hit a 404 and wonder which of the two things is wrong. */
  const enabled = Array.isArray((section.settings as Record<string, unknown>)?.enabledFeatures)
    ? ((section.settings as Record<string, unknown>).enabledFeatures as string[])
    : []
  if (!enabled.includes('modules')) {
    console.log(`  \x1b[33m!\x1b[0m 'modules' is NOT in this section's enabledFeatures — students will get a 404.`)
  }

  const result = await seedModuleFixtures(supabase, { sectionId, institutionId: section.institution_id })

  console.log(
    `  \x1b[32m✓\x1b[0m ${result.moduleCount} modules (${result.lockedCount} locked) · ${result.dividerCount} dividers · ${result.itemCount} items`,
  )
  console.log('\n\x1b[42m\x1b[30m ✓ DONE \x1b[0m')
  console.log(`\n  http://localhost:3000/student/courses/${sectionId}/modules`)
  console.log('  Log in as a student enrolled in THIS section (password LocalDev1234!, or your E2E_SHARED_PASSWORD).')
  console.log('  PDF rows open a real file (viewer + download work, and they take focus).')
  console.log('  Decks and notes carry no file on purpose — inert rows are a real state.')
  console.log('  Re-run any time; it replaces its own rows and leaves yours alone.\n')
}

main().catch((err) => {
  console.error('\n\x1b[41m\x1b[37m ✗ FAILED \x1b[0m', err)
  process.exit(1)
})
