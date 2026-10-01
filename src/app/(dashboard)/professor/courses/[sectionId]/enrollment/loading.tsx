/**
 * Loading skeleton for the section roster.
 *
 * Shaped like the real page: header, search field, then roster rows.
 *
 * The `max-w-5xl mx-auto` mirrors RosterPage's own container. Without it the
 * skeleton drew full-width and the real content then jumped 156px to the right
 * on arrival — a mispredicted geometry turns a clean load into a visible
 * reflow, which is worse than showing no skeleton at all.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function ProfessorRosterLoading() {
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32 rounded-xl" />
        <Skeleton className="h-4 w-72 rounded-xl" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
