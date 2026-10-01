'use client'

/**
 * Tells the Athena shell — which now lives a layout above this one — which
 * course the student is in, and whether the professor has her switched on.
 *
 * Renders nothing. It exists because the shell moved up to `/student/layout.tsx`
 * so it could survive a drive to a non-course page (§14.7 D1), which put it out
 * of reach of the props the course layout resolves. Announcing beats fetching:
 * these three values are already in hand on the server, behind the enrollment
 * check the layout performs regardless.
 */

import { useEffect } from 'react'
import { announceAthenaCourse } from '@/lib/hooks/use-athena-course'

export function AthenaCourseBeacon({
  sectionId,
  courseCode,
  enabled,
}: {
  sectionId: string
  courseCode: string
  enabled: boolean
}) {
  useEffect(() => {
    announceAthenaCourse({ sectionId, courseCode, enabled })
  }, [sectionId, courseCode, enabled])

  return null
}
