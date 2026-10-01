/**
 * Feature Requests (super_admin) — the queue of schools asking for a feature
 * their plan does not include.
 *
 * Type: Server Component
 * Route: /super-admin/feature-requests
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { logger } from '@/lib/logger'
import {
  FeatureRequestQueue,
  type FeatureRequestRow,
} from '@/components/super-admin/FeatureRequestQueue'

export const dynamic = 'force-dynamic'

/** Supabase returns a single relation as an object or an array depending on context. */
const resolveJoin = <T,>(val: T | T[] | null): T | null =>
  Array.isArray(val) ? (val[0] ?? null) : val

export default async function FeatureRequestsPage() {
  // Re-checked here, not just in the layout: layout and page render in parallel,
  // and the super-admin layout denies by RETURNING a dead end rather than
  // throwing, so without this the page would still stream cross-tenant data.
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('FeatureRequestsPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data, error } = await adminDb
    .from('institution_feature_requests')
    .select('id, feature_key, message, created_at, institutions(name), profiles!requested_by(first_name, last_name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    logger.error('FeatureRequestsPage: read failed', error)
  }

  const requests: FeatureRequestRow[] = (data ?? []).map(
    (row: {
      id: string
      feature_key: string
      message: string | null
      created_at: string
      institutions: { name: string } | { name: string }[] | null
      profiles: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null
    }) => {
      const institution = resolveJoin(row.institutions)
      const requester = resolveJoin(row.profiles)
      return {
        id: row.id,
        feature_key: row.feature_key,
        message: row.message,
        created_at: row.created_at,
        institutionName: institution?.name ?? 'Unknown institution',
        requesterName:
          [requester?.first_name, requester?.last_name].filter(Boolean).join(' ') || 'Someone',
      }
    },
  )

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div>
        <p className="text-[12px] uppercase tracking-wide text-muted-foreground">Administration</p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">
          Feature requests
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Approving turns the feature on for that school straight away.
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load the request queue. Refresh the page to try again.
        </div>
      ) : (
        <FeatureRequestQueue requests={requests} />
      )}
    </div>
  )
}
