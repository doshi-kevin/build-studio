/**
 * Shared event-type → icon map for notification surfaces (the header bell and the
 * full notifications page). Event notifications are about WHAT happened, so we show a
 * type icon rather than the actor's avatar; chat/DM (app source) keep the avatar,
 * where WHO messaged you is the point.
 *
 * Kept in one place so the bell and the history page never drift out of sync when a
 * new event type is added.
 */

import {
  Award,
  Bell,
  BookOpen,
  ClipboardCheck,
  FileText,
  GraduationCap,
  HeartHandshake,
  ListChecks,
  Megaphone,
  PackageCheck,
  PencilLine,
  RotateCcw,
  Bot,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react'

export function iconForType(type: string | null): LucideIcon {
  switch (type) {
    case 'assignment_published':
      return FileText
    case 'assignment_graded':
      return ClipboardCheck
    case 'resubmit_requested':
      return RotateCcw
    case 'quiz_published':
    case 'quiz_result_released':
      return ListChecks
    case 'quiz_ai_ready':
      return Bot
    case 'announcement_posted':
      return Megaphone
    case 'module_published':
      return BookOpen
    case 'classroom_started':
      return Video
    case 'badge_earned':
      return Award
    case 'team_assigned':
    case 'team_invite':
      return Users
    case 'enrollment_added':
    /* The next three are retired (no producer) but historical rows still render. */
    case 'enrollment_approved':
    case 'enrollment_rejected':
    case 'enrollment_requested':
      return GraduationCap
    case 'staff_request_approved':
    case 'staff_request_rejected':
      return Users
    case 'submissions_summary':
      return ClipboardCheck
    case 'class_insights_refreshed':
      return Bot
    /* A change to what the institution has bought. Matches the icon on the
       Plan cards in /admin/settings and the super-admin institution page. */
    case 'entitlements_changed':
      return PackageCheck
    case 're_engagement':
      return HeartHandshake
    case 'assignment_updated':
    case 'quiz_updated':
      return PencilLine
    default:
      return Bell
  }
}
