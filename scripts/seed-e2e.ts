// Seed script for Playwright E2E tests. Creates 4 deterministic users
// (admin, professor, student-enrolled, student-new), one department,
// program, course, section, and enrollment, then writes UUIDs to
// e2e/fixtures/seed-ids.json. Idempotent — re-running does not duplicate.
//
// Hard-gated against non-local Supabase URLs. Will exit(1) with a red banner
// if NEXT_PUBLIC_SUPABASE_URL does not point at 127.0.0.1 or localhost.
//
// Usage:
//   npm run db:seed:e2e              # create users + data, skip reset
//   npm run db:seed:e2e -- --reset   # DESTRUCTIVE: supabase db reset first
//
// Reads env from .env.test (via dotenv-cli in the npm script).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { v5 as uuidv5 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

// ── Hard gate: refuse to run against non-local Supabase ───────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ SEED ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set. Source .env.test.')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set. Source .env.test.')

const isLocal =
  SUPABASE_URL.startsWith('http://127.0.0.1') ||
  SUPABASE_URL.startsWith('http://localhost')
if (!isLocal) {
  abort(
    `NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL} is not local. ` +
      `E2E seed refuses to run against anything other than 127.0.0.1 or localhost.`,
  )
}

// ── Args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const doReset = args.includes('--reset')

// ── Supabase admin client ──────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Deterministic UUIDs ────────────────────────────────────────────────
// Namespaced so E2E entities never collide with real UUIDs from other sources.
const NS = uuidv5('scholera-e2e-seed', uuidv5.DNS)
const det = (key: string) => uuidv5(key, NS)

const IDS = {
  institution: det('institution'),
  department: det('department'),
  program: det('program'),
  course: det('course'),
  section: det('section'),
  enrollment: det('enrollment'),
}

// User IDs are assigned by Supabase Auth — captured at create time, not derived.
const USERS = [
  { email: 'e2e-admin@scholera.test', role: 'institution_admin', firstName: 'E2E', lastName: 'Admin' },
  { email: 'e2e-professor@scholera.test', role: 'professor', firstName: 'E2E', lastName: 'Professor' },
  { email: 'e2e-student-enrolled@scholera.test', role: 'student', firstName: 'E2E', lastName: 'StudentEnrolled' },
  { email: 'e2e-student-new@scholera.test', role: 'student', firstName: 'E2E', lastName: 'StudentNew' },
] as const
const SHARED_PASSWORD = 'e2e-password-123'

// ── Logging ────────────────────────────────────────────────────────────
const log = (msg: string) => console.log(`  ${msg}`)
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const warn = (msg: string) => console.log(`  \x1b[33m⚠\x1b[0m ${msg}`)
const phase = (msg: string) => console.log(`\n━━━ ${msg} ━━━`)

// ── Supabase reset (gated) ─────────────────────────────────────────────
function resetSupabase() {
  phase('Supabase db reset (destructive)')
  try {
    execSync('supabase db reset', { stdio: 'inherit' })
    ok('Reset complete')
  } catch (e) {
    abort(`supabase db reset failed: ${(e as Error).message}`)
  }
}

// ── User creation ──────────────────────────────────────────────────────
async function ensureUser(
  email: string,
  role: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  // Look for existing user first — listUsers is paginated; a dozen users fit in page 1.
  const { data: existing, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  })
  if (listErr) throw listErr
  const match = existing.users.find((u) => u.email === email)

  let userId: string
  if (match) {
    userId = match.id
    log(`user ${email} already exists → ${userId}`)
    // Reset password to known value + clear any lingering setup flag
    await supabase.auth.admin.updateUserById(userId, {
      password: SHARED_PASSWORD,
      email_confirm: true,
      app_metadata: { ...(match.app_metadata ?? {}), requires_password_set: false },
      user_metadata: { ...(match.user_metadata ?? {}), password_set: true },
    })
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: SHARED_PASSWORD,
      email_confirm: true,
      app_metadata: { requires_password_set: false },
      user_metadata: { password_set: true, name: `${firstName} ${lastName}` },
    })
    if (error || !data.user) throw error ?? new Error('createUser returned no user')
    userId = data.user.id
    ok(`created ${email} → ${userId}`)
  }

  // Upsert profile row directly — the handle_new_user trigger may not fire
  // (CLAUDE.md calls this out as a known gotcha).
  const { error: profErr } = await supabase
    .from('profiles')
    .upsert(
      {
        id: userId,
        email,
        first_name: firstName,
        last_name: lastName,
        name: `${firstName} ${lastName}`,
        role,
        institution_id: IDS.institution,
        status: 'active',
        onboarding_completed: true,
        invite_status: 'accepted',
      },
      { onConflict: 'id' },
    )
  if (profErr) throw profErr

  return userId
}

// ── Reference-data seeding ─────────────────────────────────────────────
async function seedReferenceData(professorId: string) {
  phase('Reference data (institution / dept / program / course / section)')

  /* The tenant every other row hangs off. profiles.institution_id is required by the
     institution_id_required_for_non_super_admin CHECK, and departments/programs/courses/
     course_sections all have it NOT NULL, so without this the seed cannot insert anything. */
  const { error: instErr } = await supabase.from('institutions').upsert(
    { id: IDS.institution, name: 'E2E Test University', slug: 'e2e-test-university', status: 'active' },
    { onConflict: 'id' },
  )
  if (instErr) throw instErr
  ok('institution')

  const { error: deptErr } = await supabase.from('departments').upsert(
    {
      id: IDS.department,
      institution_id: IDS.institution,
      code: 'E2E',
      name: 'E2E Test Department',
      status: 'active',
    },
    { onConflict: 'id' },
  )
  if (deptErr) throw deptErr
  ok('department')

  const { error: progErr } = await supabase.from('programs').upsert(
    {
      id: IDS.program,
      institution_id: IDS.institution,
      code: 'E2EBS',
      name: 'E2E Test Program',
      department_id: IDS.department,
      degree_type: 'bachelor',
      duration_semesters: 8,
    },
    { onConflict: 'id' },
  )
  if (progErr) throw progErr
  ok('program')

  const { error: courseErr } = await supabase.from('courses').upsert(
    {
      id: IDS.course,
      institution_id: IDS.institution,
      code: 'E2E101',
      title: 'E2E Test Course',
      department_id: IDS.department,
      credits: 3,
      status: 'active',
    },
    { onConflict: 'id' },
  )
  if (courseErr) throw courseErr
  ok('course')

  // enabledFeatures unlocks the per-section sidebar links + gates student
  // access. Quizzes must be on here so the quiz-lifecycle spec can navigate
  // to /student/courses/[sectionId]/quizzes; the others are bundled so new
  // E2E specs for those features don't need a seed change.
  const { error: secErr } = await supabase.from('course_sections').upsert(
    {
      id: IDS.section,
      institution_id: IDS.institution,
      course_id: IDS.course,
      professor_id: professorId,
      section_code: 'A',
      semester: 'spring',
      year: 2026,
      status: 'active',
      max_students: 30,
      settings: {
        enabledFeatures: [
          'announcements',
          'modules',
          'assignments',
          'grades',
          'enrollment',
          'roadmap',
          'quizzes',
          'projects',
          'classroom',
        ],
      },
    },
    { onConflict: 'id' },
  )
  if (secErr) throw secErr
  ok('section')
}

async function seedEnrollment(studentId: string) {
  phase('Enrollment (student-enrolled → section)')
  const { error } = await supabase.from('enrollments').upsert(
    {
      id: IDS.enrollment,
      student_id: studentId,
      section_id: IDS.section,
      status: 'enrolled',
      enrolled_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )
  if (error) throw error
  ok('enrollment')
}

// ── Fixture output ─────────────────────────────────────────────────────
interface SeedIds {
  generatedAt: string
  users: Record<string, string>
  department: string
  program: string
  course: string
  section: string
  enrollment: string
}

function writeFixture(userIdByEmail: Record<string, string>) {
  const out: SeedIds = {
    generatedAt: new Date().toISOString(),
    users: userIdByEmail,
    department: IDS.department,
    program: IDS.program,
    course: IDS.course,
    section: IDS.section,
    enrollment: IDS.enrollment,
  }
  const fixturePath = path.join(__dirname, '..', 'e2e', 'fixtures', 'seed-ids.json')
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(fixturePath, JSON.stringify(out, null, 2))
  ok(`wrote ${fixturePath}`)
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  Scholera E2E Seed                           ║')
  console.log('╚══════════════════════════════════════════════╝')
  log(`Target: ${SUPABASE_URL}`)
  log(`Reset: ${doReset ? 'YES (destructive)' : 'no'}`)

  if (doReset) resetSupabase()

  phase('Users')
  const userIdByEmail: Record<string, string> = {}
  for (const u of USERS) {
    const id = await ensureUser(u.email, u.role, u.firstName, u.lastName)
    userIdByEmail[u.email] = id
  }

  const professorId = userIdByEmail['e2e-professor@scholera.test']
  const studentEnrolledId = userIdByEmail['e2e-student-enrolled@scholera.test']

  await seedReferenceData(professorId)
  await seedEnrollment(studentEnrolledId)

  phase('Fixtures')
  writeFixture(userIdByEmail)

  console.log('\n\x1b[42m\x1b[30m ✓ SEED COMPLETE \x1b[0m\n')
}

main().catch((err) => {
  console.error('\n\x1b[41m\x1b[37m ✗ SEED FAILED \x1b[0m', err)
  process.exit(1)
})
