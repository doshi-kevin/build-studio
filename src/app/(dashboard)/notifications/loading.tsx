/**
 * Loading skeleton for the notification history page.
 *
 * Shaped like the real page: a narrow centred column, title, then rows.
 * The max-w-2xl mirrors the page so the column does not jump on arrival.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function NotificationsLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40 rounded-xl" />
        <Skeleton className="h-4 w-72 rounded-xl" />
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24 rounded-xl" />
        <Skeleton className="h-4 w-28 rounded-xl" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
