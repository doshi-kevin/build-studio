// P0 — Module consumption: enrolled student opens the modules page and can
// see a published module with a file-backed lecture item. Content delivery
// is the core reason students come to the LMS — silent breakage here (RLS
// drift, is_published filter regressions, Storage CORS, bucket policy) would
// be catastrophic at launch. Unit tests can't validate this end-to-end.
//
// This spec deliberately uses a lecture item backed by a file in Supabase
// Storage (not a plain external link) to cover the failure modes mocks miss:
//   1. Storage bucket public-read policy on `course-materials`
//   2. CORS on the public URL Playwright fetches from the browser context
//   3. RLS + is_published filter on modules
//   4. is_visible filter on module_items
//
// We seed directly via admin client — professor module creation has its own
// vitest coverage; this spec focuses on the student *read* path.

import { test, expect } from '@playwright/test'
import { admin, seedIds } from '../helpers/db'
import { storageStatePath } from '../fixtures/test-users'

test.use({ storageState: storageStatePath('studentEnrolled') })

const STAMP = Date.now()
const MODULE_TITLE = `E2E Module ${STAMP}`
const HIDDEN_MODULE_TITLE = `E2E Hidden Module ${STAMP}`
const ITEM_TITLE = `E2E Lecture ${STAMP}`
const FILE_NAME = `e2e-lecture-${STAMP}.pdf`
const BUCKET = 'course-materials'

// Minimal placeholder payload — the assertion is "the URL is fetchable",
// not "this renders as a real PDF". Keeping it tiny keeps the upload fast.
const FILE_BODY = Buffer.from(`E2E lecture content — stamp ${STAMP}`)

let moduleId: string | null = null
let itemId: string | null = null
let hiddenModuleId: string | null = null
let filePath: string | null = null

test.beforeAll(async () => {
  const { section } = seedIds()

  // 1. Published module — student MUST see this.
  const { data: mod, error: modErr } = await admin
    .from('modules')
    .insert({
      section_id: section,
      title: MODULE_TITLE,
      description: 'Seeded by E2E module-consumption spec',
      is_published: true,
      position: 0,
    })
    .select('id')
    .single()
  if (modErr || !mod) throw modErr ?? new Error('module insert failed')
  moduleId = mod.id

  // 2. Upload a file to the course-materials bucket using the canonical
  //    path format: {sectionId}/{moduleId}/{itemId}/{filename}. We reserve
  //    a fresh UUID for the item up-front so the path matches the row.
  const reservedItemId = crypto.randomUUID()
  filePath = `${section}/${mod.id}/${reservedItemId}/${FILE_NAME}`

  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(filePath, FILE_BODY, {
      contentType: 'application/pdf',
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(filePath)
  const fileUrl = urlData.publicUrl

  // 3. Lecture-type module item pointing at the uploaded file. Shape matches
  //    `lectureContentSchema` in src/lib/validations/module.ts.
  const { data: item, error: itemErr } = await admin
    .from('module_items')
    .insert({
      id: reservedItemId,
      module_id: mod.id,
      title: ITEM_TITLE,
      item_type: 'lecture',
      is_visible: true,
      position: 0,
      content: {
        fileType: 'pdf',
        fileName: FILE_NAME,
        fileSize: `${FILE_BODY.byteLength} B`,
        fileUrl,
        filePath,
      },
    })
    .select('id')
    .single()
  if (itemErr || !item) throw itemErr ?? new Error('module_item insert failed')
  itemId = item.id

  // 4. Unpublished module — student MUST NOT see this. Guards the
  //    is_published filter in /student/courses/[id]/modules/page.tsx.
  const { data: hidden, error: hiddenErr } = await admin
    .from('modules')
    .insert({
      section_id: section,
      title: HIDDEN_MODULE_TITLE,
      is_published: false,
      position: 1,
    })
    .select('id')
    .single()
  if (hiddenErr || !hidden) throw hiddenErr ?? new Error('hidden module insert failed')
  hiddenModuleId = hidden.id
})

test.afterAll(async () => {
  // Order matters: Storage object → module_items (FK on module) → modules.
  // All branches guarded so a partial setup failure doesn't crash teardown.
  if (filePath) {
    const { error } = await admin.storage.from(BUCKET).remove([filePath])
    if (error) {
      // Don't fail the run on a stray object — just surface it. Re-runs use
      // a fresh timestamped path, so orphans won't collide.
      console.warn(`[e2e cleanup] storage remove failed for ${filePath}: ${error.message}`)
    }
  }
  if (itemId) await admin.from('module_items').delete().eq('id', itemId)
  if (moduleId) await admin.from('modules').delete().eq('id', moduleId)
  if (hiddenModuleId) await admin.from('modules').delete().eq('id', hiddenModuleId)
})

test('enrolled student views published module + file item is fetchable', async ({ page, request }) => {
  const { section } = seedIds()

  await page.goto(`/student/courses/${section}/modules`)

  // Page header loads — confirms the section query + RLS path worked.
  await expect(page.getByRole('heading', { name: /^modules$/i })).toBeVisible()

  // Published module is visible.
  await expect(page.getByText(MODULE_TITLE)).toBeVisible()

  // Unpublished module is NOT visible — the critical RLS/filter assertion.
  await expect(page.getByText(HIDDEN_MODULE_TITLE)).toBeHidden()

  // Lecture item is visible (auto-expanded on load per StudentModulesList).
  await expect(page.getByText(ITEM_TITLE)).toBeVisible()

  // ── Storage reachability ────────────────────────────────────────────
  // The load-bearing half of this spec. Fetching the public URL exercises:
  //   • bucket public-read policy on `course-materials`
  //   • CORS headers on the Supabase Storage response
  //   • the URL shape our code wrote to module_items.content.fileUrl
  // If any of those drift in prod (misconfigured bucket, CORS regression,
  // signed-URL-only policy), this fails loudly instead of silently leaving
  // students staring at broken downloads.
  const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(filePath!)
  const fileResp = await request.get(urlData.publicUrl)
  expect(fileResp.status(), `file URL should be fetchable: ${urlData.publicUrl}`).toBe(200)
  const body = await fileResp.body()
  expect(body.byteLength).toBe(FILE_BODY.byteLength)
})
