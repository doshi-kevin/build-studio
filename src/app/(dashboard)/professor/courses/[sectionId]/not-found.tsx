/**
 * Course-scoped not-found boundary (professor) — catches notFound() thrown by
 * pages BELOW a valid section (a missing quiz, project, assignment, room…).
 *
 * Why this exists when (dashboard)/not-found.tsx already does: on course URLs
 * the main Sidebar hides itself (HIDE_SIDEBAR_PATTERN in Sidebar.tsx) because
 * the section layout supplies its own icon rail — but a (dashboard)-level
 * boundary replaces the subtree below (dashboard)/layout, so the rail never
 * renders and the user gets NO left nav. This boundary renders INSIDE the
 * section layout instead, keeping the rail.
 *
 * Limitation: a notFound() thrown by the section layout itself (bad sectionId)
 * cannot be caught at this level — Next routes it to the parent boundary, where
 * the rail is unavoidably absent (header + CTA only).
 *
 * No route params reach not-found.tsx, so the exits are param-free; the rail
 * carries the in-course navigation.
 *
 * Type: Server Component (static UI, no data fetching)
 */

import { DeadEnd } from '@/components/ui/dead-end'

export default function CourseNotFound() {
  return (
    <DeadEnd
      action={{ label: 'All courses', href: '/professor/courses' }}
      secondaryAction={{ label: 'Back to dashboard', href: '/dashboard' }}
    />
  )
}
