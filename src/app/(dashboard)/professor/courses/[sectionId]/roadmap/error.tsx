/**
 * Catches a failed roadmap load at THIS segment, so the boundary renders inside
 * courses/[sectionId]/layout.tsx and the course rail survives.
 *
 * Type: Client Component
 * Route: /professor/courses/[sectionId]/roadmap
 */
'use client'

import { RoadmapLoadError } from '@/components/shared/auto-roadmap/RoadmapLoadError'

export default function ProfessorRoadmapError({ reset }: { error: Error; reset: () => void }) {
  return <RoadmapLoadError reset={reset} audience="prof" />
}
