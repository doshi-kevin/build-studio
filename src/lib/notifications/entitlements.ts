/**
 * Bell notifications for plan changes.
 *
 * A school that asks Scholera for a feature and hears nothing back has no
 * reason to ask again, so the request flow is only half a product without
 * these. Modelled on notifications/ai-policy.ts, including its two rules:
 * ONE batched insert per change (never one per feature), and fire-and-forget
 * AFTER the write succeeds, never inside it. A notification failure must never
 * undo or block a plan change.
 *
 * Who hears what differs by direction, deliberately:
 *  - A GRANT reaches admins and professors. Professors are the ones who can now
 *    do something new, and they will not go looking for it.
 *  - A REVOCATION reaches admins only. A professor cannot act on it, and
 *    "Scholera is taking quizzes away in December" is a conversation their own
 *    administration should have with them, not a bell we ring.
 *  - A DECLINE reaches only the person who asked.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { ENTITLED_FEATURES, type EntitlementConfig } from '@/lib/entitlements/entitled-features'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

const label = (key: string): string =>
  ENTITLED_FEATURES.find((f) => f.key === key)?.label ?? key

const list = (keys: string[]) => keys.map(label).join(', ')

const onDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    // The stored value is UTC midnight, so read it back as UTC or it renders
    // as the previous day west of Greenwich.
    timeZone: 'UTC',
  })

export interface PlanChange {
  title: string
  body: string
  /** Revocations are not professor news; see the file header. */
  audience: 'admins' | 'admins-and-professors'
}

/**
 * Plain-language diff of two stored configs, or null when nothing a human would
 * notice changed. Compares EFFECTIVE availability rather than raw arrays, so
 * moving a key from `revoked` to a passed `pendingRevocation` does not announce
 * itself as a change when the school's experience is identical.
 */
export function describePlanChange(
  before: EntitlementConfig,
  after: EntitlementConfig,
  now: Date = new Date(),
): PlanChange | null {
  const off = (c: EntitlementConfig, key: string): boolean => {
    if (c.revoked.includes(key)) return true
    const pending = c.pendingRevocation[key]
    return !!pending && Date.parse(pending) <= now.getTime()
  }

  const gained = ENTITLED_FEATURES.filter((f) => off(before, f.key) && !off(after, f.key)).map(
    (f) => f.key,
  )
  const lost = ENTITLED_FEATURES.filter((f) => !off(before, f.key) && off(after, f.key)).map(
    (f) => f.key,
  )

  // A newly scheduled future cutoff is news even though nothing is off yet.
  const newlyScheduled = ENTITLED_FEATURES.filter((f) => {
    const at = after.pendingRevocation[f.key]
    if (!at || Date.parse(at) <= now.getTime()) return false
    return before.pendingRevocation[f.key] !== at
  }).map((f) => ({ key: f.key, at: after.pendingRevocation[f.key] }))

  if (!gained.length && !lost.length && !newlyScheduled.length) return null

  if (gained.length && !lost.length && !newlyScheduled.length) {
    return {
      title: gained.length === 1 ? `${label(gained[0])} is now available` : 'New features are available',
      body: `${list(gained)} ${gained.length === 1 ? 'is' : 'are'} now switched on for your institution. Professors can start using ${gained.length === 1 ? 'it' : 'them'} in any course.`,
      audience: 'admins-and-professors',
    }
  }

  const parts: string[] = []
  if (gained.length) parts.push(`Now available: ${list(gained)}.`)
  if (lost.length) parts.push(`No longer available: ${list(lost)}.`)
  for (const { key, at } of newlyScheduled) {
    parts.push(`${label(key)} will switch off on ${onDate(at)}.`)
  }

  return {
    title: lost.length ? 'Your plan changed' : 'A change to your plan is scheduled',
    body: `${parts.join(' ')} Existing work is never deleted, and past grades stay visible.`,
    audience: 'admins',
  }
}

export async function notifyPlanChange(
  adminDb: AdminDb,
  params: {
    institutionId: string
    actorId: string
    before: EntitlementConfig
    after: EntitlementConfig
    /**
     * The reviewer's note, when this change came from approving a request.
     * QA caught that the approve dialog asks for one, stores it in
     * review_note, and then shows it to nobody — the decline reason reached
     * the admin but the approval note did not. Asking for something and
     * discarding it is worse than not asking.
     */
    note?: string
  },
): Promise<void> {
  try {
    const change = describePlanChange(params.before, params.after)
    if (!change) return

    const note = params.note?.trim()
    // The body cap is 1000 chars at the database; the note is capped at 2000 on
    // the way in, so it is trimmed here rather than losing the whole insert.
    const body = note ? `${change.body}\n\n${note}`.slice(0, 1000) : change.body

    const roles =
      change.audience === 'admins' ? ['institution_admin'] : ['institution_admin', 'professor']
    const { data: recipients, error } = await adminDb
      .from('profiles')
      .select('id')
      .eq('institution_id', params.institutionId)
      .in('role', roles)
    if (error || !recipients?.length) {
      if (error) logger.error('notifyPlanChange: recipient query failed', error)
      return
    }

    const rows = recipients.map((r: { id: string }) => ({
      recipient_id: r.id,
      actor_id: params.actorId,
      kind: 'entitlements_changed',
      title: change.title,
      body,
      metadata: { institutionId: params.institutionId },
    }))
    const { error: insertError } = await adminDb.from('app_notifications').insert(rows)
    if (insertError) logger.error('notifyPlanChange: insert failed', insertError)
  } catch (err) {
    logger.error('notifyPlanChange: unexpected', err)
  }
}

/**
 * Tells the person who asked that their request was turned down. Only them: a
 * decline is not news for the whole institution, and broadcasting it would make
 * asking feel costly.
 */
export async function notifyRequestDeclined(
  adminDb: AdminDb,
  params: { requesterId: string; actorId: string; featureKey: string; reason: string },
): Promise<void> {
  try {
    const { error } = await adminDb.from('app_notifications').insert({
      recipient_id: params.requesterId,
      actor_id: params.actorId,
      kind: 'entitlements_changed',
      title: `Your request for ${label(params.featureKey)} was declined`,
      body: params.reason,
      metadata: { featureKey: params.featureKey },
    })
    if (error) logger.error('notifyRequestDeclined: insert failed', error)
  } catch (err) {
    logger.error('notifyRequestDeclined: unexpected', err)
  }
}
