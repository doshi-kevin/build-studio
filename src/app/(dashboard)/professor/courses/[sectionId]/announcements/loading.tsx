/**
 * Loading skeleton for the professor's announcements list.
 *
 * The page's own guard runs before its first privileged fetch, which is what
 * makes a boundary here safe.
 *
 * Shaped like the real page: header with a compose action, then announcement rows.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function ProfessorAnnouncementsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-8 w-48 rounded-xl" />
        <Skeleton className="h-9 w-36 rounded-xl" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
