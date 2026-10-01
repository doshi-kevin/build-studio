/**
 * Course Section Server Actions — course feature configuration.
 *
 * Three independent keys live in the section's `settings` JSONB:
 *   - enabledFeatures: what STUDENTS can see and reach (also the gate behind
 *     `verifyFeatureEnabled`). Professor pages never gate on this.
 *   - sidebarHidden:   what the professor removed from their OWN sidebar.
 *                      Absent/empty = every feature shows, which is the default.
 *   - sidebarOrder:    display order for both sidebars; may be partial.
 *
 * Every action verifies the professor owns the section, then merges its one key
 * into the existing settings object so the others aren't clobbered.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { isEntitledFeatureKey, entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { ensureDefaultCourseChannel } from '@/lib/discussion/default-channel'
import { COURSE_FEATURES, ADDITIONAL_FEATURES, STUDIO_TOOL_KEY } from '@/lib/course-features'
import { STUDIO_SECTION_INSTALLATIONS_LISTED } from '@/lib/studio/limits'

/** Reads a string[] out of the settings JSONB, tolerating absent/garbage values. */
function readKeys(settings: Record<string, unknown>, key: string): string[] {
  return Array.isArray(settings[key]) ? (settings[key] as string[]) : []
}

/** Feature keys arrive from the client, so they're untrusted. Anything not in
 *  the registry is inert to every consumer (they all do registry lookups), but
 *  unvalidated keys would still accumulate in `settings` — which is re-fetched
 *  and serialized on every page load for the section, and copied into cloned
 *  sections. Reject them at the door instead. */
const VALID_FEATURE_KEYS = new Set(COURSE_FEATURES.map((f) => f.key))

/** Narrower set for publishing: only `additional` features have a student side.
 *  Professor-only tools (Enrollment, Course Assistants, Settings) live in
 *  `sidebarHidden`, never in `enabledFeatures` — the student sidebar derives
 *  from ADDITIONAL_FEATURES, so such a key would be dead weight there. */
const PUBLISHABLE_FEATURE_KEYS = new Set(ADDITIONAL_FEATURES.map((f) => f.key))

/**
 * Authenticates the caller and confirms they own the section, returning the
 * admin client and current settings. Shared by every action below so the
 * auth + ownership check can't drift between them.
 */
async function loadOwnedSection(sectionId: string, source: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Not authenticated' as const }

  const adminDb = createAdminClient()
  const { data: section, error: fetchError } = await adminDb
    .from('course_sections')
    .select('id, professor_id, settings')
    .eq('id', sectionId)
    .single()

  if (fetchError || !section) {
    logger.error(`${source}: Section not found`, fetchError, { sectionId })
    return { error: 'Course section not found' as const }
  }

  if (section.professor_id !== user.id) {
    logger.warn(`${source}: Ownership mismatch`, {
      userId: user.id,
      sectionId,
      ownerId: section.professor_id,
    })
    return { error: 'You do not own this course section' as const }
  }

  return {
    user,
    adminDb,
    settings: (section.settings as Record<string, unknown>) || {},
  }
}

export async function toggleCourseFeature(
  sectionId: string,
  featureKey: string,
  enabled: boolean
): Promise<{ success?: boolean; error?: string }> {
  try {
    if (!PUBLISHABLE_FEATURE_KEYS.has(featureKey)) return { error: 'Unknown feature' }

    // 1-2. Auth + ownership
    const owned = await loadOwnedSection(sectionId, 'toggleCourseFeature')
    if ('error' in owned) return { error: owned.error }
    const { user, adminDb, settings: currentSettings } = owned

    /* The institution ceiling. Publishing to students a product the school does
       not own would be a promise we cannot keep: the student gates subtract
       unentitled keys, so the professor would see it "released" and no student
       would ever get it. Turning something OFF stays allowed — that is only ever
       narrowing, and a professor must never be stuck unable to unpublish. */
    if (enabled && isEntitledFeatureKey(featureKey)) {
      const entitlement = await checkEntitlementBySection(adminDb, sectionId, featureKey)
      if (!entitlement.allowed) return { error: entitlementRefusalMessage(featureKey) }
    }

    // 3. Merge enabledFeatures into existing settings
    const currentFeatures = readKeys(currentSettings, 'enabledFeatures')

    const updatedFeatures = enabled
      ? currentFeatures.includes(featureKey) ? currentFeatures : [...currentFeatures, featureKey]
      : currentFeatures.filter((f) => f !== featureKey)

    /* Key-scoped patch, NOT a whole-blob rewrite: settings also carries the About
       page, which autosaves every 1.5s while the professor edits it. Spreading the
       snapshot we read would silently revert an About save that landed in between
       (and vice versa). See merge_course_section_settings. */
    const patch: Record<string, unknown> = {
      enabledFeatures: updatedFeatures,
    }

    // Publishing to students implies the professor wants it in their own nav —
    // otherwise they'd have a feature live for students with no way to reach it.
    // Unpublishing does NOT hide it: that's the draft state (professor keeps
    // building, students see nothing). Hiding is the sidebar's X button.
    if (enabled) {
      patch.sidebarHidden = readKeys(currentSettings, 'sidebarHidden')
        .filter((f) => f !== featureKey)
    }

    // 4. Persist
    const { error: updateError } = await adminDb
      .rpc('merge_course_section_settings', { p_section_id: sectionId, p_patch: patch })

    if (updateError) {
      logger.error('toggleCourseFeature: Update failed', updateError, { sectionId })
      return { error: 'Failed to update features' }
    }

    // 5. Auto-create #general course channel when discussions is enabled, so
    //    students have somewhere to post the moment it goes live.
    if (featureKey === 'discussions' && enabled) {
      await ensureDefaultCourseChannel(adminDb, sectionId, user.id)
    }

    // 6. Log event
    logEvent({
      userId: user.id,
      eventType: enabled ? 'section.feature_enabled' : 'section.feature_disabled',
      metadata: { sectionId, featureKey },
    })

    // 6. Revalidate layout so sidebar re-renders (both professor and student)
    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    revalidatePath(`/student/courses/${sectionId}`, 'layout')

    logger.info('toggleCourseFeature: Updated', { userId: user.id, sectionId, featureKey, enabled })
    return { success: true }
  } catch (error) {
    logger.error('toggleCourseFeature: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Shows or hides a feature in the PROFESSOR's own sidebar. Independent of
 * `enabledFeatures` — hiding a feature the professor isn't using shouldn't
 * change anything for students, and vice versa.
 *
 * One exception, for coherence: hiding a feature that is currently published
 * also unpublishes it. Leaving it live for students while the professor has no
 * link to reach it would strand submissions they can't grade.
 */
export async function setCourseSidebarVisibility(
  sectionId: string,
  featureKey: string,
  visible: boolean,
): Promise<{ success?: boolean; error?: string }> {
  try {
    if (!VALID_FEATURE_KEYS.has(featureKey)) return { error: 'Unknown feature' }

    const owned = await loadOwnedSection(sectionId, 'setCourseSidebarVisibility')
    if ('error' in owned) return { error: owned.error }
    const { user, adminDb, settings: currentSettings } = owned

    const currentHidden = readKeys(currentSettings, 'sidebarHidden')
    const updatedHidden = visible
      ? currentHidden.filter((f) => f !== featureKey)
      : currentHidden.includes(featureKey) ? currentHidden : [...currentHidden, featureKey]

    // Key-scoped patch — see the note in toggleCourseFeature.
    const patch: Record<string, unknown> = {
      sidebarHidden: updatedHidden,
    }

    if (!visible) {
      patch.enabledFeatures = readKeys(currentSettings, 'enabledFeatures')
        .filter((f) => f !== featureKey)
    }

    const { error: updateError } = await adminDb
      .rpc('merge_course_section_settings', { p_section_id: sectionId, p_patch: patch })

    if (updateError) {
      logger.error('setCourseSidebarVisibility: Update failed', updateError, { sectionId })
      return { error: 'Failed to update your sidebar' }
    }

    logEvent({
      userId: user.id,
      eventType: visible ? 'section.sidebar_feature_shown' : 'section.sidebar_feature_hidden',
      metadata: { sectionId, featureKey },
    })

    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    // Hiding also unpublishes, so the student nav can change too.
    revalidatePath(`/student/courses/${sectionId}`, 'layout')

    logger.info('setCourseSidebarVisibility: Updated', { userId: user.id, sectionId, featureKey, visible })
    return { success: true }
  } catch (error) {
    logger.error('setCourseSidebarVisibility: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Persists sidebar display order. Writes `sidebarOrder`, NOT `enabledFeatures`
 * — the professor's sidebar now lists every feature, so writing this array to
 * `enabledFeatures` (as it used to) would publish all of them to students on
 * the first drag.
 */
export async function reorderCourseFeatures(
  sectionId: string,
  orderedKeys: string[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const owned = await loadOwnedSection(sectionId, 'reorderCourseFeatures')
    if ('error' in owned) return { error: owned.error }
    const { user, adminDb } = owned

    // Drop unknown keys and dedupe — this array is written wholesale and then
    // re-read on every page load for the section.
    // Studio plugin tabs order by `studio:<installationId>`. Display only: the key
    // grants nothing, so its shape is all that's checked, and the list stays bounded.
    const cleanKeys = [...new Set(orderedKeys.filter((k) => VALID_FEATURE_KEYS.has(k) || STUDIO_TOOL_KEY.test(k)))].slice(
      0,
      VALID_FEATURE_KEYS.size + STUDIO_SECTION_INSTALLATIONS_LISTED,
    )

    // Key-scoped patch — see the note in toggleCourseFeature.
    const { error: updateError } = await adminDb
      .rpc('merge_course_section_settings', {
        p_section_id: sectionId,
        p_patch: { sidebarOrder: cleanKeys },
      })

    if (updateError) {
      logger.error('reorderCourseFeatures: Update failed', updateError, { sectionId })
      return { error: 'Failed to reorder features' }
    }

    logEvent({
      userId: user.id,
      eventType: 'section.sidebar_reordered',
      metadata: { sectionId, featureCount: cleanKeys.length },
    })

    revalidatePath(`/professor/courses/${sectionId}`, 'layout')
    revalidatePath(`/student/courses/${sectionId}`, 'layout')
    return { success: true }
  } catch (error) {
    logger.error('reorderCourseFeatures: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
