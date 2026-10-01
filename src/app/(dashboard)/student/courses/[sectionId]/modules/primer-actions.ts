/**
 * Student primer consumption — used by the inline "Listen before class" button
 * on lecture items in the student Modules view.
 *
 * Students only CONSUME: this fetches a signed URL for a primer the professor
 * has generated AND made available (is_available). It never generates. All the
 * usual gates apply: authenticated, enrolled, feature enabled, and the item
 * belongs to this section.
 */
'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { isUnlockPending } from '@/lib/modules/unlock'

const PRECLASS_AUDIO_BUCKET = 'preclass-audio'
const SIGNED_URL_TTL_SECONDS = 60 * 60 // 1h — longer than any primer
const uuid = z.string().uuid()

export interface StudentPrimerResult {
  status: 'ready' | 'unavailable' | 'error'
  audioUrl?: string
  script?: string
  durationSeconds?: number | null
  error?: string
}

export async function getPrimer(sectionId: string, moduleItemId: string): Promise<StudentPrimerResult> {
  try {
    if (!uuid.safeParse(sectionId).success || !uuid.safeParse(moduleItemId).success) {
      return { status: 'error', error: 'Invalid request' }
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { status: 'error', error: 'Unauthorized' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    // Enrollment gate.
    const { data: enrollment } = await adminDb
      .from('enrollments')
      .select('id')
      .eq('section_id', sectionId)
      .eq('student_id', user.id)
      .in('status', ['enrolled', 'completed', 'active'])
      .maybeSingle()
    if (!enrollment) return { status: 'error', error: 'Not enrolled' }

    // Feature-enabled gate.
    const { data: section } = await adminDb
      .from('course_sections')
      .select('settings')
      .eq('id', sectionId)
      .maybeSingle()
    const enabled: string[] = Array.isArray(section?.settings?.enabledFeatures)
      ? section.settings.enabledFeatures
      : []
    if (!enabled.includes('pre-class-audio')) return { status: 'unavailable' }

    // IDOR guard: lecture item, visible, in a published AND open module of THIS
    // section. `unlock_date` is part of the guard, not just of the listing — this
    // action takes an item id straight from the client, so a primer for a week
    // that hasn't opened would otherwise be fetchable by id alone.
    const { data: item } = await adminDb
      .from('module_items')
      .select('id, item_type, is_visible, modules!inner(section_id, is_published, unlock_date)')
      .eq('id', moduleItemId)
      .maybeSingle()
    const mod = Array.isArray(item?.modules) ? item.modules[0] : item?.modules
    if (
      !item ||
      item.item_type !== 'lecture' ||
      item.is_visible !== true ||
      mod?.section_id !== sectionId ||
      mod?.is_published !== true ||
      isUnlockPending(mod?.unlock_date)
    ) {
      return { status: 'unavailable' }
    }

    // Serve only an available, generated primer.
    const { data: row } = await adminDb
      .from('preclass_primers')
      .select('script, audio_path, duration_seconds, is_available')
      .eq('module_item_id', moduleItemId)
      .maybeSingle()
    if (!row?.audio_path || !row.is_available) return { status: 'unavailable' }

    const { data: signed } = await adminDb.storage
      .from(PRECLASS_AUDIO_BUCKET)
      .createSignedUrl(row.audio_path, SIGNED_URL_TTL_SECONDS)
    if (!signed?.signedUrl) return { status: 'error', error: 'Could not load audio' }

    return {
      status: 'ready',
      audioUrl: signed.signedUrl,
      script: row.script ?? '',
      durationSeconds: row.duration_seconds,
    }
  } catch (error) {
    logger.error('student getPrimer: unexpected error', error, { sectionId, moduleItemId })
    return { status: 'error', error: 'An unexpected error occurred' }
  }
}
