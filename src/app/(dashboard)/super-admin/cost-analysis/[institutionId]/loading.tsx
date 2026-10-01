/** Route-level skeleton for the institution cost detail page. */
import { Skeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-72" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Skeleton className="h-[280px] rounded-2xl lg:col-span-2" />
        <Skeleton className="h-[280px] rounded-2xl lg:col-span-3" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  )
}
