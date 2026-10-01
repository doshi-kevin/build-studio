/**
 * Loading skeleton for the student Modules page.
 *
 * The professor page has a Suspense fallback; the student one had neither that
 * nor a `loading.tsx`, so navigating there blocked with no feedback while the
 * server fetched modules, items and signed URLs. Students are the
 * latency-sensitive audience on this surface.
 *
 * Shaped like the real page: header, toolbar, summary line, collapsed sections.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function StudentModulesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32 rounded-xl" />
        <Skeleton className="h-4 w-64 rounded-xl" />
      </div>
      <Skeleton className="h-9 w-full rounded-xl" />
      <Skeleton className="h-4 w-40 rounded-xl" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
