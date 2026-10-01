// Shared storage step for roadmap placement: the module→resource edge that pins
// a quiz/assignment/live session under a module on the roadmap. Idempotent —
// any previous placement edge for the resource is replaced, so re-picking just
// moves it. Callers are responsible for authorization and for verifying both
// endpoints belong to `sectionId` BEFORE calling this (see placement-actions.ts
// for the client-facing action, live-classroom's applyModuleItemAsDeck for the
// deck-pick path).
//
// The replace is a single atomic INSERT ... ON CONFLICT DO UPDATE inside the
// place_roadmap_edge RPC (migration 20260714173221), guarded by a partial unique
// index — so two concurrent placements (double-click / two tabs) can't leave the
// resource pinned under two modules the way the old delete-then-insert could.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export type PlacedResourceKind = 'quiz' | 'assignment' | 'live_session'

export async function writePlacementEdge(
  adminDb: SupabaseClient,
  sectionId: string,
  kind: PlacedResourceKind,
  resourceId: string,
  moduleId: string,
  /** Sort position within the module's canvas band (fractional; null = end). */
  position: number | null = null,
): Promise<boolean> {
  const { error } = await adminDb.rpc('place_roadmap_edge', {
    p_section_id: sectionId,
    p_module_id: moduleId,
    p_kind: kind,
    p_resource_id: resourceId,
    p_position: position,
  })
  if (error) {
    logger.error('writePlacementEdge: placement failed', error, { sectionId, kind, resourceId, moduleId })
    return false
  }
  return true
}
