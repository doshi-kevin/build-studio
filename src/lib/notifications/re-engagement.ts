/**
 * Re-engagement sweep (Scholera Pulse Part 4).
 *
 * Runs from /api/notifications/cron (every 5 min). For each institution where it is now
 * the local re-engagement hour, it finds enrolled students who have gone quiet — no
 * sign-in for 3 / 7 / 14 / 30 days — and sends ONE tiered, witty nudge: an in-app feed
 * card (waiting for when they return) + an email (the only channel that reaches someone
 * who has stopped opening the site).
 *
 * Signal: profiles.last_login_at (populated on sign-in). Students with a NULL
 * last_login_at are skipped — we never blast an account we have no activity signal for.
 *
 * Idempotent (claim-then-send, per .claude/rules/data-access.md): a per-(recipient, tier)
 * row in reengagement_logs is claimed via upsert(ignoreDuplicates) BEFORE the send, so
 * the 5-minute cadence and retries never double-nudge. A student gets each tier at most
 * once; the tone escalates only as the gap widens.
 *
 * force/dryRun are local-testing only — the cron route accepts them just on the non-prod
 * shared-secret path, so they can't be used against prod.
 */

import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'
import { sendReengagementEmail } from '@/lib/email'
import { localHour } from '@/lib/notifications/digest'
import { parseNotificationPreferences, isTypeMuted } from '@/lib/validations/notification-preferences'
import {
  REENGAGEMENT_TIERS,
  pickReengagementCopy,
  seedFromId,
  tierForDays,
  type ReengagementTier,
} from '@/lib/notifications/re-engagement-copy'
import { getUserStateBatch, type UserState } from '@/lib/memory/state'

/** Institution-local hour the nudge goes out — mid-morning, never a 3 a.m. buzz. */
export const REENGAGEMENT_HOUR = 10

/**
 * One concrete sentence per student, drawn from the memory layer, or nothing.
 *
 * This is the second consumer of `getUserState` and the reason it returns
 * structured data rather than prompt text: an email branches on fields, it does
 * not parse prose. Nothing here calls a model.
 *
 * Two rules from this file's own header are load-bearing. OWN DATA ONLY is
 * satisfied because memory is per-user by construction. TEASE, DON'T REVEAL
 * means the hook names the TOPIC and never the score — "cross-entropy is where
 * you're weakest" is a nudge, "cross-entropy, 20%" is a grade in an inbox.
 *
 * Most students get null, which is correct and must stay comfortable: the copy
 * reads the same without a hook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildHooks(adminDb: any, candidates: Candidate[]): Promise<Map<string, string>> {
  const hooks = new Map<string, string>()

  // Memory is scoped to a course, so group by the section each candidate's label
  // came from and ask once per section.
  const bySection = new Map<string, { institutionId: string; userIds: string[] }>()
  for (const c of candidates) {
    if (!c.sectionId || !c.institutionId) continue
    const bucket = bySection.get(c.sectionId) ?? { institutionId: c.institutionId, userIds: [] }
    bucket.userIds.push(c.recipientId)
    bySection.set(c.sectionId, bucket)
  }
  if (bySection.size === 0) return hooks

  const perSection = await Promise.all(
    [...bySection.entries()].map(([sectionId, { institutionId, userIds }]) =>
      getUserStateBatch(adminDb, { userIds, institutionId, sectionId }).catch((error) => {
        // A nudge with no hook still ships. Memory must never be the reason an
        // email does not go out.
        logger.error('buildHooks: memory read failed for a section', error, { sectionId })
        return new Map<string, UserState>()
      }),
    ),
  )

  for (const states of perSection) {
    for (const [userId, state] of states) {
      const due = state.dueSoon[0]
      if (due) {
        hooks.set(userId, `${due.title} is due soon.`)
        continue
      }
      const weakest = state.weakSkills[0]
      if (weakest) {
        hooks.set(userId, `${weakest.skill} is where you're weakest right now.`)
        continue
      }
      if (state.lastClass && !state.lastClass.attended && state.lastClass.hasRecap) {
        hooks.set(userId, 'There is a recap waiting from the class you missed.')
      }
    }
  }
  return hooks
}

/** Enrollment statuses that count as "currently a student here" (excludes 'completed'). */
const REENGAGEMENT_ENROLLED_STATUSES = ['enrolled', 'active'] as const

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Hard cap on the candidate read per run so an unbounded query never silently truncates
 * at PostgREST's implicit 1000-row limit (per .claude/rules/data-access.md). If a run
 * hits this, we log it — a truncated read would drop dormant students with no error.
 */
const REENGAGEMENT_MAX_ROWS = 5000

interface Candidate {
  recipientId: string
  email: string
  name: string | null
  institutionId: string | null
  courseLabel: string | null
  /** The section the label came from. Kept so the memory layer can be asked
   *  about the right course; the dedup below used to drop it. */
  sectionId: string | null
  daysDormant: number
  tier: ReengagementTier
}

interface ReengagementPreview {
  recipientId: string
  email: string
  tier: ReengagementTier
  daysDormant: number
  title: string
  body: string
}

export interface ReengagementResult {
  institutionsAtHour: number
  sent: number
  skipped?: string
  dryRun?: boolean
  /** Populated only for dryRun — what WOULD be sent, without sending or claiming. */
  recipients?: ReengagementPreview[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (v: any) => (Array.isArray(v) ? v[0] : v)

/**
 * Nudge dormant students in institutions at their local re-engagement hour. Best-effort;
 * never throws.
 *
 * @param adminDb service-role Supabase client (bypasses RLS)
 * @param opts.force  ignore the hour gate (local testing)
 * @param opts.dryRun compute + return recipients without sending or claiming (local testing)
 */
export async function runReengagementSweep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<ReengagementResult> {
  const now = new Date()

  // 1. Institutions at their local re-engagement hour right now (all, if forced).
  const { data: institutions, error: instErr } = await adminDb
    .from('institutions')
    .select('id, timezone')
  if (instErr) {
    logger.error('runReengagementSweep: institutions query failed', instErr)
    return { institutionsAtHour: 0, sent: 0 }
  }
  const insts = (institutions ?? []) as Array<{ id: string; timezone: string | null }>
  const atHour = insts.filter((i) => localHour(i.timezone || 'UTC', now) === REENGAGEMENT_HOUR)
  const targets = opts.force ? insts : atHour
  if (targets.length === 0) {
    return { institutionsAtHour: 0, sent: 0, skipped: 'no institution at re-engagement hour' }
  }
  const instIds = targets.map((i) => i.id)

  // 2. Enrolled students in those institutions whose last sign-in is older than the
  //    smallest tier (3d). last_login_at < cutoff also excludes NULLs (never-tracked
  //    students are skipped, not blasted). One query, joined to the course for a label.
  const cutoff = new Date(now.getTime() - REENGAGEMENT_TIERS[0] * DAY_MS).toISOString()
  const { data: rows, error: rowsErr } = await adminDb
    .from('enrollments')
    .select(
      'section_id, student:profiles!inner(id, email, name, last_login_at, institution_id, role, settings), section:course_sections!inner(status, course:courses(code, title))',
    )
    .in('status', REENGAGEMENT_ENROLLED_STATUSES)
    .eq('student.role', 'student')
    .eq('section.status', 'active')
    .in('student.institution_id', instIds)
    .lt('student.last_login_at', cutoff)
    .order('student_id', { ascending: true })
    .limit(REENGAGEMENT_MAX_ROWS)
  if (rowsErr) {
    logger.error('runReengagementSweep: candidate query failed', rowsErr)
    return { institutionsAtHour: atHour.length, sent: 0 }
  }
  const enrollmentRows = (rows ?? []) as unknown[]
  if (enrollmentRows.length === REENGAGEMENT_MAX_ROWS) {
    logger.warn('runReengagementSweep: candidate read hit the row cap — some students may be skipped', {
      cap: REENGAGEMENT_MAX_ROWS,
    })
  }

  // Dedup to one entry per student (a student enrolled in several sections appears
  // multiple times); keep the first course label seen. Compute dormancy + tier.
  const byStudent = new Map<string, Candidate>()
  for (const raw of enrollmentRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = raw as any
    const student = resolveJoin(r.student) as {
      id: string
      email: string | null
      name: string | null
      last_login_at: string | null
      institution_id: string | null
      settings: Record<string, unknown> | null
    } | null
    if (!student?.id || !student.email || !student.last_login_at) continue
    if (byStudent.has(student.id)) continue
    // Respect the student's win-back opt-out (a notification preference).
    if (isTypeMuted(parseNotificationPreferences(student.settings), 're_engagement')) continue

    const daysDormant = Math.floor((now.getTime() - new Date(student.last_login_at).getTime()) / DAY_MS)
    const tier = tierForDays(daysDormant)
    if (tier === null) continue // shouldn't happen (query cutoff = 3d), but be safe

    const section = resolveJoin(r.section) as { course?: unknown } | null
    const course = resolveJoin(section?.course) as { code?: string | null; title?: string | null } | null
    const courseLabel = course?.code || course?.title || null

    byStudent.set(student.id, {
      recipientId: student.id,
      email: student.email,
      name: student.name,
      institutionId: student.institution_id,
      courseLabel,
      sectionId: (r.section_id as string) ?? null,
      daysDormant,
      tier,
    })
  }

  const candidates = Array.from(byStudent.values())
  if (candidates.length === 0) {
    return { institutionsAtHour: atHour.length, sent: 0, skipped: 'no dormant students' }
  }

  // Ask the memory layer what it knows about the students we have ALREADY decided
  // to nudge. Filter-first-then-batch is the whole reason this scales: the cheap
  // `last_login_at` cutoff above narrows a roster to a handful, and each section
  // then costs a fixed number of queries rather than a query per student.
  const hooks = await buildHooks(adminDb, candidates)

  // Resolve each candidate's copy up front (deterministic per student) — used by both the
  // dryRun preview and the real send.
  const withCopy = candidates.map((c) => ({
    ...c,
    copy: pickReengagementCopy(
      c.tier,
      {
        name: c.name,
        courseLabel: c.courseLabel,
        daysDormant: c.daysDormant,
        hook: hooks.get(c.recipientId) ?? null,
      },
      seedFromId(c.recipientId),
    ),
  }))

  if (opts.dryRun) {
    return {
      institutionsAtHour: atHour.length,
      sent: 0,
      dryRun: true,
      recipients: withCopy.map((c) => ({
        recipientId: c.recipientId,
        email: c.email,
        tier: c.tier,
        daysDormant: c.daysDormant,
        title: c.copy.title,
        body: c.copy.body,
      })),
    }
  }

  // 3. Claim ALL (recipient, tier) rows in one bulk upsert (claim-then-send). ON CONFLICT
  //    DO NOTHING means the returned rows are exactly the (recipient, tier) pairs not yet
  //    nudged, so a concurrent/retried tick double-sends to no one.
  const { data: claimed, error: claimErr } = await adminDb
    .from('reengagement_logs')
    .upsert(
      withCopy.map((c) => ({ recipient_id: c.recipientId, tier: c.tier })),
      { onConflict: 'recipient_id,tier', ignoreDuplicates: true },
    )
    .select('recipient_id, tier')
  if (claimErr) {
    logger.error('runReengagementSweep: claim failed', claimErr)
    return { institutionsAtHour: atHour.length, sent: 0 }
  }
  const claimedKeys = new Set(
    ((claimed ?? []) as Array<{ recipient_id: string; tier: number }>).map(
      (c) => `${c.recipient_id}:${c.tier}`,
    ),
  )
  const toSend = withCopy.filter((c) => claimedKeys.has(`${c.recipientId}:${c.tier}`))
  if (toSend.length === 0) {
    return { institutionsAtHour: atHour.length, sent: 0, skipped: 'all already nudged' }
  }

  // 4. Deliver: an in-app card (via emitEvent — waits for their return) + an email (reaches
  //    the absent). Both best-effort; sends run in parallel. `sent` counts email successes.
  const results = await Promise.all(
    toSend.map(async (c) => {
      await emitEvent({
        type: 're_engagement',
        audience: [c.recipientId],
        institutionId: c.institutionId,
        actorId: null,
        title: c.copy.title,
        body: c.copy.body,
        linkUrl: '/student/courses',
      })
      return sendReengagementEmail(c.email, { title: c.copy.title, body: c.copy.body })
    }),
  )
  const sent = results.filter(Boolean).length
  if (sent < toSend.length) {
    logger.warn('runReengagementSweep: some nudge emails failed to send', {
      failed: toSend.length - sent,
    })
  }
  logger.info('runReengagementSweep: sent', { sent, institutionsAtHour: atHour.length })
  return { institutionsAtHour: atHour.length, sent }
}
