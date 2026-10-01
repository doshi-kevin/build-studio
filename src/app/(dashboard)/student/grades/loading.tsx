/**
 * Loading skeleton for the student's grades across every course.
 *
 * Shaped like the real page: title, GPA summary, then the grades table.
 *
 * `space-y-8 max-w-5xl mx-auto` mirrors GradesTable's own root container, which
 * IS this route's outermost element (the page renders nothing around it). A
 * full-width skeleton here would shunt the real content sideways on arrival.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function StudentGradesLoading() {
  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="space-y-2">
        <Skeleton className="h-8 w-36 rounded-xl" />
        <Skeleton className="h-4 w-64 rounded-xl" />
      </div>
      {/* grid-cols-1 sm:grid-cols-3, mirroring GradesTable. A single max-w-sm
          card here shifted the table ~190px on mobile. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[320px] w-full rounded-2xl" />
    </div>
  )
}
