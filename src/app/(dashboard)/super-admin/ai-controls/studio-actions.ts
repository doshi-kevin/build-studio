'use server'

/**
 * The global Studio kill switch (docs/reference/studio-plugin-publication.md). One flag
 * for every institution: while it's engaged no plugin runs anywhere.
 *
 * Same write discipline as the AI kill switch: verifySuperAdmin here, then the database
 * function through the RLS-bound user client, which checks is_super_admin() itself. So
 * neither this action nor the page is the authorization boundary.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'

export async function setStudioKillSwitch(engaged: boolean): Promise<{ success: true } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    if (typeof engaged !== 'boolean') return { error: 'Invalid setting.' }

    const supabase = await createClient()
    const { error } = await supabase.rpc('set_studio_kill_switch', { p_disabled: engaged })
    if (error) {
      logger.error('setStudioKillSwitch: rpc failed', error)
      return { error: 'Couldn’t change Studio. Try again.' }
    }

    void logEvent({
      userId: auth.userId,
      eventType: engaged ? 'studio.kill_switch.engaged' : 'studio.kill_switch.released',
      eventCategory: 'studio',
    })
    revalidatePath('/super-admin/ai-controls')
    return { success: true }
  } catch (error) {
    logger.error('setStudioKillSwitch: unexpected error', error)
    return { error: 'Couldn’t change Studio. Try again.' }
  }
}
