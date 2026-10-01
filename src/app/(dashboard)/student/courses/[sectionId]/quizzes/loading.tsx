// Loading skeleton for student quiz list — matches StudentQuizList/StudentQuizCard layout.

import { Skeleton } from '@/components/ui/skeleton'

export default function StudentQuizzesLoading() {
  return (
    <div className="space-y-6">
      {/* Header — matches PageHeader title + description */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-40 rounded-xl" />
        <Skeleton className="h-4 w-64 rounded-full" />
      </div>

      {/* Search + segmented filter bar */}
      <div className="flex gap-3">
        <Skeleton className="h-9 flex-1 rounded-xl" />
        <Skeleton className="h-9 w-44 rounded-xl" />
      </div>

      {/* Stacked quiz cards — matches grid gap-3 single-column with horizontal layout */}
      <div className="grid gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-5">
            <div className="flex-1 space-y-2">
              {/* Title row: dot + title + label */}
              <div className="flex items-center gap-2">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <Skeleton className="h-5 w-2/5 rounded-xl" />
                <Skeleton className="h-4 w-20 rounded-full" />
              </div>
              {/* Meta chips row */}
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-4 w-24 rounded-full" />
                <Skeleton className="h-4 w-20 rounded-full" />
                <Skeleton className="h-4 w-28 rounded-full" />
              </div>
            </div>
            {/* Action button on right */}
            <Skeleton className="h-9 w-24 shrink-0 rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}
