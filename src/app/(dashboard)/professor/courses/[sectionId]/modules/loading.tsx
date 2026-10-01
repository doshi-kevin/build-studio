/**
 * Loading skeleton for the professor's module board.
 *
 * The heaviest content page in a course: modules, their items, and a signed URL
 * per attached file. It had a Suspense fallback inside the page but no route
 * boundary, so the click itself produced nothing.
 *
 * Every page under this segment authorizes itself before fetching — required,
 * because a loading.tsx suspends its whole subtree, not just its own page.
 *
 * Shaped like ModulesBoard: max-w-5xl column, header, toolbar, section rows.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function ProfessorModulesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40 rounded-xl" />
          <Skeleton className="h-5 w-72 max-w-full rounded-xl" />
        </div>
        {/* A split button, so it is wider than a plain one and grows leftward. */}
        <Skeleton className="h-9 w-[167px] shrink-0 rounded-xl" />
      </div>
      <Skeleton className="h-9 w-full rounded-xl" />
      {/* The "13 modules · 32 items · 3 drafts" count line. */}
      <Skeleton className="h-4 w-56 rounded-xl" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
