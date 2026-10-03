'use server'

/**
 * The super admin's decision on one Studio check waiting for review. Thin on purpose:
 * resolveValidationReview verifies the super admin, binds the decision to the artifact
 * they saw, writes through the database's own guard (super admin only, never the
 * version's publisher, once per check), and logs it.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { resolveValidationReview } from '@/lib/studio/validator/service'

export async function resolveReviewAction(input: {
  validationId: string
  checkId: string
  artifactSha256: string
  decision: 'approved' | 'rejected'
  reason: string
}): Promise<{ success: true } | { error: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'This isn’t available.' }
  const result = await resolveValidationReview(input)
  if (!result.ok) return { error: result.error }
  revalidatePath('/super-admin/studio-reviews')
  revalidatePath('/super-admin')
  return { success: true }
}
