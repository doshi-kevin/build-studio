/**
 * Challenge Board Server Actions — Student claims, submissions, and proposals.
 *
 * Students claim challenges, submit solutions, withdraw claims,
 * and propose new challenges for professor approval.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  submitSolutionSchema,
  proposeChallengeSchema,
  type SubmitSolutionInput,
  type ProposeChallengeInput,
} from '@/lib/validations/challenge'

// ── Types ───────────────────────────────────────────────────────

type ActionResult = { success?: boolean; error?: string; data?: unknown }

// ── Helpers ─────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyEnrollment(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any

  const { data: enrollment } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .single()

  if (!enrollment) return { enrolled: false as const, adminDb }
  return { enrolled: true as const, adminDb }
}

function sectionPath(sectionId: string) {
  return `/student/courses/${sectionId}`
}

// ── Claim Actions ───────────────────────────────────────────────

export async function claimChallenge(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Verify challenge exists, is published, and belongs to this section
    const { data: challenge, error: challengeError } = await adminDb
      .from('challenges')
      .select('id, section_id, visibility')
      .eq('id', challengeId)
      .eq('section_id', sectionId)
      .eq('visibility', 'published')
      .single()

    if (challengeError || !challenge) return { error: 'Challenge not found or not available' }

    /* An RPC, not an insert (#703 part 1). A plain INSERT always collided with
       UNIQUE (challenge_id, user_id) after a withdrawal, so "Re-claim" was a dead button with no
       recovery path: the student got "you have already claimed this" forever.

       The RPC is one atomic `insert ... on conflict do update`, and its `where` clause only revives
       a WITHDRAWN row. That matters: an unconditional upsert would let a student reset their own
       APPROVED claim back to 'claimed' and wipe the reviewer's note. Verified against production,
       an approved claim survives the call untouched and it returns zero rows.

       Zero rows therefore means "there is a claim and it is not withdrawn", which is exactly the
       already-claimed case. */
    const { data: claimRows, error: claimError } = await adminDb
      .rpc('claim_challenge', { p_challenge_id: challengeId, p_user_id: user.id })

    if (claimError) {
      logger.error('claimChallenge: RPC failed', claimError, { challengeId, sectionId })
      return { error: 'Failed to claim challenge' }
    }

    const claim = (claimRows as { claim_id: string; revived: boolean }[] | null)?.[0]
    if (!claim) return { error: 'You have already claimed this challenge' }

    logEvent({
      userId: user.id,
      /* A revive is a distinct event. Without the distinction a student's engagement timeline shows
         a claim they never made a second time, and there is no trace of the withdraw-and-return. */
      eventType: claim.revived ? 'challenge.reclaimed' : 'challenge.claimed',
      eventCategory: 'student',
      metadata: { challengeId, claimId: claim.claim_id, revived: claim.revived },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true, data: { id: claim.claim_id } }
  } catch (error) {
    logger.error('claimChallenge: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function withdrawClaim(
  claimId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Verify claim belongs to user and is in 'claimed' status
    const { data: claim, error: claimError } = await adminDb
      .from('challenge_claims')
      .select('id, user_id, status')
      .eq('id', claimId)
      .eq('user_id', user.id)
      .single()

    if (claimError || !claim) return { error: 'Claim not found' }
    if (claim.status !== 'claimed') return { error: 'Can only withdraw claims that have not been submitted' }

    const { error: updateError } = await adminDb
      .from('challenge_claims')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', claimId)

    if (updateError) {
      logger.error('withdrawClaim: Update failed', updateError, { claimId, sectionId })
      return { error: 'Failed to withdraw claim' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.claim_withdrawn',
      eventCategory: 'student',
      metadata: { claimId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('withdrawClaim: Unexpected error', error, { claimId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Submission ──────────────────────────────────────────────────

export async function submitSolution(
  claimId: string,
  sectionId: string,
  input: SubmitSolutionInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = submitSolutionSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    // Verify claim belongs to user and is in 'claimed' status
    const { data: claim, error: claimError } = await adminDb
      .from('challenge_claims')
      .select('id, user_id, status')
      .eq('id', claimId)
      .eq('user_id', user.id)
      .single()

    if (claimError || !claim) return { error: 'Claim not found' }
    if (claim.status !== 'claimed') return { error: 'Can only submit for active claims' }

    /* Claim the state transition FIRST, guarded, and only then write (#701).
       This used to insert the submission and THEN flip the claim to 'submitted', with the
       `claim.status !== 'claimed'` check above as its only protection — a read-decide-write
       across an await. Two parallel calls both saw a claim that hadn't been marked yet and
       both proceeded, so the professor's review panel showed two competing submissions under
       one claim row with nothing to say which was authoritative. Proven live with Promise.all.

       The guard rides in the WHERE, so the loser matches zero rows instead of racing. The
       earlier status check stays as a cheap early-out for the ordinary case; THIS is the
       boundary. Same compare-and-set-then-revert shape as respondToJoinRequest.

       Known residual: the CAS and the insert are not in one transaction, so a crash or
       timeout BETWEEN them strands the claim in 'submitted' with nothing attached, and the
       revert below only runs on a returned error. The student then cannot retry. Closing
       that needs an RPC doing both in one transaction — the same shape
       join_project_team_atomic uses for team capacity. Left as-is deliberately: it takes a
       process death in a millisecond-wide window, whereas the race this replaces was
       reproducible on demand with Promise.all. */
    const { data: claimed, error: claimTxError } = await adminDb
      .from('challenge_claims')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .eq('id', claimId)
      .eq('status', 'claimed')
      .select('id')
      .maybeSingle()

    if (claimTxError) {
      logger.error('submitSolution: Claim transition failed', claimTxError, { claimId, sectionId })
      return { error: 'Failed to submit solution' }
    }
    if (!claimed) {
      /* Past the ownership and status checks above, zero rows can only mean a concurrent
         submission won the race. Told, not swallowed — the student pressed Submit. */
      logger.warn('submitSolution: lost the submission race', { claimId, sectionId })
      return { error: 'This claim already has a submission. Reload to see it.' }
    }

    const { error: subError } = await adminDb
      .from('challenge_submissions')
      .insert({
        claim_id: claimId,
        submission_type: parsed.data.submission_type,
        content: parsed.data.content || null,
        url: parsed.data.url || null,
        file_url: parsed.data.file_url || null,
        file_path: parsed.data.file_path || null,
        file_name: parsed.data.file_name || null,
        file_size: parsed.data.file_size || null,
      })

    if (subError) {
      /* Revert, or the claim is stranded in 'submitted' with nothing attached and the
         student can never retry. Guarded on 'submitted' so a revert can't clobber a
         state someone else has already moved on to. */
      await adminDb
        .from('challenge_claims')
        .update({ status: 'claimed', updated_at: new Date().toISOString() })
        .eq('id', claimId)
        .eq('status', 'submitted')
      logger.error('submitSolution: Insert failed, claim reverted', subError, { claimId, sectionId })
      return { error: 'Failed to submit solution' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.solution_submitted',
      eventCategory: 'student',
      metadata: { claimId, submissionType: parsed.data.submission_type },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('submitSolution: Unexpected error', error, { claimId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Propose Challenge ───────────────────────────────────────────

export async function proposeChallenge(
  sectionId: string,
  input: ProposeChallengeInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = proposeChallengeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { enrolled, adminDb } = await verifyEnrollment(sectionId, user.id)
    if (!enrolled) return { error: 'Not enrolled in this section' }

    const { data, error: insertError } = await adminDb
      .from('challenges')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: parsed.data.title,
        description: parsed.data.description || '',
        type: parsed.data.type,
        difficulty: parsed.data.difficulty,
        points: parsed.data.points,
        visibility: 'draft',
        source: 'student_proposed',
      })
      .select('id')
      .single()

    if (insertError) {
      logger.error('proposeChallenge: Insert failed', insertError, { sectionId })
      return { error: 'Failed to propose challenge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.proposed',
      eventCategory: 'student',
      metadata: { challengeId: data.id, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/professor/courses/${sectionId}/challenges`)
    return { success: true, data: { id: data.id } }
  } catch (error) {
    logger.error('proposeChallenge: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Certificates (Slice D) ──────────────────────────────────────

/**
 * Mark earned certificates as seen (dismisses the celebration). Scoped to the
 * caller's own rows (student_id = auth.uid()) so a student can only ever touch
 * their own credentials, even with forged ids.
 */
export async function markCertificatesSeen(
  sectionId: string,
  certificateRowIds: string[],
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    if (!Array.isArray(certificateRowIds) || certificateRowIds.length === 0) return { success: true }

    const adminDb = createAdminClient()
    const { error } = await adminDb
      .from('student_certificates')
      .update({ seen_at: new Date().toISOString() })
      .in('id', certificateRowIds)
      .eq('student_id', user.id)
      .is('seen_at', null)

    if (error) {
      logger.error('markCertificatesSeen: update failed', error, { sectionId })
      return { error: 'Failed to update' }
    }

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('markCertificatesSeen: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
