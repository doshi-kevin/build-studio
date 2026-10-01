/**
 * Modules Server Actions — CRUD for modules and module items.
 *
 * Verifies the professor owns the section before any mutation.
 * Uses admin client for DB operations (bypasses RLS).
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import { isUnlockPending } from '@/lib/modules/unlock'
import { signModuleItemContent } from '@/lib/supabase/signed-urls'
import { COURSE_MATERIALS_BUCKET, isSafeStoragePath } from '@/lib/supabase/storage'
import { triggerPrimer } from '@/lib/preclass-audio/trigger'
import { generatePrimer } from '@/lib/preclass-audio/generate'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { EMBED_MATERIAL_JOB_TYPE } from '@/lib/jobs/pipelines/embed-material'
import {
  createModuleSchema,
  updateModuleSchema,
  moduleDividerSchema,
  dividerRestoreIdSchema,
  reorderModuleListSchema,
  createModuleItemSchema,
  updateModuleItemSchema,
  type CreateModuleInput,
  type UpdateModuleInput,
  type ModuleDividerInput,
  type CreateModuleItemInput,
  type UpdateModuleItemInput,
} from '@/lib/validations/module'

interface ModuleItemRow {
  id: string
  module_id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/**
 * Thin wrapper kept for legacy call-site readability; delegates to the
 * shared `signModuleItemContent` helper which signs both the main file and
 * every extracted image in one batch.
 */
async function attachContentSignedUrls(items: ModuleItemRow[]): Promise<ModuleItemRow[]> {
  return signModuleItemContent(items)
}

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyOwnership(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: section, error } = await adminDb
    .from('course_sections')
    .select('id, professor_id, institution_id')
    .eq('id', sectionId)
    .single()

  if (error || !section) return { owned: false as const, adminDb, institutionId: null }
  if (section.professor_id !== userId) return { owned: false as const, adminDb, institutionId: null }
  return { owned: true as const, adminDb, institutionId: section.institution_id as string }
}

/**
 * Enqueue the vector-embedding reconcile job for one material (create,
 * re-upload, and delete all funnel here — the pipeline converges on current
 * state). Best-effort: never fails the calling action; the sweep re-kicks
 * lost kicks and a later edit re-enqueues.
 * Caller MUST have passed verifyOwnership(sectionId) already.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enqueueMaterialEmbedding(adminDb: any, sectionId: string, moduleItemId: string, userId: string) {
  try {
    const { data: section } = await adminDb
      .from('course_sections')
      .select('institution_id')
      .eq('id', sectionId)
      .single()
    if (!section) return
    await enqueueJob({
      type: EMBED_MATERIAL_JOB_TYPE,
      params: { moduleItemId },
      institutionId: section.institution_id,
      sectionId,
      createdBy: userId,
      subjectKey: moduleItemId,
    })
  } catch (error) {
    logger.warn('enqueueMaterialEmbedding: enqueue failed (non-fatal)', { moduleItemId, error })
  }
}

/**
 * True when a module item's `content.filePath` is confined to this section's own
 * storage prefix.
 *
 * `content` is a free-form JSON blob on the way in, so `filePath` is attacker-settable
 * by anyone who can write a module item — including a professor writing into a section
 * they legitimately own. It is later handed to RLS-bypassing admin-client downloads
 * (the extraction worker, the embedding pipeline, /api/extraction/page, deck promotion),
 * which authorize the ITEM but never re-check the path. Pointing it at another
 * institution's object therefore turned those readers into a cross-tenant read.
 *
 * Binding the path at the point the untrusted value enters closes every one of those
 * readers at once. Same predicate the sibling registerQuizUpload already applies.
 * Verified against prod before shipping: all 46 module_items rows carrying a filePath
 * already start with their own section id, so this rejects nothing legitimate.
 */
function contentFilePathInSection(content: unknown, sectionId: string): boolean {
  const c = (content ?? {}) as { filePath?: unknown }
  if (typeof c.filePath !== 'string' || c.filePath.length === 0) return true
  return isSafeStoragePath(c.filePath, `${sectionId}/`)
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}`
}

/**
 * The professor's Modules board. Everything now renders here — the old
 * /modules/[moduleId] editor is a redirect shim, so revalidating that path
 * invalidated a page nobody sees.
 */
function modulesPath(sectionId: string) {
  return `/professor/courses/${sectionId}/modules`
}

/**
 * The student's Modules board. Publishing a module or showing an item changes
 * what students see, so their cached page has to be invalidated too — it never
 * was before, which left students on stale content until they navigated.
 */
function studentModulesPath(sectionId: string) {
  return `/student/courses/${sectionId}/modules`
}

// ── Module Actions ───────────────────────────────────────────────

export async function getModules(sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', data: [] }

  const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!owned) return { error: 'You do not own this course section', data: [] }

  const { data: modules, error } = await adminDb
    .from('modules')
    .select('*')
    .eq('section_id', sectionId)
    .order('position', { ascending: true })

  if (error) {
    logger.error('getModules: Fetch failed', error, { sectionId })
    return { error: 'Failed to load modules', data: [] }
  }

  // Get item counts per module
  const moduleIds = (modules || []).map((m: { id: string }) => m.id)
  let itemCounts: Record<string, number> = {}
  if (moduleIds.length > 0) {
    const { data: items } = await adminDb
      .from('module_items')
      .select('module_id')
      .in('module_id', moduleIds)

    if (items) {
      itemCounts = (items as { module_id: string }[]).reduce(
        (acc: Record<string, number>, item: { module_id: string }) => {
          acc[item.module_id] = (acc[item.module_id] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      )
    }
  }

  return { data: modules || [], itemCounts }
}

export async function createModule(
  sectionId: string,
  input: CreateModuleInput,
): Promise<{ success?: boolean; error?: string; moduleId?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createModuleSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    /* Append one past the last row of EITHER table: modules and dividers share
       ONE position scale (see reorderModules), so measuring only `modules` puts a
       new module on top of any divider sitting past the last module — and
       mergeModuleRows then breaks that tie in the module's favour, silently
       reordering the two. Mirrors createModuleDivider. */
    const [lastModule, lastDivider] = await Promise.all([
      adminDb.from('modules').select('position').eq('section_id', sectionId)
        .order('position', { ascending: false }).limit(1),
      adminDb.from('module_dividers').select('position').eq('section_id', sectionId)
        .order('position', { ascending: false }).limit(1),
    ])

    const nextPosition = Math.max(
      lastModule.data?.[0]?.position ?? -1,
      lastDivider.data?.[0]?.position ?? -1,
    ) + 1

    // .select() the new row so callers (e.g. the AI assistant's module-draft
    // approval) can attach items to the module they just created.
    const { data: created, error: insertError } = await adminDb
      .from('modules')
      .insert({
        section_id: sectionId,
        title: parsed.data.title,
        description: parsed.data.description || '',
        week_number: parsed.data.week_number ?? null,
        position: nextPosition,
        is_published: parsed.data.is_published,
        unlock_date: parsed.data.unlock_date || null,
        instructor_note: parsed.data.instructor_note || '',
        coverage_state: parsed.data.coverage_state ?? 'active',
      })
      .select('id')
      .single()

    if (insertError || !created) {
      logger.error('createModule: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create module' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module.created',
      eventCategory: 'professor',
      metadata: { sectionId, title: parsed.data.title },
      sectionId,
    })

    // Notify enrolled students only when the module is created already published AND the
    // professor left "Notify students" on. A draft notifies later, when updateModule
    // publishes it. `notify` is a transient control (defaults true), not a stored column.
    // A future `unlock_date` also holds the notice back: "New module" that deep-links to
    // a week the student can't open is a broken promise. See the note in updateModule.
    if (parsed.data.is_published && parsed.data.notify !== false && !isUnlockPending(parsed.data.unlock_date)) {
      const week = parsed.data.week_number
      await emitEvent({
        type: 'module_published',
        sectionId,
        actorId: user.id,
        entity: { type: 'module', id: created.id },
        title: `New module: ${parsed.data.title}${week ? ` (Week ${week})` : ''}`,
        // Deep-link to the module: the student per-module route is a shim that opens it on
        // the modules board.
        linkUrl: `/student/courses/${sectionId}/modules/${created.id}`,
      })
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true, moduleId: created.id }
  } catch (error) {
    logger.error('createModule: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateModule(
  moduleId: string,
  sectionId: string,
  input: UpdateModuleInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateModuleSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // `notify` is a transient publish control, not a column — pull it out before the write.
    const { notify, ...moduleData } = parsed.data
    const updateData = { ...moduleData, updated_at: new Date().toISOString() }
    if ('unlock_date' in updateData && updateData.unlock_date === '') {
      updateData.unlock_date = null
    }

    // Read whether students could actually SEE this module BEFORE the write, so the notice
    // below can fire on a genuine transition (closed → open) rather than on any edit-save.
    // "Open" is both halves: published AND past its unlock date — a module can open by
    // either changing, so neither alone is the trigger.
    const { data: before } = await adminDb
      .from('modules')
      .select('is_published, unlock_date')
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      .maybeSingle()
    const wasOpen = before?.is_published === true && !isUnlockPending(before?.unlock_date)

    const { data: updated, error: updateError } = await adminDb
      .from('modules')
      .update(updateData)
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      // is_published/unlock_date come back so the notice below can ask "is this
      // module NOW open to students?" without a second read.
      .select('title, week_number, is_published, unlock_date')
      .maybeSingle()

    if (updateError) {
      logger.error('updateModule: Update failed', updateError, { moduleId, sectionId })
      return { error: 'Failed to update module' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module.updated',
      eventCategory: 'professor',
      metadata: { sectionId, moduleId },
      sectionId,
    })

    /* Notify enrolled students when this edit OPENS the module to them — unless the
       professor chose to publish silently (notify === false).

       The trigger is the transition closed → open, not any particular field, because two
       different edits can open a module and both should notify: setting is_published, and
       clearing/backdating `unlock_date` on one that is already published (what the row's
       "Open to students now" does). Reading `wasOpen` before the write is what makes it a
       transition — a plain retitle of a live module leaves wasOpen true and stays quiet,
       and publishing behind a future date leaves nowOpen false, so the notice waits for
       the edit that actually opens it ("New module" deep-linking to a week they can't
       open is a broken promise).

       `onDuplicate: 'refresh'` re-surfaces the notice when a module closes and opens again
       (unpublish → republish, or re-locking behind a new date). The one-shot
       (recipient, type, module) dedup key would otherwise swallow the second opening and
       send nothing. Safe precisely because the gate is a transition: a re-save can't reach
       this line, so refresh can't spam. Mirrors the assignment publish path.

       Known gap: an unlock_date that simply ARRIVES fires no notice, because nothing runs
       at that instant. Closing it needs a scheduled job (Cloud Scheduler hitting a route
       that emits for modules whose date has just passed) — not built. */
    const nowOpen = updated?.is_published === true && !isUnlockPending(updated?.unlock_date)
    if (!wasOpen && nowOpen && notify !== false && updated?.title) {
      const week = updated.week_number
      await emitEvent({
        type: 'module_published',
        sectionId,
        actorId: user.id,
        entity: { type: 'module', id: moduleId },
        title: `New module: ${updated.title}${week ? ` (Week ${week})` : ''}`,
        // Deep-link to the module: the student per-module route is a shim that opens it on
        // the modules board.
        linkUrl: `/student/courses/${sectionId}/modules/${moduleId}`,
        // Re-announce every time the module opens again, not once forever.
        onDuplicate: 'refresh',
      })
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateModule: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteModule(
  moduleId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: deleteError } = await adminDb
      .from('modules')
      .delete()
      .eq('id', moduleId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteModule: Delete failed', deleteError, { moduleId, sectionId })
      return { error: 'Failed to delete module' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module.deleted',
      eventCategory: 'professor',
      metadata: { sectionId, moduleId },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteModule: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/** One row of the Modules page list — a module or a module-level divider. */
export type ModuleListEntry = { id: string; kind: 'module' | 'divider' }

/**
 * Reorder the Modules page list. Modules and dividers interleave in ONE list, so
 * both tables are rewritten with the same 0..n-1 position scale — that shared
 * scale is what lets the roadmap sort them together into a single sequence.
 */
export async function reorderModules(
  sectionId: string,
  entries: ModuleListEntry[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = reorderModuleListSchema.safeParse(entries)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid order' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Update positions in batch
    const updates = parsed.data.map((entry, index) =>
      adminDb
        .from(entry.kind === 'divider' ? 'module_dividers' : 'modules')
        .update({ position: index, updated_at: new Date().toISOString() })
        .eq('id', entry.id)
        .eq('section_id', sectionId)
    )

    const results = await Promise.all(updates)
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      logger.error('reorderModules: Update failed', failed.error, { sectionId })
      return { error: 'Failed to reorder modules' }
    }

    // Curriculum order is course structure — log the change, not the id list.
    logEvent({
      userId: user.id,
      eventType: 'modules.reordered',
      eventCategory: 'professor',
      metadata: { sectionId, count: parsed.data.length },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('reorderModules: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Module Divider Actions ───────────────────────────────────────
//
// A divider is a labelled break BETWEEN modules — no items, no publish state.
// It shares modules' position scale (see reorderModules) and surfaces on the
// roadmap as a divider annotation across the map.

export async function createModuleDivider(
  sectionId: string,
  input: ModuleDividerInput,
  /**
   * Undo only: re-insert the divider under its ORIGINAL id instead of a fresh
   * one, so an undone delete restores the same row rather than a lookalike.
   * Ordering is position-driven today, so a new id was cosmetic — but a deep
   * link or an analytics event keyed on a divider id would break across an undo.
   *
   * Safe to accept from the client: it only names the PK of a row in a section
   * ownership is already verified for, `institution_id` still comes from that
   * verified section, and a UUID that collides with a live row fails the insert
   * (PK conflict) rather than overwriting anything.
   */
  restoreId?: string,
): Promise<{ success?: boolean; error?: string; dividerId?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = moduleDividerSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid label' }

    if (restoreId !== undefined && !dividerRestoreIdSchema.safeParse(restoreId).success) {
      return { error: 'Invalid divider' }
    }

    const { owned, adminDb, institutionId } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Append: one past the last row of EITHER table, since both share the scale.
    const [lastModule, lastDivider] = await Promise.all([
      adminDb.from('modules').select('position').eq('section_id', sectionId)
        .order('position', { ascending: false }).limit(1),
      adminDb.from('module_dividers').select('position').eq('section_id', sectionId)
        .order('position', { ascending: false }).limit(1),
    ])
    const highest = Math.max(
      lastModule.data?.[0]?.position ?? -1,
      lastDivider.data?.[0]?.position ?? -1,
    )

    // .select() the new row so the caller can scroll it into view (it lands at
    // the end of a long list, well below where the professor clicked) and so an
    // undo can put it back where the deleted one was.
    const { data: created, error: insertError } = await adminDb
      .from('module_dividers')
      .insert({
        section_id: sectionId,
        institution_id: institutionId,
        title: parsed.data.title,
        position: highest + 1,
        ...(restoreId ? { id: restoreId } : {}),
      })
      .select('id')
      .single()

    if (insertError || !created) {
      logger.error('createModuleDivider: Insert failed', insertError, { sectionId })
      return { error: 'Failed to add divider' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_divider.created',
      eventCategory: 'professor',
      metadata: { sectionId, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true, dividerId: created.id as string }
  } catch (error) {
    logger.error('createModuleDivider: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateModuleDivider(
  dividerId: string,
  sectionId: string,
  input: ModuleDividerInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = moduleDividerSchema.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid label' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: updateError } = await adminDb
      .from('module_dividers')
      .update({ title: parsed.data.title, updated_at: new Date().toISOString() })
      .eq('id', dividerId)
      .eq('section_id', sectionId)

    if (updateError) {
      logger.error('updateModuleDivider: Update failed', updateError, { dividerId, sectionId })
      return { error: 'Failed to rename divider' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_divider.updated',
      eventCategory: 'professor',
      metadata: { sectionId, dividerId },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateModuleDivider: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteModuleDivider(
  dividerId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: deleteError } = await adminDb
      .from('module_dividers')
      .delete()
      .eq('id', dividerId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteModuleDivider: Delete failed', deleteError, { dividerId, sectionId })
      return { error: 'Failed to remove divider' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_divider.deleted',
      eventCategory: 'professor',
      metadata: { sectionId, dividerId },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteModuleDivider: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Module Item Actions ──────────────────────────────────────────

export async function getModuleWithItems(moduleId: string, sectionId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated', module: null, items: [] }

  const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
  if (!owned) return { error: 'You do not own this course section', module: null, items: [] }

  const { data: mod, error: modError } = await adminDb
    .from('modules')
    .select('*')
    .eq('id', moduleId)
    .eq('section_id', sectionId)
    .single()

  if (modError || !mod) {
    return { error: 'Module not found', module: null, items: [] }
  }

  const { data: items, error: itemsError } = await adminDb
    .from('module_items')
    .select('*')
    .eq('module_id', moduleId)
    .order('position', { ascending: true })

  if (itemsError) {
    logger.error('getModuleWithItems: Items fetch failed', itemsError, { moduleId })
    return { module: mod, items: [] }
  }

  /* Replace each item's content.fileUrl with a fresh signed URL minted from
   * content.filePath. The course-materials bucket is private (mig 48); legacy
   * public URLs no longer resolve. */
  const itemsWithSignedUrls = await attachContentSignedUrls((items || []) as ModuleItemRow[])

  return { module: mod, items: itemsWithSignedUrls }
}

export async function createModuleItem(
  moduleId: string,
  sectionId: string,
  input: CreateModuleItemInput,
): Promise<{ success?: boolean; moduleItemId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createModuleItemSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Verify module belongs to section
    const { data: mod } = await adminDb
      .from('modules')
      .select('id')
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      .single()

    if (!mod) return { error: 'Module not found' }

    if (!contentFilePathInSection(parsed.data.content, sectionId)) {
      logger.warn('createModuleItem: filePath outside section prefix blocked', { sectionId, moduleId, userId: user.id })
      return { error: 'Invalid file path' }
    }

    // Get next position
    const { data: existing } = await adminDb
      .from('module_items')
      .select('position')
      .eq('module_id', moduleId)
      .order('position', { ascending: false })
      .limit(1)

    const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0

    const { data: inserted, error: insertError } = await adminDb
      .from('module_items')
      .insert({
        module_id: moduleId,
        item_type: parsed.data.item_type,
        title: parsed.data.title || '',
        description: parsed.data.description || '',
        position: nextPosition,
        content: parsed.data.content || {},
        is_visible: parsed.data.is_visible,
        instructor_note: parsed.data.instructor_note || '',
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      logger.error('createModuleItem: Insert failed', insertError, { moduleId })
      return { error: 'Failed to create item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_item.created',
      eventCategory: 'professor',
      metadata: { sectionId, moduleId, itemType: parsed.data.item_type },
      sectionId,
    })

    // Background: embed PDF pages into the vector store (data-intelligence layer).
    await enqueueMaterialEmbedding(adminDb, sectionId, inserted.id, user.id)

    // Revalidate the module detail page (where the new item renders) so it shows
    // without a manual reload — the section root alone doesn't cover this route.
    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true, moduleItemId: inserted.id }
  } catch (error) {
    logger.error('createModuleItem: Unexpected error', error, { moduleId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateModuleItem(
  itemId: string,
  moduleId: string,
  sectionId: string,
  input: UpdateModuleItemInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateModuleItemSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Verify the module (and thus the item) belongs to this section — prevents
    // an owner of one section from mutating another section's module items.
    const { data: mod } = await adminDb
      .from('modules')
      .select('id')
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      .single()
    if (!mod) {
      logger.warn('updateModuleItem: cross-section attempt blocked', { sectionId, moduleId, itemId, userId: user.id })
      return { error: 'Module not found' }
    }

    if (!contentFilePathInSection(parsed.data.content, sectionId)) {
      logger.warn('updateModuleItem: filePath outside section prefix blocked', { sectionId, moduleId, itemId, userId: user.id })
      return { error: 'Invalid file path' }
    }

    const { error: updateError } = await adminDb
      .from('module_items')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('module_id', moduleId)

    if (updateError) {
      logger.error('updateModuleItem: Update failed', updateError, { itemId, moduleId })
      return { error: 'Failed to update item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_item.updated',
      eventCategory: 'professor',
      metadata: { sectionId, moduleId, itemId },
      sectionId,
    })

    // Background: reconcile the vector store when the file content changed —
    // new/replaced PDF re-embeds; a PDF swapped for something else needs its
    // stale vectors removed (only worth a job if any chunks exist).
    /* Unconditional: the pipeline is convergent, so it decides what this
       material now warrants — index its pages, index its text, or remove
       vectors it should no longer have. Gating here meant guessing that from
       the file extension alone, which is how text-bearing formats ended up
       silently un-indexed. */
    if (parsed.data.content !== undefined) {
      await enqueueMaterialEmbedding(adminDb, sectionId, itemId, user.id)
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateModuleItem: Unexpected error', error, { moduleId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteModuleItem(
  itemId: string,
  moduleId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Verify the module (and thus the item) belongs to this section — prevents
    // an owner of one section from deleting another section's module items.
    const { data: mod } = await adminDb
      .from('modules')
      .select('id')
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      .single()
    if (!mod) {
      logger.warn('deleteModuleItem: cross-section attempt blocked', { sectionId, moduleId, itemId, userId: user.id })
      return { error: 'Module not found' }
    }

    // Snapshot BEFORE the delete — the chunk rows cascade away with the item,
    // but Pinecone needs an explicit cleanup job (it has no FK to cascade).
    const { count: chunkCount } = await adminDb
      .from('material_vector_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('module_item_id', itemId)

    const { error: deleteError } = await adminDb
      .from('module_items')
      .delete()
      .eq('id', itemId)
      .eq('module_id', moduleId)

    if (deleteError) {
      logger.error('deleteModuleItem: Delete failed', deleteError, { itemId, moduleId })
      return { error: 'Failed to delete item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_item.deleted',
      eventCategory: 'professor',
      metadata: { sectionId, moduleId, itemId },
      sectionId,
    })

    // Background: the item is gone — the reconcile job removes its vectors.
    if ((chunkCount ?? 0) > 0) {
      await enqueueMaterialEmbedding(adminDb, sectionId, itemId, user.id)
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteModuleItem: Unexpected error', error, { moduleId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function reorderModuleItems(
  moduleId: string,
  sectionId: string,
  orderedIds: string[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Verify the module belongs to this section before reordering its items —
    // prevents reordering another section's module items.
    const { data: mod } = await adminDb
      .from('modules')
      .select('id')
      .eq('id', moduleId)
      .eq('section_id', sectionId)
      .single()
    if (!mod) return { error: 'Module not found' }

    const updates = orderedIds.map((id, index) =>
      adminDb
        .from('module_items')
        .update({ position: index, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('module_id', moduleId)
    )

    const results = await Promise.all(updates)
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      logger.error('reorderModuleItems: Update failed', failed.error, { moduleId })
      return { error: 'Failed to reorder items' }
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('reorderModuleItems: Unexpected error', error, { moduleId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Move an item into a different module, landing at `toIndex`.
 *
 * The one-page board puts every module on screen at once, which makes dragging
 * an item from one module to another the obvious gesture — there was no way to
 * do it before, and `reorderModuleItems` scopes each update with
 * `.eq('module_id', …)`, so a cross-module drop would silently match zero rows.
 *
 * Positions are renumbered densely in BOTH modules afterwards so neither is
 * left with gaps or duplicates. Like the sibling reorder actions this is a set
 * of individual updates rather than one transaction; a partial failure is
 * reported and self-heals on the next reorder, since position is only ever
 * read as a sort key.
 */
export async function moveModuleItem(
  itemId: string,
  fromModuleId: string,
  toModuleId: string,
  sectionId: string,
  toIndex: number,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    if (fromModuleId === toModuleId) {
      return { error: 'Item is already in this module' }
    }

    // Both modules must belong to THIS section — otherwise a crafted call could
    // pull an item out of, or push one into, another section's module.
    const { data: mods } = await adminDb
      .from('modules')
      .select('id')
      .eq('section_id', sectionId)
      .in('id', [fromModuleId, toModuleId])
    if (!mods || mods.length !== 2) return { error: 'Module not found' }

    // …and the item must currently live in the source module.
    const { data: item } = await adminDb
      .from('module_items')
      .select('id')
      .eq('id', itemId)
      .eq('module_id', fromModuleId)
      .single()
    if (!item) return { error: 'Item not found' }

    const { data: targetItems } = await adminDb
      .from('module_items')
      .select('id')
      .eq('module_id', toModuleId)
      .order('position', { ascending: true })

    const targetIds = ((targetItems ?? []) as { id: string }[]).map((i) => i.id)
    const insertAt = Math.max(0, Math.min(toIndex, targetIds.length))
    targetIds.splice(insertAt, 0, itemId)

    const { error: moveError } = await adminDb
      .from('module_items')
      .update({ module_id: toModuleId, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('module_id', fromModuleId)

    if (moveError) {
      logger.error('moveModuleItem: Move failed', moveError, { itemId, toModuleId })
      return { error: 'Failed to move item' }
    }

    const { data: sourceItems } = await adminDb
      .from('module_items')
      .select('id')
      .eq('module_id', fromModuleId)
      .order('position', { ascending: true })
    const sourceIds = ((sourceItems ?? []) as { id: string }[]).map((i) => i.id)

    const renumber = [
      ...targetIds.map((id, index) =>
        adminDb
          .from('module_items')
          .update({ position: index, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('module_id', toModuleId),
      ),
      ...sourceIds.map((id, index) =>
        adminDb
          .from('module_items')
          .update({ position: index, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('module_id', fromModuleId),
      ),
    ]
    const results = await Promise.all(renumber)
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      logger.error('moveModuleItem: Renumber failed', failed.error, { itemId, toModuleId })
      return { error: 'Moved the item, but its order may be off — try reordering again' }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_item.moved',
      eventCategory: 'professor',
      metadata: { sectionId, itemId, fromModuleId, toModuleId },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('moveModuleItem: Unexpected error', error, { itemId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Document Extraction ──────────────────────────────────────────

import { parseDocument, downloadFileBuffer, getTextForLLM, type RawImage, type ExtractedImage } from '@/lib/document-parser'
import { MAX_EXTRACTION_SIZE } from '@/lib/document-parser/utils'
import { extractTopicsFromContent } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import { enqueueExtractionJob } from '@/lib/extraction/enqueue'

/**
 * V2 extraction entry point — enqueues a job against the new worker
 * queue (PR 3+). Gated behind EXTRACTION_V2_ENABLED so we can toggle
 * it per-environment. When disabled, the legacy fire-and-forget
 * extractDocumentContent() below stays in charge.
 *
 * Verifies professor ownership of the section before enqueueing.
 */
export async function enqueueExtractionJobAction(
  moduleItemId: string,
  sectionId: string,
): Promise<{ jobId?: string; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Verify the item belongs to this section before enqueueing — prevents
    // triggering extraction on another section's module item.
    const { data: itemRow } = await adminDb
      .from('module_items')
      .select('module_id, modules!inner(section_id)')
      .eq('id', moduleItemId)
      .eq('modules.section_id', sectionId)
      .single()
    if (!itemRow) return { error: 'Module item not found' }

    // Institution/platform AI kill switch — refuse at enqueue time with a clear
    // message (the worker would only skip it silently later).
    const aiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'content-ai')
    if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

    const result = await enqueueExtractionJob({ moduleItemId, sectionId })
    return { jobId: result.jobId }
  } catch (err) {
    logger.error('enqueueExtractionJobAction: failed', err, { moduleItemId })
    return { error: err instanceof Error ? err.message : 'Failed to enqueue extraction' }
  }
}

/**
 * Returns true when EXTRACTION_V2_ENABLED (or the
 * NEXT_PUBLIC_ prefixed mirror) is truthy. Client components call
 * this via the action boundary; server-side checks can read the
 * env var directly.
 */
export async function isExtractionV2Enabled(): Promise<boolean> {
  const v = process.env.EXTRACTION_V2_ENABLED ?? process.env.NEXT_PUBLIC_EXTRACTION_V2_ENABLED
  if (!v) return false
  const normalized = v.toLowerCase().trim()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * Extract text content from a PDF or PPT module item.
 * Downloads the file from Supabase Storage, parses it with officeparser,
 * and stores the extracted content in module_items.content.extraction.
 *
 * Designed to be called fire-and-forget after createModuleItem succeeds.
 */
export async function extractDocumentContent(
  moduleItemId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Fetch the module item to get file info. The modules!inner(section_id)
    // join + section filter binds the item to this section, preventing
    // extraction/overwrite of another section's module item.
    const { data: item, error: fetchError } = await adminDb
      .from('module_items')
      .select('id, content, item_type, modules!inner(section_id)')
      .eq('id', moduleItemId)
      .eq('modules.section_id', sectionId)
      .single()

    if (fetchError || !item) {
      logger.error('extractDocumentContent: Item not found', fetchError, { moduleItemId })
      return { error: 'Module item not found' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (item.content || {}) as Record<string, any>
    const fileType = content.fileType as string
    const filePath = content.filePath as string
    const fileSize = Number(content.fileSize) || 0

    // Guard: this legacy officeparser path only handles PDF/PPT. The newer types
    // (docx/xlsx native, image→vision) are extracted exclusively by the v2 worker;
    // skip them here rather than mis-parsing.
    if (fileType !== 'pdf' && fileType !== 'ppt') {
      return { error: 'Unsupported file type for extraction' }
    }

    if (!filePath) {
      return { error: 'No file path found' }
    }

    // Guard: skip files that are too large
    if (fileSize > MAX_EXTRACTION_SIZE) {
      await adminDb
        .from('module_items')
        .update({
          content: {
            ...content,
            extraction: {
              status: 'failed',
              extractedAt: new Date().toISOString(),
              error: 'File too large for extraction (max 100MB)',
              metadata: { pageCount: 0, wordCount: 0 },
              pages: [],
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', moduleItemId)

      return { error: 'File too large for extraction' }
    }

    // Set processing status immediately so UI reflects it
    await adminDb
      .from('module_items')
      .update({
        content: {
          ...content,
          extraction: {
            status: 'processing',
            extractedAt: new Date().toISOString(),
            error: null,
            metadata: { pageCount: 0, wordCount: 0 },
            pages: [],
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', moduleItemId)

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))

    // Download and parse
    const buffer = await downloadFileBuffer(filePath)
    const parseResult = await parseDocument(buffer)

    // Upload extracted images to Supabase Storage (best-effort)
    const rawImages: RawImage[] = (parseResult as { _rawImages?: RawImage[] })._rawImages || []
    const extractedImages: ExtractedImage[] = []

    if (rawImages.length > 0) {
      const imageFolder = `extracted-images/${sectionId}/${moduleItemId}`
      for (const img of rawImages.slice(0, 50)) { // cap at 50 images per document
        try {
          const imgBuffer = Buffer.from(img.data, 'base64')
          const imgPath = `${imageFolder}/${img.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

          const { error: uploadErr } = await adminDb.storage
            .from(COURSE_MATERIALS_BUCKET)
            .upload(imgPath, imgBuffer, {
              contentType: img.mimeType,
              cacheControl: '31536000',
              upsert: true,
            })

          if (!uploadErr) {
            const { data: urlData } = adminDb.storage
              .from(COURSE_MATERIALS_BUCKET)
              .getPublicUrl(imgPath)

            extractedImages.push({
              url: urlData.publicUrl,
              path: imgPath,
              name: img.name,
              mimeType: img.mimeType,
              altText: img.altText,
            })
          } else {
            logger.warn('extractDocumentContent: Image upload failed', { name: img.name, error: uploadErr.message })
          }
        } catch (imgErr) {
          logger.warn('extractDocumentContent: Image processing failed', { name: img.name, error: String(imgErr) })
        }
      }
    }

    // Build final extraction result (without raw base64 data)
    const extraction = {
      status: parseResult.status,
      extractedAt: parseResult.extractedAt,
      error: parseResult.error,
      metadata: { ...parseResult.metadata, imageCount: extractedImages.length },
      pages: parseResult.pages,
      images: extractedImages.length > 0 ? extractedImages : undefined,
    }

    // Store extraction result
    const { error: updateError } = await adminDb
      .from('module_items')
      .update({
        content: { ...content, extraction },
        updated_at: new Date().toISOString(),
      })
      .eq('id', moduleItemId)

    if (updateError) {
      logger.error('extractDocumentContent: Update failed', updateError, { moduleItemId })
      return { error: 'Failed to store extraction result' }
    }

    // ── Topic extraction (best-effort, non-blocking failure) ──
    // Institution/platform AI kill switch: the deterministic officeparser text
    // extraction above is NOT AI and always runs; only this LLM step is gated.
    const topicAiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'content-ai')
    let topicCount = 0
    if (topicAiVerdict.allowed && extraction.status === 'completed' && extraction.pages.length > 0) {
      try {
        const llmText = getTextForLLM(extraction.pages, extraction.metadata)
        const truncatedText = llmText.slice(0, 100_000)
        const extracted = await extractTopicsFromContent(truncatedText, { sectionId })

        if (extracted && extracted.topics.length > 0) {
          topicCount = extracted.topics.length
          // Re-fetch content to avoid overwriting with stale data
          const { data: freshItem } = await adminDb
            .from('module_items')
            .select('content')
            .eq('id', moduleItemId)
            .single()

          if (freshItem) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const freshContent = (freshItem.content || {}) as Record<string, any>
            await adminDb
              .from('module_items')
              .update({
                content: {
                  ...freshContent,
                  topics: extracted.topics,
                  ...(extracted.summary ? { summary: extracted.summary } : {}),
                },
                updated_at: new Date().toISOString(),
              })
              .eq('id', moduleItemId)
          }
        }
      } catch (topicErr) {
        logger.warn('extractDocumentContent: Topic extraction failed (non-critical)', {
          moduleItemId,
          error: topicErr instanceof Error ? topicErr.message : String(topicErr),
        })
      }
    }

    logEvent({
      userId: user.id,
      eventType: 'module_item.extraction_completed',
      eventCategory: 'professor',
      metadata: {
        sectionId,
        moduleItemId,
        status: extraction.status,
        pageCount: extraction.metadata.pageCount,
        wordCount: extraction.metadata.wordCount,
        topicCount,
      },
      sectionId,
    })

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('extractDocumentContent: Unexpected error', error, { moduleItemId })

    // Try to mark as failed in DB
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminDb = createAdminClient() as any
      const { data: item } = await adminDb
        .from('module_items')
        .select('content')
        .eq('id', moduleItemId)
        .single()

      if (item) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = (item.content || {}) as Record<string, any>
        await adminDb
          .from('module_items')
          .update({
            content: {
              ...content,
              extraction: {
                status: 'failed',
                extractedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : 'Unexpected error',
                metadata: { pageCount: 0, wordCount: 0 },
                pages: [],
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', moduleItemId)
      }
    } catch {
      // Best-effort — don't throw from error handler
    }

    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { error: 'An unexpected error occurred during extraction' }
  }
}

// ── Pre-Class Primers (professor-controlled generation) ──────────

/**
 * Turn a lecture's pre-class primer ON — generate it and make it available to
 * students. Professor-only: this is the ONLY way a primer is generated;
 * students never trigger generation. Kicks the async generation route
 * (fire-and-forget) so the professor UI can poll getPrimerStatusForItem for the
 * generating→ready flip; falls back to synchronous in-process generation when
 * no kick secret is set (local dev). Idempotent + herd-safe via the atomic
 * claim, so a fresh primer isn't regenerated.
 */
export async function makePrimerAvailable(
  moduleItemId: string,
  sectionId: string,
  regenerate = false,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Bind the item to this section and confirm it's a lecture (only lectures
    // get primers) — prevents generating against another section's item.
    const { data: item } = await adminDb
      .from('module_items')
      .select('id, item_type, modules!inner(section_id)')
      .eq('id', moduleItemId)
      .eq('modules.section_id', sectionId)
      .single()
    if (!item) return { error: 'Lecture not found' }
    if (item.item_type !== 'lecture') return { error: 'Primers are only available for lectures' }

    // Generate-once: on a plain enable, if a primer was already generated we just
    // flip it back on (serve the existing file — no regeneration). We only
    // generate when there's no audio yet, or when the professor pressed
    // Regenerate (force). This keeps one source of truth no matter how many
    // times the toggle is pressed.
    const { data: existing } = await adminDb
      .from('preclass_primers')
      .select('audio_path')
      .eq('module_item_id', moduleItemId)
      .eq('section_id', sectionId)
      .maybeSingle()

    // Institution/platform AI kill switch — refuse GENERATION up front with a
    // clear message (generatePrimer would refuse anyway, but silently, and the
    // professor would see "success" with no primer ever appearing). Re-enabling
    // an ALREADY-generated primer below is serving stored audio, not an AI
    // call, so it stays allowed.
    const primerAiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'preclass-ai')
    if ((regenerate || !existing?.audio_path) && !primerAiVerdict.allowed) {
      return { error: aiRefusalMessage(primerAiVerdict.lockedBy) }
    }

    if (!regenerate && existing?.audio_path) {
      await adminDb
        .from('preclass_primers')
        .update({ is_available: true })
        .eq('module_item_id', moduleItemId)
        .eq('section_id', sectionId)
    } else {
      // First-time generate or forced regenerate. Ensure the row (if any) is
      // marked available so it surfaces to students the moment it's ready.
      if (existing) {
        await adminDb
          .from('preclass_primers')
          .update({ is_available: true })
          .eq('module_item_id', moduleItemId)
          .eq('section_id', sectionId)
      }
      const { kicked } = await triggerPrimer(moduleItemId, regenerate)
      if (!kicked) await generatePrimer(moduleItemId, regenerate)
    }

    logEvent({
      userId: user.id,
      eventType: regenerate ? 'primer.regenerated' : 'primer.made_available',
      eventCategory: 'professor',
      metadata: { moduleItemId },
      sectionId,
    })
    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (err) {
    logger.error('makePrimerAvailable: failed', err, { moduleItemId })
    return { error: 'Failed to start primer generation' }
  }
}

/**
 * Fetch a primer's transcript + a signed audio URL so the professor can preview
 * exactly what students get. Ownership-checked; section-scoped IDOR guard.
 */
export async function getPrimerPreview(
  sectionId: string,
  moduleItemId: string,
): Promise<{ script?: string; audioUrl?: string; durationSeconds?: number | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { data: row } = await adminDb
      .from('preclass_primers')
      .select('script, audio_path, duration_seconds')
      .eq('module_item_id', moduleItemId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!row?.audio_path) return { error: 'No primer to preview yet' }

    const { data: signed } = await adminDb.storage
      .from('preclass-audio')
      .createSignedUrl(row.audio_path, 60 * 60)
    if (!signed?.signedUrl) return { error: 'Could not load audio' }

    return { script: row.script ?? '', audioUrl: signed.signedUrl, durationSeconds: row.duration_seconds }
  } catch (err) {
    logger.error('getPrimerPreview: failed', err, { moduleItemId })
    return { error: 'Failed to load preview' }
  }
}

/**
 * Turn a lecture's primer OFF — hide it from students WITHOUT deleting the
 * generated audio. Just flips is_available=false, so re-enabling later serves
 * the same file instantly (no regeneration). Professor-only.
 */
export async function disablePrimer(
  moduleItemId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // section_id filter is the IDOR guard. No-op if there's no row yet.
    await adminDb
      .from('preclass_primers')
      .update({ is_available: false })
      .eq('module_item_id', moduleItemId)
      .eq('section_id', sectionId)

    logEvent({
      userId: user.id,
      eventType: 'primer.disabled',
      eventCategory: 'professor',
      metadata: { moduleItemId },
      sectionId,
    })
    revalidatePath(modulesPath(sectionId))
    revalidatePath(studentModulesPath(sectionId))
    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (err) {
    logger.error('disablePrimer: failed', err, { moduleItemId })
    return { error: 'Failed to disable primer' }
  }
}

/**
 * Read a lecture's primer generation status + availability for the professor
 * Modules UI. Polled by the primer control while a generation is in flight.
 * `available` reflects the toggle; `status` reflects generation progress.
 */
export async function getPrimerStatusForItem(
  sectionId: string,
  moduleItemId: string,
): Promise<{ status: 'ready' | 'generating' | 'failed' | 'none'; available: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { status: 'none', available: false, error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { status: 'none', available: false, error: 'You do not own this course section' }

    // The primer row's section_id binds it to this section (set at generation
    // time from the item's module), so filter on it as the IDOR guard.
    const { data: row } = await adminDb
      .from('preclass_primers')
      .select('status, is_available')
      .eq('module_item_id', moduleItemId)
      .eq('section_id', sectionId)
      .maybeSingle()

    return { status: row?.status ?? 'none', available: row?.is_available ?? false }
  } catch (err) {
    logger.error('getPrimerStatusForItem: failed', err, { moduleItemId })
    return { status: 'none', available: false, error: 'Failed to read primer status' }
  }
}
