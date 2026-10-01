import { createAdminClient } from '@/lib/supabase/admin'
import { studentCatalogQueries } from '@/lib/supabase/queries'
import { notFound } from 'next/navigation'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { verifyEntitled } from '@/lib/entitlements/check'
import { isEntitledFeatureKey } from '@/lib/entitlements/entitled-features'

/**
 * Verifies that a specific course feature is reachable for a student, and
 * notFound()s if it is not. Two independent reasons it might not be:
 *
 *  1. The INSTITUTION never bought it, or its plan was revoked. This is the
 *     ceiling, checked first because it outranks anything a professor chose.
 *  2. The PROFESSOR turned it off for this section.
 *
 * Used to stop a student direct-navigating to a page they should not reach.
 * Every caller gets both checks, which is why the entitlement check lives here
 * rather than being repeated across sixteen pages.
 */
export async function verifyFeatureEnabled(
  sectionId: string,
  featureKey: string,
  options?: {
    /**
     * This route shows work the student ALREADY did — a submitted attempt, a
     * returned grade — rather than offering new work. History stays readable
     * after a revocation (design doc §4.5), so the institution ceiling does not
     * apply here. The professor's own per-section toggle still does: that is
     * their teaching choice about their own course, not a contract change.
     */
    historical?: boolean
  },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    logger.warn('verifyFeatureEnabled: No user found')
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const section = await studentCatalogQueries.getStudentSectionDetail(adminDb, sectionId, user.id)

  if (!section) {
    logger.warn('verifyFeatureEnabled: Section not found or not enrolled', { sectionId, userId: user.id })
    notFound()
  }

  // The institution ceiling. A feature the school does not have is a dead end
  // regardless of the per-section toggle, and this deliberately behaves exactly
  // like the toggle already does, one tier up: the student's past results stay
  // reachable through Grades, which is not an entitled feature.
  if (isEntitledFeatureKey(featureKey) && !options?.historical) {
    await verifyEntitled(adminDb, sectionId, featureKey)
  }

  // Extract enabled features from settings JSONB
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = (section.settings as Record<string, any>) || {}
  const enabledFeatures: string[] = Array.isArray(settings.enabledFeatures)
    ? settings.enabledFeatures
    : []

  if (!enabledFeatures.includes(featureKey)) {
    logger.warn('verifyFeatureEnabled: Feature is disabled', { sectionId, featureKey, userId: user.id })
    notFound()
  }

  return { section, user }
}
