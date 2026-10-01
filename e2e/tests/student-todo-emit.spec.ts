// End-to-end proof of the shared event layer for the student to-do list.
//
// This is the flow that was BROKEN until the shared-event-layer merge: publishing
// an assignment now fires emitEvent() (professor action) → fans out feed_items →
// the student dashboard reads them via listFeed()/buildTodoList(). Submitting fires
// a completion event (markFeedItemDone) that flips is_done so the to-do drops off.
//
// Unlike quiz-lifecycle.spec.ts we do NOT seed the feed_items directly — the whole
// point is to prove the PRODUCT emits them. We only seed a *draft* assignment, then
// drive the real publish + submit through the UI and assert the DB side-effects.
//
// Runs against the local DEV seed (professor@scholera.dev teaches section
// bec3377d…, student3@scholera.dev is enrolled). Standalone config skips the
// (currently broken) shared global-setup — see playwright.todos.config.ts.

import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Missing local Supabase env — run via `dotenv -e .env.test`.')
}
const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Dev-seed fixtures (correctly tenanted, unlike the broken e2e seed).
const SECTION_ID = 'bec3377d-1a20-5b5d-8fd0-58095a4438bc'
const INSTITUTION_ID = '00000000-0000-0000-0000-000000000002'
/* Sourced, not hardcoded: the previous literal was a working PRODUCTION password
 * (these accounts exist on the prod project), committed in plain sight. e2e runs
 * against LOCAL Supabase seeded by scripts/dev-setup/seed-dev.ts, so this default
 * matches that script's. Assertions below are unchanged. */
const SHARED_PASSWORD = process.env.E2E_SHARED_PASSWORD ?? 'LocalDev1234!'
const PROFESSOR = { email: 'professor@scholera.dev', password: SHARED_PASSWORD }
const STUDENT = { email: 'student3@scholera.dev', password: SHARED_PASSWORD }

// Unique, regex-safe title so selectors + cleanup target only this run's row.
const TITLE = `E2E Todo Emit ${Date.now()}`
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

let assignmentId: string
let studentId: string

async function login(page: import('@playwright/test').Page, user: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel(/email or student id/i).fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(dashboard|professor|student|admin)/, { timeout: 45_000 })
}

test.beforeAll(async () => {
  // Resolve the student's id (recipient we assert on).
  const { data: stu, error: stuErr } = await admin
    .from('profiles')
    .select('id')
    .eq('email', STUDENT.email)
    .single()
  if (stuErr || !stu) throw stuErr ?? new Error('student profile not found')
  studentId = stu.id

  // Seed a DRAFT assignment due 24h out (buildTodoList drops past-due items;
  // 24h → "Needs Attention" bucket). Publishing it through the UI is what must
  // fire emitEvent — so it starts as a draft with no feed_items.
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data: asg, error: asgErr } = await admin
    .from('assignments')
    .insert({
      section_id: SECTION_ID,
      institution_id: INSTITUTION_ID,
      created_by: (await admin.from('profiles').select('id').eq('email', PROFESSOR.email).single()).data!.id,
      title: TITLE,
      description: 'Seeded by student-todo-emit spec',
      submission_type: 'written',
      status: 'draft',
      due_at: dueAt,
    })
    .select('id')
    .single()
  if (asgErr || !asg) throw asgErr ?? new Error('assignment insert failed')
  assignmentId = asg.id
})

test.afterAll(async () => {
  if (assignmentId) {
    // Publishing fanned feed_items to every enrolled student; submit added a
    // submission. Remove all of it so the dev DB is left as we found it.
    await admin.from('assignment_submissions').delete().eq('assignment_id', assignmentId)
    await admin.from('feed_items').delete().eq('entity_id', assignmentId)
    await admin.from('assignments').delete().eq('id', assignmentId)
  }
})

test('publish emits a to-do → dashboard shows it → submit flips it done → it drops off', async ({ browser }) => {
  // ── 1. Professor publishes the draft through the real UI ───────────────────
  const profCtx = await browser.newContext()
  const profPage = await profCtx.newPage()
  await login(profPage, PROFESSOR)
  await profPage.goto(`/professor/courses/${SECTION_ID}/assignments`)

  const card = profPage.getByRole('listitem').filter({ hasText: TITLE })
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.getByRole('button', { name: /actions/i }).click()
  await profPage.getByRole('menuitem', { name: /^publish$/i }).click()

  // ── 2. emitEvent fired → an actionable feed_items row exists for the student.
  //    This is the load-bearing assertion: it proves the PRODUCT emitted (not a
  //    seed script). Poll — emitEvent is fire-and-forget after the action returns.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('feed_items')
          .select('is_actionable, is_done')
          .eq('recipient_id', studentId)
          .eq('entity_id', assignmentId)
          .eq('type', 'assignment_published')
          .maybeSingle()
        return data ? `actionable=${data.is_actionable},done=${data.is_done}` : 'no-row'
      },
      { timeout: 15_000, message: 'emitEvent did not create a feed_items row for the student' },
    )
    .toBe('actionable=true,done=false')
  await profCtx.close()

  // ── 3. Student sees the to-do on the dashboard (consumer path) ─────────────
  //    Feed title is "New assignment: <title>" (set by emitEvent).
  const stuCtx = await browser.newContext()
  const stuPage = await stuCtx.newPage()
  await login(stuPage, STUDENT)
  await stuPage.goto('/dashboard')
  const todoLink = stuPage.getByRole('link', { name: rx(TITLE) })
  await expect(todoLink).toBeVisible({ timeout: 20_000 })

  // ── 4. Student submits a text response → completion event flips is_done ────
  await stuPage.goto(`/student/courses/${SECTION_ID}/assignments/${assignmentId}`)
  await stuPage.getByPlaceholder(/type your response/i).fill('My E2E response.')
  await stuPage.getByRole('button', { name: /^submit$/i }).click()

  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('feed_items')
          .select('is_done')
          .eq('recipient_id', studentId)
          .eq('entity_id', assignmentId)
          .maybeSingle()
        return data?.is_done ?? null
      },
      { timeout: 15_000, message: 'submit did not flip the to-do to done' },
    )
    .toBe(true)

  // ── 5. Dashboard no longer lists it (undoneOnly read + buildTodoList) ──────
  await stuPage.goto('/dashboard')
  await expect(stuPage.getByRole('link', { name: rx(TITLE) })).toHaveCount(0)
  await stuCtx.close()
})
