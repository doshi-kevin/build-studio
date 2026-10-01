/**
 * Shared event layer — the frozen contract.
 *
 * Both the notification bell and the dashboard to-do list are built on top of this.
 * Add a new event only here (never invent ad-hoc strings at a callsite). See
 * docs/designs/notifications-calendar/shared-event-layer.md.
 */

/** The vocabulary of things that happen. Additive — extend via PR to this file. */
export type EventType =
  | 'assignment_published'
  | 'assignment_updated' //   a published assignment's due date / instructions changed
  | 'assignment_graded'
  | 'resubmit_requested'
  | 'quiz_published'
  | 'quiz_updated' //         a published quiz's due date / settings changed
  | 'quiz_result_released'
  | 'quiz_ai_ready' //        notice — AI question generation finished (author-only)
  | 'announcement_posted'
  | 'module_published'
  | 'enrollment_added' //      an admin enrolled the student (single or bulk roster import)
  | 'enrollment_approved' //   @deprecated — no producer since the approval pipeline was removed; kept so historical feed rows keep rendering
  | 'enrollment_rejected' //   @deprecated — see enrollment_approved
  | 'enrollment_requested' //  @deprecated — see enrollment_approved
  | 'staff_request_approved' // professor-facing — an admin approved the prof's TA/grader request
  | 'staff_request_rejected' // professor-facing — an admin declined the prof's TA/grader request
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'classroom_started'
  | 'team_assigned'
  | 'team_invite'
  | 'badge_earned'
  | 'certificate_earned' // a challenge milestone completed → a shareable credential
  | 'challenge_claim_rejected' // a professor declined the student's challenge submission
  | 'meeting_reminder' //     time-based (sweep-emitted) — a team's scheduled meeting is soon
  | 'deadline_approaching' // time-based (sweep-emitted)
  | 're_engagement' //        time-based (sweep-emitted) — win-back nudge for dormant students
  | 'assignment_submitted' // completion — flips the matching to-do's is_done
  | 'quiz_attempted' //       completion — flips the matching to-do's is_done
  | 'regrade_requested' //    student appeals a released grade — notifies section staff
  | 'regrade_resolved' //     staff resolved a regrade appeal — notifies the student
  | 'submission_comment_posted' // a subquestion comment — notifies the counterpart role
  | 'late_submission_requested' // student flags they need to submit after deadline — notifies section staff
  | 'submissions_summary' //  professor-facing — end-of-day roll-up of the day's submissions (sweep-emitted)
  | 'class_insights_refreshed' // professor-facing notice — the whole-class AI insights refresh job finished

/** What an event is about. */
export type FeedEntityType =
  | 'assignment'
  | 'quiz'
  | 'announcement'
  | 'module'
  | 'enrollment'
  | 'staff_request'
  | 'booking'
  | 'team'
  | 'badge'
  | 'certificate'
  | 'classroom'
  | 'regrade_request' //     dedup key must be the request row id, not the assignment id
  | 'submission_comment' //  dedup key must be the comment row id, not the assignment id
  | 'challenge_claim' //     dedup key must be the claim row id, not the challenge id
  | 'team_meeting' //        a scheduled project-team meeting
  | 'section' //             a whole section (e.g. the end-of-day submissions summary)

/** Input to emitEvent() — one call per thing that happened, at the source. */
export interface EmitEventInput {
  type: EventType
  /** Course/tenant scope. Drives audience + course-label + tenant resolution when set.
   *  Omit ONLY for section-less events (e.g. re_engagement) that pass `audience` and
   *  `institutionId` explicitly. */
  sectionId?: string | null
  /** Who caused it (null for system/time-based events). Dropped from recipients. */
  actorId?: string | null
  /** Tenant. Looked up from the section if omitted. */
  institutionId?: string | null
  /** What it's about. */
  entity?: { type: FeedEntityType; id: string }
  /** Neutral headline shown in the feed (surfaces may reformat). */
  title: string
  body?: string | null
  /** Where clicking the item goes. */
  linkUrl?: string | null
  /** true => a to-do (needs completion via a completion event); false => a notice. */
  actionable?: boolean
  /** Deadline for actionable items. */
  dueAt?: string | null
  /** Explicit recipients; omit to auto-resolve enrolled students from `sectionId`. */
  audience?: string[]
  /** Existing (recipient,type,entity) row handling: 'ignore' (default) emits once — for
   *  publish / one-shot events; 'refresh' re-surfaces the item (unread again, bumped to
   *  now) with the new title/body/due — for content-change events that can fire again. */
  onDuplicate?: 'ignore' | 'refresh'
  metadata?: Record<string, unknown>
}

/** A per-recipient feed row — what both surfaces read (mirrors the feed_items table). */
export interface FeedItem {
  id: string
  recipient_id: string
  actor_id: string | null
  institution_id: string | null
  section_id: string | null
  type: EventType
  title: string
  body: string | null
  link_url: string | null
  entity_type: FeedEntityType | null
  entity_id: string | null
  is_read: boolean
  read_at: string | null
  is_actionable: boolean
  is_done: boolean
  done_at: string | null
  due_at: string | null
  metadata: Record<string, unknown>
  created_at: string
  /** Joined actor profile (optional; surfaces that render an avatar request it). */
  actor?: {
    id: string
    name: string | null
    email: string
    avatar_url: string | null
  } | null
}

/** Column limits from the migration — callers/helpers truncate defensively. */
export const FEED_TITLE_MAX = 300
export const FEED_BODY_MAX = 1000
export const FEED_LINK_MAX = 500
