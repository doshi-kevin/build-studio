'use server'

/**
 * The global Studio kill switch (docs/reference/studio-plugin-publication.md). One flag
 * for every institution: while it's engaged no plugin runs anywhere. And the validator's
 * minimum accepted ruleset (docs/reference/studio-plugin-validator.md).
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
import { STUDIO_VALIDATOR_RULESET } from '@/lib/studio/validator/ruleset'
import { enqueueRevalidation, loadAcceptedMinimum } from '@/lib/studio/validator/service'

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

/**
 * Raises the minimum accepted ruleset one step, toward the one this code checks with (the
 * database takes one step at a time), then queues the re-checks. The raise goes through the signed-in user's own client: the database checks
 * is_super_admin(), refuses a decrease, and records who. Only after it succeeds does the
 * admin client queue one revalidation job per institution. Visible tools stay visible.
 */
export async function raiseValidatorRuleset(): Promise<{ success: true; queued: number | null } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }

    const current = await loadAcceptedMinimum()
    if (current === null) return { error: 'Couldn’t change the accepted checks. Try again.' }
    if (current >= STUDIO_VALIDATOR_RULESET) return { error: 'The accepted checks are already newer than this.' }
    const target = current + 1

    const supabase = await createClient()
    const { data, error } = await supabase.rpc('studio_set_min_accepted_ruleset', { p_ruleset: target, p_max: STUDIO_VALIDATOR_RULESET })
    if (error) {
      logger.error('raiseValidatorRuleset: rpc failed', error)
      return { error: 'Couldn’t change the accepted checks. Try again.' }
    }
    const result = data as { ok?: boolean; reason?: string; previous?: number } | null
    if (!result?.ok) return { error: result?.reason === 'lower' ? 'The accepted checks are already newer than this.' : 'Couldn’t change the accepted checks. Try again.' }

    const queued = await enqueueRevalidation(auth.userId, target)
    void logEvent({
      userId: auth.userId,
      eventType: 'studio.validator.ruleset_raised',
      eventCategory: 'studio',
      metadata: { from: result.previous ?? null, to: target, institutionsQueued: queued },
    })
    revalidatePath('/super-admin/ai-controls')
    return { success: true, queued }
  } catch (error) {
    logger.error('raiseValidatorRuleset: unexpected error', error)
    return { error: 'Couldn’t change the accepted checks. Try again.' }
  }
}

/**
 * Queues the re-checks again, at the accepted minimum as it is now, after a raise that
 * couldn't queue them all. A school already being re-checked keeps its job (one active
 * per school).
 */
export async function queueRevalidationAgain(): Promise<{ success: true; queued: number } | { error: string }> {
  try {
    const auth = await verifySuperAdmin()
    if ('error' in auth) return { error: auth.error }
    const current = await loadAcceptedMinimum()
    if (current === null) return { error: 'Couldn’t queue the re-checks. Try again.' }
    const queued = await enqueueRevalidation(auth.userId, current)
    if (queued === null) return { error: 'Couldn’t queue the re-checks. Try again.' }
    void logEvent({ userId: auth.userId, eventType: 'studio.validator.revalidation_queued', eventCategory: 'studio', metadata: { institutionsQueued: queued } })
    revalidatePath('/super-admin/ai-controls')
    return { success: true, queued }
  } catch (error) {
    logger.error('queueRevalidationAgain: unexpected error', error)
    return { error: 'Couldn’t queue the re-checks. Try again.' }
  }
}
