// Per-student analytics page — unified view of quiz scores, proctoring
// summary, and topic performance for a single student.

import { notFound } from 'next/navigation'
import { CircleAlert } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { StudentAnalyticsView } from '@/components/professor/grades/StudentAnalyticsView'
import { getStudentAnalytics } from '../../actions'

interface PageProps {
  params: Promise<{ sectionId: string; studentId: string }>
}

export default async function StudentAnalyticsPage({ params }: PageProps) {
  const { sectionId, studentId } = await params
  const result = await getStudentAnalytics(sectionId, studentId)

  /* Two outcomes that used to share one bare EmptyState with no way out (#622).
     A studentId from another section, or one that doesn't exist, is an unreachable route →
     notFound(), caught by the course-level boundary whose DeadEnd requires an exit. Keeping
     both cases on the same branch is deliberate: distinguishing them would let this page be
     used to probe which studentIds exist elsewhere. */
  if (result.notFound) notFound()

  /* A broken query is a different claim — we don't know whether the student exists, so this
     must not assert they don't. Deliberately NOT a DeadEnd: per .claude/rules/dead-ends.md a
     failed fetch isn't a dead end but a retry state, and DeadEnd's variants ('missing',
     'no-access') both assert something this branch cannot. What it DOES borrow is the part
     that was missing — a way out. */
  if (result.error || !result.data) {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Couldn't load this student"
        description="Their grades didn't come back. This is usually temporary — try again in a moment."
        action={{ label: 'Back to grades', href: `/professor/courses/${sectionId}/grades` }}
      />
    )
  }

  return <StudentAnalyticsView data={result.data} sectionId={sectionId} />
}
