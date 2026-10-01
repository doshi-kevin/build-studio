/**
 * Department Detail Loading Skeleton — shown while the department detail page loads.
 *
 * Mirrors the layout of the actual DepartmentDetailPage:
 * - Back navigation link
 * - Department name + code badge
 * - Edit form skeleton (2-column grid of input fields)
 * - Tab bar skeleton with 4 tab placeholders
 * - Tab content area skeleton
 *
 * Type: Server Component (no client state needed)
 * Route: /admin/departments/[departmentId] (loading state)
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function DepartmentDetailLoading() {
  return (
    <div className="space-y-6">
      {/* Back link */}
      <Skeleton className="h-5 w-40" />

      {/* Page header — name + status badge */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>

      {/* Edit form card skeleton */}
      <div className="border rounded-lg p-6 space-y-4">
        <Skeleton className="h-6 w-40" />

        {/* Name + Code row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>

        {/* Office + Email row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>

      {/* Tabs skeleton */}
      <div className="space-y-4">
        <div className="flex gap-4 border-b">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
        </div>
        <div className="border rounded-lg p-6">
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}
