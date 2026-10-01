/**
 * Notification preferences (Scholera Pulse Part 4) — what a student wants to be notified
 * about, and when their daily digest arrives.
 *
 * Stored in profiles.settings.notifications (JSONB), OPT-OUT model: a student stores only
 * the OPTIONAL kinds they've turned OFF, so new notification types default ON and need no
 * migration. Critical kinds (deadlines, resubmission requests, enrollment/booking
 * outcomes) are MUST-HAVE — never shown as toggles, never muted — so a preference can't
 * cause a student to miss something consequential.
 */

import { z } from 'zod'
import type { EventType } from '@/lib/events/types'

/** How often the email digest is sent. Applies to students and professors alike.
 *  Extendable — add a value here + a window/period entry in the digest sweep. */
export const DIGEST_FREQUENCIES = ['daily', 'weekly', 'biweekly'] as const
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number]
export const DIGEST_FREQUENCY_LABELS: Record<DigestFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
}

export interface NotificationKind {
  type: EventType
  label: string
  description?: string
  group:
    | 'Coursework'
    | 'Announcements & teams'
    | 'Achievements & reminders'
    | 'Roster & staff'
    | 'Submissions'
  /** Whose preferences UI this kind appears in. Defaults to 'student'. */
  role?: 'student' | 'professor'
}

/** Optional (mutable) notification kinds, in display order, grouped for the UI. */
export const OPTIONAL_NOTIFICATION_KINDS: NotificationKind[] = [
  { type: 'assignment_published', label: 'New assignments', group: 'Coursework' },
  {
    type: 'assignment_updated',
    label: 'Assignment changes',
    description: "When a published assignment's due date or instructions change",
    group: 'Coursework',
  },
  { type: 'assignment_graded', label: 'Assignment grades', group: 'Coursework' },
  { type: 'quiz_published', label: 'New quizzes', group: 'Coursework' },
  { type: 'quiz_updated', label: 'Quiz changes', group: 'Coursework' },
  { type: 'quiz_result_released', label: 'Quiz results', group: 'Coursework' },
  { type: 'module_published', label: 'New course content', group: 'Coursework' },
  { type: 'classroom_started', label: 'Live class started', group: 'Coursework' },
  { type: 'announcement_posted', label: 'Announcements', group: 'Announcements & teams' },
  { type: 'team_assigned', label: 'Team assignments', group: 'Announcements & teams' },
  { type: 'team_invite', label: 'Team invites', group: 'Announcements & teams' },
  { type: 'badge_earned', label: 'Badges earned', group: 'Achievements & reminders' },
  { type: 'certificate_earned', label: 'Certificates earned', group: 'Achievements & reminders' },
  {
    type: 'meeting_reminder',
    label: 'Team meeting reminders',
    description: 'A nudge before a meeting your project team scheduled',
    group: 'Achievements & reminders',
  },
  {
    type: 're_engagement',
    label: 'Win-back reminders',
    description: "Friendly nudges when you haven't visited in a while",
    group: 'Achievements & reminders',
  },
  // ── Professor kinds ──
  {
    type: 'submissions_summary',
    label: 'Daily submissions summary',
    description: "An end-of-day roll-up of the day's assignment, quiz, and project submissions",
    group: 'Submissions',
    role: 'professor',
  },
  {
    type: 'quiz_ai_ready',
    label: 'AI quiz ready',
    description: 'When a quiz you generated with AI has finished processing',
    group: 'Coursework',
    role: 'professor',
  },
]

/** Must-have kinds — always delivered, never a toggle. A preference cannot suppress these. */
export const MUST_HAVE_TYPES: readonly EventType[] = [
  // deadline_approaching is intentionally NOT listed: it has no producer, so advertising it as
  // an always-delivered must-have promised a notification that never actually fires.
  'resubmit_requested',
  // Being added to a course is a roster change the student must not be able to miss.
  'enrollment_added',
  'booking_confirmed',
  'booking_cancelled',
  /* The outcome of the student's OWN challenge submission (#703 part 5). Same reasoning as the
     staff-request outcomes below: a preference must not be able to suppress the answer to something
     the person submitted and is waiting on. Before this existed, a rejected claim told the student
     nothing at all, while an approval fired a badge notification. */
  'challenge_claim_rejected',
  // Professor — the outcome of the professor's own TA/grader request. Like the student
  // enrollment outcomes above, a preference can't suppress a decision they're waiting on.
  'staff_request_approved',
  'staff_request_rejected',
]

const OPTIONAL_TYPES: string[] = OPTIONAL_NOTIFICATION_KINDS.map((k) => k.type)

export const notificationPreferencesSchema = z.object({
  // Only optional kinds can be muted; anything else (a must-have, a typo) is dropped.
  mutedTypes: z
    .array(z.string())
    .default([])
    .transform((arr) => arr.filter((t) => OPTIONAL_TYPES.includes(t))),
  // null = use the institution default digest hour.
  digestHour: z.number().int().min(0).max(23).nullable().default(null),
  // How often the digest email arrives. Defaults to daily (existing behavior).
  digestFrequency: z.enum(DIGEST_FREQUENCIES).default('daily'),
})
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>

export interface NotificationPreferences {
  mutedTypes: string[]
  digestHour: number | null
  digestFrequency: DigestFrequency
}

const DEFAULT_PREFS: NotificationPreferences = {
  mutedTypes: [],
  digestHour: null,
  digestFrequency: 'daily',
}

/**
 * Safely parse preferences from the settings JSONB. Returns defaults (nothing muted,
 * default digest hour) for missing/malformed data, and ignores any muted value that
 * isn't a currently-optional kind.
 */
export function parseNotificationPreferences(
  settings: Record<string, unknown> | null | undefined,
): NotificationPreferences {
  if (!settings || typeof settings !== 'object') return { ...DEFAULT_PREFS }
  const n = (settings as Record<string, unknown>).notifications
  if (!n || typeof n !== 'object') return { ...DEFAULT_PREFS }
  const obj = n as Record<string, unknown>

  const mutedTypes = Array.isArray(obj.mutedTypes)
    ? obj.mutedTypes.filter((t): t is string => typeof t === 'string' && OPTIONAL_TYPES.includes(t))
    : []
  const digestHour =
    typeof obj.digestHour === 'number' && obj.digestHour >= 0 && obj.digestHour <= 23
      ? Math.floor(obj.digestHour)
      : null
  const digestFrequency = (DIGEST_FREQUENCIES as readonly string[]).includes(
    obj.digestFrequency as string,
  )
    ? (obj.digestFrequency as DigestFrequency)
    : 'daily'

  return { mutedTypes, digestHour, digestFrequency }
}

/**
 * Has the student opted out of this notification kind? Must-have kinds are NEVER muted —
 * a preference can't suppress a critical alert, even if the type somehow appears in the
 * muted list.
 */
export function isTypeMuted(prefs: NotificationPreferences, type: string): boolean {
  if ((MUST_HAVE_TYPES as readonly string[]).includes(type)) return false
  return prefs.mutedTypes.includes(type)
}

/** Can this notification type be muted by a preference (i.e. is it optional)? Callers use
 *  this to skip the preference lookup entirely for types nobody can opt out of. */
export function isMutableNotificationType(type: string): boolean {
  return OPTIONAL_TYPES.includes(type)
}
