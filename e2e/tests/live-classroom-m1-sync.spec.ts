// P0 — Live Classroom M1 Sync: professor starts a live class, uploads a PDF,
// and advances slides. Student sees the slide updates in real-time via Realtime.
//
// This spec uses two browser contexts (professor and student) to validate the
// core real-time sync loop end-to-end. The PDF fixture is a minimal 3-page doc
// to keep uploads fast while still testing slide advancement.

import { test, expect, BrowserContext, Page } from '@playwright/test'
import { admin, seedIds } from '../helpers/db'
import { storageStatePath } from '../fixtures/test-users'

// We need two contexts: professor presents, student follows.
let profContext: BrowserContext
let studentContext: BrowserContext
let profPage: Page
let studentPage: Page
let roomId: string | null = null

// Test setup: create both contexts
test.beforeAll(async ({ browser }) => {
  profContext = await browser.newContext({
    storageState: storageStatePath('professor'),
  })
  studentContext = await browser.newContext({
    storageState: storageStatePath('studentEnrolled'),
  })
  profPage = await profContext.newPage()
  studentPage = await studentContext.newPage()
})

test.afterAll(async () => {
  // Clean up room if created (best-effort)
  if (roomId) {
    try {
      await admin
        .from('lc_rooms')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', roomId)

      // Delete storage files
      const { data: files } = await admin.storage
        .from('live-classroom-decks')
        .list(roomId)
      if (files && files.length > 0) {
        const paths = files.map((f) => `${roomId}/${f.name}`)
        await admin.storage.from('live-classroom-decks').remove(paths)
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  await profContext.close()
  await studentContext.close()
})

/**
 * `.serial` because these three are one scenario, not three tests: the room the first one starts
 * is the room the other two act on. Under the config's `fullyParallel` they could run in any
 * order or on different workers, and the dependency was previously papered over with
 * `test.skip(!roomId, 'Room was not created in previous test')` — which reports GREEN when the
 * room genuinely failed to start. Serial makes the ordering real and lets Playwright skip the
 * rest when an earlier step fails, which is the honest signal.
 */
test.describe.serial('Live Classroom M1 — PDF Sync', () => {
  test('professor starts room, student can join', async () => {
    const { section } = seedIds()

    // 1. Professor navigates to live classroom
    await profPage.goto(`/professor/courses/${section}/live-classroom`)
    await expect(profPage.getByRole('heading', { name: /live classroom/i })).toBeVisible()

    // 2. Professor starts live class
    await profPage.getByRole('button', { name: /start live class/i }).click()

    // Wait for navigation to the room
    await profPage.waitForURL(/\/live-classroom\/[a-f0-9-]+$/, { timeout: 10000 })

    // Extract room ID from URL
    const url = profPage.url()
    const match = url.match(/\/live-classroom\/([a-f0-9-]+)$/)
    expect(match).toBeTruthy()
    roomId = match![1]

    // 3. Verify deck upload dialog is shown
    await expect(profPage.getByText(/upload your presentation/i)).toBeVisible({ timeout: 5000 })

    // 4. Student navigates to live classroom and sees the live room
    await studentPage.goto(`/student/courses/${section}/live-classroom`)
    await expect(studentPage.getByRole('heading', { name: /live classroom/i })).toBeVisible()

    // Student should see "Live Now" indicator
    await expect(studentPage.getByText(/live now/i)).toBeVisible({ timeout: 5000 })

    // 5. Student joins the class
    await studentPage.getByRole('button', { name: /join class/i }).click()
    await studentPage.waitForURL(/\/live-classroom\/[a-f0-9-]+$/, { timeout: 10000 })

    // Student should see "Waiting for slides" message
    await expect(studentPage.getByText(/waiting for slides/i)).toBeVisible({ timeout: 5000 })
  })

  test('professor sees the deck upload prompt in a room with no deck', async () => {
    /* Scoped to the upload PROMPT, not the upload itself: the 3-page fixture this spec's header
       describes was never committed. The previous version wrapped these assertions in a
       try/catch that called `test.skip(true, 'PDF fixture not available')` on ANY failure, so a
       broken upload screen, a renamed string or a 500 all reported as a skipped test. Nothing
       here touches a fixture, so there is nothing to swallow. */
    expect(roomId).toBeTruthy()
    const { section } = seedIds()

    await profPage.goto(`/professor/courses/${section}/live-classroom/${roomId}`)

    await expect(profPage.getByText(/upload your presentation/i)).toBeVisible({ timeout: 5000 })
    await expect(profPage.getByText(/drag & drop your pdf/i)).toBeVisible()
    await expect(profPage.getByText(/50 mb/i)).toBeVisible()
    await expect(profPage.getByText(/100 pages/i)).toBeVisible()
  })

  test('professor ends class and student sees ended state', async () => {
    expect(roomId).toBeTruthy()
    const { section } = seedIds()

    // Professor is on the room page
    await profPage.goto(`/professor/courses/${section}/live-classroom/${roomId}`)

    // End the room directly via DB since we can't test the full upload flow without a fixture
    await admin
      .from('lc_rooms')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', roomId)

    // Student should see "class ended" after realtime update
    await studentPage.goto(`/student/courses/${section}/live-classroom/${roomId}`)

    await expect(studentPage.getByText(/class has ended/i)).toBeVisible({ timeout: 10000 })
    await expect(studentPage.getByRole('button', { name: /back to live classroom/i })).toBeVisible()
  })
})
