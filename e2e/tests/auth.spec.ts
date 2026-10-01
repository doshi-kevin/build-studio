// P0 — Auth round-trip: admin-provisioned user → first login → logout →
// forgot-password → reset via admin API → re-login with new password.
//
// Scholera is invite-only — public /signup is disabled at the middleware
// level. All users enter the system via institution-admin invites that
// ship a temp password. This spec models that "fresh user with credentials
// in hand" state by provisioning the auth user + profile directly through
// the admin API, then driving the real /login UI from there.
//
// If any of this breaks the platform is unusable, which is the "embarrass
// you if it broke" bar this suite exists to enforce.

import { test, expect } from '@playwright/test'
import { admin, deleteUserByEmail } from '../helpers/db'

const TEMP_EMAIL = `e2e-newuser-${Date.now()}@scholera.test`
const TEMP_PASSWORD = 'e2e-temp-password-456'
const NEW_PASSWORD = 'e2e-temp-password-789'

// Clean slate — previous runs of this suite leave a user behind if the
// test bailed mid-flow. Deleting before each run keeps it idempotent.
test.beforeAll(async () => {
  await deleteUserByEmail(TEMP_EMAIL)
})
test.afterAll(async () => {
  await deleteUserByEmail(TEMP_EMAIL)
})

// This spec traverses 6 cold-compile Next dev routes in one flow (login,
// dashboard, admin/departments, forgot-password, login again). At ~15s
// first-compile each, the global 90s per-test budget is thin. Give this
// spec a larger budget so the auth round-trip doesn't end up starved.
test.setTimeout(180_000)

test('admin-provisioned user → login → logout → forgot password → reset → login again', async ({
  page,
}) => {
  // ── 1. Provision the user via admin API (stand-in for an admin invite) ──
  // Mirrors what scripts/seed-e2e.ts:ensureUser does and what
  // src/app/(dashboard)/admin/students/actions.ts:createStudent does in
  // prod: create the auth user with a known password, then upsert the
  // matching profile row. handle_new_user is a no-op (it cannot guess
  // institution_id), so the explicit profile upsert is load-bearing.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: TEMP_EMAIL,
    password: TEMP_PASSWORD,
    email_confirm: true,
    user_metadata: { name: 'E2E New User', password_set: true },
  })
  if (createErr || !created.user) throw createErr ?? new Error('createUser returned no user')

  const { error: profErr } = await admin
    .from('profiles')
    .upsert(
      {
        id: created.user.id,
        email: TEMP_EMAIL,
        first_name: 'E2E',
        last_name: 'NewUser',
        name: 'E2E New User',
        role: 'student',
        status: 'active',
        onboarding_completed: true,
        invite_status: 'accepted',
      },
      { onConflict: 'id' },
    )
  if (profErr) throw profErr

  // ── 2. Login via /login ─────────────────────────────────────────────
  await page.goto('/login')
  await page.getByLabel(/email or student id/i).fill(TEMP_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(TEMP_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  // 45s covers the Next.js dev-server first-compile of /dashboard after
  // router.push — signInWithPassword returns quickly but the target route
  // may be uncompiled. Prod bundles resolve this in <1s.
  await expect(page).toHaveURL(/\/dashboard|\/(professor|student|admin)/, {
    timeout: 45_000,
  })

  // ── 3. Admin layout blocks a new (student-default) user ────────────
  // (Also covers the role-access concern Gemini flagged as unit-level —
  //  one assertion here is cheap and in the real auth code path.)
  // The admin layout does NOT redirect — per project convention only
  // middleware redirects. Layout instead renders a no-access DeadEnd in
  // place, so we assert the URL held AND the denial rendered.
  await page.goto('/admin/departments')
  // DeadEnd -> EmptyState renders the title as an <h3>. Regex skips the
  // apostrophe in "don't" so it survives a straight/curly quote change.
  await expect(
    page.getByRole('heading', { name: /have access to this area/i }),
  ).toBeVisible({ timeout: 15_000 })
  // Staying on /admin/* is the actual invariant: a redirect here would mean
  // the layout took over auth routing from middleware.
  await expect(page).toHaveURL(/\/admin\/departments/)

  // ── 4. Logout via header dropdown ───────────────────────────────────
  await page.goto('/dashboard')
  // Avatar dropdown trigger: the only button rendering the user initials.
  // DashboardHeader uses an Avatar trigger; we find it via role=button that
  // holds the user's initials image/text. Fallback: first button in header.
  const avatar = page
    .getByRole('button')
    .filter({ has: page.locator('[class*="rounded-full"]') })
    .first()
  await avatar.click()
  await page.getByRole('menuitem', { name: /logout/i }).click()
  await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 })

  // ── 5. Forgot password form — submit + confirmation renders ─────────
  // The /forgot-password route is the only user-facing entry point for
  // password reset, so we validate it renders + accepts submissions.
  await page.goto('/forgot-password')
  await page.getByLabel(/email or student id/i).fill(TEMP_EMAIL)
  await page.getByRole('button', { name: /send reset link/i }).click()
  await expect(page.getByRole('heading', { name: /check your email/i })).toBeVisible()

  // ── 6. Apply new password via admin API ─────────────────────────────
  // Rationale: @supabase/ssr's browser client defaults to PKCE flow, so it
  // doesn't consume hash-fragment tokens from admin.generateLink. The prod
  // flow uses PKCE `?code=` via /auth/callback; the implicit-flow link is
  // a test-only edge case that doesn't match prod. Driving the UI here
  // would exercise a flow users never see. Set the password via admin API
  // — the load-bearing assertion for this spec is the re-login below,
  // which proves the new credential actually works.
  await admin.auth.admin.updateUserById(created.user.id, {
    password: NEW_PASSWORD,
    email_confirm: true,
  })

  // ── 7. Re-login with the new password ───────────────────────────────
  // Clear cookies so the credential login exercises the real sign-in path,
  // not a stale session from step 2.
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel(/email or student id/i).fill(TEMP_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/dashboard|\/(professor|student|admin)/, {
    timeout: 45_000,
  })
})
