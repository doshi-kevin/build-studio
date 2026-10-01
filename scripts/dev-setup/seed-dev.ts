// Dev seed for interns. Populates a LOCAL Supabase with realistic dummy data
// under the existing "Scholera Dev" institution (00000000-0000-0000-0000-000000000002,
// seeded by migration 20). Creates a department, program, 1 professor + 1 admin +
// 6 students, 2 courses/sections, enrollments, quizzes (questions + attempts +
// answers), modules (with real multi-page PDFs — see fixtures/modules.ts and
// fixtures/pdf.ts), assignments (with real file submissions), projects (with teams),
// skills (with class medians and per-student mastery trend), Athena memory preferences
// (professor + student), and announcements — enough to populate the professor and
// student dashboards, grades, modules, assignments, projects, skills, memory, and quiz
// pages.
//
// Idempotent — re-running upserts by deterministic UUID and does not duplicate.
//
// Hard-gated by target. It runs ONLY against:
//   - localhost / 127.0.0.1 (the intern default), OR
//   - an explicitly confirmed remote project: SEED_CONFIRM_REF must be set AND
//     equal the project ref parsed from NEXT_PUBLIC_SUPABASE_URL (used to seed
//     the hosted staging project — see scripts/dev-setup/CONTEXT.md).
// The PRODUCTION ref is blocked unconditionally, so the seed can never write to
// prod even if every other guard is misconfigured.
//
// Locally you do NOT run this directly — run ./scripts/dev-setup/setup-local.sh,
// which db-resets first (schema from migrations) and then invokes this with the
// local stack's env vars. Read scripts/dev-setup/CONTEXT.md first.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { v5 as uuidv5 } from 'uuid'
import { seedModuleFixtures } from './fixtures/modules'
import { generateLectureNotes } from './fixtures/pdf'

// ── Hard gate: refuse to run against non-local Supabase ───────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ SEED ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set. Run via setup-local.sh.')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set. Run via setup-local.sh.')

// The production project ref is blocked unconditionally — no env var or flag can
// override this. It is the last line of defense against ever seeding prod.
const PROD_REF = 'ywdqaoahfmmzcsczxvxn'
if (SUPABASE_URL.includes(PROD_REF)) {
  abort(
    `Target is the PRODUCTION project (${PROD_REF}). The dev seed never runs against production.`,
  )
}

const isLocal =
  SUPABASE_URL.startsWith('http://127.0.0.1') ||
  SUPABASE_URL.startsWith('http://localhost')

if (!isLocal) {
  // Remote target (e.g. the hosted staging project). Require an explicit
  // confirmation that matches the target's own project ref — an allowlist, so
  // adding a new environment can never silently re-enable an old/wrong target.
  const targetRef = SUPABASE_URL.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? ''
  const confirmRef = process.env.SEED_CONFIRM_REF ?? ''
  if (!targetRef) {
    abort(`Could not parse a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}.`)
  }
  if (confirmRef !== targetRef) {
    abort(
      `Remote seeding requires explicit confirmation. To seed this project, set ` +
        `SEED_CONFIRM_REF=${targetRef} (got SEED_CONFIRM_REF="${confirmRef}").`,
    )
  }
}

// ── Constants ─────────────────────────────────────────────────────────
// Scholera Dev institution. A fresh local `db reset` does NOT create it, so the
// seed creates it itself (idempotent upsert) — see seedInstitution().
const INSTITUTION_ID = '00000000-0000-0000-0000-000000000002'
/* Deliberately NOT the production Scholera Dev password. This script is local-only
 * (it aborts on the prod ref below), but the literal is committed — and until this
 * changed it published a working production credential to anyone with repo read
 * access, which is the exact exposure the .env.example redaction closed. Override
 * with E2E_SHARED_PASSWORD if your local stack was seeded with something else. */
const SHARED_PASSWORD = process.env.E2E_SHARED_PASSWORD ?? 'LocalDev1234!'

// ── Semester timeline ─────────────────────────────────────────────────
// Every course-content date is relative to WHEN THE SEED RUNS, not a fixed calendar
// date. A hardcoded "due Feb 1" reads as broken the moment it's actually September —
// a professor opened this seed once and found a submission that had supposedly been
// "waiting to grade" for 220 days. The semester "starts" 6 weeks before today and runs
// long enough to cover the module fixture's Week 9 final review, so today always lands
// mid-semester: weeks already covered are graded/available, weeks ahead are still locked.
const DAY_MS = 86_400_000
const SEMESTER_START_MS = Date.now() - 42 * DAY_MS
const daysFromStart = (n: number) => new Date(SEMESTER_START_MS + n * DAY_MS).toISOString()

// ── Supabase admin client ─────────────────────────────────────────────
// Untyped client, matching scripts/seed-e2e.ts. (The generated Database type in
// src/lib/supabase/types.ts is stale — it predates the institutions table — so
// typing against it produces false errors. Column correctness here is instead
// verified against the live schema; see CONTEXT.md.)
const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Deterministic UUIDs ───────────────────────────────────────────────
// Namespaced so dev entities never collide with real UUIDs from other sources.
const NS = uuidv5('scholera-dev-seed', uuidv5.DNS)
const det = (key: string) => uuidv5(key, NS)

// ── Logging ───────────────────────────────────────────────────────────
const log = (msg: string) => console.log(`  ${msg}`)
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const phase = (msg: string) => console.log(`\n━━━ ${msg} ━━━`)

// ── Users ─────────────────────────────────────────────────────────────
const USERS = [
  { email: 'admin@scholera.dev', role: 'institution_admin', firstName: 'Dana', lastName: 'Admin' },
  { email: 'professor@scholera.dev', role: 'professor', firstName: 'Paula', lastName: 'Professor' },
  { email: 'student1@scholera.dev', role: 'student', firstName: 'Emily', lastName: 'Chen' },
  { email: 'student2@scholera.dev', role: 'student', firstName: 'Marcus', lastName: 'Johnson' },
  { email: 'student3@scholera.dev', role: 'student', firstName: 'Priya', lastName: 'Patel' },
  { email: 'student4@scholera.dev', role: 'student', firstName: 'Alex', lastName: 'Rodriguez' },
  { email: 'student5@scholera.dev', role: 'student', firstName: 'Jordan', lastName: 'Kim' },
  { email: 'student6@scholera.dev', role: 'student', firstName: 'Sam', lastName: 'Nguyen' },
] as const

// Creates the auth user (or reuses an existing one), resets its password to the
// shared dev password, and upserts the matching profile row. Mirrors the proven
// pattern in scripts/seed-e2e.ts. Returns the user id.
async function ensureUser(
  email: string,
  role: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  const { data: existing, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  })
  if (listErr) throw listErr
  const match = existing.users.find((u) => u.email === email)

  let userId: string
  if (match) {
    userId = match.id
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
  }

  // Upsert profile directly — the handle_new_user trigger may not fire (CLAUDE.md gotcha).
  // institution_id set explicitly per the multi-tenant rule.
  const { error: profErr } = await supabase.from('profiles').upsert(
    {
      id: userId,
      email,
      first_name: firstName,
      last_name: lastName,
      name: `${firstName} ${lastName}`,
      role,
      institution_id: INSTITUTION_ID,
      status: 'active',
      onboarding_completed: true,
      invite_status: 'accepted',
    },
    { onConflict: 'id' },
  )
  if (profErr) throw profErr

  return userId
}

// ── Institution ───────────────────────────────────────────────────────
// Self-contained: create the Scholera Dev tenant so the seed works on any
// fresh local db reset, without depending on a migration to seed it.
async function seedInstitution() {
  phase('Institution')
  const { error } = await supabase.from('institutions').upsert(
    { id: INSTITUTION_ID, name: 'Scholera Dev', slug: 'dev' },
    { onConflict: 'id' },
  )
  if (error) throw error
  ok('institution: Scholera Dev')
}

// ── Storage buckets ───────────────────────────────────────────────────
// Two buckets the app uploads to are NOT created by any migration: they were
// made by hand in the prod Storage dashboard, and the migrations only ever
// flip them private + attach RLS policies (course-materials → mig 48,
// proctoring-snapshots → mig 47). So a fresh `db reset` leaves them missing
// and every upload fails with "Bucket not found". We recreate them here to
// match prod. (chat-attachments and live-classroom-decks ARE created by
// migrations 25 and 30, so they need no help.) Idempotent: update if present,
// create if not.
const REQUIRED_BUCKETS = [
  // Module items / lecture materials / formula sheets. Private (mig 48); 50 MB
  // cap matches MAX_FILE_SIZE in src/lib/supabase/storage.ts.
  { id: 'course-materials', public: false, fileSizeLimit: 52428800, allowedMimeTypes: null },
  // Exam webcam snapshots. Private (mig 47); images only, no explicit size cap.
  { id: 'proctoring-snapshots', public: false, fileSizeLimit: null, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
]

async function seedBuckets() {
  phase('Storage buckets')
  for (const b of REQUIRED_BUCKETS) {
    const opts = { public: b.public, fileSizeLimit: b.fileSizeLimit ?? undefined, allowedMimeTypes: b.allowedMimeTypes ?? undefined }
    const { data: existing } = await supabase.storage.getBucket(b.id)
    const { error } = existing
      ? await supabase.storage.updateBucket(b.id, opts)
      : await supabase.storage.createBucket(b.id, opts)
    if (error) throw error
    ok(`bucket: ${b.id}${existing ? ' (updated)' : ' (created)'}`)
  }
}

// ── Reference data: department, program, courses, sections ─────────────
// institution_id is set explicitly everywhere (the auto-fill triggers exist but
// we don't rely on them — multi-tenant writes must include institution_id).
async function seedReferenceData(professorId: string) {
  phase('Reference data (department / program / courses / sections)')

  const departmentId = det('department')
  const { error: deptErr } = await supabase.from('departments').upsert(
    { id: departmentId, code: 'CS', name: 'Computer Science', institution_id: INSTITUTION_ID, status: 'active' },
    { onConflict: 'id' },
  )
  if (deptErr) throw deptErr
  ok('department: Computer Science')

  const { error: progErr } = await supabase.from('programs').upsert(
    {
      id: det('program'),
      code: 'CSBS',
      name: 'BS in Computer Science',
      department_id: departmentId,
      degree_type: 'bachelor',
      duration_semesters: 8,
      institution_id: INSTITUTION_ID,
    },
    { onConflict: 'id' },
  )
  if (progErr) throw progErr
  ok('program: BS in Computer Science')

  const courses = [
    { key: 'course-101', code: 'CS101', title: 'Intro to Programming' },
    { key: 'course-201', code: 'CS201', title: 'Data Structures' },
  ]
  const enabledFeatures = [
    'announcements', 'modules', 'assignments', 'grades',
    'enrollment', 'roadmap', 'quizzes', 'projects', 'live-classroom',
  ]

  const sectionIds: string[] = []
  for (const c of courses) {
    const courseId = det(c.key)
    const { error: courseErr } = await supabase.from('courses').upsert(
      {
        id: courseId,
        code: c.code,
        title: c.title,
        department_id: departmentId,
        institution_id: INSTITUTION_ID,
        credits: 3,
        status: 'active',
      },
      { onConflict: 'id' },
    )
    if (courseErr) throw courseErr

    const sectionId = det(`${c.key}-section`)
    const { error: secErr } = await supabase.from('course_sections').upsert(
      {
        id: sectionId,
        course_id: courseId,
        professor_id: professorId,
        institution_id: INSTITUTION_ID,
        section_code: 'A',
        semester: 'spring',
        year: 2026,
        status: 'active',
        max_students: 30,
        settings: { enabledFeatures },
      },
      { onConflict: 'id' },
    )
    if (secErr) throw secErr
    sectionIds.push(sectionId)
    ok(`course + section: ${c.code}`)
  }

  return sectionIds
}

// ── Enrollments ───────────────────────────────────────────────────────
// All students into section 1; first three also into section 2.
async function seedEnrollments(studentIds: string[], sectionIds: string[]) {
  phase('Enrollments')
  const rows: Array<{ id: string; student_id: string; section_id: string; status: string; enrolled_at: string }> = []
  const enrolledAt = daysFromStart(0)

  for (const studentId of studentIds) {
    rows.push({
      id: det(`enroll-${studentId}-${sectionIds[0]}`),
      student_id: studentId,
      section_id: sectionIds[0],
      status: 'enrolled',
      enrolled_at: enrolledAt,
    })
  }
  for (const studentId of studentIds.slice(0, 3)) {
    rows.push({
      id: det(`enroll-${studentId}-${sectionIds[1]}`),
      student_id: studentId,
      section_id: sectionIds[1],
      status: 'enrolled',
      enrolled_at: enrolledAt,
    })
  }

  const { error } = await supabase.from('enrollments').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  ok(`${rows.length} enrollments`)
}

// ── Modules (real PDF-backed course content) ────────────────────────────
// Fixture data + insert logic live in fixtures/modules.ts, shared with the standalone
// scripts/dev-setup/seed-modules-tile-fixtures.ts (which targets an arbitrary section
// for UI dev work). Here it always targets section 1 (CS101).
async function seedModules(sectionId: string) {
  phase('Modules')
  const result = await seedModuleFixtures(supabase, { sectionId, institutionId: INSTITUTION_ID })
  ok(`${result.moduleCount} modules (${result.lockedCount} locked) · ${result.dividerCount} dividers · ${result.itemCount} items, incl. 1 real uploaded PDF`)
}

// ── Assignments (with real file submissions) ────────────────────────────
// The same real, multi-page lecture-notes PDF used in the module fixture, reused across
// submitting students (nothing in the read path cares which student "wrote" a shared
// test object). Uploaded to the assignment-submissions bucket, which migrations already
// create locally — unlike course-materials/proctoring-snapshots, it needs no help from
// seedBuckets().
const SAMPLE_SUBMISSION_PATH = 'dev-fixtures/homework1/sample-submission.pdf'
const SUBMISSIONS_BUCKET = 'assignment-submissions'

async function seedAssignments(professorId: string, studentIds: string[], sectionId: string) {
  phase('Assignments')

  const hw1Id = det('assignment-hw1')
  const { error: hw1Err } = await supabase.from('assignments').upsert(
    {
      id: hw1Id,
      section_id: sectionId,
      institution_id: INSTITUTION_ID,
      created_by: professorId,
      title: 'Homework 1: Warm-up Exercises',
      description: 'Short exercises covering the material from Weeks 1-2.',
      submission_type: 'files',
      status: 'published',
      points: 20,
      due_at: daysFromStart(28),
      published_at: daysFromStart(11),
    },
    { onConflict: 'id' },
  )
  if (hw1Err) throw hw1Err

  const hw2Id = det('assignment-hw2-draft')
  const { error: hw2Err } = await supabase.from('assignments').upsert(
    {
      id: hw2Id,
      section_id: sectionId,
      institution_id: INSTITUTION_ID,
      created_by: professorId,
      title: 'Homework 2: Recursion Practice',
      description: 'Work in progress.',
      submission_type: 'code',
      status: 'draft',
    },
    { onConflict: 'id' },
  )
  if (hw2Err) throw hw2Err
  ok('2 assignments (1 published + 1 draft)')

  const { bytes: pdfBytes } = generateLectureNotes()
  const { error: upErr } = await supabase.storage
    .from(SUBMISSIONS_BUCKET)
    .upload(SAMPLE_SUBMISSION_PATH, pdfBytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) throw upErr

  const fileFor = (name: string) => [{ path: SAMPLE_SUBMISSION_PATH, name, size: pdfBytes.length, type: 'application/pdf' }]

  // First three students submit: two graded (so the gradebook has scores), one still
  // 'submitted' (so the professor's grading queue has something in it). The other three
  // students submit nothing — a realistic "hasn't turned it in" state.
  const submissions = [
    {
      studentId: studentIds[0],
      status: 'graded',
      score: 18,
      feedback: 'Good work overall — minor style issues in exercise 3.',
      graded: true,
    },
    {
      studentId: studentIds[1],
      status: 'graded',
      score: 15,
      feedback: 'Exercise 2 has a logic error; see inline comments.',
      graded: true,
    },
    { studentId: studentIds[2], status: 'submitted', score: null, feedback: '', graded: false },
  ]

  const rows = submissions.map((s) => ({
    id: det(`hw1-submission-${s.studentId}`),
    assignment_id: hw1Id,
    student_id: s.studentId,
    institution_id: INSTITUTION_ID,
    status: s.status,
    files: fileFor(`homework1-${s.studentId.slice(0, 8)}.pdf`),
    score: s.score,
    feedback: s.feedback,
    graded_by: s.graded ? professorId : null,
    graded_at: s.graded ? daysFromStart(32) : null,
    submitted_at: daysFromStart(27),
  }))
  const { error: subErr } = await supabase.from('assignment_submissions').upsert(rows, { onConflict: 'id' })
  if (subErr) throw subErr
  ok(`${rows.length} submissions (2 graded, 1 awaiting grading)`)
}

// ── Projects (with teams) ────────────────────────────────────────────────
// projects / project_teams / project_members carry no institution_id column of their
// own — tenancy flows through section_id (verified against the live local schema).
async function seedProjects(professorId: string, studentIds: string[], sectionId: string) {
  phase('Projects')

  const projectId = det('project-capstone')
  const { error: projErr } = await supabase.from('projects').upsert(
    {
      id: projectId,
      section_id: sectionId,
      created_by: professorId,
      title: 'Course Capstone Project',
      description: 'Build and present a small end-to-end project applying the semester\'s material.',
      status: 'active',
      visibility: 'course',
      max_team_size: 4,
    },
    { onConflict: 'id' },
  )
  if (projErr) throw projErr

  const teamAlphaId = det('team-alpha')
  const teamBetaId = det('team-beta')
  const { error: teamErr } = await supabase.from('project_teams').upsert(
    [
      { id: teamAlphaId, project_id: projectId, created_by: studentIds[0], name: 'Team Alpha', status: 'active' },
      { id: teamBetaId, project_id: projectId, created_by: studentIds[3], name: 'Team Beta', status: 'active' },
    ],
    { onConflict: 'id' },
  )
  if (teamErr) throw teamErr

  // student[5] is left off every team — the realistic "hasn't joined a team yet" state.
  const memberRows = [
    { studentId: studentIds[0], teamId: teamAlphaId, role: 'owner' },
    { studentId: studentIds[1], teamId: teamAlphaId, role: 'member' },
    { studentId: studentIds[2], teamId: teamAlphaId, role: 'member' },
    { studentId: studentIds[3], teamId: teamBetaId, role: 'owner' },
    { studentId: studentIds[4], teamId: teamBetaId, role: 'member' },
  ].map((m) => ({
    id: det(`project-member-${m.studentId}`),
    project_id: projectId,
    team_id: m.teamId,
    user_id: m.studentId,
    role: m.role,
  }))
  const { error: memErr } = await supabase.from('project_members').upsert(memberRows, { onConflict: 'id' })
  if (memErr) throw memErr

  ok(`1 project · 2 teams · ${memberRows.length} members (1 student unassigned)`)
}

// ── Quizzes (question bank + assignments + attempts + answers) ─────────
// Schema notes (verified against prod):
//   - quiz_questions is a SECTION-level bank: no quiz_id / order_index on it.
//   - quiz_question_assignments links a question to a quiz (quiz_id, question_id, order_index).
//   - content jsonb shapes:
//       multiple_choice: { choices: [{id,text,isCorrect}], questionType, allowMultiple }
//       true_false:      { correctAnswer: boolean, questionType }
//   - quiz_answers stores MC picks as selected_choice_ids (uuid[]) and TF as boolean_answer.
type SeedQuestion =
  | {
      key: string
      kind: 'multiple_choice'
      question_text: string
      choices: { text: string; correct: boolean }[]
      points: number
    }
  | {
      key: string
      kind: 'true_false'
      question_text: string
      correctAnswer: boolean
      points: number
    }

// Deterministic choice ids for a multiple-choice question, so re-runs are stable
// and answers can reference the exact correct/incorrect choice id.
function choiceId(qKey: string, i: number) {
  return det(`${qKey}-choice-${i}`)
}

function questionContent(q: SeedQuestion) {
  if (q.kind === 'multiple_choice') {
    return {
      questionType: 'multiple_choice',
      allowMultiple: false,
      choices: q.choices.map((c, i) => ({ id: choiceId(q.key, i), text: c.text, isCorrect: c.correct })),
    }
  }
  return { questionType: 'true_false', correctAnswer: q.correctAnswer }
}

// Builds a quiz_answers row for a student answering question `q` correctly or not.
function answerRow(
  q: SeedQuestion,
  studentId: string,
  attemptId: string,
  correct: boolean,
): Record<string, unknown> {
  const base = {
    id: det(`answer-${attemptId}-${q.key}`),
    attempt_id: attemptId,
    question_id: det(q.key),
    is_correct: correct,
    earned_points: correct ? q.points : 0,
  }
  if (q.kind === 'multiple_choice') {
    const correctIdx = q.choices.findIndex((c) => c.correct)
    const wrongIdx = q.choices.findIndex((c) => !c.correct)
    return { ...base, selected_choice_ids: [choiceId(q.key, correct ? correctIdx : wrongIdx)] }
  }
  return { ...base, boolean_answer: correct ? q.correctAnswer : !q.correctAnswer }
}

// Inserts the question bank rows for a quiz and links them via assignments.
async function seedQuizQuestions(sectionId: string, quizId: string, questions: SeedQuestion[]) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const { error: qErr } = await supabase.from('quiz_questions').upsert(
      {
        id: det(q.key),
        section_id: sectionId,
        question_text: q.question_text,
        question_type: q.kind,
        content: questionContent(q),
        points: q.points,
        tags: ['fundamentals'],
      },
      { onConflict: 'id' },
    )
    if (qErr) throw qErr

    const { error: aErr } = await supabase.from('quiz_question_assignments').upsert(
      { id: det(`${q.key}-assign`), quiz_id: quizId, question_id: det(q.key), position: i },
      { onConflict: 'id' },
    )
    if (aErr) throw aErr
  }
}

async function seedQuizzes(professorId: string, studentIds: string[], sectionIds: string[]) {
  phase('Quizzes')

  // One published quiz on section 1 with graded attempts; one draft quiz on section 2.
  const section1 = sectionIds[0]
  const quizId = det('quiz-1')
  const questions: SeedQuestion[] = [
    {
      key: 'quiz-1-q1',
      kind: 'multiple_choice',
      question_text: 'What is the time complexity of binary search?',
      choices: [
        { text: 'O(n)', correct: false },
        { text: 'O(log n)', correct: true },
        { text: 'O(n^2)', correct: false },
        { text: 'O(1)', correct: false },
      ],
      points: 1,
    },
    {
      key: 'quiz-1-q2',
      kind: 'multiple_choice',
      question_text: 'Which data structure uses FIFO ordering?',
      choices: [
        { text: 'Stack', correct: false },
        { text: 'Queue', correct: true },
        { text: 'Tree', correct: false },
        { text: 'Graph', correct: false },
      ],
      points: 1,
    },
    {
      key: 'quiz-1-q3',
      kind: 'true_false',
      question_text: 'A hash table guarantees O(1) lookup in the worst case.',
      correctAnswer: false,
      points: 1,
    },
  ]
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)

  const { error: quizErr } = await supabase.from('quizzes').upsert(
    {
      id: quizId,
      section_id: section1,
      created_by: professorId,
      title: 'Quiz 1 — Fundamentals',
      description: 'Covers complexity, data structures, and hashing.',
      status: 'published',
      time_limit_minutes: 20,
      due_date: daysFromStart(21),
    },
    { onConflict: 'id' },
  )
  if (quizErr) throw quizErr
  await seedQuizQuestions(section1, quizId, questions)
  ok(`published quiz "Quiz 1 — Fundamentals" (${questions.length} questions)`)

  // Graded attempts for the first three students. Student s answers the first
  // (3 - s) questions correctly, so scores vary across students.
  let attemptCount = 0
  for (let s = 0; s < 3; s++) {
    const studentId = studentIds[s]
    const attemptId = det(`quiz-1-attempt-${studentId}`)
    const correctness = questions.map((_, qi) => qi < 3 - s)
    const earned = questions.reduce((sum, q, qi) => sum + (correctness[qi] ? q.points : 0), 0)

    const { error: attErr } = await supabase.from('quiz_attempts').upsert(
      {
        id: attemptId,
        quiz_id: quizId,
        student_id: studentId,
        section_id: section1,
        status: 'submitted',
        score: earned,
        total_points: totalPoints,
        earned_points: earned,
        started_at: daysFromStart(20),
        submitted_at: new Date(SEMESTER_START_MS + 20 * DAY_MS + 15 * 60_000).toISOString(),
        time_spent_seconds: 900,
      },
      { onConflict: 'id' },
    )
    if (attErr) throw attErr

    const rows = questions.map((q, qi) => answerRow(q, studentId, attemptId, correctness[qi]))
    const { error: ansErr } = await supabase.from('quiz_answers').upsert(rows, { onConflict: 'id' })
    if (ansErr) throw ansErr
    attemptCount++
  }
  ok(`${attemptCount} graded attempts with answers`)

  // A draft quiz on section 2 (no attempts) so the professor draft view is populated.
  const draftQuizId = det('quiz-2-draft')
  const { error: draftErr } = await supabase.from('quizzes').upsert(
    {
      id: draftQuizId,
      section_id: sectionIds[1],
      created_by: professorId,
      title: 'Quiz 2 — Trees (Draft)',
      description: 'Work in progress.',
      status: 'draft',
    },
    { onConflict: 'id' },
  )
  if (draftErr) throw draftErr
  await seedQuizQuestions(sectionIds[1], draftQuizId, [
    {
      key: 'quiz-2-q1',
      kind: 'true_false',
      question_text: 'A binary tree node has at most two children.',
      correctAnswer: true,
      points: 1,
    },
  ])
  ok('draft quiz "Quiz 2 — Trees (Draft)"')
}

// ── Skills (class medians + per-student mastery trend) ──────────────────
// Schema notes (verified against the live local schema and the scoring engine in
// src/lib/skills/):
//   - A skill with no children is a valid "main skill" — its class score comes from its
//     own skill_mastery rows directly (aggregateSectionMastery, src/lib/skills/aggregate.ts).
//     No parent/subtopic tree needed for this seed.
//   - skill_mastery.state can stay '{}': mapMasteryRow (queries.ts) falls back to n=1
//     when a score is present, so no fabricated evidence-weight JSON is required.
//   - classMetric defaults to 'median' (src/lib/skills/config.ts) — nothing to configure
//     on the section for the median to compute correctly.
//   - The per-student trend both the professor Skill Index and the student's own view
//     read comes from skill_mastery_snapshots, comparing the latest captured_on date
//     against one roughly 14+ days older (src/lib/roadmap/engagement.ts). Two dates per
//     (student, skill) — an older, lower score and today's, matching the live
//     skill_mastery.score — makes a real upward trend appear from the same rows.
type SkillDef = { key: string; name: string; scores: number[] }

const SKILL_DEFS: SkillDef[] = [
  // Ties to quiz-1 Q1 (binary search). Solid, unremarkable spread.
  { key: 'skill-time-complexity', name: 'Time Complexity', scores: [88, 82, 78, 70, 65, 55] },
  // Ties to quiz-1 Q2 (queue). Wider spread, one student clearly behind.
  { key: 'skill-data-structures', name: 'Data Structures', scores: [92, 85, 75, 68, 58, 42] },
  // Ties to quiz-1 Q3 (hash table). Deliberately weak class-wide — median lands right at
  // the default at-risk threshold (50), a useful edge case for the at-risk view.
  { key: 'skill-hashing', name: 'Hashing', scores: [65, 60, 52, 48, 40, 28] },
  // Ties to Homework 2 (Recursion Practice). Deliberately strong class-wide, so the
  // student "Strengths" view and the professor's ranked list both have a clear top skill.
  { key: 'skill-recursion', name: 'Recursion', scores: [95, 90, 88, 82, 78, 70] },
]

const SNAPSHOT_BASELINE_DAYS_AGO = 20

async function seedSkills(
  studentIds: string[],
  sectionId: string,
  quizId: string,
  homeworkId: string,
) {
  phase('Skills')

  const skillRows = SKILL_DEFS.map((s, i) => ({
    id: det(s.key),
    section_id: sectionId,
    institution_id: INSTITUTION_ID,
    parent_id: null,
    name: s.name,
    source: 'professor',
    position: i,
  }))
  const { error: skillErr } = await supabase.from('skills').upsert(skillRows, { onConflict: 'id' })
  if (skillErr) throw skillErr

  // Coverage: the three quiz-topic skills tie to quiz-1, Recursion ties to Homework 1
  // (the one real graded/gradeable assignment — Homework 2 is still a draft).
  const activitySkillRows = SKILL_DEFS.map((s) => ({
    id: det(`activity-${s.key}`),
    section_id: sectionId,
    institution_id: INSTITUTION_ID,
    activity_id: s.key === 'skill-recursion' ? homeworkId : quizId,
    activity_type: s.key === 'skill-recursion' ? 'assignment' : 'quiz',
    skill_id: det(s.key),
  }))
  const { error: actErr } = await supabase.from('activity_skills').upsert(activitySkillRows, { onConflict: 'id' })
  if (actErr) throw actErr

  const masteryRows = SKILL_DEFS.flatMap((s) =>
    studentIds.map((studentId, i) => ({
      id: det(`mastery-${s.key}-${studentId}`),
      section_id: sectionId,
      institution_id: INSTITUTION_ID,
      student_id: studentId,
      skill_id: det(s.key),
      score: s.scores[i],
    })),
  )
  const { error: masteryErr } = await supabase.from('skill_mastery').upsert(masteryRows, { onConflict: 'id' })
  if (masteryErr) throw masteryErr

  // Two dates per (student, skill): an older, lower score and today's — the actual
  // trend comparison the class and per-student views read.
  const today = new Date().toISOString().slice(0, 10)
  const baseline = new Date(Date.now() - SNAPSHOT_BASELINE_DAYS_AGO * 86_400_000).toISOString().slice(0, 10)
  const snapshotRows = SKILL_DEFS.flatMap((s) =>
    studentIds.flatMap((studentId, i) => {
      const current = s.scores[i]
      const older = Math.max(0, current - 10)
      return [
        { student_id: studentId, skill_id: det(s.key), section_id: sectionId, institution_id: INSTITUTION_ID, score: older, estimate: older, captured_on: baseline },
        { student_id: studentId, skill_id: det(s.key), section_id: sectionId, institution_id: INSTITUTION_ID, score: current, estimate: current, captured_on: today },
      ]
    }),
  )
  const { error: snapErr } = await supabase
    .from('skill_mastery_snapshots')
    .upsert(snapshotRows, { onConflict: 'student_id,skill_id,captured_on' })
  if (snapErr) throw snapErr

  ok(`${skillRows.length} skills · ${masteryRows.length} mastery rows · ${snapshotRows.length} trend snapshots`)
}

// ── Athena memory (professor + student preferences) ──────────────────────
// Schema notes (verified against src/lib/validations/memory.ts and the live
// user_memory table):
//   - One table for both roles; `kind` decides the slot. Single-value slots hold exactly
//     one row per (user, section-scope, kind) — a second statement would normally REPLACE
//     the first, so this seed writes exactly one. Multi-value slots (constraint, context,
//     workflow) accumulate, capped at 3 by the application and backstopped at 10 in the DB.
//   - section_id null = general scope (applies everywhere); set = course-scoped.
//   - `text` is the actual sentence read by the assistant (max 160 chars); `value` stays
//     '{}' — nothing reads it for these slots.
async function seedMemory(professorId: string, studentId: string, sectionId: string) {
  phase('Athena memory')

  const row = (key: string, userId: string, kind: string, text: string, scopeSectionId: string | null) => ({
    id: det(`memory-${key}`),
    user_id: userId,
    institution_id: INSTITUTION_ID,
    section_id: scopeSectionId,
    kind,
    value: {},
    text,
    source: 'stated',
  })

  const rows = [
    // Professor — general.
    row('prof-announcement-style', professorId, 'announcement_style', 'Keep announcements warm and encouraging, not just logistical.', null),
    row('prof-workflow-1', professorId, 'workflow', 'Never suggest group work for take-home assignments.', null),
    row('prof-workflow-2', professorId, 'workflow', 'Always include a worked example when drafting quiz explanations.', null),
    // Professor — course-scoped.
    row('prof-grading-style', professorId, 'grading_style', 'Be strict about partial credit — show your work or lose points.', sectionId),

    // Student — general.
    row('student-explanation-style', studentId, 'explanation_style', 'Show worked examples, not just the final answer.', null),
    row('student-language-level', studentId, 'language_level', 'Use plain language, avoid unexplained jargon.', null),
    row('student-tone', studentId, 'tone', 'Be encouraging — I get discouraged easily when I am stuck.', null),
    row('student-constraint-1', studentId, 'constraint', 'Never suggest studying on Saturdays.', null),
    row('student-constraint-2', studentId, 'constraint', 'I am colorblind — avoid red/green comparisons in examples.', null),
    // Student — course-scoped.
    row('student-context', studentId, 'context', 'Struggling with recursion — please slow down and use small examples.', sectionId),
  ]

  const { error } = await supabase.from('user_memory').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  ok(`${rows.length} memory rows (professor + student1)`)
}

// ── Announcements ─────────────────────────────────────────────────────
async function seedAnnouncements(professorId: string, sectionId: string) {
  phase('Announcements')
  const rows = [
    {
      id: det('announcement-welcome'),
      section_id: sectionId,
      author_id: professorId,
      title: 'Welcome to CS101',
      content: 'Welcome! Check the syllabus under Modules and keep an eye on the Quizzes page for deadlines.',
      is_pinned: true,
      published_at: daysFromStart(0),
    },
    {
      id: det('announcement-quiz'),
      section_id: sectionId,
      author_id: professorId,
      title: 'Quiz 1 is now live',
      content: 'Quiz 1 covers fundamentals. You have 20 minutes once you start.',
      published_at: daysFromStart(14),
    },
  ]
  const { error } = await supabase.from('announcements').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  ok(`${rows.length} announcements`)
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  Scholera Dev Seed                           ║')
  console.log('╚══════════════════════════════════════════════╝')
  log(`Target: ${SUPABASE_URL}`)
  log(`Institution: Scholera Dev (${INSTITUTION_ID})`)

  await seedInstitution()
  await seedBuckets()

  phase('Users')
  const userIdByEmail: Record<string, string> = {}
  for (const u of USERS) {
    userIdByEmail[u.email] = await ensureUser(u.email, u.role, u.firstName, u.lastName)
  }
  ok(`${USERS.length} users (1 admin, 1 professor, 6 students)`)

  const professorId = userIdByEmail['professor@scholera.dev']
  const studentIds = USERS.filter((u) => u.role === 'student').map((u) => userIdByEmail[u.email])

  const sectionIds = await seedReferenceData(professorId)
  await seedEnrollments(studentIds, sectionIds)
  await seedModules(sectionIds[0])
  await seedAssignments(professorId, studentIds, sectionIds[0])
  await seedProjects(professorId, studentIds, sectionIds[0])
  await seedQuizzes(professorId, studentIds, sectionIds)
  await seedSkills(studentIds, sectionIds[0], det('quiz-1'), det('assignment-hw1'))
  await seedMemory(professorId, studentIds[0], sectionIds[0])
  await seedAnnouncements(professorId, sectionIds[0])

  console.log('\n\x1b[42m\x1b[30m ✓ SEED COMPLETE \x1b[0m')
  console.log('\n  Log in at http://localhost:3000 with any of:')
  console.log('    admin@scholera.dev      (admin)')
  console.log('    professor@scholera.dev  (professor)')
  console.log('    student1@scholera.dev   (student)   … through student6@scholera.dev')
  console.log(`    password for all: ${SHARED_PASSWORD}\n`)
  console.log('  CS101 has real content: modules with real multi-page PDFs, a gradeable')
  console.log('  assignment with file submissions, a project with two teams, skills with')
  console.log('  class medians and a mastery trend, and Athena memory preferences.\n')
}

main().catch((err) => {
  console.error('\n\x1b[41m\x1b[37m ✗ SEED FAILED \x1b[0m', err)
  process.exit(1)
})
