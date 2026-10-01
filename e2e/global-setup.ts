// Playwright global setup: pre-flight checks, seed, then log each role in
// via the real /login form and persist storage state per role for reuse
// across specs (Gemini: cuts ~2s off every test).

import { chromium, type FullConfig } from '@playwright/test'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { TEST_USERS, AUTH_STATE_DIR, SHARED_PASSWORD } from './fixtures/test-users'

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (true) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.status < 500) return
    } catch {
      // connection refused, try again
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

export default async function globalSetup(config: FullConfig) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''

  // Guard #1: Supabase URL must be local. The seed script asserts the same,
  // but we assert here too because this runs before the seed and catches
  // misconfigurations earlier.
  const isLocal =
    supabaseUrl.startsWith('http://127.0.0.1') ||
    supabaseUrl.startsWith('http://localhost')
  if (!isLocal) {
    throw new Error(
      `E2E refused: NEXT_PUBLIC_SUPABASE_URL="${supabaseUrl}" is not local. ` +
        `Only 127.0.0.1 or localhost is allowed.`,
    )
  }

  // Guard #2: Supabase must actually be reachable before we seed.
  console.log(`[e2e] Waiting for Supabase at ${supabaseUrl} …`)
  await waitForUrl(`${supabaseUrl}/auth/v1/health`, 30_000).catch(() => {
    throw new Error(
      `Supabase not reachable at ${supabaseUrl}. Run 'supabase start' first.`,
    )
  })

  // Seed. If the fixture already exists and contains all expected users,
  // skip — saves ~5s on every local run.
  const fixturePath = path.resolve(__dirname, 'fixtures', 'seed-ids.json')
  let needsSeed = true
  if (fs.existsSync(fixturePath)) {
    try {
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
      const allUsersPresent = Object.values(TEST_USERS).every(
        (u) => fixture.users?.[u.email],
      )
      if (allUsersPresent) needsSeed = false
    } catch {
      needsSeed = true
    }
  }
  if (needsSeed) {
    console.log('[e2e] Running db:seed:e2e …')
    execSync('npm run db:seed:e2e', {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    })
  } else {
    console.log('[e2e] Seed fixture already present — skipping seed')
  }

  // Wait for the dev server (Playwright spawned it in parallel).
  const baseURL =
    (config.projects[0].use.baseURL as string | undefined) ??
    'http://localhost:3000'
  console.log(`[e2e] Waiting for dev server at ${baseURL} …`)
  await waitForUrl(baseURL, 120_000)

  // Log each role in once via the real form, persist storageState.
  fs.mkdirSync(AUTH_STATE_DIR, { recursive: true })
  const browser = await chromium.launch()
  for (const [role, user] of Object.entries(TEST_USERS)) {
    console.log(`[e2e] Logging in ${user.email} (${role}) …`)
    const ctx = await browser.newContext({ baseURL })
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.getByLabel(/email or student id/i).fill(user.email)
    await page.getByLabel('Password', { exact: true }).fill(SHARED_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    try {
      // 45s covers Next.js dev-server cold compile of /dashboard on the
      // very first login — subsequent roles hit a warmed bundle in <1s.
      await page.waitForURL(/\/(dashboard|professor|student|admin)/, {
        timeout: 45_000,
      })
    } catch (err) {
      const url = page.url()
      const bodyText = await page.locator('body').innerText().catch(() => '<no body>')
      const errorText = await page
        .locator('[role="alert"], .text-red-500, .text-destructive')
        .allInnerTexts()
        .catch(() => [])
      console.error(`[e2e] Login stuck for ${user.email}. URL=${url}`)
      console.error(`[e2e] Errors on page:`, errorText)
      console.error(`[e2e] Body text (first 500):`, bodyText.slice(0, 500))
      throw err
    }
    await ctx.storageState({ path: path.join(AUTH_STATE_DIR, `${role}.json`) })
    await ctx.close()
  }
  await browser.close()
  console.log('[e2e] Global setup complete.')
}
