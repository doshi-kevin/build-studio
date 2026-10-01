/**
 * Course-scoped not-found boundary (student) — catches notFound() thrown by
 * pages BELOW a valid enrolled section (a missing quiz, project, announcement,
 * a feature the professor toggled off…).
 *
 * Same rationale as the professor twin: on course URLs the main Sidebar hides
 * (HIDE_SIDEBAR_PATTERN) in favor of the section layout's icon rail, and only a
 * boundary INSIDE the section layout keeps that rail rendered. See
 * professor/courses/[sectionId]/not-found.tsx for the full explanation.
 *
 * Type: Server Component (static UI, no data fetching)
 */

import { DeadEnd } from '@/components/ui/dead-end'

export default function StudentCourseNotFound() {
  return (
    <DeadEnd
      action={{ label: 'All courses', href: '/student/courses' }}
      secondaryAction={{ label: 'Back to dashboard', href: '/dashboard' }}
    />
  )
}
