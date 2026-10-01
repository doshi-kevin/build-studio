/**
 * Institution Detail (super_admin) — metadata, users-by-role, suspend control,
 * and an Invite Admin CTA when the institution has no admin assigned.
 *
 * Type: Server Component
 * Route: /super-admin/institutions/[id]
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, AlertTriangle } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySuperAdmin } from '@/lib/auth/super-admin-context'
import { institutionQueries } from '@/lib/supabase/queries'
import { logger } from '@/lib/logger'
import { InstitutionDetailHeader } from '@/components/super-admin/institutions/InstitutionDetailHeader'
import { InstitutionUsersList } from '@/components/super-admin/institutions/InstitutionUsersList'
import { InviteAdminCard } from '@/components/super-admin/institutions/InviteAdminCard'
import { AiPolicyEditor } from '@/components/shared/AiPolicyEditor'
import { InstitutionEntitlementsCard } from '@/components/super-admin/institutions/InstitutionEntitlementsCard'
import { updateInstitutionPlatformAiPolicy } from '../ai-actions'
import { updateInstitutionEntitlements } from '../entitlement-actions'
import { getEntitlementConfig } from '@/lib/entitlements/check'
import { getEffectiveAiPolicy } from '@/lib/ai/kill-switch'
import { AI_FEATURES, AI_FEATURE_KEYS, type AiFeatureKey } from '@/lib/ai/ai-features'

export const dynamic = 'force-dynamic'

export default async function InstitutionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  /**
   * Re-check the role HERE, not just in the layout. Layout and page segments render
   * in PARALLEL, and the super-admin layout denies by RETURNING a <DeadEnd/> rather
   * than throwing — so without this guard the page still executed and streamed its
   * data. That made this the worst leak in the app: any authenticated user GETting
   * /super-admin/institutions/<uuid> got a 200 whose body carried that institution's
   * full roster (real names and email addresses, grouped by role), for ANY
   * institution, with the seed UUIDs trivially guessable.
   *
   * Returning null is correct here and is not the usual page pattern — the layout is
   * already rendering the visible no-access dead end around this slot.
   */
  const auth = await verifySuperAdmin()
  if ('error' in auth) {
    logger.warn('InstitutionDetailPage: denied, skipping fetch', { id, reason: auth.error })
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const institution = await institutionQueries.getById(adminDb, id)
  if (!institution) {
    logger.warn('InstitutionDetailPage: Institution not found', { id })
    notFound()
  }

  const users = await institutionQueries.getUsersByInstitution(adminDb, id)
  const adminCount = users.filter((u: { role: string }) => u.role === 'institution_admin').length

  // AI kill switch: this card edits the PLATFORM layer (Scholera's per-tenant
  // lock). Rows the GLOBAL layer disables render locked — lift those on
  // /super-admin/ai-controls, not here. Same calm-inline-state rule as
  // /admin/settings if the read fails.
  let aiPolicy: Awaited<ReturnType<typeof getEffectiveAiPolicy>> | null = null
  try {
    aiPolicy = await getEffectiveAiPolicy(adminDb, id)
  } catch (error) {
    logger.error('InstitutionDetailPage: AI policy read failed', error, { id })
  }
  // The plan card. Its own read with its own failure handling, deliberately
  // separate from the AI policy read above: the two controls fail in opposite
  // directions and must never share an error path.
  // Own try/catch, same reason as /admin/settings: a permissive default here
  // would tell staff this institution has products it does not, and the AI card
  // further down already renders a couldn't-load state on the same page.
  let entitlements: Awaited<ReturnType<typeof getEntitlementConfig>> | null = null
  try {
    entitlements = await getEntitlementConfig(adminDb, id)
  } catch (error) {
    logger.error('InstitutionDetailPage: entitlement read failed', error, { id })
  }

  // Suggested date for a scheduled revocation: the latest end_date across this
  // institution's running sections. Only a SUGGESTION. The stored value is an
  // absolute timestamp the super admin confirms, because a date derived from
  // user-editable section data cannot enforce a contract.
  const { data: runningSections } = await adminDb
    .from('course_sections')
    .select('end_date')
    .eq('institution_id', id)
    .not('end_date', 'is', null)
    .gte('end_date', new Date().toISOString())
    .order('end_date', { ascending: false })
    .limit(1)
  const suggestedRevocationDate: string | null =
    runningSections?.[0]?.end_date ? new Date(runningSections[0].end_date).toISOString() : null

  const selfDisabled = aiPolicy
    ? aiPolicy.institution.institution.allDisabled
      ? 'everything'
      : aiPolicy.institution.institution.disabledFeatures
          .map((k) => AI_FEATURES.find((f) => f.key === k)?.label ?? k)
          .join(', ')
    : ''

  logger.info('InstitutionDetailPage: Loaded', { id, slug: institution.slug, users: users.length, adminCount })

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <Link
        href="/super-admin"
        className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Institutions
      </Link>

      <InstitutionDetailHeader institution={institution} totalUsers={users.length} adminCount={adminCount} />

      {adminCount === 0 && (
        <div className="rounded-2xl border border-border bg-muted/20 p-6">
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
            <div>
              <h2 className="font-[family-name:var(--font-instrument-serif)] text-xl">
                No admin assigned
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                This institution has no <code className="text-[12px]">institution_admin</code> yet.
                Without one, no one at the customer can manage their own departments, professors, or
                students. Invite an admin below.
              </p>
            </div>
          </div>
          <InviteAdminCard institutionId={institution.id} institutionName={institution.name} />
        </div>
      )}

      <InstitutionUsersList users={users} />

      {entitlements ? (
        <InstitutionEntitlementsCard
          initial={entitlements}
          suggestedRevocationDate={suggestedRevocationDate}
          save={updateInstitutionEntitlements.bind(null, id)}
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load this institution&apos;s plan — refresh the page to try again.
        </div>
      )}

      {aiPolicy ? (
        <AiPolicyEditor
          initial={{
            allDisabled: aiPolicy.institution.platform.allDisabled,
            disabledFeatures: aiPolicy.institution.platform.disabledFeatures as AiFeatureKey[],
            version: aiPolicy.institution.platform.version,
          }}
          lockedAll={aiPolicy.global.allDisabled}
          lockedFeatures={AI_FEATURE_KEYS.filter((key) => aiPolicy.global.disabledFeatures.includes(key))}
          lockedNote="Disabled globally"
          lockedSuffix="disabled globally (AI Controls)"
          lockedBanner="All AI features are disabled globally (AI Controls). This institution's settings are kept and apply again when the global switch is lifted."
          partialLockNote="Some features are disabled globally (AI Controls). Settings here are kept and resume when the global switch lifts."
          heading="AI Controls"
          description={`Scholera's kill switch for ${institution.name}. Anything you disable here overrides the institution's own settings — their admins see it locked and cannot re-enable it.`}
          scopeLabel={`all professors and students at ${institution.name}`}
          footnote={
            selfDisabled
              ? `The institution's own admins have additionally disabled: ${selfDisabled}.`
              : 'The institution’s own admins have not disabled anything themselves.'
          }
          idPrefix="ai-platform"
          save={updateInstitutionPlatformAiPolicy.bind(null, id)}
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          Couldn&apos;t load this institution&apos;s AI controls — refresh the page to try again.
        </div>
      )}
    </div>
  )
}
