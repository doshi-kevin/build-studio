/**
 * Catches a failed roadmap load at THIS segment, so the boundary renders inside
 * courses/[sectionId]/layout.tsx and the course rail survives.
 *
 * Type: Client Component
 * Route: /student/courses/[sectionId]/roadmap
 */
'use client'

import { RoadmapLoadError } from '@/components/shared/auto-roadmap/RoadmapLoadError'

export default function StudentRoadmapError({ reset }: { error: Error; reset: () => void }) {
  return <RoadmapLoadError reset={reset} audience="stu" />
}
