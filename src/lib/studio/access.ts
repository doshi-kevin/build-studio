/**
 * Whether Studio may run, and how much, for one institution. Three independent switches:
 *
 *   Kill switch    "has Scholera stopped plugin execution?" One global flag in
 *                  platform_settings.settings.studio, written only by a super admin
 *                  (set_studio_kill_switch). Fails CLOSED: if it can't be read, Studio is
 *                  off. Read fresh on every call, like the AI kill switch.
 *   Entitlement    "has this school got Studio?" The `studio` institution entitlement.
 *                  Fails OPEN on a read error, like every entitlement (check.ts): it is
 *                  a commercial control, not a security boundary.
 *   Release gate   STUDIO_STUDENT_ACCESS. Students reach no plugin at all until it is
 *                  "on", which waits for the Supabase acceptance checklist
 *                  (docs/reference/studio-supabase-acceptance.md). Server-only env.
 *
 * Losing the entitlement means "stop taking new work, keep history readable": frames
 * still load and reads still answer, every write is refused. The kill switch means
 * nothing runs. Hiding and archiving are always allowed, because they only reduce what
 * students can reach.
 */
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkEntitlement } from '@/lib/entitlements/check'
import { logger } from '@/lib/logger'

export type StudioAccess = 'full' | 'read_only' | 'off'

/** What a professor is told while the kill switch is engaged. */
export const STUDIO_PAUSED = 'Studio is paused right now. Try again later.'

/** Whether a stored platform_settings.settings value engages the switch. A settings
 * object with no `studio` key, or with `{ disabled: false }`, means running. Anything
 * else counts as engaged, so garbage can't switch Studio back on. */
export function killSwitchEngagedBy(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true
  if (!Object.hasOwn(settings, 'studio')) return false
  const studio = (settings as Record<string, unknown>).studio
  if (!studio || typeof studio !== 'object' || Array.isArray(studio)) return true
  return (studio as Record<string, unknown>).disabled !== false
}

/** True when Studio must not run anywhere. Fails closed. */
export async function studioKillSwitchEngaged(): Promise<boolean> {
  return (await readStudioKillSwitch()) !== 'running'
}

/** The switch's state for the super-admin control: `unknown` when it can't be read,
 * which every other caller treats as engaged. */
export async function readStudioKillSwitch(): Promise<'running' | 'engaged' | 'unknown'> {
  try {
    const { data, error } = await createAdminClient()
      .from('platform_settings')
      .select('settings')
      .eq('id', true)
      .maybeSingle()
    if (error) throw error
    // The row is created by a migration and nothing deletes it. Its absence is an ops
    // problem, not a stored decision, so it doesn't engage the switch (same contract as
    // the AI kill switch). Only a failed read does.
    if (!data) {
      logger.warn('studio/access.readStudioKillSwitch: platform_settings row missing')
      return 'running'
    }
    return killSwitchEngagedBy(data.settings) ? 'engaged' : 'running'
  } catch (error) {
    logger.error('studio/access.readStudioKillSwitch: read failed, treating Studio as off', error)
    return 'unknown'
  }
}

/** Whether students may reach any plugin in this deployment. */
export function studentAccessReleased(): boolean {
  return process.env.STUDIO_STUDENT_ACCESS === 'on'
}

/** full: everything. read_only: entitlement lost, reads only. off: kill switch. */
export async function studioAccess(institutionId: string): Promise<StudioAccess> {
  if (await studioKillSwitchEngaged()) return 'off'
  const verdict = await checkEntitlement(createAdminClient(), institutionId, 'studio')
  return verdict.allowed ? 'full' : 'read_only'
}
