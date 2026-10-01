/**
 * Professor Assignments Page — list + create + entry to grading.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments
 */

import { createClient } from '@/lib/supabase/server'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { assignmentQueries, skillQueries } from '@/lib/supabase/queries'
import { verifySectionAccess, canWriteAsProfessor } from '@/lib/auth/section-access'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { AssignmentsManager } from '@/components/professor/assignments/AssignmentsManager'
import type { AssignmentRow } from '@/lib/validations/assignment'

interface AssignmentsPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function AssignmentsPage({ params }: AssignmentsPageProps) {
  const { sectionId } = await params

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page whose buttons happen to fail (.claude/rules/dead-ends.md). Runs
     before anything else on this page, including the write-on-GET branch below.
     Existing rows stay readable through their own detail routes and Grades. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'assignments')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // RLS ("Professors and TAs can manage section assignments") scopes the read.
  const assignments = await assignmentQueries.listSectionAssignments(supabase, sectionId)

  /* Resolve the acting role so the list can hide what this role can't do (#749).
     deleteAssignment is professor-only; a TA used to be shown Delete on every row
     and learned it wasn't theirs from the refusal. This is presentation only — the
     action re-checks, so it is the affordance and not the boundary. */
  const access = user ? await verifySectionAccess(sectionId, user.id) : null
  const canDelete = access?.ok ? canWriteAsProfessor(access.role) : false

  /* Which assignments actually feed Topic Mastery. An assignment reaches a skill
     only through AI-extracted concepts or inheritance from a tagged module — there
     is no per-assignment tagging UI — so one that has neither is graded normally
     and contributes nothing, silently. The list marks those so the gap is visible
     and the professor can tag a module to close it. */
  const activitySkills = await skillQueries.getSectionActivitySkills(supabase, sectionId)
  const mappedAssignmentIds = [
    ...new Set(activitySkills.filter((r) => r.activity_type === 'assignment').map((r) => r.activity_id)),
  ]

  return (
    <>
      <AssignmentsManager
        sectionId={sectionId}
        assignments={assignments as unknown as AssignmentRow[]}
        canDelete={canDelete}
        /* A section with NO mappings at all is either a read failure (the query
           returns [] on error) or a section that has not started tracking. Neither
           deserves a warning on all 67 rows, so pass undefined and mark nothing —
           which is what the prop's contract already promised. */
        mappedAssignmentIds={activitySkills.length ? mappedAssignmentIds : undefined}
      />
      {/* The dock provider is mounted on the assignments layout, so Athena works here —
          but nothing on this page could summon it. No surface registers from the list, so
          Athena is a general course-level brainstorm here rather than an editor driver. */}
      <AthenaAskLine />
    </>
  )
}
