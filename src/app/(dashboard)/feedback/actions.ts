// Server actions for the feedback system. Handles submitting feedback
// from students/professors and admin operations (status updates, notes).
// On submit, posts a notification to the team's Slack #issues channel
// after the response is sent (via after()) so user UX never blocks on Slack.

'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertTenantOwns } from '@/lib/auth/assert-tenant-owns'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { postFeedbackToSlack } from '@/lib/slack'
import { submitFeedbackSchema, updateFeedbackStatusSchema } from '@/lib/validations/feedback'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

/** Submit feedback — called by students and professors from the floating widget */
export async function submitFeedback(input: unknown) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'You must be logged in to submit feedback.' }
  }

  const parsed = submitFeedbackSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || 'Invalid input.' }
  }

  // Get user role + institution from profile. institution_id is required for
  // tenant-scoped feedback (institution_admin only sees their own users' feedback).
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, institution_id')
    .eq('id', user.id)
    .single()

  if (!profile || (profile.role !== 'student' && profile.role !== 'professor')) {
    return { error: 'Only students and professors can submit feedback.' }
  }

  if (!profile.institution_id) {
    logger.error('submitFeedback: Profile missing institution_id', null, { userId: user.id })
    return { error: 'Your account is not linked to an institution. Contact support.' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: inserted, error } = await adminDb
    .from('feedbacks')
    .insert({
      user_id: user.id,
      user_role: profile.role,
      institution_id: profile.institution_id,
      rating: parsed.data.rating,
      category: parsed.data.category,
      message: parsed.data.message || null,
      page_url: parsed.data.page_url,
      page_context: parsed.data.page_context,
    })
    .select('id, created_at')
    .single()

  if (error) {
    logger.error('submitFeedback: Insert failed', error, { userId: user.id })
    return { error: 'Failed to submit feedback. Please try again.' }
  }

  logEvent({
    userId: user.id,
    eventType: 'feedback.submitted',
    eventCategory: 'feedback',
    metadata: {
      category: parsed.data.category,
      rating: parsed.data.rating,
      pageUrl: parsed.data.page_url,
    },
  })

  // Notify Slack #issues after the response returns. after() keeps the
  // Slack POST alive in serverless environments where dangling promises
  // would otherwise be killed when the response finishes.
  if (inserted) {
    after(async () => {
      // postFeedbackToSlack swallows its own errors, but wrap defensively
      // so a future regression can never surface as an unhandled rejection
      // in serverless logs (which would falsely look like a feedback failure).
      try {
        await postFeedbackToSlack({
          feedbackId: inserted.id,
          userId: user.id,
          userRole: profile.role as 'student' | 'professor',
          rating: parsed.data.rating,
          category: parsed.data.category,
          message: parsed.data.message || null,
          pageUrl: parsed.data.page_url,
          pageContext: parsed.data.page_context,
          createdAt: inserted.created_at || new Date().toISOString(),
        })
      } catch (err) {
        logger.warn('submitFeedback: Slack notification threw unexpectedly', {
          feedbackId: inserted.id,
          err: String(err),
        })
      }
    })
  }

  return { success: true }
}

/** Update feedback status and admin notes — admin only */
export async function updateFeedbackStatus(input: unknown) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { error: 'Unauthorized.' }
  }

  // Verify admin role + tenant
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, institution_id')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'institution_admin') {
    return { error: 'Only admins can update feedback status.' }
  }
  if (!profile.institution_id) {
    return { error: 'Your account is missing tenant assignment. Contact support.' }
  }

  const parsed = updateFeedbackStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || 'Invalid input.' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  /* Tenant guard — without this an admin in tenant A could mutate a
   * tenant-B feedback row's status / admin_notes. */
  const own = await assertTenantOwns(adminDb, 'feedbacks', parsed.data.id, profile.institution_id, { actionName: 'updateFeedbackStatus' })
  if (!own.ok) return { error: own.error }

  const updateData: Record<string, unknown> = { status: parsed.data.status }
  if (parsed.data.admin_notes !== undefined) {
    updateData.admin_notes = parsed.data.admin_notes || null
  }

  const { error } = await adminDb
    .from('feedbacks')
    .update(updateData)
    .eq('id', parsed.data.id)

  if (error) {
    logger.error('updateFeedbackStatus: Update failed', error, { feedbackId: parsed.data.id })
    return { error: 'Failed to update feedback.' }
  }

  logEvent({
    userId: user.id,
    eventType: 'feedback.status_updated',
    eventCategory: 'admin',
    metadata: {
      feedbackId: parsed.data.id,
      newStatus: parsed.data.status,
    },
  })

  revalidatePath('/admin/feedback')
  return { success: true }
}
