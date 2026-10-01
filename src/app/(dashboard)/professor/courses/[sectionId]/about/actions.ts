/**
 * About Section Server Actions — save the professor's course About content.
 *
 * Verifies the professor owns the section, validates the content with Zod,
 * merges it into the existing settings JSONB, and persists to the database.
 *
 * Uses two Supabase clients:
 * - Regular client (server.ts) — for auth verification
 * - Admin client (admin.ts) — for mutations (bypasses RLS)
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { aboutContentV2Schema, type AboutContentV2 } from '@/lib/validations/course-about'

/**
 * Save the About section content for a course section.
 * Merges into existing settings.about without clobbering other settings keys.
 */
export async function saveAboutContent(
  sectionId: string,
  content: AboutContentV2
): Promise<{ success?: boolean; error?: string }> {
  try {
    // 1. Auth check
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { error: 'Not authenticated' }
    }

    // 2. Validate content
    const parsed = aboutContentV2Schema.safeParse(content)
    if (!parsed.success) {
      logger.warn('saveAboutContent: Validation failed', {
        userId: user.id,
        sectionId,
        issues: parsed.error.issues.map(i => i.message),
      })
      return { error: 'Invalid content: ' + parsed.error.issues[0]?.message }
    }

    // 3. Verify professor owns this section
    const adminDb = createAdminClient()
    const { data: section, error: fetchError } = await adminDb
      .from('course_sections')
      .select('id, professor_id')
      .eq('id', sectionId)
      .single()

    if (fetchError || !section) {
      logger.error('saveAboutContent: Section not found', fetchError, { sectionId })
      return { error: 'Course section not found' }
    }

    if (section.professor_id !== user.id) {
      logger.warn('saveAboutContent: Ownership mismatch', {
        userId: user.id,
        sectionId,
        ownerId: section.professor_id,
      })
      return { error: 'You do not own this course section' }
    }

    /* 4. Persist just the `about` key. This action fires on a 1.5s autosave debounce,
       so it is running constantly while a professor edits. Reading settings and
       writing the whole blob back would revert any concurrent write to the other
       keys that share this column — enabledFeatures (the student-visibility gate),
       sidebarHidden, sidebarOrder — from a second tab or the sidebar. The RPC does
       the shallow merge inside one UPDATE, so only `about` changes. */
    const { error: updateError } = await adminDb
      .rpc('merge_course_section_settings', {
        p_section_id: sectionId,
        p_patch: { about: parsed.data },
      })

    if (updateError) {
      logger.error('saveAboutContent: Update failed', updateError, { sectionId })
      return { error: 'Failed to save changes' }
    }

    // 6. Log event
    logEvent({
      userId: user.id,
      eventType: 'section.about_updated',
      metadata: { sectionId },
    })

    // 7. Revalidate
    revalidatePath(`/professor/courses/${sectionId}`)

    logger.info('saveAboutContent: Saved', { userId: user.id, sectionId })
    return { success: true }
  } catch (error) {
    logger.error('saveAboutContent: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
