/**
 * ReadTracker — fires markAnnouncementRead on mount.
 *
 * Used in the announcement detail page to track when a student views
 * an announcement. Silent — renders nothing visible.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useRef } from 'react'
import { markAnnouncementRead } from '@/app/(dashboard)/student/courses/[sectionId]/announcements/actions'

interface ReadTrackerProps {
  announcementId: string
  sectionId: string
}

export function ReadTracker({ announcementId, sectionId }: ReadTrackerProps) {
  const tracked = useRef(false)

  useEffect(() => {
    if (tracked.current) return
    tracked.current = true
    markAnnouncementRead(announcementId, sectionId)
  }, [announcementId, sectionId])

  return null
}
