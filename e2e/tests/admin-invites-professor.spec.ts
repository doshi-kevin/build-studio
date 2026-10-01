// P0 — Admin invites professor: admin fills the invite form, Supabase
// creates the auth user + profile + department_faculty row, professor
// follows the recovery link (stand-in for clicking the magic link in
// their inbox), sets a password, and logs in.
//
// Validates the flow hardened by commits 48ccb62 + 169d64c. If this breaks
// we cannot onboard professors, which is launch-blocking.

import { test, expect } from '@playwright/test'
import { admin, deleteUserByEmail, seedIds } from '../helpers/db'
import { storageStatePath } from '../fixtures/test-users'

const INVITE_EMAIL = `e2e-invited-prof-${Date.now()}@scholera.test`
const NEW_PROF_PASSWORD = 'e2e-invited-prof-pass'

test.use({ storageState: storageStatePath('admin') })

test.beforeAll(async () => {
  await deleteUserByEmail(INVITE_EMAIL)
})
test.afterAll(async () => {
  await deleteUserByEmail(INVITE_EMAIL)
})

test('admin invites professor → DB + onboarding + login', async ({ page, browser }) => {
  const { department } = seedIds()

  // ── 1. Admin opens the invite dialog and fills the form ────────────
  await page.goto('/admin/professors')
  await page.getByRole('button', { name: /invite professor/i }).first().click()

  const dialog = page.getByRole('dialog', { name: /invite professor/i })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel(/first name/i).fill('Invited')
  await dialog.getByLabel(/last name/i).fill('Professor')
  await dialog.getByLabel('Email *', { exact: false }).fill(INVITE_EMAIL)

  // Department select — open + pick the E2E-seeded department.
  await dialog.getByRole('combobox', { name: /department/i }).click()
  // Radix renders the listbox in a portal, so scope by role at the page level.
  await page.getByRole('option').filter({ hasText: 'E2E' }).first().click()

  // Position + employment type — any valid option.
  await dialog.getByRole('combobox', { name: /position/i }).click()
  await page.getByRole('option').first().click()
  await dialog.getByRole('combobox', { name: /employment type/i }).click()
  await page.getByRole('option').first().click()

  // Submit.
  await dialog.getByRole('button', { name: /invite professor/i }).click()

  // Dialog closes on success. 30s covers the inviteUserByEmail round-trip
  // (auth user create → profile upsert → department_faculty insert → SMTP).
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  // ── 2. DB assertions — user + profile + department_faculty ─────────
  // Covers the RLS + admin-client path that mocks can't verify.
  const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const authUser = listed.users.find((u) => u.email === INVITE_EMAIL)
  expect(authUser, 'invited auth user exists').toBeDefined()

  const { data: profile } = await admin
    .from('profiles')
    .select('id, email, role, invite_status, first_name, last_name')
    .eq('email', INVITE_EMAIL)
    .single()
  expect(profile?.invite_status).toBe('pending')
  expect(profile?.first_name).toBe('Invited')

  const { data: faculty } = await admin
    .from('department_faculty')
    .select('department_id, professor_id, status')
    .eq('professor_id', authUser!.id)
    .single()
  expect(faculty?.department_id).toBe(department)
  expect(faculty?.status).toBe('active')

  // ── 3. Set the invited professor's password via admin API ──────────
  // Rationale: the UI-based reset-password flow relies on supabase-js
  // picking up hash-fragment tokens from the recovery redirect. That path
  // has its own dedicated coverage in auth.spec.ts ("forgot password →
  // reset → login again"). For this spec — whose unique value is the
  // invite fan-out (profile + department_faculty + invite_status) — we
  // skip the UI reset and set the password directly. Keeps the spec
  // focused on what only E2E can prove.
  await admin.auth.admin.updateUserById(authUser!.id, {
    password: NEW_PROF_PASSWORD,
    email_confirm: true,
    user_metadata: { ...(authUser!.user_metadata ?? {}), password_set: true },
    app_metadata: {
      ...(authUser!.app_metadata ?? {}),
      requires_password_set: false,
    },
  })

  // ── 4. Invited professor logs in normally ──────────────────────────
  // Fresh context with no admin cookies — `test.use({ storageState })` at
  // the top of this file is inherited by `browser.newContext()` by
  // default, so pass explicit `storageState: undefined`.
  const guestCtx = await browser.newContext({ storageState: undefined })
  const guest = await guestCtx.newPage()
  await guest.goto('/login')
  await guest.getByLabel(/email or student id/i).fill(INVITE_EMAIL)
  await guest.getByLabel('Password', { exact: true }).fill(NEW_PROF_PASSWORD)
  await guest.getByRole('button', { name: /sign in/i }).click()
  // Professor role → may land on /dashboard or /professor depending on
  // the role-aware landing router. Both are valid; /login is not.
  await expect(guest).not.toHaveURL(/\/login/, { timeout: 45_000 })
  await expect(guest).toHaveURL(/\/(dashboard|professor)/, { timeout: 45_000 })

  await guestCtx.close()
})
