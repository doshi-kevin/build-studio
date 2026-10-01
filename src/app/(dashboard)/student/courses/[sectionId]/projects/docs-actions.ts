// Server actions for the project_docs (multi-canvas) feature. Each
// action verifies enrollment + team membership before any DB write,
// validates input via Zod, and revalidates the course path so the
// Discussions sidebar re-renders.

'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import {
  createDocSchema,
  updateDocTitleSchema,
  updateDocContentSchema,
  htmlToDocContent,
  type DocContent,
} from '@/lib/validations/project-docs'
import { emitSystemMessage } from '@/lib/chat/system-messages'

type ActionResult<T = unknown> = { success?: boolean; error?: string; data?: T }

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

async function verifyTeamMembership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const { data: member } = await adminDb
    .from('project_members')
    .select('id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!member
}

function sectionPath(sectionId: string) {
  return `/student/courses/${sectionId}`
}

// ── List ────────────────────────────────────────────────────────

export async function listTeamDocs(
  teamId: string,
): Promise<ActionResult<Array<{
  id: string
  title: string
  is_pinned: boolean
  position: number
  updated_at: string
  updated_by: string | null
}>>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const isMember = await verifyTeamMembership(adminDb, teamId, user.id)
    if (!isMember) return { error: 'Not a team member' }

    const { data, error } = await adminDb
      .from('project_docs')
      .select('id, title, is_pinned, position, updated_at, updated_by')
      .eq('team_id', teamId)
      .order('is_pinned', { ascending: false })
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) {
      logger.error('listTeamDocs: DB error', error, { teamId })
      return { error: 'Failed to load docs' }
    }

    return { success: true, data: data ?? [] }
  } catch (error) {
    logger.error('listTeamDocs: unexpected', error, { teamId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Read single doc (with content) ──────────────────────────────

export async function getDoc(
  docId: string,
): Promise<ActionResult<{
  id: string
  team_id: string
  title: string
  content: DocContent | null
  is_pinned: boolean
  position: number
  created_by: string
  updated_by: string | null
  updated_at: string
}>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: doc, error } = await adminDb
      .from('project_docs')
      .select('id, team_id, title, content, is_pinned, position, created_by, updated_by, updated_at')
      .eq('id', docId)
      .single()

    if (error || !doc) return { error: 'Doc not found' }

    const isMember = await verifyTeamMembership(adminDb, doc.team_id, user.id)
    if (!isMember) return { error: 'Not a team member' }

    return { success: true, data: doc }
  } catch (error) {
    logger.error('getDoc: unexpected', error, { docId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Create ──────────────────────────────────────────────────────

export async function createDoc(
  teamId: string,
  sectionId: string,
  input: { title?: string } = {},
): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = createDocSchema.safeParse({ title: input.title ?? 'Untitled' })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const isMember = await verifyTeamMembership(adminDb, teamId, user.id)
    if (!isMember) return { error: 'Not a team member' }

    // Determine next position (highest existing + 1)
    const { data: positions } = await adminDb
      .from('project_docs')
      .select('position')
      .eq('team_id', teamId)
      .order('position', { ascending: false })
      .limit(1)

    const nextPosition =
      positions && positions.length > 0 && typeof positions[0].position === 'number'
        ? positions[0].position + 1
        : 1 // 0 is reserved for the pinned Planning doc

    const { data: inserted, error } = await adminDb
      .from('project_docs')
      .insert({
        team_id: teamId,
        title: parsed.data.title,
        content: htmlToDocContent(''),
        is_pinned: false,
        position: nextPosition,
        created_by: user.id,
        updated_by: user.id,
      })
      .select('id')
      .single()

    if (error || !inserted) {
      logger.error('createDoc: DB error', error, { teamId })
      return { error: 'Failed to create doc' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.doc_created',
      eventCategory: 'student',
      metadata: { teamId, docId: inserted.id, sectionId },
      sectionId,
    })

    // Fire-and-forget system message into the team's default channel.
    await emitSystemMessage(adminDb, teamId, 'doc_created', {
      actor_id: user.id,
      doc_id: inserted.id,
      doc_title: parsed.data.title,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true, data: { id: inserted.id } }
  } catch (error) {
    logger.error('createDoc: unexpected', error, { teamId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Update title ────────────────────────────────────────────────

export async function updateDocTitle(
  docId: string,
  sectionId: string,
  input: { title: string },
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateDocTitleSchema.safeParse(input)
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: doc } = await adminDb
      .from('project_docs')
      .select('team_id, is_pinned')
      .eq('id', docId)
      .single()

    if (!doc) return { error: 'Doc not found' }

    const isMember = await verifyTeamMembership(adminDb, doc.team_id, user.id)
    if (!isMember) return { error: 'Not a team member' }

    const { error } = await adminDb
      .from('project_docs')
      .update({ title: parsed.data.title, updated_by: user.id })
      .eq('id', docId)

    if (error) {
      logger.error('updateDocTitle: DB error', error, { docId })
      return { error: 'Failed to rename doc' }
    }

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('updateDocTitle: unexpected', error, { docId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Update content (autosave) ───────────────────────────────────

export async function updateDocContent(
  docId: string,
  sectionId: string,
  html: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    const parsed = updateDocContentSchema.safeParse({ content: htmlToDocContent(html) })
    if (!parsed.success) {
      return { error: 'Invalid input: ' + parsed.error.issues[0]?.message }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: doc } = await adminDb
      .from('project_docs')
      .select('team_id')
      .eq('id', docId)
      .single()

    if (!doc) return { error: 'Doc not found' }

    const isMember = await verifyTeamMembership(adminDb, doc.team_id, user.id)
    if (!isMember) return { error: 'Not a team member' }

    const { error } = await adminDb
      .from('project_docs')
      .update({ content: parsed.data.content, updated_by: user.id })
      .eq('id', docId)

    if (error) {
      logger.error('updateDocContent: DB error', error, { docId })
      return { error: 'Failed to save doc' }
    }

    // No revalidatePath here — content updates are hot-path autosave;
    // the sidebar shows title + updated_at, and updated_at will refresh
    // on next natural navigation.
    return { success: true }
  } catch (error) {
    logger.error('updateDocContent: unexpected', error, { docId })
    return { error: 'An unexpected error occurred' }
  }
}

// ── Delete (non-pinned only) ────────────────────────────────────

export async function deleteDoc(
  docId: string,
  sectionId: string,
): Promise<ActionResult> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    const { data: doc } = await adminDb
      .from('project_docs')
      .select('team_id, is_pinned, title')
      .eq('id', docId)
      .single()

    if (!doc) return { error: 'Doc not found' }
    if (doc.is_pinned) return { error: 'The Planning doc cannot be deleted' }

    const isMember = await verifyTeamMembership(adminDb, doc.team_id, user.id)
    if (!isMember) return { error: 'Not a team member' }

    const { error } = await adminDb.from('project_docs').delete().eq('id', docId)

    if (error) {
      logger.error('deleteDoc: DB error', error, { docId })
      return { error: 'Failed to delete doc' }
    }

    logEvent({
      userId: user.id,
      eventType: 'project.doc_deleted',
      eventCategory: 'student',
      metadata: { docId, teamId: doc.team_id, sectionId, title: doc.title },
      sectionId,
    })

    revalidatePath(sectionPath(sectionId))
    return { success: true }
  } catch (error) {
    logger.error('deleteDoc: unexpected', error, { docId })
    return { error: 'An unexpected error occurred' }
  }
}
