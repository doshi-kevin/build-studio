'use server'

// Skill Mastery — Slice 1 server actions: AI suggestion + the professor's
// add / rename / remove of the per-section skill hierarchy.
//
// Every mutating action follows the house sequence: authenticate → verify
// section write access → admin DB op (stamping institution_id) → logEvent →
// revalidate. The `skills` table isn't in the generated types until the
// migration is applied, so DB calls go through verifySectionAccess's adminDb
// (already an `any`), keeping the typed paths elsewhere intact.

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { readAllPages } from '@/lib/supabase/paged-read'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { suggestSectionSkillHierarchy, suggestSkillParent } from '@/lib/ai/llm-client'
import { checkAiFeatureBySection } from '@/lib/ai/kill-switch'
import { aiRefusalMessage } from '@/lib/ai/ai-features'
import {
  addSkillSchema,
  renameSkillSchema,
  deleteSkillSchema,
  setSkillExcludedSchema,
  setSkillSuppressedSchema,
  applySkillSuggestionsSchema,
  confirmSkillReviewSchema,
  setSkillPlacementSchema,
  reorderSkillsSchema,
  type SuggestedSkill,
} from '@/lib/validations/skill'
import { z } from 'zod'
import { enqueueMasteryRecompute } from '@/lib/extraction/enqueue'
import { getClassMasteryTrend } from '@/lib/roadmap/engagement'
import { buildSkillIndex, type SkillIndexData, type SkillIndexNode } from '@/lib/skills/index-view'
import { publishSectionSkillsToLibrary } from '@/lib/skills/library'
import type { SkillRow } from '@/lib/validations/skill'

type ActionError = { error: string }

/** Authenticate + confirm the caller may write skills on this section. */
async function requireSectionWriter(sectionId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: 'You must be signed in.' }

  const access = await verifySectionAccess(sectionId, user.id)
  if (!access.ok || !canWriteAsStaff(access.role)) {
    return { ok: false as const, error: 'You do not have access to manage this section.' }
  }
  return { ok: true as const, user, access }
}

/** Resolve the section's institution_id for tenant-stamping new rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInstitutionId(adminDb: any, sectionId: string): Promise<string | null> {
  const { data } = await adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  return data?.institution_id ?? null
}

/** Compact digest of the section's materials (titles + summaries + lecture
 *  skills) to feed the suggester — already-extracted signal, not raw PDFs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gatherSectionDigest(adminDb: any, sectionId: string): Promise<string> {
  const { data: items } = await adminDb
    .from('module_items')
    .select('title, content, modules!inner(section_id)')
    .eq('modules.section_id', sectionId)
    .limit(500)

  if (!items?.length) return ''

  const parts: string[] = []
  for (const item of items) {
    const content = (item.content || {}) as Record<string, unknown>
    const seg: string[] = []
    if (typeof item.title === 'string' && item.title.trim()) seg.push(item.title.trim())
    if (typeof content.summary === 'string' && content.summary.trim()) {
      seg.push(content.summary.trim())
    }
    if (Array.isArray(content.skills) && content.skills.length) {
      seg.push((content.skills as unknown[]).filter((t) => typeof t === 'string').join(', '))
    }
    if (seg.length) parts.push(seg.join(' — '))
  }
  return parts.join('\n\n').slice(0, 100_000)
}

/**
 * Generate (but don't persist) an AI-suggested skill hierarchy from the
 * section's uploaded material. The professor reviews the result and applies
 * the subset they want via applySkillSuggestions.
 */
export async function generateSkillSuggestions(
  sectionId: string,
): Promise<{ skills: SuggestedSkill[] } | ActionError> {
  const guard = await requireSectionWriter(sectionId)
  if (!guard.ok) return { error: guard.error }

  // Institution/platform AI kill switch.
  const aiVerdict = await checkAiFeatureBySection(guard.access.adminDb, sectionId, 'roadmap-skills-ai')
  if (!aiVerdict.allowed) return { error: aiRefusalMessage(aiVerdict.lockedBy) }

  const digest = await gatherSectionDigest(guard.access.adminDb, sectionId)
  if (!digest.trim()) {
    return { error: 'Upload course material first — there’s nothing to suggest skills from yet.' }
  }

  const skills = await suggestSectionSkillHierarchy(digest, { sectionId })
  if (!skills || skills.length === 0) {
    return { error: 'Couldn’t suggest skills from this material. Try again, or add skills manually.' }
  }
  return { skills }
}

/** Insert an accepted set of AI-suggested skills (main skills + subtopics). */
export async function applySkillSuggestions(input: unknown): Promise<{ success: true; added: number } | ActionError> {
  const parsed = applySkillSuggestionsSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid skills.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access

  const institutionId = await getInstitutionId(adminDb, parsed.data.sectionId)
  if (!institutionId) return { error: 'Could not resolve this section.' }

  const { count: existingMains } = await adminDb
    .from('skills')
    .select('id', { count: 'exact', head: true })
    .eq('section_id', parsed.data.sectionId)
    .is('parent_id', null)

  let position = existingMains ?? 0
  let added = 0

  for (const main of parsed.data.skills) {
    const { data: inserted, error } = await adminDb
      .from('skills')
      .insert({
        section_id: parsed.data.sectionId,
        institution_id: institutionId,
        parent_id: null,
        name: main.name,
        info: main.info ?? null,
        source: 'ai',
        position: position++,
      })
      .select('id')
      .single()

    if (error || !inserted) {
      logger.error('applySkillSuggestions: main insert failed', error, {
        sectionId: parsed.data.sectionId,
      })
      continue
    }
    added++

    if (main.subtopics.length) {
      const subRows = main.subtopics.map((s, i) => ({
        section_id: parsed.data.sectionId,
        institution_id: institutionId,
        parent_id: inserted.id,
        name: s.name,
        info: s.info ?? null,
        source: 'ai',
        position: i,
      }))
      const { error: subErr } = await adminDb.from('skills').insert(subRows)
      if (subErr) {
        logger.error('applySkillSuggestions: subtopic insert failed', subErr, {
          sectionId: parsed.data.sectionId,
        })
      } else {
        added += subRows.length
      }
    }
  }

  if (added === 0) return { error: 'Couldn’t save the skills. Please try again.' }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.suggestions_applied',
    eventCategory: 'course',
    sectionId: parsed.data.sectionId,
    metadata: { added },
  })
  revalidatePath(`/professor/courses/${parsed.data.sectionId}/skills`)
  return { success: true, added }
}

/** Suggest which existing main skill a new skill best fits under (AI placement-on-add).
 *  Returns { parentId: null } when it's better as its own main skill. */
export async function suggestSkillPlacement(
  sectionId: string,
  name: string,
): Promise<{ parentId: string | null; parentName: string | null } | ActionError> {
  const guard = await requireSectionWriter(sectionId)
  if (!guard.ok) return { error: guard.error }
  const trimmed = (name || '').trim()
  if (!trimmed) return { parentId: null, parentName: null }

  const { data } = await guard.access.adminDb
    .from('skills')
    .select('id, name, suppressed, excluded')
    .eq('section_id', sectionId)
    .is('parent_id', null)
  /* Only TRACKED mains are candidates (#598). Suppressed = an AI suggestion the professor
     hasn't confirmed; excluded = one they deliberately dropped. Either makes a poor parent,
     and nesting under a suppressed main hides the new skill completely: the List renders
     `initialTree.filter(n => !n.suppressed)`, and the separate "suggested" strip prints only
     the suggestion's own name, never its subtopics. The skill then exists — it shows in the
     Matrix and has a working Concept Detail page — with no route to rename or delete it. */
  const mains = ((data ?? []) as Array<{ id: string; name: string; suppressed: boolean | null; excluded: boolean | null }>)
    .filter((m) => !m.suppressed && !m.excluded)
  if (mains.length === 0) return { parentId: null, parentName: null }

  // Institution/platform AI kill switch — this is an implicit assist, so degrade
  // to "no placement suggestion" (skill lands as a main) instead of erroring.
  const aiVerdict = await checkAiFeatureBySection(guard.access.adminDb, sectionId, 'roadmap-skills-ai')
  if (!aiVerdict.allowed) return { parentId: null, parentName: null }

  const parentName = await suggestSkillParent(
    trimmed,
    mains.map((m) => m.name),
    { sectionId },
  )
  const match = parentName ? mains.find((m) => m.name === parentName) : undefined
  return { parentId: match?.id ?? null, parentName: match?.name ?? null }
}

/** Add a single skill. parentId null/absent => main skill; a uuid => subtopic. */
export async function addSkill(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = addSkillSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid skill.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const { sectionId, name, parentId } = parsed.data

  // A subtopic's parent must be a main skill in this same section (two levels only).
  if (parentId) {
    const { data: parent } = await adminDb
      .from('skills')
      .select('id, parent_id, section_id')
      .eq('id', parentId)
      .maybeSingle()
    if (!parent || parent.section_id !== sectionId || parent.parent_id !== null) {
      return { error: 'That parent skill is no longer valid.' }
    }
  }

  const institutionId = await getInstitutionId(adminDb, sectionId)
  if (!institutionId) return { error: 'Could not resolve this section.' }

  // Load the section's skills once — to place the new one at the end of its level
  // AND to reject a duplicate name. The tag→skill mapping matches by name across
  // the whole section, so an identical name anywhere makes it ambiguous (#330).
  // Names aren't compared with ilike: a name may contain % or _.
  const { data: existing } = await adminDb.from('skills').select('name, parent_id').eq('section_id', sectionId)
  const rows = (existing ?? []) as Array<{ name: string; parent_id: string | null }>
  const norm = (s: string) => s.trim().toLowerCase()
  if (rows.some((t) => norm(t.name) === norm(name))) {
    return { error: `A skill named “${name.trim()}” already exists in this course.` }
  }
  const siblingCount = rows.filter((t) => t.parent_id === (parentId ?? null)).length

  const { error } = await adminDb.from('skills').insert({
    section_id: sectionId,
    institution_id: institutionId,
    parent_id: parentId ?? null,
    name,
    source: 'professor',
    position: siblingCount,
  })
  if (error) {
    logger.error('addSkill: insert failed', error, { sectionId })
    return { error: 'Couldn’t add the skill. Please try again.' }
  }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.created',
    eventCategory: 'course',
    sectionId,
    metadata: { isSubskill: Boolean(parentId) },
  })
  revalidatePath(`/professor/courses/${sectionId}/skills`)
  return { success: true }
}

/** Rename a skill (main or subtopic). */
export async function renameSkill(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = renameSkillSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid name.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { sectionId, skillId, name } = parsed.data
  const { adminDb } = guard.access

  // Reject a rename that collides with another skill's name (case-insensitive),
  // section-wide, for the same tag→skill mapping reason as addSkill (issue #330).
  const { data: others } = await adminDb
    .from('skills')
    .select('name')
    .eq('section_id', sectionId)
    .neq('id', skillId)
  const norm = (s: string) => s.trim().toLowerCase()
  if (((others ?? []) as Array<{ name: string }>).some((t) => norm(t.name) === norm(name))) {
    return { error: `A skill named “${name.trim()}” already exists in this course.` }
  }

  /* count:'exact' so a write that matched NO row is reported as a failure. The section
     filter is what makes a cross-section skillId touch nothing (correct), but without this
     the caller was told the rename succeeded and showed the new name over unchanged data. */
  const { error, count } = await adminDb
    .from('skills')
    .update({ name, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', skillId)
    .eq('section_id', sectionId)
  if (error) {
    logger.error('renameSkill: update failed', error, { skillId })
    return { error: 'Couldn’t rename the skill. Please try again.' }
  }
  if ((count ?? 0) === 0) {
    logger.warn('renameSkill: matched no row', { skillId, sectionId })
    return { error: 'That skill no longer exists in this course.' }
  }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.renamed',
    eventCategory: 'course',
    sectionId: parsed.data.sectionId,
    metadata: { skillId: parsed.data.skillId },
  })
  revalidatePath(`/professor/courses/${parsed.data.sectionId}/skills`)
  return { success: true }
}

/** Delete a skill. Deleting a main skill cascades to its subtopics (FK). */
export async function deleteSkill(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = deleteSkillSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid request.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }

  // Same as renameSkill: a delete that matched nothing must not report success.
  const { error, count } = await guard.access.adminDb
    .from('skills')
    .delete({ count: 'exact' })
    .eq('id', parsed.data.skillId)
    .eq('section_id', parsed.data.sectionId)
  if (error) {
    logger.error('deleteSkill: delete failed', error, { skillId: parsed.data.skillId })
    return { error: 'Couldn’t remove the skill. Please try again.' }
  }
  if ((count ?? 0) === 0) {
    logger.warn('deleteSkill: matched no row', { skillId: parsed.data.skillId, sectionId: parsed.data.sectionId })
    return { error: 'That skill no longer exists in this course.' }
  }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.deleted',
    eventCategory: 'course',
    sectionId: parsed.data.sectionId,
    metadata: { skillId: parsed.data.skillId },
  })
  revalidatePath(`/professor/courses/${parsed.data.sectionId}/skills`)
  return { success: true }
}

/** Soft-exclude / re-include a skill (the modal's include checkbox). Keeps the
 *  row so it isn't re-added by auto-populate; excluded skills drop out of
 *  mastery scoring and the roadmap. Deleting a main cascades in the UI via the
 *  trash action — this only flips the flag. */
export async function setSkillExcluded(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = setSkillExcludedSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid request.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const { sectionId, skillId, excluded } = parsed.data

  // Excluding a main skill excludes its subtopics too; re-including restores them.
  const { error } = await adminDb
    .from('skills')
    .update({ excluded, updated_at: new Date().toISOString() })
    .eq('section_id', sectionId)
    .or(`id.eq.${skillId},parent_id.eq.${skillId}`)
  if (error) {
    logger.error('setSkillExcluded: update failed', error, { skillId })
    return { error: 'Couldn’t update the skill. Please try again.' }
  }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.excluded_set',
    eventCategory: 'course',
    sectionId,
    metadata: { skillId, excluded },
  })
  // Inclusion changed → reconcile mastery in the background (post-response).
  after(() => enqueueMasteryRecompute(sectionId))
  revalidatePath(`/professor/courses/${sectionId}/roadmap`)
  return { success: true }
}

/**
 * Promote a suggested (suppressed) skill to tracked, or push a tracked one back
 * to suggested. The Curate "Suggested" group's Track button calls this with
 * suppressed=false. Promoting a main also promotes its subtopics.
 */
export async function setSkillSuppressed(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = setSkillSuppressedSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid request.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const { sectionId, skillId, suppressed } = parsed.data

  const { error } = await adminDb
    .from('skills')
    .update({ suppressed, updated_at: new Date().toISOString() })
    .eq('section_id', sectionId)
    .or(`id.eq.${skillId},parent_id.eq.${skillId}`)
  if (error) {
    logger.error('setSkillSuppressed: update failed', error, { skillId })
    return { error: 'Couldn’t update the skill. Please try again.' }
  }

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.suppressed_set',
    eventCategory: 'course',
    sectionId,
    metadata: { skillId, suppressed },
  })
  after(() => enqueueMasteryRecompute(sectionId))
  revalidatePath(`/professor/courses/${sectionId}/roadmap`)
  return { success: true }
}

/**
 * Confirm the reviewed skill tree (the modal's "Confirm skill list"). The modal
 * is the canonical list editor — this reconciles the section's skills to exactly
 * the provided tree: update existing (by id), insert new, drop omitted.
 */
export async function confirmSkillReview(
  input: unknown,
): Promise<{ success: true; tracked: number } | ActionError> {
  const parsed = confirmSkillReviewSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid skills.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const sectionId = parsed.data.sectionId

  const institutionId = await getInstitutionId(adminDb, sectionId)
  if (!institutionId) return { error: 'Could not resolve this section.' }

  // Rebuild the reviewed tree atomically: every main + subtopic is upserted and
  // omitted skills are dropped in one transaction (see confirm_skill_review),
  // so a mid-rebuild failure can't leave a half-written tree. Returns the
  // tracked-node count.
  const { data: tracked, error } = await adminDb.rpc('confirm_skill_review', {
    p_section_id: sectionId,
    p_institution_id: institutionId,
    p_skills: parsed.data.skills,
  })
  if (error) {
    logger.error('confirmSkillReview: rpc failed', error, { sectionId })
    return { error: 'Couldn’t save your skills. Please try again.' }
  }

  // Stamp the review time → clears the "skills to confirm" badge (unconfirmed =
  // AI skills created after this). Deep-merged so other config keys are kept.
  await adminDb.rpc('merge_section_skill_mastery_config', {
    p_section_id: sectionId,
    p_config: { skillsReviewedAt: new Date().toISOString() },
  })

  // Curation just became authoritative → mirror the tracked list into the
  // course library so the next offering of this course starts from it (issue
  // #173). After the response: the professor is waiting on their own list, not
  // on next semester's convenience. Additive — see lib/skills/library.ts.
  after(async () => {
    await publishSectionSkillsToLibrary(adminDb, sectionId)
  })

  await logEvent({
    userId: guard.user.id,
    eventType: 'skill.review_confirmed',
    eventCategory: 'course',
    sectionId,
    metadata: { tracked },
  })
  revalidatePath(`/professor/courses/${sectionId}/skills`)
  revalidatePath(`/professor/courses/${sectionId}/roadmap`)
  return { success: true, tracked: (tracked as number) ?? 0 }
}

/**
 * Count of skills still awaiting the professor's confirmation: AI-extracted
 * skills created after the last review (settings.topicMastery.skillsReviewedAt).
 * Professor-added skills don't count — they were added deliberately. Drives the
 * "Tracked skills" badge + the extraction-complete nudge. Read-only.
 */
export async function getUnconfirmedSkillCount(
  sectionId: string,
): Promise<{ count: number }> {
  try {
    const guard = await requireSectionWriter(sectionId)
    if (!guard.ok) return { count: 0 }
    const { adminDb } = guard.access

    const { data: sec } = await adminDb
      .from('course_sections')
      .select('settings')
      .eq('id', sectionId)
      .maybeSingle()
    const reviewedAt = (sec?.settings as { topicMastery?: { skillsReviewedAt?: string } } | null)
      ?.topicMastery?.skillsReviewedAt

    let query = adminDb
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId)
      .eq('source', 'ai')
    if (reviewedAt) query = query.gt('created_at', reviewedAt)

    const { count } = await query
    return { count: count ?? 0 }
  } catch (error) {
    logger.error('getUnconfirmedSkillCount', error)
    return { count: 0 }
  }
}

/**
 * Mark the section's tracked skills as reviewed (stamps skillsReviewedAt = now).
 * This is the explicit "I've looked at these" action behind the Confirm button;
 * it clears the pending-review blinker. Skills added later (created after now)
 * make it reappear. Lighter than confirmSkillReview — it touches only settings,
 * not the skill tree.
 */
export async function markSkillsReviewed(
  sectionId: string,
): Promise<{ success: true } | ActionError> {
  try {
    const guard = await requireSectionWriter(sectionId)
    if (!guard.ok) return { error: guard.error }
    const { adminDb } = guard.access

    const { error } = await adminDb.rpc('merge_section_skill_mastery_config', {
      p_section_id: sectionId,
      p_config: { skillsReviewedAt: new Date().toISOString() },
    })
    if (error) {
      logger.error('markSkillsReviewed: rpc failed', error, { sectionId })
      return { error: 'Couldn’t save. Please try again.' }
    }

    await logEvent({
      userId: guard.user.id,
      eventType: 'skill.reviewed',
      eventCategory: 'course',
      sectionId,
    })
    revalidatePath(`/professor/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('markSkillsReviewed', error)
    return { error: 'Unexpected error' }
  }
}

/** Move a skill (drag re-parent / "Move"), pinning the placement so AI won't move it. */
export async function setSkillPlacement(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = setSkillPlacementSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid move.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const { sectionId, skillId, parentId, pinned } = parsed.data

  if (parentId) {
    if (parentId === skillId) return { error: 'A skill can’t be its own parent.' }
    const { data: parent } = await adminDb
      .from('skills')
      .select('id, parent_id, section_id')
      .eq('id', parentId)
      .maybeSingle()
    if (!parent || parent.section_id !== sectionId || parent.parent_id !== null) {
      return { error: 'That parent skill is no longer valid.' }
    }
    // Two levels only: a skill with its own subtopics can't become a subtopic.
    const { count } = await adminDb
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .eq('parent_id', skillId)
    if ((count ?? 0) > 0) {
      return { error: 'Move its subtopics out first — skills are only two levels deep.' }
    }
  }

  const { error } = await adminDb
    .from('skills')
    .update({ parent_id: parentId, placement_pinned: pinned, updated_at: new Date().toISOString() })
    .eq('id', skillId)
    .eq('section_id', sectionId)
  if (error) {
    logger.error('setSkillPlacement: update failed', error, { skillId })
    return { error: 'Couldn’t move the skill. Please try again.' }
  }

  revalidatePath(`/professor/courses/${sectionId}/skills`)
  return { success: true }
}

/** Persist a drag-reorder of siblings under one parent (or the main-skill level). */
export async function reorderSkills(input: unknown): Promise<{ success: true } | ActionError> {
  const parsed = reorderSkillsSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid order.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  const { adminDb } = guard.access
  const { sectionId, orderedIds } = parsed.data

  const { error } = await adminDb.rpc('reorder_skills', {
    p_section_id: sectionId,
    p_ordered_ids: orderedIds,
  })
  if (error) {
    logger.error('reorderSkills: rpc failed', error, { sectionId })
    return { error: 'Couldn’t save the new order. Please try again.' }
  }

  revalidatePath(`/professor/courses/${sectionId}/skills`)
  return { success: true }
}

const configInputSchema = z.object({
  sectionId: z.string().uuid(),
  config: z.object({
    baseAlpha: z.number().min(0.05).max(0.95).optional(),
    classMetric: z.enum(['median', 'mean', 'percent_proficient']).optional(),
    proficientThreshold: z.number().min(0).max(100).optional(),
    atRiskThreshold: z.number().min(0).max(100).optional(),
    stakeMultipliers: z
      .object({
        exam: z.number().min(0.1).max(10),
        assignment: z.number().min(0.1).max(10),
        quiz: z.number().min(0.1).max(10),
      })
      .partial()
      .optional(),
    // Must be listed or Zod strips it, silently dropping the toggle on save.
    includeLiveQuiz: z.boolean().optional(),
  }),
})

/** Update the section's Skill Mastery knobs (professor only). */
export async function updateSkillMasteryConfig(
  input: unknown,
): Promise<{ success: true } | ActionError> {
  const parsed = configInputSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid settings.' }

  const guard = await requireSectionWriter(parsed.data.sectionId)
  if (!guard.ok) return { error: guard.error }
  if (guard.access.role !== 'professor') {
    return { error: 'Only the professor can change these settings.' }
  }
  const { adminDb } = guard.access
  const { sectionId, config } = parsed.data

  // Deep-merge the patch into settings.topicMastery in one statement (see
  // merge_section_skill_mastery_config) so a concurrent settings write — e.g. a
  // Manage-Features toggle — can't clobber the blob via read-merge-write.
  const { error } = await adminDb.rpc('merge_section_skill_mastery_config', {
    p_section_id: sectionId,
    p_config: config,
  })
  if (error) {
    logger.error('updateSkillMasteryConfig: update failed', error, { sectionId })
    return { error: 'Couldn’t save settings. Please try again.' }
  }

  // Scoring knobs changed → recompute the whole section's mastery in the background.
  after(() => enqueueMasteryRecompute(sectionId))
  revalidatePath(`/professor/courses/${sectionId}/skills`)
  return { success: true }
}


/**
 * Read-only skill-index model for the two-pane /skills view: the section's skill
 * tree with per-skill coverage (quizzes via activity_skills, lectures via
 * content.topics name-match) and class mastery. Section-write access required.
 */
export async function getSkillIndex(
  sectionId: string,
): Promise<{ data?: SkillIndexData; error?: string }> {
  const guard = await requireSectionWriter(sectionId)
  if (!guard.ok) return { error: guard.error }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = guard.access.adminDb as any
  try {
    const [skillsRes, actRes, quizzesRes, assignmentsRes, liveRes, lecturesRes, masteryRes, sectionRes] = await Promise.all([
      adminDb.from('skills').select('*').eq('section_id', sectionId).order('position', { ascending: true }),
      // All canonical activity→skill mappings (quiz / exam / assignment / live_quiz).
      adminDb.from('activity_skills').select('activity_id, skill_id, activity_type').eq('section_id', sectionId),
      adminDb.from('quizzes').select('id, title').eq('section_id', sectionId),
      adminDb.from('assignments').select('id, title').eq('section_id', sectionId),
      // Live-classroom quizzes for this section (lc_interactions joined via room).
      adminDb.from('lc_interactions').select('id, payload, lc_rooms!inner(section_id)').eq('kind', 'quiz').eq('lc_rooms.section_id', sectionId),
      adminDb.from('module_items').select('id, title, content, modules!inner(section_id)').eq('modules.section_id', sectionId).eq('is_visible', true),
      // Paged: these rows drive the per-skill class mastery shown in the index, so
      // PostgREST's silent 1000-row cap would not blank a number here — it would
      // show a wrong one. A ~90-student section already crosses it. `id` is
      // selected as well as ordered on because paging needs a unique sort key.
      /* student_id and state are required, not incidental: without them the index
         cannot roll subtopics up to their parent, and `state.w` is what makes one
         exam outrank eight node checks in that roll-up. */
      readAllPages<{ student_id: string; skill_id: string; score: number | null; state: { n?: number; w?: number } | null }>(
        () => adminDb.from('skill_mastery').select('id, student_id, skill_id, score, state').eq('section_id', sectionId),
        'id',
        'getSkillIndex.mastery',
      ),
      // The section's own class metric. Ignoring it is what made the list and the
      // concept panel disagree on the same skill.
      adminDb.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
    ])

    // Suppressed skills are AI suggestions not yet promoted — keep them out of the
    // coverage lens (they live in the Curate "Suggested" group until opted in).
    const skills = ((skillsRes.data || []) as SkillRow[]).filter((s) => !s.suppressed)
    const activitySkills = (actRes.data || []) as { activity_id: string; skill_id: string; activity_type: string }[]
    const quizzes = ((quizzesRes.data || []) as { id: string; title: string | null }[]).map((q) => ({ id: q.id, title: q.title || 'Untitled quiz' }))
    const assignments = ((assignmentsRes.data || []) as { id: string; title: string | null }[]).map((a) => ({ id: a.id, title: a.title || 'Untitled assignment' }))
    const liveQuizzes = ((liveRes.data || []) as { id: string; payload: { title?: string } | null }[]).map((l) => ({ id: l.id, title: l.payload?.title || 'Live quiz' }))
    const lectures = ((lecturesRes.data || []) as { id: string; title: string | null; content: { topics?: unknown } | null }[]).map((it) => ({
      id: it.id,
      title: it.title || 'Untitled',
      topics: Array.isArray(it.content?.topics) ? (it.content!.topics as unknown[]).filter((t): t is string => typeof t === 'string' && !!t.trim()) : [],
    }))
    // readAllPages returns the rows directly, not a { data } envelope.
    const mastery = masteryRes

    /* Direction, not just level. A professor reading "70%" cannot tell whether
       the class is climbing or sliding, which is usually the thing they'd act on.
       Best-effort: a section with under two days of snapshots simply has no
       trend yet, and the list renders exactly as before. */
    let trendBySkillId: Record<string, number> | undefined
    try {
      const trend = await getClassMasteryTrend(adminDb, sectionId)
      if (trend.length) {
        trendBySkillId = {}
        for (const t of trend) trendBySkillId[t.skillId] = Math.round(t.to - t.from)
      }
    } catch (error) {
      logger.warn('getSkillIndex: mastery trend unavailable', { sectionId, error: String(error) })
    }

    /* Say so when AI is off. Mastery keeps scoring from hand tags and hand-made
       skills, but concept extraction and AI placement are off — without a note the
       professor just sees fewer skills appearing and no reason for it. Reuses the
       shared refusal copy so an infra error never impersonates policy. */
    let aiNotice: string | undefined
    let aiNoticeIsPolicy: boolean | undefined
    const aiVerdict = await checkAiFeatureBySection(adminDb, sectionId, 'roadmap-skills-ai')
    if (!aiVerdict.allowed) {
      aiNotice = aiRefusalMessage(aiVerdict.lockedBy)
      aiNoticeIsPolicy = aiVerdict.lockedBy !== 'error'
    }

    const config = resolveSkillMasteryConfig((sectionRes as { data?: { settings?: unknown } } | null)?.data?.settings)
    const index = buildSkillIndex({ skills, activitySkills, quizzes, assignments, liveQuizzes, lectures, mastery, config })

    // A category is never itself assessed, so it never has skill_mastery_snapshots
    // rows of its own — trendBySkillId above only ever has entries for leaf
    // skills. Roll a category's trend up from its children the same way its
    // coverage is already rolled up in buildSkillIndex, post-order so a
    // grandparent picks up an already-rolled child too.
    if (trendBySkillId) {
      const rollUpTrend = (node: SkillIndexNode): void => {
        for (const child of node.children) rollUpTrend(child)
        if (node.children.length === 0 || trendBySkillId![node.id] != null) return
        const deltas = node.children.map((c) => trendBySkillId![c.id]).filter((d): d is number => d != null)
        if (deltas.length) trendBySkillId![node.id] = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
      }
      for (const root of index.tree) rollUpTrend(root)
    }

    return { data: { ...index, trendBySkillId, aiNotice, aiNoticeIsPolicy } }
  } catch (error) {
    logger.error('getSkillIndex', error, { sectionId })
    return { error: 'Could not load skills.' }
  }
}
