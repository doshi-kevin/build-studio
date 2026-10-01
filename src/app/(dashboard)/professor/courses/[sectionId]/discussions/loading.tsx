/**
 * Loading skeleton for course discussions.
 *
 * Two columns: the channel and people rail, then the message pane. Modelling
 * the split matters more than the rows here, because getting the column widths
 * wrong is what produces a visible jump when the real pane arrives.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function ProfessorDiscussionsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-40 rounded-xl" />
      <div className="flex gap-4">
        <div className="hidden w-60 shrink-0 space-y-2 md:block">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[420px] flex-1 rounded-2xl" />
      </div>
    </div>
  )
}
