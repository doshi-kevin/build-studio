'use server'

// Roadmap archive — the write path: take a node off the map, or put it back.
// The list itself, its key and its reader live in ./archive.ts — a `'use server'`
// file may only export async functions.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsProfessor } from '@/lib/auth/section-access'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { ARCHIVABLE_NODE_KEY, MAX_ARCHIVED, ROADMAP_ARCHIVED_KEY, readArchivedKeys } from './archive'

/**
 * Take a roadmap node off the map (`archived: true`) or put it back where it was
 * (`archived: false`). Professor-only, idempotent in both directions.
 */
export async function setRoadmapNodeArchived(
  sectionId: string,
  nodeKey: string,
  archived: boolean,
): Promise<{ success?: true; error?: string }> {
  try {
    if (!ARCHIVABLE_NODE_KEY.test(nodeKey)) return { error: 'That node can’t be archived' }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Not authenticated' }

    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok || !canWriteAsProfessor(access.role)) {
      return { error: 'Only the professor can archive nodes on the roadmap' }
    }
    const adminDb = access.adminDb

    const { data: section, error: fetchError } = await adminDb
      .from('course_sections')
      .select('settings')
      .eq('id', sectionId)
      .maybeSingle()
    if (fetchError || !section) {
      logger.error('setRoadmapNodeArchived: section not found', fetchError, { sectionId })
      return { error: 'Course section not found' }
    }

    const settings = (section.settings as Record<string, unknown>) ?? {}
    const current = readArchivedKeys(settings)
    if (archived && current.length >= MAX_ARCHIVED && !current.includes(nodeKey)) {
      return { error: 'The Archive is full — put something back first' }
    }
    const next = archived
      ? current.includes(nodeKey) ? current : [...current, nodeKey]
      : current.filter((k) => k !== nodeKey)

    const { error: updateError } = await adminDb
      .from('course_sections')
      .update({ settings: { ...settings, [ROADMAP_ARCHIVED_KEY]: next } })
      .eq('id', sectionId)
    if (updateError) {
      logger.error('setRoadmapNodeArchived: update failed', updateError, { sectionId, nodeKey, archived })
      return { error: archived ? 'Couldn’t archive it — try again' : 'Couldn’t put it back — try again' }
    }

    await logEvent({
      userId: user.id,
      eventType: archived ? 'roadmap.node_archived' : 'roadmap.node_restored',
      sectionId,
      metadata: { nodeKey },
    })
    revalidatePath(`/professor/courses/${sectionId}/roadmap`)
    revalidatePath(`/student/courses/${sectionId}/roadmap`)
    return { success: true }
  } catch (error) {
    logger.error('setRoadmapNodeArchived', error)
    return { error: 'Unexpected error' }
  }
}
