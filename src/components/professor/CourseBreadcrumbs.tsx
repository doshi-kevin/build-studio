/**
 * CourseBreadcrumbs — auto-detects current page from pathname and
 * renders breadcrumb navigation within the course container.
 *
 * Type: Client Component (uses usePathname)
 */
'use client'

import { usePathname } from 'next/navigation'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { COURSE_FEATURES } from '@/lib/course-features'

interface CourseBreadcrumbsProps {
  sectionId: string
  courseName: string
  courseCode: string
  /** Adjusts the root breadcrumb link — professors go to /professor/courses,
   * TAs/graders go to /staff/courses where their own landing lives. */
  userRole?: 'professor' | 'ta' | 'grader'
}

/** Map route segments to human-readable labels */
const ROUTE_LABELS: Record<string, string> = {
  '': 'About',
  // inlineOnly features have no page of their own — they piggyback on another
  // feature's route (e.g. Class Primers → /modules) and must not relabel it.
  ...Object.fromEntries(
    COURSE_FEATURES.filter((f) => !f.inlineOnly).map((f) => [f.route.replace('/', ''), f.label]),
  ),
}

export function CourseBreadcrumbs({ sectionId, courseName, courseCode, userRole = 'professor' }: CourseBreadcrumbsProps) {
  const pathname = usePathname()
  const basePath = `/professor/courses/${sectionId}`
  const isProfessor = userRole === 'professor'

  // Extract the current sub-page segment
  const relative = pathname.replace(basePath, '')
  const segment = relative.split('/').filter(Boolean)[0] || ''
  const pageLabel = ROUTE_LABELS[segment] || segment.charAt(0).toUpperCase() + segment.slice(1)

  // Section-root (/professor/courses/[sectionId]) resolves to the About page,
  // which is gated to the owning professor. TAs/graders following that link
  // 404. Route them to the section's announcements page instead — that's
  // the staff-accessible landing for the section workspace.
  const sectionRootHref = isProfessor ? basePath : `${basePath}/announcements`

  const items = [
    isProfessor
      ? { label: 'My Courses', href: '/professor/courses' }
      : { label: 'My Sections', href: '/staff/courses' },
    { label: courseCode ? `${courseCode} — ${courseName}` : courseName, href: sectionRootHref },
    { label: pageLabel },
  ]

  return <Breadcrumbs items={items} />
}
