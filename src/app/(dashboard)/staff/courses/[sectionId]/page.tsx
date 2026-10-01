/**
 * Staff Section Detail — legacy intermediate step, now a redirect.
 * Staff (TA/grader) cards jump straight into the shared professor workspace.
 * This route stays only to forward any stale bookmarks.
 */

import { redirect } from 'next/navigation'

interface StaffSectionPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function StaffSectionPage({ params }: StaffSectionPageProps) {
  const { sectionId } = await params
  redirect(`/professor/courses/${sectionId}/announcements`)
}
