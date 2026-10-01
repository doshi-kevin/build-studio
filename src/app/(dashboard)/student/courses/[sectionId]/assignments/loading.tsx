/**
 * Loading skeleton for the student assignment list.
 *
 * The page re-verifies the session, the enrolment and the feature toggle before
 * it fetches, so first paint is several round trips deep.
 *
 * Shaped like the real page: header, then assignment rows with status.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function StudentAssignmentsLoading() {
  return (
    <div className="space-y-6">
      {/* h-10 not h-8: the real heading is a ~42px display title, and the 10px
          underestimate cascaded down the whole page. */}
      <Skeleton className="h-10 w-44 rounded-xl" />
      {/* The StatBar panel: 2-up on mobile, 4-up from sm. Omitting it shifted
          everything below it by ~192px on a phone when the real page landed. */}
      <div className="rounded-2xl border border-border shadow-sm">
        <div className="grid grid-cols-2 divide-y divide-border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 p-4">
              <Skeleton className="h-3 w-16 rounded-xl" />
              <Skeleton className="h-6 w-10 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-4 w-40 rounded-xl" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
