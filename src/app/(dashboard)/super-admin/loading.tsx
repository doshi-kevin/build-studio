/**
 * Loading skeleton for the platform institution list.
 *
 * Covers the super-admin routes that have no nearer loading.tsx (the two
 * cost-analysis routes already have their own).
 *
 * Shaped like the real page: space-y-8 column, header, then institution rows.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function SuperAdminLoading() {
  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          {/* The "Platform" eyebrow, which the sibling cost-analysis skeleton
              already models. Omitting it left the header ~60px short. */}
          <Skeleton className="h-3 w-20 rounded-xl" />
          <Skeleton className="h-8 w-52 rounded-xl" />
        </div>
        <Skeleton className="h-9 w-40 rounded-xl" />
      </div>
      <div className="rounded-2xl border border-border divide-y divide-border">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none" />
        ))}
      </div>
    </div>
  )
}
