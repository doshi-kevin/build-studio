/**
 * Studio review queue (super_admin): checks Studio couldn't decide on its own, oldest
 * first. Each shows the tool's stated purpose, what the check found, and the flagged
 * view's source as escaped read-only text. A decision takes a reason the professor reads.
 *
 * Type: Server Component
 * Route: /super-admin/studio-reviews
 */

import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { getReviewQueue } from '@/lib/studio/validator/service'
import { logger } from '@/lib/logger'
import { StudioReviewQueue } from '@/components/super-admin/StudioReviewQueue'

export const dynamic = 'force-dynamic'

export default async function StudioReviewsPage() {
  /* Re-check the role here: layout and page render in parallel (PR #555). Returning null
     is correct only because the layout renders the visible no-access dead end. */
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('StudioReviewsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }
  const items = await getReviewQueue()
  if (!items) throw new Error('The Studio review queue couldn’t be read.')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Studio</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">Review queue</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Checks Studio couldn’t decide on its own. Students can’t see a tool until its checks are approved. The professor reads your
          reason.
        </p>
      </div>
      <StudioReviewQueue items={items} />
    </div>
  )
}
