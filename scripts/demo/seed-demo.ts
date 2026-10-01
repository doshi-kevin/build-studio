// Demo seed — builds a self-contained, mid-semester university for client demos.
//
// This is NOT scripts/dev-setup/seed-dev.ts. That one is the intern's local
// fixture: a thin Scholera Dev tenant that only has to be valid. This one has to
// be *convincing* — a term that is 9 weeks in, with grades, mastery trends, live
// class reports and conversations that all agree with each other.
//
// Run it through scripts/demo/seed-demo.sh, which loads the environment and
// handles the production confirmation. Read scripts/demo/CONTEXT.md first.
//
//   bash scripts/demo/seed-demo.sh              # create or refresh
//   bash scripts/demo/seed-demo.sh --reset      # delete the tenant, then rebuild

import {
  db, rowCounts, ok, warn, phase, log,
  INSTITUTION_ID, INSTITUTION_NAME, INSTITUTION_SLUG, EMAIL_DOMAIN, DEMO_PASSWORD,
  TERM_LABEL, TERM_START, TERM_END, WEEKS_IN, isLocalTarget, targetLabel, isoDate,
} from './parts/context'
import { deleteStoragePrefix } from './parts/files'
import { seedCampus } from './parts/roster'
import { seedContent } from './parts/content'
import { seedAssessments, seedFinalScores } from './parts/assessments'
import { seedCollab } from './parts/collab'
import { seedClassroom } from './parts/classroom'
import { seedAi } from './parts/ai'

const RESET = process.argv.includes('--reset')

// ── Reset ─────────────────────────────────────────────────────────────

/**
 * Delete the demo tenant and everything reachable from it.
 *
 * Order matters and follows the real foreign keys: course_sections cascade to
 * almost everything section-scoped, while institutions is RESTRICT on courses,
 * departments, programs, profiles and skills. So sections go first, then the
 * things that only reference the institution, then the people, then the tenant.
 *
 * Storage is deleted first and separately. Postgres cascades do not touch
 * Supabase Storage, so without this every reset would leave the deck and
 * materials buckets full of orphaned files.
 */
async function reset() {
  phase('Reset')
  warn(`deleting the ${INSTITUTION_NAME} tenant and every row in it`)

  const { data: sections } = await db
    .from('course_sections')
    .select('id')
    .eq('institution_id', INSTITUTION_ID)
  const sectionIds = (sections ?? []).map((s) => s.id as string)

  const { data: rooms } = sectionIds.length
    ? await db.from('lc_rooms').select('id').in('section_id', sectionIds)
    : { data: [] as { id: string }[] }

  let files = 0
  for (const room of rooms ?? []) files += await deleteStoragePrefix('live-classroom-decks', room.id as string)
  for (const id of sectionIds) files += await deleteStoragePrefix('course-materials', id)
  log(`removed ${files} storage objects`)

  const del = async (table: string, column: string, value: string | string[]) => {
    const q = db.from(table).delete()
    const { error } = Array.isArray(value) ? await q.in(column, value) : await q.eq(column, value)
    if (error) throw new Error(`delete ${table}: ${error.message}`)
  }

  if (sectionIds.length) await del('course_sections', 'institution_id', INSTITUTION_ID)
  await del('feedbacks', 'institution_id', INSTITUTION_ID)
  await del('personal_events', 'institution_id', INSTITUTION_ID)
  await del('course_skills', 'institution_id', INSTITUTION_ID)
  await del('accreditation_standards', 'institution_id', INSTITUTION_ID)
  await del('courses', 'institution_id', INSTITUTION_ID)
  await del('programs', 'institution_id', INSTITUTION_ID)

  const { data: depts } = await db.from('departments').select('id').eq('institution_id', INSTITUTION_ID)
  const deptIds = (depts ?? []).map((d) => d.id as string)
  if (deptIds.length) await del('department_faculty', 'department_id', deptIds)
  await del('departments', 'institution_id', INSTITUTION_ID)

  // Auth users go through the admin API; deleting auth.users cascades to profiles.
  const { data: profiles } = await db
    .from('profiles')
    .select('id, email')
    .eq('institution_id', INSTITUTION_ID)
  let removed = 0
  for (const p of profiles ?? []) {
    if (!String(p.email ?? '').endsWith(`@${EMAIL_DOMAIN}`)) {
      warn(`leaving ${p.email} alone — not a demo address`)
      continue
    }
    const { error } = await db.auth.admin.deleteUser(p.id as string)
    if (error) warn(`could not delete auth user ${p.email}: ${error.message}`)
    else removed++
  }
  await del('profiles', 'institution_id', INSTITUTION_ID)

  // `institutions` is ON DELETE RESTRICT from a dozen tables. Most of them are
  // cleared by the course_sections cascade above, but if any row survives, the
  // delete fails with a constraint name and no indication of which table is
  // holding it. Name the blocker instead, so a failed reset is actionable rather
  // than a puzzle.
  const RESTRICTING = [
    'course_sections', 'courses', 'departments', 'programs', 'profiles',
    'skills', 'course_skills', 'certificates', 'student_certificates',
    'certificate_challenges', 'activity_skills', 'skill_mastery',
    'skill_mastery_snapshots', 'feedbacks',
  ]
  const blockers: string[] = []
  for (const table of RESTRICTING) {
    const { count } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('institution_id', INSTITUTION_ID)
    if ((count ?? 0) > 0) blockers.push(`${table} (${count})`)
  }
  if (blockers.length > 0) {
    throw new Error(
      `cannot delete the institution — rows still reference it: ${blockers.join(', ')}. ` +
        `Delete those first, then re-run --reset.`,
    )
  }

  const { error } = await db.from('institutions').delete().eq('id', INSTITUTION_ID)
  if (error) throw new Error(`delete institution: ${error.message}`)

  ok(`removed ${sectionIds.length} sections, ${removed} accounts, and the institution row`)
}

// ── Summary ───────────────────────────────────────────────────────────

function summarise() {
  const tables = [...rowCounts.entries()].sort((a, b) => b[1] - a[1])
  const total = tables.reduce((n, [, c]) => n + c, 0)

  console.log(`\n\x1b[1m━━━ What was written ━━━\x1b[0m`)
  const width = Math.max(...tables.map(([t]) => t.length))
  for (const [table, count] of tables) {
    console.log(`  ${table.padEnd(width)}  ${String(count).padStart(6)}`)
  }
  console.log(`  ${'—'.repeat(width)}  ${'—'.repeat(6)}`)
  console.log(`  ${'total'.padEnd(width)}  ${String(total).padStart(6)}\n`)
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║  Scholera — demo university seed                         ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  log(`Target:      ${targetLabel}`)
  log(`Institution: ${INSTITUTION_NAME} (${INSTITUTION_SLUG}) — ${INSTITUTION_ID}`)
  log(`Term:        ${TERM_LABEL}, ${isoDate(TERM_START.toISOString())} to ${isoDate(TERM_END.toISOString())} (week ${WEEKS_IN})`)
  if (!isLocalTarget) warn('this is a REMOTE database')

  if (RESET) await reset()

  const campus = await seedCampus()
  const content = await seedContent(campus)
  const grades = await seedAssessments(campus, content)
  const collab = await seedCollab(campus, grades)
  // After the project is graded — it is a weighted gradebook category, so the
  // overall standing is not final until its scores exist.
  await seedFinalScores(campus)
  await seedClassroom(campus, content, grades)
  await seedAi(campus, grades, collab)

  summarise()

  console.log('\x1b[42m\x1b[30m ✓ DEMO TENANT READY \x1b[0m\n')
  console.log(`  ${INSTITUTION_NAME} · CS 340 Applied Machine Learning · ${TERM_LABEL}, week ${WEEKS_IN}`)
  console.log(`\n  Demo from \x1b[1msection A\x1b[0m — it is the one seeded to full depth.\n`)
  console.log(`  \x1b[1mLogins\x1b[0m (password for everyone: ${DEMO_PASSWORD})`)
  console.log(`    ${campus.roster.professors[0].email.padEnd(34)} professor, section A  ← start here`)
  console.log(`    ${campus.main.students[0].email.padEnd(34)} student, strong`)
  console.log(`    ${campus.main.students[9].email.padEnd(34)} student, at risk`)
  console.log(`    ${campus.roster.assistants[0].email.padEnd(34)} teaching assistant`)
  console.log(`    ${campus.roster.admin.email.padEnd(34)} institution admin`)
  console.log(`\n  Every account is firstname.lastname@${EMAIL_DOMAIN}. Full roster in the run output above.\n`)
}

main().catch((err) => {
  console.error(`\n\x1b[41m\x1b[37m ✗ DEMO SEED FAILED \x1b[0m ${(err as Error).message}\n`)
  if (process.env.DEMO_DEBUG) console.error(err)
  else console.error('  Re-run with DEMO_DEBUG=1 for the full stack trace.\n')
  process.exit(1)
})

