/**
 * The one write path for Athena's study artifacts (design doc §15).
 *
 * Two `create` tools now leave rows on the roadmap — `leave_study_artifact` and
 * `map_knowledge_path` — and everything about the WRITE is identical between
 * them: the per-section cap, the tenancy/ownership columns, the audit event.
 * Only the payload differs. Keeping the insert here means a second tool cannot
 * ship a row missing `institution_id`, or slip past the cap, by forgetting to
 * copy a line.
 *
 * Every identifier on the row comes from `ctx` — the verified session, the
 * verified enrollment, the verified section's tenant. The caller supplies
 * content and a module anchor it resolved server-side; it never supplies an id
 * the model chose.
 */

import { logEvent } from '@/lib/supabase/event-logger'
import type { ArtifactKind } from '@/lib/athena/artifact-kinds'
import type { AthenaStudentCtx } from './contract'

/** Keep one student's corner of one course bounded — the lane is marginalia,
 *  not a second course. The count-then-insert pair is not atomic, but a racing
 *  double-send can only overshoot by one note; nothing corrupts. */
export const MAX_ARTIFACTS_PER_SECTION = 30

/** The correction handed back at the cap, phrased for the model to relay. */
export const AT_CAP =
  "this student's roadmap already holds the maximum number of artifacts for this course — suggest they archive ones they've finished (open the note on the roadmap → Move to Archive)."

export interface NewArtifact {
  /** A module of THIS section, resolved server-side. */
  moduleId: string
  kind: ArtifactKind
  title: string
  payload: object
}

/** The new row's id, or a problem string the tool hands back to the model. */
export type SaveResult = { id: string } | { problem: string }

export async function saveArtifact(ctx: AthenaStudentCtx, art: NewArtifact): Promise<SaveResult> {
  /* Archived notes don't hold a slot — the Archive tray would otherwise turn
     the cap into a permanent refusal once 30 notes had ever existed. */
  const { count } = await ctx.adminDb
    .from('athena_artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('section_id', ctx.sectionId)
    .eq('student_id', ctx.userId)
    .is('archived_at', null)
  if ((count ?? 0) >= MAX_ARTIFACTS_PER_SECTION) return { problem: AT_CAP }

  const { data: row, error } = await ctx.adminDb
    .from('athena_artifacts')
    .insert({
      institution_id: ctx.institutionId,
      section_id: ctx.sectionId,
      student_id: ctx.userId,
      module_id: art.moduleId,
      conversation_id: ctx.conversationId,
      kind: art.kind,
      title: art.title,
      payload: art.payload,
    })
    .select('id')
    .single()
  if (error || !row) return { problem: 'could not save the artifact — try once more' }

  await logEvent({
    userId: ctx.userId,
    eventType: 'athena_artifact_created',
    eventCategory: 'ai',
    sectionId: ctx.sectionId,
    metadata: { artifactId: row.id, kind: art.kind, moduleId: art.moduleId },
  })

  return { id: row.id as string }
}
