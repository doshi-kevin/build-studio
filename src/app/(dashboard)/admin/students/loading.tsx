/**
 * Loading skeleton for the institution's student directory.
 *
 * Shaped from the real page, not from an assumption: `space-y-8` column, an
 * "Administration" eyebrow, a serif display title, a description, the
 * Enrollment-policy card, a toolbar, then a 4-up card grid. An earlier version
 * of this file drew a plain title over full-width table rows and landed content
 * up to 269px below where it promised.
 *
 * Both pages in this segment call verifyInstitutionAdmin before touching the
 * admin client, which is the precondition for suspending this subtree at all.
 *
 * The cards themselves deliberately carry no entrance animation — a directory
 * is a lookup surface. See src/lib/motion.ts.
 */

import { Skeleton } from '@/components/ui/skeleton'

export default function AdminStudentsLoading() {
  return (
    <div className="space-y-8">
      <div>
        {/* h-4 not h-3: the eyebrow's text-[11px] line box is 16.5px.
            h-12 not h-8: text-[32px] in Instrument Serif renders 48px tall.
            Underestimating both put every row below the header 23px high. */}
        <Skeleton className="mb-2 h-4 w-28 rounded-xl" />
        <Skeleton className="h-12 w-40 rounded-xl" />
        <Skeleton className="mt-2 h-5 w-96 max-w-full rounded-xl" />
      </div>
      {/* EnrollmentPolicyCard — unique to this page, and ~102px of it. */}
      <Skeleton className="h-[102px] w-full rounded-2xl" />
      {/* Toolbar, result count and grid are one space-y-5 block on the real
          page, not three space-y-8 siblings, and the "N students" count line
          sits between the toolbar and the grid. Missing both cost 28px. */}
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-80 max-w-full rounded-xl" />
          <Skeleton className="h-9 w-36 rounded-xl" />
        </div>
        <Skeleton className="h-5 w-24 rounded-xl" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-[158px] w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  )
}
