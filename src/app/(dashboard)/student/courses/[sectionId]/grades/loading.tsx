/**
 * Loading skeleton for a student's grades in one course.
 *
 * Shaped like the real page: PageHeader, the grade summary card, then the
 * per-category breakdown.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function StudentCourseGradesLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-28 rounded-xl" />
        <Skeleton className="h-4 w-64 rounded-xl" />
      </div>
      <Skeleton className="h-32 w-full max-w-md rounded-2xl" />
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
