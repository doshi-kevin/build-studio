/**
 * Roadmap loading state — the paper and inked title appear instantly while the
 * page's data assembles, so navigation lands on "Course Roadmap" first and the
 * map fades in behind it.
 *
 * Route: /student/courses/[sectionId]/roadmap
 */

import { AutoRoadmapSkeleton } from '@/components/shared/auto-roadmap/AutoRoadmapSkeleton'

export default function StudentRoadmapLoading() {
  return <AutoRoadmapSkeleton audience="stu" />
}
