'use server'

// Roadmap placement — which module a quiz/assignment lives under on the roadmap.
// Placement is an explicit professor decision stored as a module→resource edge in
// roadmap_edges (NOT inferred from foreign keys), written when a resource is first
// drafted and confirmed again at publish time.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsProfessor } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { writePlacementEdge } from '@/lib/roadmap/placement'

export type PlaceableResourceKind = 'quiz' | 'assignment' | 'live_session'
const RESOURCE_TABLE: Record<PlaceableResourceKind, string> = {
  quiz: 'quizzes',
  assignment: 'assignments',
  live_session: 'lc_rooms',
}

async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  return user
}

/** Modules of this section, for the placement picker. */
export async function getPlacementModules(
  sectionId: string,
): Promise<{ data?: { id: string; title: string; weekNumber: number | null }[]; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this course section' }

    const { data, error } = await access.adminDb
      .from('modules')
      .select('id, title, week_number')
      .eq('section_id', sectionId)
      .order('position', { ascending: true })
    if (error) {
      logger.error('getPlacementModules: query failed', error, { sectionId })
      return { error: 'Failed to load modules' }
    }
    return { data: (data ?? []).map((m: { id: string; title: string; week_number: number | null }) => ({ id: m.id, title: m.title, weekNumber: m.week_number })) }
  } catch (error) {
    logger.error('getPlacementModules', error)
    return { error: 'Unexpected error' }
  }
}

/** The module a resource is currently placed under (null if unplaced). */
export async function getResourcePlacement(
  sectionId: string,
  kind: PlaceableResourceKind,
  resourceId: string,
): Promise<{ data?: string | null; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this course section' }

    const { data, error } = await access.adminDb
      .from('roadmap_edges')
      .select('from_node_id')
      .eq('section_id', sectionId)
      .eq('from_node_type', 'module')
      .eq('to_node_type', kind)
      .eq('to_node_id', resourceId)
      .limit(1)
      .maybeSingle()
    if (error) {
      logger.error('getResourcePlacement: query failed', error, { sectionId, kind, resourceId })
      return { error: 'Failed to load placement' }
    }
    return { data: data?.from_node_id ?? null }
  } catch (error) {
    logger.error('getResourcePlacement', error)
    return { error: 'Unexpected error' }
  }
}

/** Place a resource under a module (idempotent — replaces any previous placement,
 *  so re-picking just moves it on the roadmap). Professor-only. */
export async function setResourcePlacement(
  sectionId: string,
  kind: PlaceableResourceKind,
  resourceId: string,
  moduleId: string,
  /** Optional sort position within the module's canvas band (drag-reorder). */
  position?: number,
): Promise<{ success?: boolean; error?: string }> {
  try {
    const user = await getAuthUser()
    if (!user) return { error: 'Not authenticated' }
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok || !canWriteAsProfessor(access.role)) return { error: 'Only the professor can place resources on the roadmap' }
    const adminDb = access.adminDb

    // Both endpoints must belong to this section — the ids come from the client.
    const { data: mod } = await adminDb.from('modules').select('id').eq('id', moduleId).eq('section_id', sectionId).maybeSingle()
    if (!mod) return { error: 'Module not found in this section' }
    const { data: res } = await adminDb.from(RESOURCE_TABLE[kind]).select('id').eq('id', resourceId).eq('section_id', sectionId).maybeSingle()
    if (!res) return { error: 'Resource not found in this section' }

    const safePosition = typeof position === 'number' && Number.isFinite(position) ? position : null
    const written = await writePlacementEdge(adminDb, sectionId, kind, resourceId, moduleId, safePosition)
    if (!written) return { error: "Couldn't place it on the roadmap — your assignment is saved. You can place it later from the roadmap." }

    await logEvent({ userId: user.id, eventType: 'roadmap.resource_placed', sectionId, metadata: { kind, resourceId, moduleId } })
    revalidatePath(`/professor/courses/${sectionId}/roadmap`)
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('setResourcePlacement', error)
    return { error: 'Unexpected error' }
  }
}
