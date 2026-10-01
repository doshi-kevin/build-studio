'use server'

// Role-scoped read actions for the unified resource node modal's LEFT content
// (assignment description/rubric, live-session polls/pop-quizzes). Shared by the
// professor AND student roadmaps. Read-only: authenticate → authorize section
// access (professor / TA / grader OR enrolled student) → query scoped by
// section_id so a caller can never read another section's resource (IDOR-safe).

import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess } from '@/lib/auth/section-access'
import { roadmapQueries, type RoadmapDrawerAssignment, type RoadmapDrawerSession } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'

/** Assignment statuses an enrolled student may read — the same pair the
 *  assignments table's own RLS policy allows. 'scheduled' and 'archived' stay
 *  hidden; 'closed' is past due, not withheld. */
const STUDENT_VISIBLE_ASSIGNMENT_STATUS = ['published', 'closed']

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/** Grant when the caller is the section's professor / TA / grader OR an actively
 *  enrolled student. Returns the admin client to run the (section-scoped) read,
 *  and WHICH of the two the caller is — staff may read unreleased work, a
 *  student may not. */
async function authorizeSection(sectionId: string, userId: string) {
  const access = await verifySectionAccess(sectionId, userId)
  const adminDb = access.adminDb
  if (access.ok) return { authorized: true as const, isStaff: true, adminDb }
  const { data: enrolled } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ON_ROSTER_STATUSES)
    .maybeSingle()
  return { authorized: !!enrolled, isStaff: false, adminDb }
}

export async function getNodeAssignmentContent(
  sectionId: string,
  assignmentId: string,
): Promise<{ data?: RoadmapDrawerAssignment; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { authorized, isStaff, adminDb } = await authorizeSection(sectionId, user.id)
    if (!authorized) return { error: 'No access to this section' }

    // A student may only read a RELEASED assignment's brief. Without this the
    // action handed out the description, guidelines and grading rubric of work
    // the professor has not released — the student quiz twin
    // (getNodeQuizQuestions) has always gated this way and this did not.
    //
    // 'published' AND 'closed', matching the assignments table's own student
    // policy: 'closed' means past due, not withheld, and a student can still
    // open it from the assignments page. Gating on 'published' alone would
    // hide every past-due brief here while showing it there.
    if (!isStaff) {
      const { data: a } = await adminDb
        .from('assignments')
        .select('status')
        .eq('id', assignmentId)
        .eq('section_id', sectionId)
        .maybeSingle()
      if (!a || !STUDENT_VISIBLE_ASSIGNMENT_STATUS.includes(a.status)) return { error: 'Assignment not found' }
    }

    const data = await roadmapQueries.getAssignmentContent(adminDb, sectionId, assignmentId)
    if (!data) return { error: 'Assignment not found' }
    return { data }
  } catch (error) {
    logger.error('getNodeAssignmentContent', error)
    return { error: 'Unexpected error' }
  }
}

export async function getNodeSessionContent(
  sectionId: string,
  roomId: string,
): Promise<{ data?: RoadmapDrawerSession; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const { authorized, isStaff, adminDb } = await authorizeSection(sectionId, user.id)
    if (!authorized) return { error: 'No access to this section' }
    // Staff read every staged poll / pop quiz; a student only what the table's own
    // policy would have let them see (see getSessionContent). The roadmap's new
    // ?node= deep link made this reachable mid-class: a live room's tile joins the
    // classroom on click, so before it the card had no way to open.
    const data = await roadmapQueries.getSessionContent(adminDb, sectionId, roomId, { isStaff })
    if (!data) return { error: 'Session not found' }
    return { data }
  } catch (error) {
    logger.error('getNodeSessionContent', error)
    return { error: 'Unexpected error' }
  }
}
