/**
 * Course Settings Server Actions — manage dates, capacity, status,
 * archive/restore, and clone content from previous sections.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { z } from 'zod'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyOwnership(sectionId: string, userId: string) {
  const adminDb = createAdminClient()
  const { data, error } = await adminDb
    .from('course_sections')
    .select('id, professor_id, status, settings, start_date, end_date, max_students, modality, location')
    .eq('id', sectionId)
    .single()

  if (error || !data) return null
  if (data.professor_id !== userId) return null
  return data
}

// ── Validation ──────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  max_students: z.number().int().min(1).max(500).nullable().optional(),
  modality: z.enum(['in_person', 'online', 'hybrid']).nullable().optional(),
  location: z.string().max(200).trim().nullable().optional(),
  status: z.enum(['draft', 'active']).optional(),
})

type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>

// ── Actions ──────────────────────────────────────────────────────

/**
 * Fetch section settings for the settings form.
 */
export async function getSectionSettings(
  sectionId: string,
): Promise<{ data?: Record<string, unknown>; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const section = await verifyOwnership(sectionId, user.id)
    if (!section) return { error: 'Section not found or not owned by you' }

    return {
      data: {
        start_date: section.start_date,
        end_date: section.end_date,
        max_students: section.max_students,
        modality: section.modality,
        location: section.location,
        status: section.status,
      },
    }
  } catch (error) {
    logger.error('getSectionSettings', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Update section settings (dates, capacity, modality, location, draft/active status).
 * Professors cannot set status to cancelled or archived via this action.
 */
export async function updateSectionSettings(
  sectionId: string,
  input: UpdateSettingsInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const section = await verifyOwnership(sectionId, user.id)
    if (!section) return { error: 'Section not found or not owned by you' }

    const parsed = updateSettingsSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = Object.values(parsed.error.flatten().fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    const updates: Record<string, unknown> = {}
    const data = parsed.data

    if (data.start_date !== undefined) updates.start_date = data.start_date
    if (data.end_date !== undefined) updates.end_date = data.end_date
    if (data.max_students !== undefined) updates.max_students = data.max_students
    if (data.modality !== undefined) updates.modality = data.modality
    if (data.location !== undefined) updates.location = data.location || null
    if (data.status !== undefined) updates.status = data.status

    if (Object.keys(updates).length === 0) return { success: true }

    const adminDb = createAdminClient()
    const { error: updateError } = await adminDb
      .from('course_sections')
      .update(updates)
      .eq('id', sectionId)

    if (updateError) {
      logger.error('updateSectionSettings: DB update failed', updateError, { sectionId })
      return { error: 'Failed to save settings' }
    }

    logEvent({
      userId: user.id,
      eventType: 'section.settings_updated',
      metadata: { sectionId, fields: Object.keys(updates) },
    })

    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    revalidatePath('/professor/courses')
    return { success: true }
  } catch (error) {
    logger.error('updateSectionSettings', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Archive a section. Only allowed from active or inactive status.
 */
export async function archiveSection(
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const section = await verifyOwnership(sectionId, user.id)
    if (!section) return { error: 'Section not found or not owned by you' }

    if (!['active', 'inactive'].includes(section.status)) {
      return { error: `Cannot archive a section with status "${section.status}"` }
    }

    const adminDb = createAdminClient()
    const { error: updateError } = await adminDb
      .from('course_sections')
      .update({ status: 'archived', archived_at: new Date().toISOString() })
      .eq('id', sectionId)

    if (updateError) {
      logger.error('archiveSection: DB update failed', updateError, { sectionId })
      return { error: 'Failed to archive section' }
    }

    logEvent({
      userId: user.id,
      eventType: 'section.archived',
      metadata: { sectionId },
    })

    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    revalidatePath('/professor/courses')
    return { success: true }
  } catch (error) {
    logger.error('archiveSection', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Restore an archived section back to active.
 */
export async function restoreSection(
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const section = await verifyOwnership(sectionId, user.id)
    if (!section) return { error: 'Section not found or not owned by you' }

    if (section.status !== 'archived') {
      return { error: 'Only archived sections can be restored' }
    }

    const adminDb = createAdminClient()
    const { error: updateError } = await adminDb
      .from('course_sections')
      .update({ status: 'active', archived_at: null })
      .eq('id', sectionId)

    if (updateError) {
      logger.error('restoreSection: DB update failed', updateError, { sectionId })
      return { error: 'Failed to restore section' }
    }

    logEvent({
      userId: user.id,
      eventType: 'section.restored',
      metadata: { sectionId },
    })

    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    revalidatePath('/professor/courses')
    return { success: true }
  } catch (error) {
    logger.error('restoreSection', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Get the professor's other sections for the clone source picker.
 */
export async function getProfessorSectionsForClone(
  sectionId: string,
): Promise<{ data?: Array<{ id: string; courseCode: string; courseTitle: string; semester: string; year: number; sectionCode: string; moduleCount: number }>; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: sections, error: sectionsError } = await adminDb
      .from('course_sections')
      .select('id, section_code, semester, year, course:courses(code, title)')
      .eq('professor_id', user.id)
      .neq('id', sectionId)
      .order('year', { ascending: false })
      .order('semester', { ascending: false })

    if (sectionsError) {
      logger.error('getProfessorSectionsForClone: query failed', sectionsError)
      return { error: 'Failed to load sections' }
    }

    if (!sections || sections.length === 0) {
      return { data: [] }
    }

    // Count modules for each section
    const sectionIds = sections.map((s: { id: string }) => s.id)
    const { data: moduleCounts } = await adminDb
      .from('modules')
      .select('section_id')
      .in('section_id', sectionIds)

    const countMap = new Map<string, number>()
    for (const m of moduleCounts || []) {
      countMap.set(m.section_id, (countMap.get(m.section_id) || 0) + 1)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

    return {
      data: sections.map((s: Record<string, unknown>) => {
        const course = resolveJoin(s.course)
        return {
          id: s.id as string,
          courseCode: course?.code || '',
          courseTitle: course?.title || 'Untitled',
          semester: s.semester as string,
          year: s.year as number,
          sectionCode: s.section_code as string,
          moduleCount: countMap.get(s.id as string) || 0,
        }
      }),
    }
  } catch (error) {
    logger.error('getProfessorSectionsForClone', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Clone content from a source section into the target section.
 * Copies: modules + module_items + settings (about, enabledFeatures, sidebar layout).
 * Does NOT copy: enrollments, announcements, grades.
 *
 * `settings.roadmapPositions` may still be present on older sections and is
 * carried along by the settings copy, but nothing reads it: the roadmap computes
 * its own layout, and the canvas that let a professor drag nodes is gone.
 */
export async function cloneFromSection(
  sourceSectionId: string,
  targetSectionId: string,
): Promise<{ success?: boolean; modulesCopied?: number; itemsCopied?: number; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // Verify ownership of both sections
    const [source, target] = await Promise.all([
      verifyOwnership(sourceSectionId, user.id),
      verifyOwnership(targetSectionId, user.id),
    ])

    if (!source) return { error: 'Source section not found or not owned by you' }
    if (!target) return { error: 'Target section not found or not owned by you' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // 1. Fetch source modules
    const { data: sourceModules, error: modulesError } = await adminDb
      .from('modules')
      .select('id, title, description, week_number, position, is_published, unlock_date, instructor_note')
      .eq('section_id', sourceSectionId)
      .order('position', { ascending: true })

    if (modulesError) {
      logger.error('cloneFromSection: modules query failed', modulesError)
      return { error: 'Failed to read source modules' }
    }

    if (!sourceModules || sourceModules.length === 0) {
      // Still copy settings even if no modules — and still log + revalidate, or
      // the copied sidebar layout wouldn't appear on the target until a manual
      // refresh and the clone would go unrecorded.
      const settingsOnly = await copySettings(adminDb, sourceSectionId, targetSectionId)
      if (settingsOnly.error) return { error: settingsOnly.error }

      logEvent({
        userId: user.id,
        eventType: 'section.cloned',
        metadata: { sourceSectionId, targetSectionId, modulesCopied: 0, itemsCopied: 0 },
      })
      revalidatePath(`/professor/courses/${targetSectionId}`, 'layout')
      return { success: true, modulesCopied: 0, itemsCopied: 0 }
    }

    // 2. Fetch source module items
    const sourceModuleIds = sourceModules.map((m: { id: string }) => m.id)
    const { data: sourceItems, error: itemsError } = await adminDb
      .from('module_items')
      .select('id, module_id, item_type, title, description, position, content, is_visible, instructor_note')
      .in('module_id', sourceModuleIds)
      .order('position', { ascending: true })

    if (itemsError) {
      logger.error('cloneFromSection: items query failed', itemsError)
      return { error: 'Failed to read source items' }
    }

    // 3. Delete existing modules in target (cascades to items)
    await adminDb.from('modules').delete().eq('section_id', targetSectionId)

    // 4. Insert cloned modules
    const moduleIdMap = new Map<string, string>() // old ID → new ID
    const newModules = sourceModules.map((m: Record<string, unknown>) => {
      const newId = crypto.randomUUID()
      moduleIdMap.set(m.id as string, newId)
      return {
        id: newId,
        section_id: targetSectionId,
        title: m.title,
        description: m.description,
        week_number: m.week_number,
        position: m.position,
        is_published: m.is_published,
        unlock_date: m.unlock_date,
        instructor_note: m.instructor_note,
      }
    })

    const { error: insertModulesError } = await adminDb.from('modules').insert(newModules)
    if (insertModulesError) {
      logger.error('cloneFromSection: insert modules failed', insertModulesError)
      return { error: 'Failed to copy modules' }
    }

    // 5. Insert cloned items
    let itemsCopied = 0
    if (sourceItems && sourceItems.length > 0) {
      const newItems = sourceItems.map((item: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        module_id: moduleIdMap.get(item.module_id as string),
        item_type: item.item_type,
        title: item.title,
        description: item.description,
        position: item.position,
        content: item.content,
        is_visible: item.is_visible,
        instructor_note: item.instructor_note,
      }))

      const { error: insertItemsError } = await adminDb.from('module_items').insert(newItems)
      if (insertItemsError) {
        logger.error('cloneFromSection: insert items failed', insertItemsError)
        return { error: 'Failed to copy module items' }
      }
      itemsCopied = newItems.length
    }

    // 6. Copy settings (about, enabledFeatures, sidebar layout, customization)
    const settingsResult = await copySettings(adminDb, sourceSectionId, targetSectionId)
    if (settingsResult.error) return { error: settingsResult.error }

    logEvent({
      userId: user.id,
      eventType: 'section.cloned',
      metadata: {
        sourceSectionId,
        targetSectionId,
        modulesCopied: newModules.length,
        itemsCopied,
      },
    })

    revalidatePath(`/professor/courses/${targetSectionId}`, 'layout')
    return { success: true, modulesCopied: newModules.length, itemsCopied }
  } catch (error) {
    logger.error('cloneFromSection', error)
    return { error: 'Unexpected error' }
  }
}

/** Returns `{ error }` if the write fails, so the caller doesn't report a
 *  successful clone whose settings never landed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function copySettings(adminDb: any, sourceSectionId: string, targetSectionId: string): Promise<{ error?: string }> {
  const { data: sourceSection } = await adminDb
    .from('course_sections')
    .select('settings')
    .eq('id', sourceSectionId)
    .single()

  if (!sourceSection?.settings) return {}

  const sourceSettings = sourceSection.settings as Record<string, unknown>
  const { data: targetSection } = await adminDb
    .from('course_sections')
    .select('settings')
    .eq('id', targetSectionId)
    .single()

  const targetSettings = (targetSection?.settings as Record<string, unknown>) || {}

  const merged = {
    ...targetSettings,
    about: sourceSettings.about || targetSettings.about,
    enabledFeatures: sourceSettings.enabledFeatures || targetSettings.enabledFeatures,
    // Carry the professor's sidebar setup too — a clone that kept the features
    // but reset the nav would look like the copy half-failed.
    sidebarHidden: sourceSettings.sidebarHidden || targetSettings.sidebarHidden,
    sidebarOrder: sourceSettings.sidebarOrder || targetSettings.sidebarOrder,
    customization: sourceSettings.customization || targetSettings.customization,
  }

  const { error } = await adminDb
    .from('course_sections')
    .update({ settings: merged })
    .eq('id', targetSectionId)

  if (error) {
    logger.error('copySettings: update failed', error, { sourceSectionId, targetSectionId })
    return { error: 'Failed to copy course settings' }
  }
  return {}
}
