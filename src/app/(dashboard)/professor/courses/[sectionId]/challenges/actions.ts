/**
 * Challenge Board Server Actions — Professor manages challenges, reviews, and badges.
 *
 * Professors create/update/publish/archive challenges, review student claims,
 * manage badges, and approve/reject student-proposed challenges.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { emitEvent } from '@/lib/events/emit'
import { applyGradeToSkillMastery } from '@/lib/skills/grade-hook'
import {
  createChallengeSchema,
  updateChallengeSchema,
  reviewClaimSchema,
  createBadgeSchema,
  awardBadgeSchema,
  type CreateChallengeInput,
  type UpdateChallengeInput,
  type ReviewClaimInput,
  CHALLENGE_DIFFICULTY_STAKE,
  type ChallengeDifficulty,
  type CreateBadgeInput,
  type AwardBadgeInput,
} from '@/lib/validations/challenge'
import {
  createCertificateSchema,
  updateCertificateSchema,
  type CreateCertificateInput,
  type UpdateCertificateInput,
} from '@/lib/validations/certificate'

// ── Types ───────────────────────────────────────────────────────

type ActionResult = { success?: boolean; error?: string; data?: unknown }

// ── Helpers ─────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyOwnership(sectionId: string, userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: section, error } = await adminDb
    .from('course_sections')
    .select('id, professor_id, institution_id')
    .eq('id', sectionId)
    .single()

  if (error || !section) return { owned: false as const, adminDb, institutionId: null as string | null }
  if (section.professor_id !== userId) return { owned: false as const, adminDb, institutionId: null as string | null }
  return { owned: true as const, adminDb, institutionId: section.institution_id as string | null }
}

/**
 * Sync a challenge's skill links in the shared activity_skills map (activity_type
 * 'challenge'). Delete-and-reinsert is safe here: activity_id is polymorphic (no
 * FK), so nothing cascades, and the set is tiny. institution_id comes from the
 * verified section context, never the client (multi-tenant write provenance).
 */
async function syncChallengeSkills(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  institutionId: string | null,
  challengeId: string,
  skillIds: string[],
) {
  await adminDb
    .from('activity_skills')
    .delete()
    .eq('section_id', sectionId)
    .eq('activity_type', 'challenge')
    .eq('activity_id', challengeId)

  if (!institutionId || skillIds.length === 0) return

  // Guard against IDs from another section/tenant: only map skills that belong to
  // this section (the client sends skill_ids; treat them as untrusted).
  const { data: valid } = await adminDb
    .from('skills')
    .select('id')
    .eq('section_id', sectionId)
    .in('id', skillIds)
  const validIds = ((valid ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (validIds.length === 0) return

  await adminDb.from('activity_skills').insert(
    validIds.map((skillId) => ({
      section_id: sectionId,
      institution_id: institutionId,
      activity_type: 'challenge',
      activity_id: challengeId,
      skill_id: skillId,
    })),
  )
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}`
}

// ── Challenge CRUD ──────────────────────────────────────────────

export async function createChallenge(
  sectionId: string,
  input: CreateChallengeInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createChallengeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb, institutionId } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'challenges')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('challenges') }

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
        bonus_points: parsed.data.bonus_points,
        badge_id: parsed.data.badge_id || null,
        max_claims: parsed.data.max_claims || null,
        due_at: parsed.data.due_at || null,
        visibility: 'draft',
        source: 'instructor',
      })
      .select('id')
      .single()

    if (insertError) {
      /* 23505 is the partial unique index on (section_id, created_by, title) for drafts, which
         exists because a double-click created two identical drafts 4.4 ms apart in production
         (#703 part 2). The dialog's disabled-while-pending button does not catch that: the
         second click lands before React re-renders. So the collision is the guard working, not
         a failure, and it must not read as one. */
      if ((insertError as { code?: string }).code === '23505') {
        return { error: 'You already have a draft challenge with this title.' }
      }
      logger.error('createChallenge: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create challenge' }
    }

    await syncChallengeSkills(adminDb, sectionId, institutionId, data.id, parsed.data.skill_ids ?? [])

    logEvent({
      userId: user.id,
      eventType: 'challenge.created',
      eventCategory: 'professor',
      metadata: { challengeId: data.id, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true, data: { id: data.id } }
  } catch (error) {
    logger.error('createChallenge: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateChallenge(
  challengeId: string,
  sectionId: string,
  input: UpdateChallengeInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateChallengeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb, institutionId } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    /* Presence must come from the RAW input. updateChallengeSchema is `.partial()`
       over defaulted fields, so zod materialises description/type/difficulty/
       points/bonus_points/skill_ids for keys the caller never sent — a title-only
       edit would blank the description, reset points to 10, and (worst) make the
       skill_ids guard below always true, deleting every skill link. That is the
       exact opposite of what its own comment promises. Latent today: this action
       has no caller. Fixed now so wiring one up is safe.
       Mirrors updateQuestion in the quizzes actions. */
    const provided = (key: keyof UpdateChallengeInput) =>
      Object.prototype.hasOwnProperty.call(input ?? {}, key) &&
      (input as Record<string, unknown>)[key] !== undefined

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (provided('title')) updateData.title = parsed.data.title
    if (provided('description')) updateData.description = parsed.data.description
    if (provided('type')) updateData.type = parsed.data.type
    if (provided('difficulty')) updateData.difficulty = parsed.data.difficulty
    if (provided('points')) updateData.points = parsed.data.points
    if (provided('bonus_points')) updateData.bonus_points = parsed.data.bonus_points
    if (provided('badge_id')) updateData.badge_id = parsed.data.badge_id || null
    if (provided('max_claims')) updateData.max_claims = parsed.data.max_claims || null
    if (provided('due_at')) updateData.due_at = parsed.data.due_at || null

    // .select() so we can confirm a row was actually updated. A 0-row update
    // (challengeId belongs to another section) returns no error — we must NOT
    // proceed to sync relations on an object we don't own (IDOR / cross-tenant write).
    const { data: updated, error: updateError } = await adminDb
      .from('challenges')
      .update(updateData)
      .eq('id', challengeId)
      .eq('section_id', sectionId)
      .select('id')

    if (updateError) {
      /* Same 23505 branch as createChallenge, and it exists because the partial unique index I
         added for #703 part 2 also applies to RENAMES. A professor retitling a draft onto an
         existing draft's title now collides, and without this it reported "Failed to update
         challenge", which reads as a server fault for something they can fix in one edit. The
         create path got this treatment and the update path was overlooked. */
      if ((updateError as { code?: string }).code === '23505') {
        return { error: 'You already have a draft challenge with this title.' }
      }
      logger.error('updateChallenge: Update failed', updateError, { challengeId, sectionId })
      return { error: 'Failed to update challenge' }
    }
    if (!updated || updated.length === 0) return { error: 'Challenge not found' }

    /* Only re-sync skill links when the caller explicitly sent skill_ids, so a
       partial update that omits them doesn't silently wipe existing links. This is
       what provided() finally makes true — the previous
       `parsed.data.skill_ids !== undefined` was ALWAYS true, because zod
       materialises the field's `[]` default, so every partial edit deleted every
       link. Sending `[]` on purpose still clears them. */
    if (provided('skill_ids') && parsed.data.skill_ids) {
      await syncChallengeSkills(adminDb, sectionId, institutionId, challengeId, parsed.data.skill_ids)
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.updated',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('updateChallenge: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function publishChallenge(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: updateError } = await adminDb
      .from('challenges')
      .update({ visibility: 'published', updated_at: new Date().toISOString() })
      .eq('id', challengeId)
      .eq('section_id', sectionId)

    if (updateError) {
      logger.error('publishChallenge: Update failed', updateError, { challengeId, sectionId })
      return { error: 'Failed to publish challenge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.published',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('publishChallenge: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function archiveChallenge(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: updateError } = await adminDb
      .from('challenges')
      .update({ visibility: 'archived', updated_at: new Date().toISOString() })
      .eq('id', challengeId)
      .eq('section_id', sectionId)

    if (updateError) {
      logger.error('archiveChallenge: Update failed', updateError, { challengeId, sectionId })
      return { error: 'Failed to archive challenge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.archived',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('archiveChallenge: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * What a challenge delete would destroy, for the confirmation dialog.
 *
 * challenge_claims.challenge_id is ON DELETE CASCADE, so deleting a challenge that has
 * already been scored removes students' earned points with it — and there is no way to
 * re-grant them: reviewClaim only accepts claims in `submitted` state, so nothing
 * destroyed here can be restored through the product at all (#702).
 *
 * Returns null on ANY failure, never zeros. Zeros are an affirmative claim, and the dialog
 * renders them as "nothing is attached" — handing that back for a lookup that merely FAILED
 * is how a professor tidying up a course wipes real student credit while being told it is
 * safe. Same fail-closed rule as getSectionCascadeCounts (#715).
 */
export async function getChallengeCascadeCounts(
  challengeId: string,
  sectionId: string,
): Promise<{ claims: number; approved: number; points: number } | null> {
  try {
    const user = await getAuthUser()
    if (!user) return null

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return null

    const [{ data: challenge, error: cErr }, { data: claims, error: clErr }] = await Promise.all([
      adminDb.from('challenges').select('points, bonus_points').eq('id', challengeId).eq('section_id', sectionId).maybeSingle(),
      adminDb.from('challenge_claims').select('status').eq('challenge_id', challengeId),
    ])
    if (cErr || clErr) {
      logger.error('getChallengeCascadeCounts: read failed', cErr ?? clErr, { challengeId, sectionId })
      return null
    }

    const rows = (claims ?? []) as Array<{ status: string }>
    const approved = rows.filter((c) => c.status === 'approved').length
    const per = (challenge?.points ?? 0) + (challenge?.bonus_points ?? 0)
    return { claims: rows.length, approved, points: approved * per }
  } catch (error) {
    logger.error('getChallengeCascadeCounts', error, { challengeId, sectionId })
    return null
  }
}

/**
 * How many students currently hold a badge, for the delete confirmation.
 *
 * Deleting a badge cascades to every user_badges row, so it removes a credential from
 * students who already earned it. Null on any failure, for the same reason as above.
 */
export async function getBadgeCascadeCounts(
  badgeId: string,
  sectionId: string,
): Promise<{ holders: number } | null> {
  try {
    const user = await getAuthUser()
    if (!user) return null

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return null

    const { count, error } = await adminDb
      .from('user_badges')
      .select('id', { count: 'exact', head: true })
      .eq('badge_id', badgeId)
      .eq('section_id', sectionId)
    if (error) {
      logger.error('getBadgeCascadeCounts: read failed', error, { badgeId, sectionId })
      return null
    }
    return { holders: count ?? 0 }
  } catch (error) {
    logger.error('getBadgeCascadeCounts', error, { badgeId, sectionId })
    return null
  }
}

export async function deleteChallenge(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: deleteError } = await adminDb
      .from('challenges')
      .delete()
      .eq('id', challengeId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteChallenge: Delete failed', deleteError, { challengeId, sectionId })
      return { error: 'Failed to delete challenge' }
    }

    // activity_id is polymorphic (no FK), so skill links don't cascade — clean them up.
    await adminDb
      .from('activity_skills')
      .delete()
      .eq('section_id', sectionId)
      .eq('activity_type', 'challenge')
      .eq('activity_id', challengeId)

    logEvent({
      userId: user.id,
      eventType: 'challenge.deleted',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('deleteChallenge: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Claim Review ────────────────────────────────────────────────

export async function reviewClaim(
  claimId: string,
  sectionId: string,
  input: ReviewClaimInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = reviewClaimSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // Fetch claim to verify it's in this section + get challenge info
    const { data: claim, error: claimError } = await adminDb
      .from('challenge_claims')
      .select('id, user_id, challenge_id, status, challenge:challenges!inner(id, section_id, badge_id, difficulty)')
      .eq('id', claimId)
      .single()

    if (claimError || !claim) return { error: 'Claim not found' }
    if (claim.challenge?.section_id !== sectionId) return { error: 'Claim not in this section' }
    if (claim.status !== 'submitted') return { error: 'Can only review submitted claims' }

    /* Guard the transition in the WHERE (#701). Same read-decide-write shape as
       submitSolution: the `claim.status !== 'submitted'` check above is separated from this
       update by an await, so two parallel approvals both passed it.

       This one is currently HARMLESS, and it's worth writing down why rather than leaving
       it to be rediscovered: the leaderboard is a derived view that sums over the existence
       of approved claims, not a ledger counting approval events, so a double-approval still
       credits exactly once. That is harmless by accident of the read model, not by design —
       the moment anything starts counting approvals it becomes a double-credit bug. Cheaper
       to close now than to find out then. */
    const { data: reviewed, error: updateError } = await adminDb
      .from('challenge_claims')
      .update({
        status: parsed.data.status,
        reviewer_note: parsed.data.reviewer_note || '',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', claimId)
      .eq('status', 'submitted')
      .select('id')
      .maybeSingle()

    if (updateError) {
      logger.error('reviewClaim: Update failed', updateError, { claimId, sectionId })
      return { error: 'Failed to review claim' }
    }
    if (!reviewed) {
      /* Past the ownership and status checks, zero rows means a concurrent review won.
         Reported so the loser doesn't believe their decision was the one recorded. */
      logger.warn('reviewClaim: lost the review race', { claimId, sectionId })
      return { error: 'Someone else already reviewed this claim. Reload to see the decision.' }
    }

    // Fold an approved challenge into the student's skill mastery (Slice A). A
    // challenge is binary, so approval = 100% evidence; grade-hook normalizes the
    // stake (0.5 multiplier, 1 assessed point) so it's a gentle nudge, not an
    // overwrite of exam/quiz history. Best-effort: never blocks the review.
    if (parsed.data.status === 'approved') {
      const difficulty = claim.challenge?.difficulty as ChallengeDifficulty | undefined
      await applyGradeToSkillMastery({
        sectionId,
        studentId: claim.user_id,
        activityType: 'challenge',
        activityId: claim.challenge_id,
        pct: 100,
        points: 1,
        // Harder challenges nudge mastery more (still ≤ a quiz's weight).
        stake: CHALLENGE_DIFFICULTY_STAKE[difficulty ?? 'medium'] ?? CHALLENGE_DIFFICULTY_STAKE.medium,
      })
    }

    // Auto-award badge if approved and challenge has badge_id
    if (parsed.data.status === 'approved' && claim.challenge?.badge_id) {
      await adminDb
        .from('user_badges')
        .upsert({
          section_id: sectionId,
          badge_id: claim.challenge.badge_id,
          user_id: claim.user_id,
          awarded_by: user.id,
          reason: `Completed challenge: ${claim.challenge_id}`,
        }, { onConflict: 'section_id,badge_id,user_id' })

      // Notify the student they earned the badge. Dedup keyed on the badge id, so
      // an already-held badge won't re-notify.
      const { data: badge } = await adminDb
        .from('badges')
        .select('name')
        .eq('id', claim.challenge.badge_id)
        .maybeSingle()
      await emitEvent({
        type: 'badge_earned',
        sectionId,
        actorId: user.id,
        audience: [claim.user_id],
        entity: { type: 'badge', id: claim.challenge.badge_id },
        title: `Badge earned: ${badge?.name ?? 'New badge'} 🏅`,
        linkUrl: `/student/courses/${sectionId}/challenges`,
      })
    }

    // Issue any certificate whose full challenge set the student has now completed
    // (Slice B). The RPC is atomic + race-safe (locks the student's enrollment) and
    // returns only genuinely-new credentials, so we notify exactly once each.
    if (parsed.data.status === 'approved') {
      const { data: issued, error: issueError } = await adminDb.rpc('issue_certificates_for_challenge', {
        p_section_id: sectionId,
        p_student_id: claim.user_id,
        p_challenge_id: claim.challenge_id,
      })
      if (issueError) {
        logger.error('reviewClaim: certificate issuance failed', issueError, { claimId, sectionId })
      } else {
        for (const cert of (issued ?? []) as Array<{ id: string; public_id: string; title: string }>) {
          await emitEvent({
            type: 'certificate_earned',
            sectionId,
            actorId: user.id,
            audience: [claim.user_id],
            entity: { type: 'certificate', id: cert.id },
            title: `Certificate earned: ${cert.title} 🎓`,
            linkUrl: `/student/courses/${sectionId}/challenges`,
          })
        }
      }
    }

    /* Tell the student they were declined, and why (#703 part 5).
       Approval already notified them, via badge_earned and certificate_earned. A REJECTION emitted
       nothing at all, so a student who submitted work and was turned down had no way to learn it
       short of reopening the challenge board and noticing the status had changed.

       The reviewer's note rides along as the body, which is the whole point: "declined" without a
       reason is worse than silence, because there is nothing to act on. The note field already
       existed on the review form; nothing was carrying it to the student.

       Dedup keyed on the CLAIM row, not the challenge, and `refresh` rather than `ignore`, because a
       student can resubmit and be declined again and the second decision must not be swallowed as a
       duplicate of the first. */
    if (parsed.data.status === 'rejected') {
      const note = parsed.data.reviewer_note?.trim()
      await emitEvent({
        type: 'challenge_claim_rejected',
        sectionId,
        actorId: user.id,
        audience: [claim.user_id],
        entity: { type: 'challenge_claim', id: claimId },
        title: 'Challenge submission needs another look',
        body: note
          ? note
          : 'Your professor declined this submission without a note. Reach out to them if you are unsure why.',
        linkUrl: `/student/courses/${sectionId}/challenges`,
        onDuplicate: 'refresh',
      })
    }

    logEvent({
      userId: user.id,
      eventType: `challenge.claim_${parsed.data.status}`,
      eventCategory: 'professor',
      metadata: { claimId, challengeId: claim.challenge_id, studentId: claim.user_id },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('reviewClaim: Unexpected error', error, { claimId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Student Proposals ───────────────────────────────────────────

export async function approveProposal(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: updateError } = await adminDb
      .from('challenges')
      .update({ visibility: 'published', updated_at: new Date().toISOString() })
      .eq('id', challengeId)
      .eq('section_id', sectionId)
      .eq('source', 'student_proposed')
      .eq('visibility', 'draft')

    if (updateError) {
      logger.error('approveProposal: Update failed', updateError, { challengeId, sectionId })
      return { error: 'Failed to approve proposal' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.proposal_approved',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('approveProposal: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function rejectProposal(
  challengeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: updateError } = await adminDb
      .from('challenges')
      .update({ visibility: 'archived', updated_at: new Date().toISOString() })
      .eq('id', challengeId)
      .eq('section_id', sectionId)
      .eq('source', 'student_proposed')

    if (updateError) {
      logger.error('rejectProposal: Update failed', updateError, { challengeId, sectionId })
      return { error: 'Failed to reject proposal' }
    }

    logEvent({
      userId: user.id,
      eventType: 'challenge.proposal_rejected',
      eventCategory: 'professor',
      metadata: { challengeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('rejectProposal: Unexpected error', error, { challengeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Badge Management ────────────────────────────────────────────

export async function createBadge(
  sectionId: string,
  input: CreateBadgeInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createBadgeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'challenges')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('challenges') }

    const { data, error: insertError } = await adminDb
      .from('badges')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        name: parsed.data.name,
        description: parsed.data.description || '',
        icon: parsed.data.icon || '🏆',
      })
      .select('id')
      .single()

    if (insertError) {
      if (insertError.code === '23505') return { error: 'A badge with this name already exists' }
      logger.error('createBadge: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create badge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'badge.created',
      eventCategory: 'professor',
      metadata: { badgeId: data.id, name: parsed.data.name },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true, data: { id: data.id } }
  } catch (error) {
    logger.error('createBadge: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function awardBadge(
  sectionId: string,
  input: AwardBadgeInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = awardBadgeSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: insertError } = await adminDb
      .from('user_badges')
      .insert({
        section_id: sectionId,
        badge_id: parsed.data.badge_id,
        user_id: parsed.data.user_id,
        awarded_by: user.id,
        reason: parsed.data.reason || '',
      })

    if (insertError) {
      if (insertError.code === '23505') return { error: 'Student already has this badge' }
      logger.error('awardBadge: Insert failed', insertError, { sectionId })
      return { error: 'Failed to award badge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'badge.awarded',
      eventCategory: 'professor',
      metadata: { badgeId: parsed.data.badge_id, studentId: parsed.data.user_id },
      sectionId,
    })

    // Notify the student they earned the badge. Dedup keyed on the badge id.
    const { data: badge } = await adminDb
      .from('badges')
      .select('name')
      .eq('id', parsed.data.badge_id)
      .maybeSingle()
    await emitEvent({
      type: 'badge_earned',
      sectionId,
      actorId: user.id,
      audience: [parsed.data.user_id],
      entity: { type: 'badge', id: parsed.data.badge_id },
      title: `Badge earned: ${badge?.name ?? 'New badge'} 🏅`,
      linkUrl: `/student/courses/${sectionId}/challenges`,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('awardBadge: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteBadge(
  badgeId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const { error: deleteError } = await adminDb
      .from('badges')
      .delete()
      .eq('id', badgeId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteBadge: Delete failed', deleteError, { badgeId, sectionId })
      return { error: 'Failed to delete badge' }
    }

    logEvent({
      userId: user.id,
      eventType: 'badge.deleted',
      eventCategory: 'professor',
      metadata: { badgeId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('deleteBadge: Unexpected error', error, { badgeId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Certificate Management (Slice B) ────────────────────────────

/**
 * Replace a certificate's challenge set. Delete-and-reinsert of the join rows;
 * only challenges that belong to this section are linked (client IDs are
 * untrusted). institution_id comes from the verified section context.
 */
async function syncCertificateChallenges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  sectionId: string,
  institutionId: string | null,
  certificateId: string,
  challengeIds: string[],
) {
  // section_id scoping is defense-in-depth: callers already verify the certificate
  // belongs to this section, but never let the delete reach another tenant's rows.
  await adminDb.from('certificate_challenges').delete().eq('certificate_id', certificateId).eq('section_id', sectionId)
  if (!institutionId || challengeIds.length === 0) return

  const { data: valid } = await adminDb
    .from('challenges')
    .select('id')
    .eq('section_id', sectionId)
    .in('id', challengeIds)
  const validIds = ((valid ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (validIds.length === 0) return

  await adminDb.from('certificate_challenges').insert(
    validIds.map((challengeId) => ({
      certificate_id: certificateId,
      challenge_id: challengeId,
      section_id: sectionId,
      institution_id: institutionId,
    })),
  )
}

export async function createCertificate(
  sectionId: string,
  input: CreateCertificateInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createCertificateSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb, institutionId } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'challenges')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('challenges') }
    if (!institutionId) return { error: 'Section is missing an institution' }

    const { data, error: insertError } = await adminDb
      .from('certificates')
      .insert({
        section_id: sectionId,
        institution_id: institutionId,
        created_by: user.id,
        title: parsed.data.title,
        description: parsed.data.description || '',
      })
      .select('id')
      .single()

    if (insertError) {
      logger.error('createCertificate: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create certificate' }
    }

    await syncCertificateChallenges(adminDb, sectionId, institutionId, data.id, parsed.data.challenge_ids)

    logEvent({
      userId: user.id,
      eventType: 'certificate.created',
      eventCategory: 'professor',
      metadata: { certificateId: data.id, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true, data: { id: data.id } }
  } catch (error) {
    logger.error('createCertificate: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateCertificate(
  certificateId: string,
  sectionId: string,
  input: UpdateCertificateInput,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateCertificateSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const { owned, adminDb, institutionId } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.title !== undefined) updateData.title = parsed.data.title
    if (parsed.data.description !== undefined) updateData.description = parsed.data.description
    if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active

    // .select() to confirm the certificate is actually in this section. A 0-row
    // update returns no error; proceeding to sync would let a professor wipe/hijack
    // another section's certificate composition (IDOR / cross-tenant write).
    const { data: updated, error: updateError } = await adminDb
      .from('certificates')
      .update(updateData)
      .eq('id', certificateId)
      .eq('section_id', sectionId)
      .select('id')

    if (updateError) {
      logger.error('updateCertificate: Update failed', updateError, { certificateId, sectionId })
      return { error: 'Failed to update certificate' }
    }
    if (!updated || updated.length === 0) return { error: 'Certificate not found' }

    if (parsed.data.challenge_ids !== undefined) {
      await syncCertificateChallenges(adminDb, sectionId, institutionId, certificateId, parsed.data.challenge_ids)
    }

    logEvent({
      userId: user.id,
      eventType: 'certificate.updated',
      eventCategory: 'professor',
      metadata: { certificateId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    revalidatePath(`/student/courses/${sectionId}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('updateCertificate: Unexpected error', error, { certificateId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function deleteCertificate(
  certificateId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const { owned, adminDb } = await verifyOwnership(sectionId, user.id)
    if (!owned) return { error: 'You do not own this course section' }

    // An earned certificate is an immutable credential (a student may have posted
    // its public link to LinkedIn). Never hard-delete one — deactivate instead.
    const { count } = await adminDb
      .from('student_certificates')
      .select('id', { count: 'exact', head: true })
      .eq('certificate_id', certificateId)
      .eq('section_id', sectionId)
    if (count && count > 0) {
      return { error: 'Students have already earned this certificate. Set it to inactive instead of deleting.' }
    }

    const { error: deleteError } = await adminDb
      .from('certificates')
      .delete()
      .eq('id', certificateId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteCertificate: Delete failed', deleteError, { certificateId, sectionId })
      return { error: 'Failed to delete certificate' }
    }

    logEvent({
      userId: user.id,
      eventType: 'certificate.deleted',
      eventCategory: 'professor',
      metadata: { certificateId },
      sectionId,
    })

    revalidatePath(`${sectionPath(sectionId)}/challenges`)
    return { success: true }
  } catch (error) {
    logger.error('deleteCertificate: Unexpected error', error, { certificateId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
