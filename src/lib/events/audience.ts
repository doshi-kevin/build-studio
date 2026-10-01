/**
 * Audience resolution for the shared event layer.
 *
 * The same enrollment relationship, both directions:
 *   - resolveAudience:        section → enrolled students  (notification/to-do fanout)
 *   - resolveStudentSections: student → enrolled sections  (dashboard scoping)
 *
 * Both take a service-role admin client so callers reuse their own. Enrolled audience
 * = statuses 'enrolled' | 'active' | 'completed'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

type AdminDb = SupabaseClient<Database>

const ENROLLED_STATUSES = ['enrolled', 'active', 'completed'] as const

/** Enrolled student ids for a section (fanout target). */
export async function resolveAudience(adminDb: AdminDb, sectionId: string): Promise<string[]> {
  const { data } = await adminDb
    .from('enrollments')
    .select('student_id')
    .eq('section_id', sectionId)
    .in('status', ENROLLED_STATUSES)
  return ((data ?? []) as Array<{ student_id: string }>).map((e) => e.student_id)
}

/**
 * Notification audience for ONE announcement, honouring its targeting (#665).
 *
 * `resolveAudience` answers "who is enrolled", which is the wrong question for a
 * targeted announcement: a post aimed at a single student notified every enrolled
 * student, so 6 of 7 got a bell reading "New announcement: <title>" for something they
 * cannot open — the link 404s for them. The body was protected; the TITLE was not, and
 * titles are routinely the sensitive part ("Academic integrity meeting", "Re: your late
 * submission"). Targeting exists precisely to prevent that.
 *
 * Fails CLOSED: `mentioned_only` with no mention rows notifies nobody rather than
 * falling back to the roster. An announcement targeted at no one reaching everyone is
 * the exact bug this exists to stop.
 */
export async function resolveAnnouncementAudience(
  adminDb: AdminDb,
  announcementId: string,
  sectionId: string,
  visibility: string | null | undefined,
): Promise<string[]> {
  if (visibility !== 'mentioned_only') return resolveAudience(adminDb, sectionId)

  const { data } = await adminDb
    .from('announcement_mentions')
    .select('student_id')
    .eq('announcement_id', announcementId)
  return ((data ?? []) as Array<{ student_id: string }>).map((m) => m.student_id)
}

/**
 * Grading staff for a section — the professor plus any active TAs/graders. Used to notify the
 * people who can action a regrade appeal or answer a student's subquestion comment. Mirrors the
 * staff predicate in verifySectionAccess / the assignment RLS policies (status 'active', unexpired).
 */
export async function resolveStaffAudience(adminDb: AdminDb, sectionId: string): Promise<string[]> {
  const ids = new Set<string>()
  const { data: section } = await adminDb
    .from('course_sections')
    .select('professor_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (section?.professor_id) ids.add(section.professor_id as string)

  const { data: staff } = await adminDb
    .from('section_staff')
    .select('staff_id')
    .eq('section_id', sectionId)
    .eq('status', 'active')
    .gt('ends_at', new Date().toISOString())
  for (const s of (staff ?? []) as Array<{ staff_id: string }>) ids.add(s.staff_id)

  return [...ids]
}

/** Section ids a student is enrolled in (dashboard scoping). */
export async function resolveStudentSections(adminDb: AdminDb, userId: string): Promise<string[]> {
  const { data } = await adminDb
    .from('enrollments')
    .select('section_id')
    .eq('student_id', userId)
    .in('status', ENROLLED_STATUSES)
  return ((data ?? []) as Array<{ section_id: string }>).map((e) => e.section_id)
}
