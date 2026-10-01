/**
 * Loading skeleton for the professor gradebook.
 *
 * This is the heaviest page in the product: four gradebook queries run in
 * parallel (grades, class analytics, projects, assignments) before anything
 * paints, over a table that can reach a few thousand cells. It had no
 * loading.tsx and no Suspense boundary, so the professor stared at the previous
 * screen for the whole round trip.
 *
 * Shaped like the real page: PageHeader, tab strip, then a wide table block.
 * The real table deliberately does NOT animate in — see src/lib/motion.ts.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function ProfessorGradesLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-28 rounded-xl" />
        <Skeleton className="h-4 w-80 rounded-xl" />
      </div>
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-xl" />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 flex-1 rounded-xl" />
        <Skeleton className="h-9 w-50 shrink-0 rounded-xl" />
      </div>
      <Skeleton className="h-[420px] w-full rounded-2xl" />
    </div>
  )
}
