/**
 * Notification Preferences Actions (Scholera Pulse Part 4).
 *
 * Saves a student's notification preferences to profiles.settings.notifications (JSONB).
 * Mirrors the student-profile action: authenticate → verify student role → validate with
 * Zod → read-merge-write the settings namespace (never clobbering other keys) → log →
 * revalidate. Admin client for the write (bypasses RLS); ownership is enforced in code.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { deletePreference } from '@/lib/memory/preferences'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  notificationPreferencesSchema,
  type NotificationPreferencesInput,
} from '@/lib/validations/notification-preferences'

async function verifyStudent() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Not authenticated' as const }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'student') {
    return { error: 'Unauthorized — student access required' as const }
  }
  return { userId: user.id }
}

export async function updateNotificationPreferences(
  input: NotificationPreferencesInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyStudent()
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
      logger.error('updateNotificationPreferences: Update failed', updateError)
      return { error: 'Failed to save preferences' }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'student.notification_prefs_updated',
      metadata: { mutedCount: parsed.data.mutedTypes.length, digestHour: parsed.data.digestHour },
    })

    revalidatePath('/student/preferences')
    return { success: true }
  } catch (error) {
    logger.error('updateNotificationPreferences', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Forget one thing Athena remembered.
 *
 * The memory layer saves a stated preference silently, with no confirmation
 * dialog, because a blocking "shall I remember this?" is clicked through
 * without being read and buys nothing. What makes saving silently acceptable is
 * this action existing: the student can see everything held about them and
 * remove any of it in one click. Deleting IS the amendment right in practice,
 * so it has to genuinely delete rather than hide the row.
 */
export async function forgetMemory(id: string): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await verifyStudent()
    if ('error' in auth) return { error: auth.error }
    if (!z.string().uuid().safeParse(id).success) return { error: 'Invalid item' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    // Scoped by user id as well as row id. The caller is authenticated, but the
    // id arrives from the client, and a guessed one must never reach another
    // student's memory.
    const ok = await deletePreference(adminDb, { id, userId: auth.userId })
    if (!ok) return { error: 'Could not remove that' }

    logEvent({
      userId: auth.userId,
      eventType: 'memory.preference_forgotten',
      eventCategory: 'student',
    })

    revalidatePath('/student/preferences')
    return { success: true }
  } catch (error) {
    logger.error('forgetMemory', error)
    return { error: 'Unexpected error' }
  }
}
