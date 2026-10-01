/**
 * Professor Onboarding Server Actions — handles profile completion after invite acceptance.
 *
 * Called when a professor fills in their remaining profile details (phone, title,
 * office info, bio, research interests, URLs) during the onboarding wizard.
 *
 * Password is set earlier via SetPasswordDialog (gated on requires_password_set in
 * auth.users.app_metadata) before the wizard ever loads, so it isn't handled here.
 *
 * Updates two tables:
 * - profiles: phone, onboarding_completed, invite_status
 * - department_faculty: title, office fields, bio, research, URLs (primary department only)
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import { professorOnboardingSchema, type ProfessorOnboardingInput } from '@/lib/validations/professor-onboarding'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

/**
 * Completes professor onboarding — updates profile + primary department_faculty row.
 * Sets onboarding_completed=true and invite_status='active'.
 */
export async function completeOnboarding(input: ProfessorOnboardingInput) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { error: 'Not authenticated' }
    }

    const profile = await profileQueries.getProfileById(supabase, user.id)
    if (!profile || profile.role !== 'professor') {
      return { error: 'Unauthorized — professor access required' }
    }

    const parsed = professorOnboardingSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const data = parsed.data

    /* Update profile with phone + mark onboarding complete */
    const { error: profileError } = await adminDb
      .from('profiles')
      .update({
        phone: data.phone || null,
        onboarding_completed: true,
        invite_status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (profileError) {
      logger.error('completeOnboarding: Profile update failed', profileError, { userId: user.id })
      return { error: 'Failed to update profile' }
    }

    /* Update primary department_faculty row with remaining details */
    const { data: primaryFaculty } = await adminDb
      .from('department_faculty')
      .select('id')
      .eq('professor_id', user.id)
      .eq('is_primary_department', true)
      .single()

    if (primaryFaculty) {
      const { error: facultyError } = await adminDb
        .from('department_faculty')
        .update({
          title: data.title || null,
          office_location: data.office_location || null,
          office_hours: data.office_hours || null,
          office_phone: data.office_phone || null,
          bio: data.bio || null,
          research_interests: data.research_interests || null,
          website_url: data.website_url || null,
          linkedin_url: data.linkedin_url || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', primaryFaculty.id)

      if (facultyError) {
        logger.error('completeOnboarding: Faculty update failed', facultyError, { userId: user.id })
        /* Non-fatal — profile was already updated */
      }
    }

    logger.info('completeOnboarding: Success', { userId: user.id })
    logEvent({ userId: user.id, eventType: 'professor.onboarding_completed', metadata: {} })

    revalidatePath('/professor')
    revalidatePath('/professor/onboarding')
    return { success: true }
  } catch (error) {
    logger.error('completeOnboarding', error)
    return { error: 'Unexpected error' }
  }
}
