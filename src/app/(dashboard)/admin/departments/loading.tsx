/**
 * Department List Loading Skeleton — shown while the department list page loads.
 *
 * Mirrors the layout of the actual DepartmentsPage:
 * - Page title + description (static text, no skeleton needed)
 * - Toolbar skeleton: search input, status filter, add button
 * - Table skeleton: header row + 5 placeholder rows with animated pulse
 *
 * Type: Server Component (no client state needed)
 * Route: /admin/departments (loading state)
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function DepartmentsLoading() {
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Departments</h1>
        <p className="text-muted-foreground mt-1">
          Manage academic departments, their programs, and faculty assignments.
        </p>
      </div>

      {/* Toolbar skeleton — search, filter, button */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex flex-1 gap-3">
          <Skeleton className="h-10 flex-1 max-w-sm" />
          <Skeleton className="h-10 w-[130px]" />
        </div>
        <Skeleton className="h-10 w-[160px]" />
      </div>

      {/* Table skeleton — header + 5 rows */}
      <div className="border rounded-lg">
        <div className="p-4 space-y-4">
          {/* Table header */}
          <div className="grid grid-cols-7 gap-4">
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 col-span-1" />
            <Skeleton className="h-4 w-8" />
          </div>

          {/* 5 skeleton rows */}
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="grid grid-cols-7 gap-4 py-2">
              <Skeleton className="h-5 col-span-1" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-5 w-8 mx-auto" />
              <Skeleton className="h-5 w-8 mx-auto" />
              <Skeleton className="h-5 w-8 mx-auto" />
              <Skeleton className="h-8 w-8" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
