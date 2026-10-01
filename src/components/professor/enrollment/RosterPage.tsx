/**
 * RosterPage — read-only enrolled-student list for a section.
 *
 * Enrollment is admin-driven (docs/designs/platform/admin-roster-import.md): students are
 * added by the institution admin, so this page is a roster to consult, not a
 * queue to manage. Grades shown come from the enrollment row (final grade/score).
 *
 * Type: Client Component
 */
'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Users, Mail, ExternalLink } from 'lucide-react'
import { PageHeader } from '@/components/professor/PageHeader'
import { EmptyState } from '@/components/ui/empty-state'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

interface DepartedStudent {
  id: string
  name: string
  /** Null for rows dropped before enrollments.dropped_at existed. */
  droppedAt: string | null
}

interface RosterPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enrolledStudents: any[]
  /** Students who left the course. Their graded work is still in the database. */
  departed?: DepartedStudent[]
}

export function RosterPage({ enrolledStudents, departed = [] }: RosterPageProps) {
  const activeStudents = useMemo(
    () => enrolledStudents.filter((e) => e.status === 'enrolled' || e.status === 'completed'),
    [enrolledStudents]
  )

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Roster"
        description="Students enrolled in this section. Your institution admin manages who is added or removed."
      />

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Enrolled Students</h2>
          </div>
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {activeStudents.length} {activeStudents.length === 1 ? 'student' : 'students'}
          </span>
        </div>

        {/* A departure used to be completely invisible (#744): every professor-facing query
            filters to the active set, so a student the professor may have been part-way
            through grading was simply gone on the next refresh, with nothing saying why.
            Their submissions and grades are untouched in the database. Filtering the roster
            itself to active students is correct; what was missing was any signal at all. */}
        {departed.length > 0 && (
          <div className="border-b border-border bg-muted/30 px-5 py-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {departed.length} {departed.length === 1 ? 'student has' : 'students have'} left this
                course
              </span>{' '}
              ({departed.map((d) => d.name).join(', ')}). Their submitted work and grades are kept,
              so ask your administrator if you need them re-enrolled.
            </p>
          </div>
        )}

        {activeStudents.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No students enrolled yet"
            description="Students appear here once your institution admin enrolls them."
            className="py-12"
          />
        ) : (
          /* No entrance animation, deliberately. A roster is a list a professor
             scans, often many times while grading, and the frequency rule in
             src/lib/motion.ts gives that category nothing: staggering names in
             makes the list slower to read, not richer. */
          <div className="divide-y divide-border">
            {activeStudents.map((enrollment, index) => {
              const student = resolveJoin(enrollment.student)
              return (
                <div key={enrollment.id}>
                  <div className="flex items-center justify-between px-5 py-3 hover:bg-muted transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs text-muted-foreground w-5 text-right shrink-0 tabular-nums">{index + 1}</span>
                      <div className="min-w-0">
                        {/* The name opens the student's profile: who they are, what
                            else they're taking, and when you could both meet. Only
                            for 'enrolled' rows — that page requires a live enrolment,
                            so linking a 'completed' one would hand the professor a
                            door that 404s. */}
                        {student?.id && enrollment.status === 'enrolled' ? (
                          /* The icon is the affordance. Without it the name was
                             indistinguishable from a departed student's name,
                             which is NOT a link, until you happened to hover
                             it — and this is the feature's main entry point.
                             Same treatment GradebookTable uses on its names. */
                          <Link
                            href={`/professor/students/${student.id}`}
                            className="group flex min-w-0 items-center gap-1 py-0.5 text-sm font-medium text-foreground hover:underline"
                          >
                            <span className="truncate">{student.name || 'Unknown Student'}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          </Link>
                        ) : (
                          <p className="text-sm font-medium text-foreground truncate">{student?.name || 'Unknown Student'}</p>
                        )}
                        {/* The Mail icon implied a contact action that didn't exist —
                            querySelectorAll('a[href^="mailto:"]') returned 0 on this
                            roster (#744). */}
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1.5 truncate">
                          <Mail className="h-3 w-3 shrink-0" />
                          {student?.email ? (
                            <a href={`mailto:${student.email}`} className="min-w-0 truncate hover:text-foreground hover:underline">
                              {student.email}
                            </a>
                          ) : (
                            '—'
                          )}
                        </p>
                      </div>
                    </div>
                    {(enrollment.final_grade || enrollment.final_score != null) && (
                      <div className="flex items-baseline gap-2 text-xs shrink-0 tabular-nums">
                        <span className="text-muted-foreground">Final</span>
                        {enrollment.final_grade && (
                          <span className="font-semibold text-foreground">{enrollment.final_grade}</span>
                        )}
                        {enrollment.final_score != null && (
                          <span className="text-muted-foreground">{enrollment.final_score}%</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
