/**
 * Professor Notification Preferences Actions.
 *
 * Saves a professor's notification preferences to profiles.settings.notifications (JSONB) —
 * the same namespace + shape as the student action, just gated to the professor role. The
 * only mutable professor kinds are the professor-facing ones (enrollment requests, the daily
 * submissions summary); must-have kinds (booking + staff-request outcomes) can't be muted.
 * authenticate → verify professor → validate → read-merge-write settings → log → revalidate.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { z } from 'zod'
import { deletePreference } from '@/lib/memory/preferences'
import {
  notificationPreferencesSchema,
  type NotificationPreferencesInput,
} from '@/lib/validations/notification-preferences'

async function verifyProfessor() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Not authenticated' as const }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'professor') {
    return { error: 'Unauthorized — professor access required' as const }
  }
  return { userId: user.id }
}

export async function updateProfessorNotificationPreferences(
  input: NotificationPreferencesInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyProfessor()
    if ('error' in auth) return { error: auth.error }

    const parsed = notificationPreferencesSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid preferences' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: current } = await adminDb
      .from('profiles')
      .select('settings')
      .eq('id', auth.userId)
      .single()

    // Spread existing settings so we never clobber other namespaces (e.g. settings.profile).
    const currentSettings = (current?.settings as Record<string, unknown>) || {}
    const updatedSettings = {
      ...currentSettings,
      notifications: {
        mutedTypes: parsed.data.mutedTypes,
        digestHour: parsed.data.digestHour,
        digestFrequency: parsed.data.digestFrequency,
      },
    }

    const { error: updateError } = await adminDb
      .from('profiles')
      .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
      .eq('id', auth.userId)

    if (updateError) {
      logger.error('updateProfessorNotificationPreferences: Update failed', updateError)
      return { error: 'Failed to save preferences' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'professor.notification_prefs_updated',
      metadata: { mutedCount: parsed.data.mutedTypes.length, digestHour: parsed.data.digestHour },
    })

    revalidatePath('/professor/preferences')
    return { success: true }
  } catch (error) {
    logger.error('updateProfessorNotificationPreferences', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Remove one thing Athena remembered about how this professor works.
 *
 * The same control the student page offers, for the same reason: memory saves
 * quietly, so being able to see and delete it is what makes that acceptable.
 */
export async function forgetMemory(id: string): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyProfessor()
    if ('error' in auth) return { error: auth.error }
    if (!z.string().uuid().safeParse(id).success) return { error: 'Invalid item' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    // Scoped by user id as well as row id: the id comes from the client, and a
    // guessed one must never reach another person's memory.
    const ok = await deletePreference(adminDb, { id, userId: auth.userId })
    if (!ok) return { error: 'Could not remove that' }

    logEvent({
      userId: auth.userId,
      eventType: 'memory.preference_forgotten',
      eventCategory: 'professor',
    })
    revalidatePath('/professor/preferences')
    return { success: true }
  } catch (error) {
    logger.error('forgetMemory: failed', error, { source: 'professorPreferences.forgetMemory' })
    return { error: 'Could not remove that' }
  }
}
