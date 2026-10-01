// Loading skeleton for the quiz studio — matches its header + rail + canvas layout.

import { Skeleton } from '@/components/ui/skeleton'

export default function QuizDetailLoading() {
  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)]">
      {/* Header — back + inline title/description + action buttons */}
      <div className="shrink-0 border-b pb-3 bg-background">
        <div className="flex items-start justify-between gap-4 pt-1">
          <div className="flex items-start gap-2">
            <Skeleton className="h-8 w-8 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-xl" />
            <Skeleton className="h-8 w-24 rounded-xl" />
            <Skeleton className="h-8 w-24 rounded-xl" />
          </div>
        </div>
      </div>

      {/* Body — rail + canvas */}
      <div className="flex flex-1 min-h-0">
        <div className="w-48 shrink-0 space-y-2 border-r p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
          <Skeleton className="h-8 w-full rounded-xl" />
        </div>
        <div className="flex-1 space-y-4 p-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}
