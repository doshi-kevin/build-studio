/**
 * Team meeting reminders (Scholera Pulse).
 *
 * Runs from /api/notifications/cron (every ~5 min). Emits a one-time in-app
 * nudge to each member of a project team shortly before a meeting the team
 * scheduled (team_meetings.scheduled_start).
 *
 * Idempotent (per .claude/rules/data-access.md): each row is claimed with a
 * guarded `UPDATE ... SET reminded_at = now() WHERE id = ? AND reminded_at IS
 * NULL` — so a stuttering or overlapping cron never double-sends. emitEvent
 * additionally dedups on (recipient, type, entity_id) and drops recipients who
 * muted the type.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { emitEvent } from '@/lib/events/emit'

/** How far ahead of the meeting we remind. */
const REMIND_LEAD_MIN = 15
/** Bound the per-run claim so an unexpected backlog can't fan out unboundedly. */
const SWEEP_MAX_ROWS = 200

export interface MeetingReminderResult {
  due: number
  reminded: number
}

interface MeetingRow {
  id: string
  team_id: string
  project_id: string
  section_id: string
  title: string
  scheduled_start: string
}

export async function runMeetingReminderSweep(
  adminDb: SupabaseClient,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<MeetingReminderResult> {
  const now = Date.now()
  // Normally remind meetings starting within the lead window; `force` widens the
  // window to a day for local testing.
  const windowEndMs = now + (opts.force ? 24 * 60 : REMIND_LEAD_MIN) * 60 * 1000

  const { data, error } = await adminDb
    .from('team_meetings')
    .select('id, team_id, project_id, section_id, title, scheduled_start')
    .is('reminded_at', null)
    .not('scheduled_start', 'is', null)
    .gte('scheduled_start', new Date(now).toISOString())
    .lte('scheduled_start', new Date(windowEndMs).toISOString())
    .order('scheduled_start', { ascending: true })
    .limit(SWEEP_MAX_ROWS)

  if (error) {
    logger.error('runMeetingReminderSweep: query failed', error)
    return { due: 0, reminded: 0 }
  }

  const rows = (data ?? []) as MeetingRow[]
  if (opts.dryRun) return { due: rows.length, reminded: 0 }

  let reminded = 0
  for (const m of rows) {
    // Claim the row first so a retry/overlap can't double-emit.
    const { data: claimed } = await adminDb
      .from('team_meetings')
      .update({ reminded_at: new Date().toISOString() })
      .eq('id', m.id)
      .is('reminded_at', null)
      .select('id')
      .maybeSingle()
    if (!claimed) continue // another run already claimed it

    const { data: members } = await adminDb
      .from('project_members')
      .select('user_id')
      .eq('team_id', m.team_id)
    const audience = ((members ?? []) as { user_id: string }[]).map((r) => r.user_id)
    if (audience.length === 0) continue

    await emitEvent({
      type: 'meeting_reminder',
      sectionId: m.section_id,
      audience,
      entity: { type: 'team_meeting', id: m.id },
      title: `Team meeting soon: ${m.title}`,
      linkUrl: `/student/courses/${m.section_id}/projects/${m.project_id}`,
      dueAt: m.scheduled_start,
    })
    reminded += 1
  }

  return { due: rows.length, reminded }
}
