// Loading skeleton for the professor quiz dashboard — matches QuizDashboard/QuizList layout.

import { Skeleton } from '@/components/ui/skeleton'

export default function QuizzesLoading() {
  return (
    <div className="space-y-6">
      {/* Header — rendered by QuizDashboard */}
      <div>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>

      {/* Tabs skeleton */}
      <Skeleton className="h-10 w-80" />

      {/* Search bar + Create button row — matches QuizList flex layout */}
      <div className="space-y-4">
        <div className="flex gap-3">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-[140px]" />
        </div>

        {/* Stacked quiz card rows — matches grid gap-3 single-column layout */}
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1">
                <Skeleton className="h-5 w-5" />
                <div className="flex-1">
                  <Skeleton className="h-5 w-2/5" />
                  <div className="flex items-center gap-3 mt-2">
                    <Skeleton className="h-4 w-16 rounded-full" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
              </div>
              <Skeleton className="h-8 w-8" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
