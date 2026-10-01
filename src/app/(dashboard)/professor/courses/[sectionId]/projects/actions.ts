/**
 * Project Workspace Server Actions — Professor/TA manage project assignments
 * and grade teams.
 *
 * Professors and active TAs can create/update project assignments and grade
 * teams. deleteProject is professor-only (nuclear — destroys teams, grades,
 * phases, videos). Graders are read-only for v1 per the TA access scope.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { checkEntitlementBySection } from '@/lib/entitlements/check'
import { entitlementRefusalMessage } from '@/lib/entitlements/entitled-features'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  createProjectSchema,
  updateProjectSchema,
  masterPhaseSchema,
  updateMasterPhaseSchema,
  placePhaseItemSchema,
  reorderIdsSchema,
  phaseItemGradingSchema,
  addManualItemSchema,
  gradeItemScoreSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  type PhaseItemGradingInput,
  type AddManualItemInput,
  type GradeItemScoreInput,
  type MasterPhaseInput,
  type UpdateMasterPhaseInput,
  type PlacePhaseItemInput,
} from '@/lib/validations/project'
import {
  verifySectionAccess,
  canWriteAsProfessor,
  canWriteAsStaff,
} from '@/lib/auth/section-access'
import { removeItemFromScheme } from '@/lib/grades/fetch'
import { projectQueries } from '@/lib/supabase/queries'

// ── Helpers ──────────────────────────────────────────────────────

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

function sectionPath(sectionId: string) {
  return `/professor/courses/${sectionId}`
}

// ── Project Assignment Actions ──────────────────────────────────

export async function createProject(
  sectionId: string,
  input: CreateProjectInput,
): Promise<{ success?: boolean; error?: string; data?: { id: string } }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createProjectSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    const entitlement = await checkEntitlementBySection(adminDb, sectionId, 'projects')
    if (!entitlement.allowed) return { error: entitlementRefusalMessage('projects') }

    const { data: project, error: insertError } = await adminDb
      .from('projects')
      .insert({
        section_id: sectionId,
        created_by: user.id,
        title: parsed.data.title,
        description: parsed.data.description || '',
        guidelines: parsed.data.guidelines || '',
        status: 'active',
        visibility: 'course',
        max_team_size: parsed.data.max_team_size ?? 5,
        due_date: parsed.data.due_date || null,
        allow_team_workspace: parsed.data.allow_team_workspace ?? true,
      })
      .select('id')
      .single()

    if (insertError || !project) {
      logger.error('createProject: Insert failed', insertError, { sectionId })
      return { error: 'Failed to create project' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.created',
      eventCategory: 'professor',
      metadata: { sectionId, projectId: project.id, title: parsed.data.title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { id: project.id } }
  } catch (error) {
    logger.error('createProject: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateProject(
  projectId: string,
  sectionId: string,
  input: UpdateProjectInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateProjectSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {
      ...parsed.data,
      updated_at: new Date().toISOString(),
    }


    const { error: updateError } = await adminDb
      .from('projects')
      .update(updateData)
      .eq('id', projectId)
      .eq('section_id', sectionId)

    if (updateError) {
      logger.error('updateProject: Update failed', updateError, { projectId, sectionId })
      return { error: 'Failed to update project' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.updated',
      eventCategory: 'professor',
      metadata: { sectionId, projectId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateProject: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Delete a project assignment. Professor-only — this cascades to teams,
 * phases, videos, grades, and showcases.
 */
export async function deleteProject(
  projectId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsProfessor(access.role)) {
      return { error: 'Only the professor can delete a project' }
    }
    const { adminDb } = access

    const { error: deleteError } = await adminDb
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('section_id', sectionId)

    if (deleteError) {
      logger.error('deleteProject: Delete failed', deleteError, { projectId, sectionId })
      return { error: 'Failed to delete project' }
    }

    // Clear grading-scheme membership/excuses for this now-deleted item (polymorphic, no FK cascade).
    await removeItemFromScheme(adminDb, sectionId, 'project', projectId)

    logEvent({
      userId: user.id,
      eventType: 'project.deleted',
      eventCategory: 'professor',
      metadata: { sectionId, projectId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteProject: Unexpected error', error, { sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Grading-engine actions (weighted phase items → computed grade) ──
//
// Writes are admin-client only (SELECT-only RLS). Each action re-binds the item
// (and, for a student score, the student) to this section before touching a row.

/** Bind a phase item -> project -> section before any grading write. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyPhaseItemInProject(adminDb: any, itemId: string, projectId: string, sectionId: string) {
  const { data } = await adminDb
    .from('project_phase_items')
    .select('id, projects!inner(section_id)')
    .eq('id', itemId)
    .eq('project_id', projectId)
    .eq('projects.section_id', sectionId)
    .maybeSingle()
  return !!data
}

export async function updatePhaseItemGrading(
  itemId: string,
  projectId: string,
  sectionId: string,
  input: PhaseItemGradingInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = phaseItemGradingSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: 'You do not have permission to perform this action' }
    const { adminDb } = access

    if (!(await verifyPhaseItemInProject(adminDb, itemId, projectId, sectionId))) {
      return { error: 'Item not found' }
    }

    const { error: updateError } = await adminDb
      .from('project_phase_items')
      .update({
        weight: parsed.data.weight,
        grain: parsed.data.grain,
        scoring_mode: parsed.data.scoring_mode,
        levels: parsed.data.levels,
        ...(parsed.data.manual_title !== undefined ? { manual_title: parsed.data.manual_title || null } : {}),
        ...(parsed.data.manual_max !== undefined ? { manual_max: parsed.data.manual_max } : {}),
      })
      .eq('id', itemId)

    if (updateError) {
      logger.error('updatePhaseItemGrading: Update failed', updateError, { itemId, projectId })
      return { error: 'Failed to save item settings' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_grading_updated',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, itemId, weight: parsed.data.weight, grain: parsed.data.grain },
      sectionId,
    })
    revalidatePath(`${sectionPath(sectionId)}/projects/${projectId}`)
    return { success: true }
  } catch (error) {
    logger.error('updatePhaseItemGrading: Unexpected error', error, { itemId, projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function addManualPhaseItem(
  phaseId: string,
  projectId: string,
  sectionId: string,
  input: AddManualItemInput,
): Promise<{ success?: boolean; error?: string; data?: { id: string } }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = addManualItemSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: 'You do not have permission to perform this action' }
    const { adminDb } = access

    if (!(await verifyMasterPhase(adminDb, phaseId, projectId, sectionId))) {
      return { error: 'Phase not found' }
    }
    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    const { count } = await adminDb
      .from('project_phase_items')
      .select('id', { count: 'exact', head: true })
      .eq('phase_id', phaseId)

    const { data: row, error: insertError } = await adminDb
      .from('project_phase_items')
      .insert({
        phase_id: phaseId,
        project_id: projectId,
        institution_id: institutionId,
        item_type: parsed.data.item_type,
        manual_title: parsed.data.manual_title,
        manual_max: parsed.data.item_type === 'manual' ? (parsed.data.manual_max ?? 100) : null,
        weight: parsed.data.weight,
        // Attendance always computes per student, so team grain is a dead path — coerce it.
        grain: parsed.data.item_type === 'attendance' ? 'individual' : parsed.data.grain,
        position: count ?? 0,
      })
      .select('id')
      .single()

    if (insertError || !row) {
      logger.error('addManualPhaseItem: Insert failed', insertError, { phaseId, projectId })
      return { error: 'Failed to add item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.manual_item_added',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, phaseId, itemType: parsed.data.item_type },
      sectionId,
    })
    revalidatePath(`${sectionPath(sectionId)}/projects/${projectId}`)
    return { success: true, data: { id: row.id } }
  } catch (error) {
    logger.error('addManualPhaseItem: Unexpected error', error, { phaseId, projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function gradeItemScore(
  itemId: string,
  projectId: string,
  sectionId: string,
  input: GradeItemScoreInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = gradeItemScoreSchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: 'You do not have permission to perform this action' }
    const { adminDb } = access

    if (!(await verifyPhaseItemInProject(adminDb, itemId, projectId, sectionId))) {
      return { error: 'Item not found' }
    }
    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    // Bind the target to this project (a team in it, or a student on one of its teams).
    let teamId: string | null = null
    if (parsed.data.student_id) {
      // limit(1), not maybeSingle(): a student on two teams in the project would
      // make maybeSingle() error and block a legitimate grade save.
      const { data: membership } = await adminDb
        .from('project_members')
        .select('team_id')
        .eq('project_id', projectId)
        .eq('user_id', parsed.data.student_id)
        .limit(1)
      if (!membership || membership.length === 0) {
        return { error: 'That student is not on a team in this project' }
      }
    } else if (parsed.data.team_id) {
      const { data: team } = await adminDb
        .from('project_teams')
        .select('id')
        .eq('id', parsed.data.team_id)
        .eq('project_id', projectId)
        .maybeSingle()
      if (!team) return { error: 'Team not found' }
      teamId = parsed.data.team_id
    }

    const { error: upsertError } = await adminDb
      .from('project_item_scores')
      .upsert(
        {
          phase_item_id: itemId,
          project_id: projectId,
          institution_id: institutionId,
          team_id: teamId,
          student_id: parsed.data.student_id ?? null,
          earned: parsed.data.earned ?? null,
          level_id: parsed.data.level_id ?? null,
          graded_by: user.id,
          graded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'phase_item_id,team_id,student_id' },
      )

    if (upsertError) {
      logger.error('gradeItemScore: Upsert failed', upsertError, { itemId, projectId })
      return { error: 'Failed to save score' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.item_score_saved',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, itemId, target: parsed.data.student_id ? 'student' : 'team' },
      sectionId,
    })
    revalidatePath(`${sectionPath(sectionId)}/projects/${projectId}`)
    return { success: true }
  } catch (error) {
    logger.error('gradeItemScore: Unexpected error', error, { itemId, projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function setProjectGradesReleased(
  projectId: string,
  sectionId: string,
  released: boolean,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: 'You do not have permission to perform this action' }
    const { adminDb } = access

    if (!(await verifyProjectInSection(adminDb, projectId, sectionId))) {
      return { error: 'Project not found' }
    }
    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    if (released) {
      const { error } = await adminDb
        .from('project_grade_releases')
        .upsert(
          { project_id: projectId, institution_id: institutionId, released_at: new Date().toISOString(), released_by: user.id },
          { onConflict: 'project_id' },
        )
      if (error) {
        logger.error('setProjectGradesReleased: Release failed', error, { projectId })
        return { error: 'Failed to release grades' }
      }
    } else {
      const { error } = await adminDb.from('project_grade_releases').delete().eq('project_id', projectId)
      if (error) {
        logger.error('setProjectGradesReleased: Unrelease failed', error, { projectId })
        return { error: 'Failed to hide grades' }
      }
    }

    logEvent({
      userId: user.id,
      eventType: released ? 'project.grades_released' : 'project.grades_unreleased',
      eventCategory: 'professor',
      metadata: { sectionId, projectId },
      sectionId,
    })
    revalidatePath(`${sectionPath(sectionId)}/projects/${projectId}`)
    return { success: true }
  } catch (error) {
    logger.error('setProjectGradesReleased: Unexpected error', error, { projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Phase Comment Actions ──────────────────────────────────────

export interface PhaseComment {
  id: string
  phase_id: string
  author_id: string
  content: string
  created_at: string
  author?: { name: string | null; avatar_url: string | null }
}

/**
 * Fetch all comments for a specific project phase.
 */
export async function getPhaseComments(
  phaseId: string,
  sectionId: string,
): Promise<{ error?: string; data?: PhaseComment[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const { adminDb } = access

    // Bind the phase to this section (phase -> project -> section) before
    // reading its comment thread, so a member of one section can't read
    // another section's phase comments (content + author name/avatar).
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id, projects!inner(section_id)')
      .eq('id', phaseId)
      .eq('projects.section_id', sectionId)
      .single()
    if (!phase) return { error: 'Phase not found' }

    const { data: comments, error } = await adminDb
      .from('phase_comments')
      .select(`
        id, phase_id, author_id, content, created_at,
        author:profiles!phase_comments_author_id_fkey(name, avatar_url)
      `)
      .eq('phase_id', phaseId)
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('getPhaseComments: Fetch failed', error, { phaseId })
      return { error: 'Failed to fetch comments' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PhaseComment[] = (comments || []).map((c: any) => ({
      id: c.id,
      phase_id: c.phase_id,
      author_id: c.author_id,
      content: c.content,
      created_at: c.created_at,
      author: Array.isArray(c.author) ? c.author[0] : c.author,
    }))

    return { data: mapped }
  } catch (error) {
    logger.error('getPhaseComments: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Add a comment to a project phase. Professors and active TAs can comment.
 */
export async function addPhaseComment(
  phaseId: string,
  sectionId: string,
  content: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    if (!content.trim() || content.length > 5000) {
      return { error: 'Comment must be between 1 and 5000 characters' }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    // Verify the phase belongs to a project in this section (phase -> project
    // -> section), so a member of one section can't inject comments into
    // another section's phase.
    const { data: phase } = await adminDb
      .from('project_phases')
      .select('id, projects!inner(section_id)')
      .eq('id', phaseId)
      .eq('projects.section_id', sectionId)
      .single()

    if (!phase) return { error: 'Phase not found' }

    const { error: insertError } = await adminDb
      .from('phase_comments')
      .insert({
        phase_id: phaseId,
        author_id: user.id,
        content: content.trim(),
      })

    if (insertError) {
      logger.error('addPhaseComment: Insert failed', insertError, { phaseId })
      return { error: 'Failed to add comment' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_commented',
      eventCategory: 'professor',
      metadata: { sectionId, phaseId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('addPhaseComment: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Delete a phase comment. Only the author can delete their own comment.
 */
export async function deletePhaseComment(
  commentId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const { adminDb } = access

    // Bind the comment to this section (comment -> phase -> project -> section)
    // before deleting, so a staff user of one section can't delete another
    // section's comment by guessing its id.
    const { data: comment } = await adminDb
      .from('phase_comments')
      .select('id, project_phases!inner(projects!inner(section_id))')
      .eq('id', commentId)
      .eq('project_phases.projects.section_id', sectionId)
      .maybeSingle()
    if (!comment) return { error: 'Comment not found' }

    const { error: deleteError } = await adminDb
      .from('phase_comments')
      .delete()
      .eq('id', commentId)
      .eq('author_id', user.id)

    if (deleteError) {
      logger.error('deletePhaseComment: Delete failed', deleteError, { commentId })
      return { error: 'Failed to delete comment' }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deletePhaseComment: Unexpected error', error, { commentId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Master Phase Actions (professor's official project structure) ──
//
// Writes are admin-client only (tables have SELECT-only RLS). Every action
// re-binds the target rows to this section before touching them, so a staff
// user of one section can't reach another section's board by guessing ids.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSectionInstitutionId(adminDb: any, sectionId: string): Promise<string | null> {
  const { data } = await adminDb
    .from('course_sections')
    .select('institution_id')
    .eq('id', sectionId)
    .single()
  return data?.institution_id ?? null
}

/** Bind project -> section before any board write. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyProjectInSection(adminDb: any, projectId: string, sectionId: string) {
  const { data } = await adminDb
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('section_id', sectionId)
    .maybeSingle()
  return !!data
}

/** Bind phase -> project -> section before any phase write. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyMasterPhase(adminDb: any, phaseId: string, projectId: string, sectionId: string) {
  const { data } = await adminDb
    .from('project_master_phases')
    .select('id, projects!inner(section_id)')
    .eq('id', phaseId)
    .eq('project_id', projectId)
    .eq('projects.section_id', sectionId)
    .maybeSingle()
  return !!data
}

export async function createMasterPhase(
  projectId: string,
  sectionId: string,
  input: MasterPhaseInput,
): Promise<{ success?: boolean; error?: string; data?: { id: string } }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = masterPhaseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyProjectInSection(adminDb, projectId, sectionId))) {
      return { error: 'Project not found' }
    }
    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    // Append at the end of the board.
    const { count } = await adminDb
      .from('project_master_phases')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)

    const { data: phase, error: insertError } = await adminDb
      .from('project_master_phases')
      .insert({
        project_id: projectId,
        institution_id: institutionId,
        name: parsed.data.name,
        start_date: parsed.data.start_date ?? null,
        end_date: parsed.data.end_date ?? null,
        position: count ?? 0,
      })
      .select('id')
      .single()

    if (insertError || !phase) {
      logger.error('createMasterPhase: Insert failed', insertError, { projectId })
      return { error: 'Failed to create phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.master_phase_created',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, phaseId: phase.id, name: parsed.data.name },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { id: phase.id } }
  } catch (error) {
    logger.error('createMasterPhase: Unexpected error', error, { projectId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function updateMasterPhase(
  phaseId: string,
  projectId: string,
  sectionId: string,
  input: UpdateMasterPhaseInput,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateMasterPhaseSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyMasterPhase(adminDb, phaseId, projectId, sectionId))) {
      return { error: 'Phase not found' }
    }

    const { error: updateError } = await adminDb
      .from('project_master_phases')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', phaseId)

    if (updateError) {
      logger.error('updateMasterPhase: Update failed', updateError, { phaseId })
      return { error: 'Failed to update phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.master_phase_updated',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, phaseId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateMasterPhase: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Delete a master phase. Its placement rows cascade-delete, which returns the
 * placed assignments/quizzes to the library — the items themselves are untouched.
 */
/**
 * Refuse a structural delete that would destroy saved student grades.
 *
 * `project_master_phases → project_phase_items → project_item_scores` is a cascade
 * chain, so deleting one phase takes every rubric row under it AND every score
 * already saved against those rows. Nothing warned, nothing was recoverable, and
 * because `project_grade_releases` is keyed on the PROJECT it survived the delete —
 * so students kept seeing a grade, silently recomputed over whatever rows were left.
 * See issue #814.
 *
 * Scoped deliberately: this asks whether the rows BEING DELETED carry scores, not
 * whether the project has any score anywhere, so a professor can still tidy an empty
 * phase mid-semester. Release is the one project-wide bar, because any structural
 * change moves a grade students have already seen.
 *
 * The equivalent guard on the Athena path lives inside apply_project_proposal, which
 * re-reads it in the transaction; this is the hand-click path saying the same thing.
 */
export async function assertDeletableStructure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  projectId: string,
  target: { phaseId: string } | { itemRowId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: released, error: releaseError } = await adminDb
    .from('project_grade_releases')
    .select('project_id')
    .eq('project_id', projectId)
    .maybeSingle()

  // Fail closed: a delete this destructive must not proceed on a failed read.
  if (releaseError) {
    logger.error('assertDeletableStructure: release lookup failed', releaseError, { projectId })
    return { ok: false, error: 'Could not verify this project’s grade status. Nothing was removed.' }
  }
  if (released) {
    return {
      ok: false,
      error:
        'Grades for this project are released, so its structure cannot be changed — students would see their grade change. Unrelease grades first.',
    }
  }

  let scoreQuery = adminDb
    .from('project_item_scores')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)

  if ('phaseId' in target) {
    const { data: rows, error: rowsError } = await adminDb
      .from('project_phase_items')
      .select('id')
      .eq('phase_id', target.phaseId)
      .eq('project_id', projectId)
    if (rowsError) {
      logger.error('assertDeletableStructure: phase rows lookup failed', rowsError, { projectId })
      return { ok: false, error: 'Could not verify what this phase holds. Nothing was removed.' }
    }
    const ids = (rows ?? []).map((r: { id: string }) => r.id)
    if (ids.length === 0) return { ok: true }
    scoreQuery = scoreQuery.in('phase_item_id', ids)
  } else {
    scoreQuery = scoreQuery.eq('phase_item_id', target.itemRowId)
  }

  const { count, error: scoreError } = await scoreQuery
  if (scoreError) {
    logger.error('assertDeletableStructure: score lookup failed', scoreError, { projectId })
    return { ok: false, error: 'Could not verify existing grades. Nothing was removed.' }
  }
  if ((count ?? 0) > 0) {
    const n = count ?? 0
    return {
      ok: false,
      error:
        'phaseId' in target
          ? `This phase holds ${n} saved ${n === 1 ? 'grade' : 'grades'}. Deleting it would destroy ${n === 1 ? 'it' : 'them'} permanently — clear the grades first if you really mean to.`
          : `This row holds ${n} saved ${n === 1 ? 'grade' : 'grades'}. Removing it would destroy ${n === 1 ? 'it' : 'them'} permanently — clear the grades first if you really mean to.`,
    }
  }
  return { ok: true }
}

export async function deleteMasterPhase(
  phaseId: string,
  projectId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyMasterPhase(adminDb, phaseId, projectId, sectionId))) {
      return { error: 'Phase not found' }
    }

    const deletable = await assertDeletableStructure(adminDb, projectId, { phaseId })
    if (!deletable.ok) return { error: deletable.error }

    const { error: deleteError } = await adminDb
      .from('project_master_phases')
      .delete()
      .eq('id', phaseId)

    if (deleteError) {
      logger.error('deleteMasterPhase: Delete failed', deleteError, { phaseId })
      return { error: 'Failed to delete phase' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.master_phase_deleted',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, phaseId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteMasterPhase: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

export async function reorderMasterPhases(
  projectId: string,
  sectionId: string,
  orderedIds: string[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = reorderIdsSchema.safeParse(orderedIds)
    if (!parsed.success) return { error: 'Invalid phase order' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyProjectInSection(adminDb, projectId, sectionId))) {
      return { error: 'Project not found' }
    }

    // Board size is small (≤100 by schema validation); parallel updates,
    // each scoped to this project so a foreign id in the list is a no-op.
    const results = await Promise.all(
      parsed.data.map((phaseId, index) =>
        adminDb
          .from('project_master_phases')
          .update({ position: index, updated_at: new Date().toISOString() })
          .eq('id', phaseId)
          .eq('project_id', projectId),
      ),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = results.find((r: any) => r.error)
    if (failed) {
      logger.error('reorderMasterPhases: Update failed', failed.error, { projectId })
      return { error: 'Failed to save the new order' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.master_phases_reordered',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, count: parsed.data.length },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('reorderMasterPhases: Unexpected error', error, { projectId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Place an assignment or quiz into a master phase (or move it there), at the
 * given position. Placement is a tag — the item's own dates never change.
 * The unique (project_id, assignment_id/quiz_id) constraint turns a concurrent
 * double-drop into a move instead of a duplicate.
 */
export async function placePhaseItem(
  phaseId: string,
  projectId: string,
  sectionId: string,
  input: PlacePhaseItemInput,
): Promise<{ success?: boolean; error?: string; data?: { id: string } }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = placePhaseItemSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyMasterPhase(adminDb, phaseId, projectId, sectionId))) {
      return { error: 'Phase not found' }
    }

    // The dragged item must belong to this same section (no cross-section
    // placement by guessed id).
    const { item_type: itemType, item_id: itemId } = parsed.data
    const itemTable = itemType === 'assignment' ? 'assignments' : 'quizzes'
    const { data: item } = await adminDb
      .from(itemTable)
      .select('id')
      .eq('id', itemId)
      .eq('section_id', sectionId)
      .maybeSingle()
    if (!item) return { error: 'Item not found in this section' }

    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    const conflictKey = itemType === 'assignment' ? 'project_id,assignment_id' : 'project_id,quiz_id'
    const { data: placed, error: upsertError } = await adminDb
      .from('project_phase_items')
      .upsert(
        {
          phase_id: phaseId,
          project_id: projectId,
          institution_id: institutionId,
          item_type: itemType,
          assignment_id: itemType === 'assignment' ? itemId : null,
          quiz_id: itemType === 'quiz' ? itemId : null,
          position: parsed.data.position,
        },
        { onConflict: conflictKey },
      )
      .select('id')
      .single()

    if (upsertError || !placed) {
      logger.error('placePhaseItem: Upsert failed', upsertError, { phaseId, itemId })
      return { error: 'Failed to place item' }
    }

    // Renormalize the target phase's order so the drop index sticks.
    const { data: siblings } = await adminDb
      .from('project_phase_items')
      .select('id')
      .eq('phase_id', phaseId)
      .neq('id', placed.id)
      .order('position', { ascending: true })
      .limit(500)

    const ordered = (siblings || []).map((s: { id: string }) => s.id)
    ordered.splice(Math.min(parsed.data.position, ordered.length), 0, placed.id)
    const results = await Promise.all(
      ordered.map((id: string, index: number) =>
        adminDb
          .from('project_phase_items')
          .update({ position: index })
          .eq('id', id)
          .eq('project_id', projectId),
      ),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = results.find((r: any) => r.error)
    if (failed) {
      logger.error('placePhaseItem: Reorder failed', failed.error, { phaseId })
      return { error: 'Failed to save the new order' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_placed',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, phaseId, itemType, itemId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { id: placed.id } }
  } catch (error) {
    logger.error('placePhaseItem: Unexpected error', error, { phaseId })
    return { error: 'An unexpected error occurred' }
  }
}

/** Remove a placement (drag back to the library). The item itself is untouched. */
export async function removePhaseItem(
  itemRowId: string,
  projectId: string,
  sectionId: string,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) {
      return { error: 'You do not have permission to perform this action' }
    }
    const { adminDb } = access

    if (!(await verifyProjectInSection(adminDb, projectId, sectionId))) {
      return { error: 'Project not found' }
    }

    const deletable = await assertDeletableStructure(adminDb, projectId, { itemRowId })
    if (!deletable.ok) return { error: deletable.error }

    const { error: deleteError } = await adminDb
      .from('project_phase_items')
      .delete()
      .eq('id', itemRowId)
      .eq('project_id', projectId)

    if (deleteError) {
      logger.error('removePhaseItem: Delete failed', deleteError, { itemRowId })
      return { error: 'Failed to remove item' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.phase_item_removed',
      eventCategory: 'professor',
      metadata: { sectionId, projectId, itemRowId },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('removePhaseItem: Unexpected error', error, { itemRowId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Team Discussions (read-only professor view) ─────────────────

/**
 * Fetch one channel's messages for the professor's read-only team view.
 * Binds channel -> team -> project -> section before reading, so staff of one
 * section can't read another section's team chat by guessing a channel id.
 * Read-only: no send/delete/react paths exist on the professor side.
 */
export async function getTeamChannelMessages(
  channelId: string,
  teamId: string,
  projectId: string,
  sectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ error?: string; data?: any[] }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    const { adminDb } = access

    const { data: channel } = await adminDb
      .from('project_chat_channels')
      .select('id, project_teams!inner(id, project_id, projects!inner(section_id))')
      .eq('id', channelId)
      .eq('team_id', teamId)
      .eq('project_teams.project_id', projectId)
      .eq('project_teams.projects.section_id', sectionId)
      .maybeSingle()
    if (!channel) return { error: 'Channel not found' }

    const messages = await projectQueries.getChannelMessages(adminDb, channelId)
    return { data: messages }
  } catch (error) {
    logger.error('getTeamChannelMessages: Unexpected error', error, { channelId, teamId })
    return { error: 'An unexpected error occurred' }
  }
}

/**
 * Apply one Athena-proposed project structure (phases + weighted rubric rows).
 *
 * Everything lands in ONE database transaction via apply_project_proposal, rather
 * than as a sequence of createMasterPhase/addManualPhaseItem calls. Two reasons,
 * both things a professor would actually hit: a dropped connection mid-sequence
 * leaves a half-built board whose only undo was client state that reload destroys,
 * and a retried ambiguous response duplicates every phase and row.
 *
 * `proposalId` is the idempotency key, minted once when Athena produces the
 * proposal — so double-clicking Apply is a no-op, not a second board.
 *
 * The freeze check (is anything scored / released) is deliberately NOT done here.
 * It is re-read inside the transaction, because the professor can open a proposal
 * while nothing is scored and apply it after a TA has graded in another tab.
 */
export async function applyAthenaProjectProposal(
  projectId: string,
  sectionId: string,
  proposalId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: any[],
): Promise<{ success?: boolean; error?: string; summary?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    if (!Array.isArray(actions) || actions.length === 0) return { error: 'Nothing to apply' }
    if (actions.length > 100) return { error: 'That proposal is too large to apply at once' }
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return { error: 'Invalid proposal' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this section' }
    if (!canWriteAsStaff(access.role)) return { error: 'You do not have permission to perform this action' }
    const { adminDb } = access

    const institutionId = await getSectionInstitutionId(adminDb, sectionId)
    if (!institutionId) return { error: 'Section not found' }

    const { data, error } = await adminDb.rpc('apply_project_proposal', {
      p_proposal_id: proposalId,
      p_project_id: projectId,
      p_section_id: sectionId,
      p_institution_id: institutionId,
      p_user_id: user.id,
      p_actions: actions,
    })

    if (error) {
      // The function raises for a refused restructure; surface that sentence to the
      // professor rather than a generic failure, since it is an explanation.
      const frozen = typeof error.message === 'string' && error.message.includes('FROZEN:')
      logger.error('applyAthenaProjectProposal: RPC failed', error, { projectId, sectionId })
      return {
        error: frozen
          ? error.message.replace(/^.*FROZEN:\s*/, '')
          : 'Could not apply that proposal. Nothing was changed.',
      }
    }
    if (data && data.ok === false) return { error: data.error ?? 'Could not apply that proposal.' }

    logEvent({
      userId: user.id,
      eventType: 'project.athena_proposal_applied',
      eventCategory: 'professor',
      metadata: {
        sectionId,
        projectId,
        proposalId,
        alreadyApplied: !!data?.alreadyApplied,
        phasesAdded: data?.phasesAdded ?? 0,
        itemsAdded: data?.itemsAdded ?? 0,
        edits: data?.edits ?? 0,
      },
      sectionId,
    })
    revalidatePath(`${sectionPath(sectionId)}/projects/${projectId}`)

    if (data?.alreadyApplied) return { success: true, summary: 'That proposal was already applied.' }
    const bits: string[] = []
    if (data?.phasesAdded) bits.push(`${data.phasesAdded} phase${data.phasesAdded === 1 ? '' : 's'}`)
    if (data?.itemsAdded) bits.push(`${data.itemsAdded} rubric row${data.itemsAdded === 1 ? '' : 's'}`)
    if (data?.edits) bits.push(`${data.edits} edit${data.edits === 1 ? '' : 's'}`)
    return { success: true, summary: bits.length ? `Applied ${bits.join(', ')}.` : 'Applied.' }
  } catch (error) {
    logger.error('applyAthenaProjectProposal: Unexpected error', error, { projectId, sectionId })
    return { error: 'An unexpected error occurred' }
  }
}
