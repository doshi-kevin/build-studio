/**
 * Dashboard Loading Skeleton — shown while the role-specific dashboard data
 * fetches (the page waits on a dozen-plus DB queries before its first paint).
 *
 * Shape is deliberately generic: greeting + metric chips + a wide panel
 * beside a narrower rail. Professor and student render through the same
 * layout shell with different data underneath, so one skeleton covers both
 * without overfitting either role's specific rail widgets.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Greeting + metric chips */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
        <Skeleton className="h-8 w-56" />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:shrink-0">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-20" />
          ))}
        </div>
      </div>

      {/* Course cards row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 shrink-0">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>

      {/* To-do list + rail. 3fr/2fr mirrors both dashboards' ResizablePanelGroup
          defaultSize of 60/40 — a skeleton that predicts the wrong geometry turns
          a clean load into a visible reflow, which is worse than a spinner. A
          professor who has dragged the handles will still mismatch (sizes persist
          per autoSaveId); matching the default is the best available guess. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <Skeleton className="h-full min-h-[300px] w-full rounded-2xl" />
        <Skeleton className="h-full min-h-[300px] w-full rounded-2xl" />
      </div>
    </div>
  )
}
