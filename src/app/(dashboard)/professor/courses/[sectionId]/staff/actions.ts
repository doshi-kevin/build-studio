// Server actions for professors managing TA/grader requests on a course section.
// Professors cannot create section_staff rows directly — they submit requests
// into section_staff_requests and an institution_admin approves them.
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { profileQueries } from '@/lib/supabase/queries'
import {
  submitStaffRequestSchema,
  type SubmitStaffRequestInput,
} from '@/lib/validations/section-staff'
import { sendStaffRequestSubmitted } from '@/lib/email'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'

async function verifyProfessorOwnsSection(sectionId: string) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Not authenticated' as const }

  const profile = await profileQueries.getProfileById(supabase, user.id)
  if (!profile || profile.role !== 'professor') {
    return { error: 'Unauthorized — professor access required' as const }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: section, error: sectionError } = await adminDb
    .from('course_sections')
    .select('id, professor_id, end_date, course:courses(id, code, title)')
    .eq('id', sectionId)
    .single()

  if (sectionError || !section) return { error: 'Section not found' as const }
  if (section.professor_id !== user.id) return { error: 'You do not own this section' as const }

  return {
    userId: user.id,
    email: user.email?.toLowerCase() || '',
    name: profile.name || 'your professor',
    section,
    adminDb,
  }
}

/**
 * Professor submits a candidate TA/grader for approval.
 * Creates a row in section_staff_requests with status='pending'.
 */
export async function submitStaffRequest(input: SubmitStaffRequestInput) {
  try {
    const parsed = submitStaffRequestSchema.safeParse(input)
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors
      const firstError = Object.values(fieldErrors).flat()[0]
      return { error: firstError || 'Invalid input' }
    }
    const data = parsed.data

    const ctx = await verifyProfessorOwnsSection(data.section_id)
    if ('error' in ctx) return { error: ctx.error }

    /* Default ends_at to section.end_date + 1 day if not supplied. */
    const defaultEnd = ctx.section.end_date
      ? new Date(new Date(ctx.section.end_date).getTime() + 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 150 * 24 * 60 * 60 * 1000).toISOString()

    if (data.candidate_email === ctx.email) {
      return { error: 'You cannot nominate yourself as a course assistant' }
    }

    /* Duplicate-pending guard (the DB unique index also enforces this). */
    const { data: existingPending } = await ctx.adminDb
      .from('section_staff_requests')
      .select('id')
      .eq('section_id', data.section_id)
      .ilike('candidate_email', data.candidate_email)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingPending) {
      return { error: 'A pending request already exists for this email on this section' }
    }

    /* Warn if candidate is already active staff for this section. */
    const { data: existingActive } = await ctx.adminDb
      .from('section_staff')
      .select('id, role, staff:profiles!section_staff_staff_id_fkey(email)')
      .eq('section_id', data.section_id)
      .eq('status', 'active')
      .maybeSingle()

    if (existingActive?.staff?.email?.toLowerCase() === data.candidate_email) {
      return { error: 'This person is already active staff on this section' }
    }

    const { error: insertError } = await ctx.adminDb
      .from('section_staff_requests')
      .insert({
        section_id: data.section_id,
        requested_by: ctx.userId,
        candidate_email: data.candidate_email,
        candidate_first_name: data.candidate_first_name,
        candidate_last_name: data.candidate_last_name,
        requested_role: data.requested_role,
        starts_at: data.starts_at || new Date().toISOString(),
        ends_at: data.ends_at || defaultEnd,
        message: data.message || null,
      })

    if (insertError) {
      logger.error('submitStaffRequest: insert failed', insertError, { sectionId: data.section_id })
      return { error: 'Failed to submit request. Try again.' }
    }

    /* Tell the candidate their application is in review. Best-effort: the
     * request row is already committed, so an email failure must never turn a
     * successful submission into an error. sendStaffRequestSubmitted catches
     * internally and returns false; the try/catch guards a future refactor
     * that forgets that contract. */
    const course = Array.isArray(ctx.section.course) ? ctx.section.course[0] : ctx.section.course
    let candidateEmailOk = false
    try {
      candidateEmailOk = await sendStaffRequestSubmitted(
        data.candidate_email,
        `${data.candidate_first_name} ${data.candidate_last_name}`.trim() || data.candidate_email,
        {
          role: data.requested_role,
          courseLabel: course ? `${course.code} · ${course.title}` : 'your course',
          professorName: ctx.name,
        },
      )
    } catch (emailError) {
      logger.warn('submitStaffRequest: candidate email threw', {
        sectionId: data.section_id,
        error: emailError instanceof Error ? emailError.message : String(emailError),
      })
    }

    logger.info('submitStaffRequest: Success', {
      sectionId: data.section_id,
      role: data.requested_role,
      professorId: ctx.userId,
      candidateEmailOk,
    })
    logEvent({
      userId: ctx.userId,
      eventType: 'staff_request.submitted',
      sectionId: data.section_id,
      metadata: { candidate_email: data.candidate_email, role: data.requested_role },
    })

    revalidatePath(`/professor/courses/${data.section_id}/staff`)
    revalidatePath('/admin/staff')
    return { success: true }
  } catch (error) {
    logger.error('submitStaffRequest', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Professor withdraws their own pending request.
 * Only allowed while status='pending'.
 */
export async function withdrawStaffRequest(requestId: string, sectionId: string) {
  try {
    const ctx = await verifyProfessorOwnsSection(sectionId)
    if ('error' in ctx) return { error: ctx.error }

    const { data: req, error: fetchError } = await ctx.adminDb
      .from('section_staff_requests')
      .select('id, requested_by, status')
      .eq('id', requestId)
      .single()

    if (fetchError || !req) return { error: 'Request not found' }
    if (req.requested_by !== ctx.userId) return { error: 'You did not submit this request' }
    if (req.status !== 'pending') return { error: 'Only pending requests can be withdrawn' }

    const { error: deleteError } = await ctx.adminDb
      .from('section_staff_requests')
      .delete()
      .eq('id', requestId)

    if (deleteError) {
      logger.error('withdrawStaffRequest: delete failed', deleteError, { requestId })
      return { error: 'Failed to withdraw request' }
    }

    logEvent({
      userId: ctx.userId,
      eventType: 'staff_request.withdrawn',
      sectionId,
      metadata: { requestId },
    })
    revalidatePath(`/professor/courses/${sectionId}/staff`)
    revalidatePath('/admin/staff')
    return { success: true }
  } catch (error) {
    logger.error('withdrawStaffRequest', error)
    return { error: 'Unexpected error' }
  }
}
