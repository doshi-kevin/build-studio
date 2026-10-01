'use server'

/**
 * logMaterialEvent — records a student's content-consumption event for the
 * roadmap triage engine's engagement signals (open counts, "you are here",
 * "new since last visit"). Called from client components at the point a student
 * opens a material or an external link; logEvent is server-only (service role),
 * so the browser reaches it through this action.
 *
 * Fire-and-forget: verifies the caller is the enrolled student AND that the item
 * belongs to this section, then logs. Any failure is swallowed — a missed
 * analytics event must never break opening a file.
 *
 * NOT rate-limited. A student can still replay this for items they can legitimately
 * see, inflating their own engagement counts; the `kind` allowlist bounds the blast
 * radius to `material.*` rows, so nothing here can forge an audit event. A real
 * limiter needs shared state (Cloud Run runs several instances, so an in-process
 * counter would not hold) — worth doing if these signals ever drive anything a
 * student benefits from gaming.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/supabase/event-logger'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import { isUnlockPending } from '@/lib/modules/unlock'

const KINDS = ['viewed', 'link_clicked', 'downloaded'] as const
type MaterialEventKind = (typeof KINDS)[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function logMaterialEvent(
  sectionId: string,
  itemId: string,
  kind: MaterialEventKind,
): Promise<void> {
  try {
    // A 'use server' export is a reachable POST endpoint and TypeScript is erased
    // at runtime, so every argument is attacker-controlled. `kind` is interpolated
    // into events.event_type (text, no CHECK, written with the service role) — an
    // allowlist is what stops a student forging audit rows like 'grade.updated'.
    // The ids are bounded too: they land in event metadata, and only real uuids
    // can ever match a row anyway.
    if (!KINDS.includes(kind)) return
    if (!UUID.test(sectionId) || !UUID.test(itemId)) return
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const { data: enrolled } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ON_ROSTER_STATUSES)
      .maybeSingle()
    if (!enrolled) return
    /* The item must actually BELONG to this section, and be one the student can
       see. Enrolment alone only proved they may log *something* here: any valid
       uuid was accepted, so a scripted caller could pump `material.viewed` at
       arbitrary ids and skew the very engagement signals that drive the
       professor's triage annotations ("no one has opened this", "12 opened this
       week"). Same published + visible + OPEN join the roadmap itself reads through,
       so a hidden item, an unpublished module, or a week that hasn't reached its
       unlock date can't be logged against either. */
    const { data: item } = await adminDb
      .from('module_items')
      .select('id, modules!inner(section_id, is_published, unlock_date)')
      .eq('id', itemId)
      .eq('modules.section_id', sectionId)
      .eq('modules.is_published', true)
      .eq('is_visible', true)
      .maybeSingle()
    if (!item) return
    const mod = Array.isArray(item.modules) ? item.modules[0] : item.modules
    if (isUnlockPending(mod?.unlock_date)) return
    void logEvent({
      userId: user.id,
      eventType: `material.${kind}`,
      eventCategory: 'student',
      sectionId,
      metadata: { itemId },
    })
  } catch {
    /* fire-and-forget: never surface a logging failure to the UI */
  }
}
