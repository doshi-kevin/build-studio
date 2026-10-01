// E2E for the in-fullscreen poll/quiz banner. The student is in fullscreen
// (so the sidebar responder is hidden), the prof opens a poll, and the
// banner must surface on top of the slide. Clicking "Answer" exits
// fullscreen and the original sidebar responder takes over.
//
// Setup is direct-DB (no PDF upload fixture): we insert a row into
// lc_rooms with synthetic deck_url + deck_page_count so the StudentLiveView
// reaches its mounted "live slide" branch where the fullscreen container
// and banner code path live. The slide image itself may 404 — that's fine,
// we only assert on UI chrome.

import { test, expect, type Page } from '@playwright/test'
import { admin, seedIds } from '../helpers/db'
import { storageStatePath } from '../fixtures/test-users'

let roomId: string | null = null
let interactionId: string | null = null

test.afterEach(async () => {
  if (interactionId) {
    await admin.from('lc_interactions').delete().eq('id', interactionId).then(() => {})
    interactionId = null
  }
  if (roomId) {
    await admin
      .from('lc_rooms')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', roomId)
      .then(() => {})
    roomId = null
  }
})

async function createLiveRoomWithDeck(sectionId: string, profId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('lc_rooms')
    .insert({
      section_id: sectionId,
      prof_id: profId,
      status: 'live',
      deck_url: 'live-classroom-decks/synthetic/deck.pdf',
      deck_page_count: 5,
      current_slide: 0,
    })
    .select('id')
    .single()
  if (error || !data) return null
  return data.id
}

async function openPoll(roomIdParam: string, profId: string, question: string): Promise<string | null> {
  const { data, error } = await admin
    .from('lc_interactions')
    .insert({
      room_id: roomIdParam,
      kind: 'poll',
      created_by: profId,
      status: 'open',
      opened_at: new Date().toISOString(),
      payload: {
        question,
        choices: [
          { id: 'a', text: 'Option A' },
          { id: 'b', text: 'Option B' },
        ],
      },
    })
    .select('id')
    .single()
  if (error || !data) return null
  return data.id
}

async function isFullscreen(page: Page): Promise<boolean> {
  return page.evaluate(() => document.fullscreenElement !== null)
}

test.describe('Live Classroom — fullscreen poll banner', () => {
  test('student in fullscreen sees banner when poll opens, "Answer" exits fullscreen and reveals responder', async ({
    browser,
  }) => {
    /* Seeding failures are ASSERTIONS, not skips. These were `test.skip(!roomId, 'Could not seed
       lc_rooms row — schema may have diverged')`, which turns the single regression this spec
       exists to catch — the live-classroom schema drifting — into a green run. A skip that fires
       on the failure it is watching for is worse than no test. The one skip kept below is for a
       browser capability, which is an environment fact rather than a product regression. */
    const { section, users } = seedIds()
    const profId = users['e2e-professor@scholera.test']
    expect(profId, 'no professor in seed-ids.json — run `npm run db:seed:e2e`').toBeTruthy()

    roomId = await createLiveRoomWithDeck(section, profId)
    expect(roomId, 'could not seed an lc_rooms row — the schema may have drifted').toBeTruthy()

    const studentContext = await browser.newContext({
      storageState: storageStatePath('studentEnrolled'),
    })
    const studentPage = await studentContext.newPage()

    try {
      await studentPage.goto(`/student/courses/${section}/live-classroom/${roomId}`)

      // Wait until the slide stage is mounted (image element with the
      // slide alt text). Joining-classroom spinner clears once useRoom
      // resolves the snapshot.
      await expect(studentPage.getByRole('img', { name: /slide 1/i })).toBeVisible({
        timeout: 15_000,
      })

      // Banner must NOT be visible before fullscreen.
      const banner = studentPage.getByRole('alert')
      await expect(banner).toHaveCount(0)

      // Open a poll directly in the DB. The room channel rebroadcast is
      // not in this test's scope — useInteractions hydrates from snapshot
      // on next navigation, so we trigger a refresh AFTER inserting.
      interactionId = await openPoll(roomId!, profId, 'Which option fits best?')
      expect(interactionId, 'could not seed an lc_interactions row').toBeTruthy()

      await studentPage.reload()
      await expect(studentPage.getByRole('img', { name: /slide 1/i })).toBeVisible({
        timeout: 15_000,
      })

      // Still no banner — student is not in fullscreen yet.
      await expect(banner).toHaveCount(0)

      // Trigger fullscreen via the F shortcut. Playwright's keyboard
      // events count as user activation in Chromium so requestFullscreen()
      // is permitted. If the host environment refuses fullscreen (some
      // CI sandboxes do), we surface a clear skip rather than a flake.
      await studentPage.locator('body').click() // ensure focus
      await studentPage.keyboard.press('f')

      /* Ask the capability question directly instead of catching a failure and skipping inside
         the handler. A catch-and-skip also swallows anything else that goes wrong in the wait,
         so a real regression would report as "skipped". Whether the host granted fullscreen is
         an environment fact, and it is the only thing allowed to skip this test. */
      const enteredFullscreen = await studentPage
        .waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 5_000 })
        .then(() => true, () => false)
      test.skip(
        !enteredFullscreen && !(await isFullscreen(studentPage)),
        'Browser refused requestFullscreen — likely a sandbox restriction',
      )

      // Banner now visible with the poll title.
      await expect(banner).toBeVisible({ timeout: 5_000 })
      await expect(banner.getByText(/which option fits best/i)).toBeVisible()
      await expect(banner.getByRole('button', { name: /answer/i })).toBeVisible()

      // Click Answer — exits fullscreen and the sidebar responder mounts.
      await banner.getByRole('button', { name: /answer/i }).click()

      await studentPage.waitForFunction(() => document.fullscreenElement === null, null, {
        timeout: 5_000,
      })

      // Banner gone, responder card visible. Responder shows the same
      // question and choice text.
      await expect(banner).toHaveCount(0)
      await expect(studentPage.getByText('Which option fits best?')).toBeVisible()
      await expect(studentPage.getByRole('button', { name: /option a/i })).toBeVisible()
    } finally {
      await studentContext.close()
    }
  })
})
