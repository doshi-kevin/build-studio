/**
 * Daily notification digest (Scholera Pulse Part 3).
 *
 * Runs from /api/notifications/cron (every 5 min). For each institution where it is
 * now the local digest hour (7 AM), it emails students who have unread, digest-eligible
 * feed_items from the last 24h and haven't already been sent a digest today.
 *
 * Idempotent (claim-then-send, per .claude/rules/data-access.md): a per-(recipient, day)
 * row in email_digest_logs is claimed via upsert(ignoreDuplicates) BEFORE the Resend
 * send, so the 5-minute cadence and retries never double-send. A run that claims no row
 * (already sent today) does nothing.
 *
 * force/dryRun are for local testing only — the cron route accepts them just for the
 * shared-secret (non-production) path, so they can't be used against prod.
 */

import { logger } from '@/lib/logger'
import { sendDailyDigest, type DigestItem } from '@/lib/email'
import {
  parseNotificationPreferences,
  isTypeMuted,
  type DigestFrequency,
} from '@/lib/validations/notification-preferences'

/** Institution-local hour at which the digest goes out. */
export const DIGEST_HOUR = 7

/**
 * Hard cap on the feed read per run, so an unbounded query never silently truncates
 * at PostgREST's implicit 1000-row limit (per .claude/rules/data-access.md). If a run
 * ever hits this, we log it — a truncated read would drop students from that day's
 * digest with no error, so it must surface (add pagination if it fires in practice).
 */
const DIGEST_MAX_ROWS = 5000

/**
 * Durable events worth a morning summary. Excludes `classroom_started` (ephemeral — a
 * "class started" reminder the next morning is pointless) and chat/DM (those live in
 * app_notifications, not feed_items).
 */
export const DIGEST_ELIGIBLE_TYPES = [
  'assignment_published',
  'assignment_updated',
  'assignment_graded',
  'resubmit_requested',
  'quiz_published',
  'quiz_updated',
  'quiz_result_released',
  'announcement_posted',
  'module_published',
  'enrollment_added',
  'team_assigned',
  'team_invite',
  'badge_earned',
  // Professor-facing kinds — the digest is per-recipient, so these ride the same rail and
  // reach professors once the CTA is role-aware (below).
  'staff_request_approved',
  'staff_request_rejected',
  'submissions_summary',
] as const

/** America/New_York is the institutions.timezone DB default; fall back to it if a stored tz is
 *  IANA-invalid (e.g. 'EST', 'PST8PDT' — accepted by Postgres AT TIME ZONE but rejected by Intl),
 *  so one bad row can't throw and take the whole digest down for every institution. */
const DEFAULT_TZ = 'America/New_York'
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return DEFAULT_TZ
  }
}

/** Current local hour (0–23) in the given IANA timezone. */
export function localHour(timeZone: string, now: Date): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(timeZone), hour: '2-digit', hourCycle: 'h23' }).format(now)
  return Number(s)
}

/** Current local calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function localDate(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Trailing content window (in days) per frequency. daily = the original 24h. Also the
 *  dedup-period length, so weekly/biweekly send once per 7/14-day bucket. */
const DIGEST_WINDOW_DAYS: Record<DigestFrequency, number> = { daily: 1, weekly: 7, biweekly: 14 }
/** Widest window any frequency needs — bounds the single feed read to one query. */
const MAX_WINDOW_DAYS = 14
/** Monday, 2024-01-01 UTC — a fixed anchor so weekly/biweekly buckets are stable + aligned. */
const BUCKET_EPOCH = Date.parse('2024-01-01T00:00:00Z')

/**
 * The date identifying the recipient's CURRENT digest period — the value stored in
 * email_digest_logs.digest_date, so the (recipient, digest_date) unique key naturally caps
 * one digest per period. daily → today; weekly → that week's Monday; biweekly → the 2-week
 * bucket's start. All in the institution's local calendar.
 */
export function digestPeriodStart(frequency: DigestFrequency, timeZone: string, now: Date): string {
  const today = localDate(timeZone, now)
  const bucket = DIGEST_WINDOW_DAYS[frequency]
  if (bucket <= 1) return today
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  const daysSince = Math.floor((todayMs - BUCKET_EPOCH) / DAY_MS)
  const startMs = BUCKET_EPOCH + Math.floor(daysSince / bucket) * bucket * DAY_MS
  return new Date(startMs).toISOString().slice(0, 10)
}

interface DigestPreviewRecipient {
  recipientId: string
  email: string
  name: string | null
  digestDate: string
  itemCount: number
  items: DigestItem[]
}

export interface DigestResult {
  institutionsAtDigestHour: number
  sent: number
  skipped?: string
  dryRun?: boolean
  /** Populated only for dryRun — what WOULD be sent, without sending or claiming. */
  recipients?: DigestPreviewRecipient[]
}

/**
 * Send the daily digest to every eligible student in institutions at their local
 * digest hour. Best-effort; never throws.
 *
 * @param adminDb service-role Supabase client (bypasses RLS)
 * @param opts.force  ignore the digest-hour gate (local testing)
 * @param opts.dryRun compute + return recipients without sending or claiming (local testing)
 */
export async function runDigestSweep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DigestResult> {
  const now = new Date()

  // 1. Institutions at their local digest hour right now (all, if forced).
  const { data: institutions, error: instErr } = await adminDb
    .from('institutions')
    .select('id, timezone')
  if (instErr) {
    logger.error('runDigestSweep: institutions query failed', instErr)
    return { institutionsAtDigestHour: 0, sent: 0 }
  }
  const insts = (institutions ?? []) as Array<{ id: string; timezone: string | null }>
  if (insts.length === 0) {
    return { institutionsAtDigestHour: 0, sent: 0, skipped: 'no institutions' }
  }
  // Each student can pick their own digest hour (default 7 AM local), so every institution
  // is a candidate on every tick; each recipient is gated on their OWN preferred hour when
  // the digest is assembled below. institutionsAtDefaultHour is reported for observability.
  const tzById = new Map(insts.map((i) => [i.id, i.timezone || 'UTC']))
  const localHourById = new Map(insts.map((i) => [i.id, localHour(i.timezone || 'UTC', now)]))
  const institutionsAtDefaultHour = insts.filter(
    (i) => localHourById.get(i.id) === DIGEST_HOUR,
  ).length

  // 2. Unread, digest-eligible feed items in those institutions. Read the widest window any
  //    recipient could need (biweekly = 14d); each recipient is filtered to their own
  //    frequency's trailing window when their digest is assembled below.
  const since = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS).toISOString()
  const { data: feedRows, error: feedErr } = await adminDb
    .from('feed_items')
    .select('recipient_id, institution_id, section_id, type, title, link_url, created_at')
    .in('institution_id', Array.from(tzById.keys()))
    .in('type', DIGEST_ELIGIBLE_TYPES)
    .eq('is_read', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(DIGEST_MAX_ROWS)
  if (feedErr) {
    logger.error('runDigestSweep: feed query failed', feedErr)
    return { institutionsAtDigestHour: institutionsAtDefaultHour, sent: 0 }
  }
  const rows = (feedRows ?? []) as Array<{
    recipient_id: string
    institution_id: string
    section_id: string | null
    type: string
    title: string
    link_url: string | null
    created_at: string
  }>
  if (rows.length === DIGEST_MAX_ROWS) {
    logger.warn('runDigestSweep: feed read hit the row cap — some digests may be truncated', {
      cap: DIGEST_MAX_ROWS,
    })
  }
  if (rows.length === 0) {
    return { institutionsAtDigestHour: institutionsAtDefaultHour, sent: 0, skipped: 'no unread items' }
  }

  // Course label per section, resolved from feed_items.section_id (always set) via one
  // batched join — so the digest groups by course ("CS201: …") without relying on any
  // producer stamping the label into metadata.
  const sectionIds = Array.from(new Set(rows.map((r) => r.section_id).filter(Boolean))) as string[]
  const labelBySection = new Map<string, string>()
  if (sectionIds.length > 0) {
    const { data: sections } = await adminDb
      .from('course_sections')
      .select('id, course:courses(code, title)')
      .in('id', sectionIds)
    for (const s of (sections ?? []) as Array<{ id: string; course: unknown }>) {
      const course = (Array.isArray(s.course) ? s.course[0] : s.course) as
        | { code?: string | null; title?: string | null }
        | null
      const label = course?.code || course?.title || null
      if (label) labelBySection.set(s.id, label)
    }
  }

  // Group items by recipient (newest first, from the query order).
  const byRecipient = new Map<
    string,
    { instId: string; items: Array<DigestItem & { type: string; createdAt: string }> }
  >()
  for (const r of rows) {
    let entry = byRecipient.get(r.recipient_id)
    if (!entry) {
      entry = { instId: r.institution_id, items: [] }
      byRecipient.set(r.recipient_id, entry)
    }
    entry.items.push({
      type: r.type,
      title: r.title,
      linkUrl: r.link_url,
      courseLabel: r.section_id ? (labelBySection.get(r.section_id) ?? null) : null,
      createdAt: r.created_at,
    })
  }

  // 3. Emails + names for those recipients (one batched query, no N+1).
  const recipientIds = Array.from(byRecipient.keys())
  const { data: profiles } = await adminDb
    .from('profiles')
    .select('id, email, name, role, settings')
    .in('id', recipientIds)
  const profById = new Map(
    (
      (profiles ?? []) as Array<{
        id: string
        email: string
        name: string | null
        role: string | null
        settings: Record<string, unknown> | null
      }>
    ).map((p) => [p.id, p]),
  )

  // Assemble each recipient's digest — email/name + per-institution digest date.
  interface Target {
    recipientId: string
    email: string
    name: string | null
    digestDate: string
    items: DigestItem[]
    frequency: DigestFrequency
    ctaPath: string
  }
  const digests: Target[] = []
  for (const [recipientId, { instId, items }] of byRecipient) {
    const prof = profById.get(recipientId)
    if (!prof?.email) continue
    const prefs = parseNotificationPreferences(prof.settings)
    // Per-recipient digest hour: send only when the institution's local time matches this
    // recipient's preferred hour (default 7 AM). `force` bypasses the gate for local testing.
    const preferredHour = prefs.digestHour ?? DIGEST_HOUR
    if (!opts.force && localHourById.get(instId) !== preferredHour) continue
    const tz = tzById.get(instId) || 'UTC'
    // Trailing window for this recipient's frequency (daily 24h / weekly 7d / biweekly 14d),
    // plus the mute filter. Frequency + dedup period together mean a weekly recipient gets
    // ONE email per week covering that week's items.
    const windowStart = new Date(
      now.getTime() - DIGEST_WINDOW_DAYS[prefs.digestFrequency] * DAY_MS,
    ).toISOString()
    const visible = items.filter((it) => !isTypeMuted(prefs, it.type) && it.createdAt >= windowStart)
    if (visible.length === 0) continue
    digests.push({
      recipientId,
      email: prof.email,
      name: prof.name,
      // Dedup key = the current period's start date, so weekly/biweekly claim once per period.
      digestDate: digestPeriodStart(prefs.digestFrequency, tz, now),
      items: visible,
      frequency: prefs.digestFrequency,
      // The "Open Scholera" CTA lands the recipient in the right dashboard. Per-item links
      // are already role-correct; only this overall button needed role awareness.
      ctaPath: prof.role === 'professor' ? '/professor/courses' : '/student/courses',
    })
  }

  if (opts.dryRun) {
    return {
      institutionsAtDigestHour: institutionsAtDefaultHour,
      sent: 0,
      dryRun: true,
      recipients: digests.map((t) => ({
        recipientId: t.recipientId,
        email: t.email,
        name: t.name,
        digestDate: t.digestDate,
        itemCount: t.items.length,
        items: t.items,
      })),
    }
  }
  if (digests.length === 0) {
    return { institutionsAtDigestHour: institutionsAtDefaultHour, sent: 0, skipped: 'no eligible recipients' }
  }

  // Claim ALL (recipient, day) rows in one bulk upsert (claim-then-send). ON CONFLICT
  // DO NOTHING means the returned rows are exactly the recipients not yet digested today,
  // so a concurrent/retried tick double-sends to no one. Then send to only those, in
  // parallel — one DB round-trip + concurrent Resend calls, not N sequential (mirrors the
  // atomic bulk claim in publish-sweep.ts).
  const { data: claimed, error: claimErr } = await adminDb
    .from('email_digest_logs')
    .upsert(
      digests.map((t) => ({ recipient_id: t.recipientId, digest_date: t.digestDate })),
      { onConflict: 'recipient_id,digest_date', ignoreDuplicates: true },
    )
    .select('recipient_id')
  if (claimErr) {
    logger.error('runDigestSweep: claim failed', claimErr)
    return { institutionsAtDigestHour: institutionsAtDefaultHour, sent: 0 }
  }
  const claimedIds = new Set(
    ((claimed ?? []) as Array<{ recipient_id: string }>).map((c) => c.recipient_id),
  )
  const toSend = digests.filter((t) => claimedIds.has(t.recipientId))

  // sendDailyDigest is best-effort and never throws, so Promise.all is safe.
  const results = await Promise.all(
    toSend.map((t) =>
      sendDailyDigest(t.email, t.name ?? 'there', {
        items: t.items,
        date: t.digestDate,
        ctaPath: t.ctaPath,
        frequency: t.frequency,
      }),
    ),
  )
  const sent = results.filter(Boolean).length
  if (sent < toSend.length) {
    logger.warn('runDigestSweep: some digest emails failed to send', {
      failed: toSend.length - sent,
    })
  }
  logger.info('runDigestSweep: sent', { sent, institutionsAtDigestHour: institutionsAtDefaultHour })
  return { institutionsAtDigestHour: institutionsAtDefaultHour, sent }
}
