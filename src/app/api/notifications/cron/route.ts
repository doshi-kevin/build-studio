/**
 * Scholera Pulse — scheduled notifications cron endpoint.
 *
 * Triggered on a schedule (GCP Cloud Scheduler in prod, every 5 minutes) to run the
 * app-layer work that no server action covers. Today: the deferred-publish sweep
 * (notify students about scheduled assignments that pg_cron auto-published) — the
 * 5-minute cadence keeps that notification within ~5–10 min of publish. The daily
 * email digest will hang off this same endpoint in a later slice; the 5-minute
 * cadence is safe for it because it only sends during the institution-local 7 AM
 * hour, guarded by a per-day dedup row.
 *
 * Auth: one shared secret, the same shape the extraction-worker and jobs-worker
 * kick endpoints have used in production since June — `x-notifications-cron-secret`,
 * compared with timingSafeEqual, failing closed when the secret is unset.
 *
 * It used to branch on NODE_ENV: deny if production, otherwise accept a bearer
 * token. That was wrong on two counts and is worth not repeating. NODE_ENV
 * answers "is this an optimized build", not "which deployment is this" — the
 * Dockerfile sets it to production for staging too, so Pulse could never run
 * there either. And the branch failed OPEN on misconfiguration: if NODE_ENV were
 * ever unset in the deployed container, a mass-notification endpoint would start
 * accepting a bearer token instead of denying. Authorization should rest on a
 * credential, never on a guess about the environment. The same reasoning is
 * already written down in src/lib/pinecone/client.ts.
 *
 * Cloud Scheduler OIDC would be stronger still (no shared secret to leak) and is
 * the eventual target, but nothing in this codebase verifies OIDC yet, and a
 * sweep that has never run once is the more pressing problem.
 */

import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  sweepAssignmentPublishNotifications,
  sweepQuizPublishNotifications,
} from '@/lib/notifications/publish-sweep'
import { runDigestSweep } from '@/lib/notifications/digest'
import { runReengagementSweep } from '@/lib/notifications/re-engagement'
import { runMeetingReminderSweep } from '@/lib/notifications/meeting-reminder-sweep'
import { runSubmissionSummarySweep } from '@/lib/notifications/submission-summary-sweep'
import { runQuizResultsSweep } from '@/lib/notifications/quiz-results-sweep'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.NOTIFICATIONS_CRON_SECRET
  // No secret configured means no caller can be authorised. Fails closed
  // everywhere, with no environment branch to get wrong.
  if (!expected) return false
  const provided = req.headers.get('x-notifications-cron-secret')
  if (!provided) return false
  // timingSafeEqual needs equal-length buffers; the length gate guarantees it.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

/** Run one sweep in isolation so a thrown error (e.g. one institution with an IANA-invalid
 *  timezone, which makes Intl throw inside the digest) doesn't starve the sweeps that follow it.
 *  Logs and returns an error marker instead of bubbling to the outer 500. */
async function safeSweep<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (error) {
    logger.error(`notifications/cron: ${name} sweep failed`, error)
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Local testing helpers (only reachable via the non-prod shared secret, since prod
    // fails closed above): ?dryRun=1 previews the digest read-only; ?force=1 ignores the
    // 7 AM gate.
    const params = new URL(req.url).searchParams
    const force = params.get('force') === '1'
    const dryRun = params.get('dryRun') === '1'
    // The immediate-publish trigger kicks this endpoint at the exact moment a scheduled
    // assignment/quiz flips to published. It only needs the publish sweeps — skip the
    // digest + re-engagement work so a publish doesn't fire that logic on every kick.
    const publishOnly = params.get('publishOnly') === '1'

    // A dry run is fully read-only — skip the publish sweep (which claims rows).
    if (dryRun) {
      const digest = await safeSweep('digest', () => runDigestSweep(adminDb, { force, dryRun: true }))
      const reengagement = await safeSweep('reengagement', () => runReengagementSweep(adminDb, { force, dryRun: true }))
      const meetingReminders = await safeSweep('meetingReminders', () => runMeetingReminderSweep(adminDb, { force, dryRun: true }))
      return NextResponse.json({ ok: true, dryRun: true, digest, reengagement, meetingReminders })
    }

    // Publish sweeps run on every invocation (poll AND immediate kick). Idempotent:
    // each atomically claims only published-but-unnotified rows.
    const publishSweep = await safeSweep('publish', () => sweepAssignmentPublishNotifications(adminDb))
    const quizPublishSweep = await safeSweep('quizPublish', () => sweepQuizPublishNotifications(adminDb))
    if (publishOnly) {
      return NextResponse.json({ ok: true, publishSweep, quizPublishSweep })
    }

    // Each sweep runs isolated (safeSweep) so one failing sweep — e.g. the digest hitting one
    // institution with an invalid timezone — no longer starves the sweeps after it.
    const digest = await safeSweep('digest', () => runDigestSweep(adminDb, { force }))
    const reengagement = await safeSweep('reengagement', () => runReengagementSweep(adminDb, { force }))
    // Team meeting reminders — claim-then-emit, idempotent via reminded_at.
    const meetingReminders = await safeSweep('meetingReminders', () => runMeetingReminderSweep(adminDb, { force }))
    // Professor end-of-day submissions summary — gated to each institution's local
    // summary hour, deduped per (professor, section, day). Claims + emits (not read-only),
    // so it runs only on the real (non-dryRun) path.
    const submissionSummary = await safeSweep('submissionSummary', () => runSubmissionSummarySweep(adminDb, { force }))
    // When an "after due date" quiz closes, notify its attempters that results are available.
    const quizResults = await safeSweep('quizResults', () => runQuizResultsSweep(adminDb, { force }))
    return NextResponse.json({
      ok: true,
      publishSweep,
      quizPublishSweep,
      digest,
      reengagement,
      meetingReminders,
      submissionSummary,
      quizResults,
    })
  } catch (error) {
    logger.error('notifications/cron', error)
    return NextResponse.json({ error: 'Cron run failed' }, { status: 500 })
  }
}
