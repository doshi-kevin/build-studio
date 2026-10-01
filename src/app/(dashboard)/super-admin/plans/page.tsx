/**
 * Plans (super_admin) — who has what, every institution on one grid.
 *
 * The per-institution card is where you CHANGE a plan. This is where you see
 * them together, which is the question that comes up when selling: which
 * schools do not have Live Classroom yet.
 *
 * Type: Server Component
 * Route: /super-admin/plans
 */

import Link from 'next/link'
import { Check, Minus, CalendarClock } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { logger } from '@/lib/logger'
import {
  ENTITLED_FEATURES,
  parseEntitlementConfig,
  evaluateEntitlement,
} from '@/lib/entitlements/entitled-features'

export const dynamic = 'force-dynamic'

export default async function PlansPage() {
  // Re-checked here, not only in the layout: the two render in parallel and the
  // layout denies by returning a dead end, so without this the page would still
  // stream every institution on the platform.
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('PlansPage: denied, skipping fetch', { reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data, error } = await adminDb
    .from('institutions')
    .select('id, name, slug, status, settings')
    .order('name')

  if (error) {
    logger.error('PlansPage: read failed', error)
    return (
      <div className="mx-auto max-w-6xl space-y-8">
        <Header />
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load plans. Refresh the page to try again.
        </div>
      </div>
    )
  }

  const now = new Date()
  const rows = (data ?? []).map(
    (inst: { id: string; name: string; slug: string; status: string; settings: unknown }) => {
      const config = parseEntitlementConfig(inst.settings)
      return {
        ...inst,
        verdicts: ENTITLED_FEATURES.map((f) => ({
          key: f.key,
          label: f.label,
          ...evaluateEntitlement(config, f.key, now),
        })),
      }
    },
  )

  // The number worth surfacing: a product nobody has is either mispriced or
  // forgotten, and a product everybody has is not really a product.
  const adoption = ENTITLED_FEATURES.map((f) => ({
    label: f.label,
    count: rows.filter(
      (r: { verdicts: { key: string; entitled: boolean }[] }) =>
        r.verdicts.find((v) => v.key === f.key)?.entitled,
    ).length,
  }))

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Header />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          No institutions yet.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-4 py-3 text-left font-medium">Institution</th>
                  {ENTITLED_FEATURES.map((f) => (
                    <th key={f.key} className="px-3 py-3 text-center font-medium whitespace-nowrap">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(
                  (row: {
                    id: string
                    name: string
                    status: string
                    verdicts: {
                      key: string
                      label: string
                      entitled: boolean
                      pendingRevocationAt?: string | null
                    }[]
                  }) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          href={`/super-admin/institutions/${row.id}`}
                          className="font-medium hover:underline"
                        >
                          {row.name}
                        </Link>
                        {row.status !== 'active' && (
                          <span className="ml-2 text-muted-foreground">({row.status})</span>
                        )}
                      </td>
                      {row.verdicts.map((v) => (
                        <td key={v.key} className="px-3 py-3 text-center">
                          {/* role="img" is load-bearing, not decoration: lucide
                              skips its default aria-hidden once an aria-label is
                              present, but a bare <svg> has no reliable mapped
                              role, so several screen readers drop the label and
                              announce an empty cell — which reads as "this
                              school has nothing". */}
                          {!v.entitled ? (
                            <Minus
                              role="img"
                              className="mx-auto size-4 text-muted-foreground/50"
                              aria-label={`${v.label}: not included`}
                            />
                          ) : v.pendingRevocationAt ? (
                            <CalendarClock
                              role="img"
                              className="mx-auto size-4 text-muted-foreground"
                              aria-label={`${v.label}: ends ${new Date(
                                v.pendingRevocationAt,
                              ).toLocaleDateString('en-US', { timeZone: 'UTC' })}`}
                            />
                          ) : (
                            <Check
                              role="img"
                              className="mx-auto size-4 text-muted-foreground"
                              aria-label={`${v.label}: included`}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-medium">How many schools have each product</p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {adoption.map((a) => (
                <span key={a.label}>
                  {a.label}: {a.count} of {rows.length}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Header() {
  return (
    <div>
      <p className="text-[12px] uppercase tracking-wide text-muted-foreground">Administration</p>
      <h1 className="font-[family-name:var(--font-instrument-serif)] text-3xl">Plans</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What every institution has bought. Click a name to change one. A clock means the feature is
        scheduled to switch off.
      </p>
    </div>
  )
}
