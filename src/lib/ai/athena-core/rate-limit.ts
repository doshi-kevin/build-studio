/**
 * athena-core — per-student daily rate limiting for the student Athena surface.
 *
 * Authoritative and server-side; the client never decides. One accepted user
 * message claims one slot in the `tutor` pool at the student cap (models.ts),
 * counted per (institution, user, scope, model) over a rolling window.
 *
 * Shares the table and the `athena_increment_rate_limit` RPC with the professor
 * surfaces — the RPC takes the cap as a parameter, so "students get their own
 * caps" needs no second table, no second RPC, and no migration. What it does NOT
 * share is code: no import from professor-assistant (§2 of the design).
 *
 * There is no failover. The student surface exposes one model, and the pricier
 * fallback is exactly the cost tail this cap exists to bound — refusing is the
 * honest answer.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import {
  STUDENT_LIMIT_SCOPE,
  STUDENT_RATE_LIMIT_WINDOW_HOURS,
  studentModelDef,
  type StudentModelDef,
  type StudentModelId,
} from './models'

// The admin Supabase client is intentionally loosely typed across the codebase
// (section-access.ts does the same) — the generated types don't cover our RPCs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export type StudentSlotResult =
  | { accepted: true; modelDef: StudentModelDef }
  | { accepted: false }

/**
 * Claim one request slot for this student. The increment is a single guarded
 * statement inside the RPC, so two concurrent sends can never both push a
 * student past the cap.
 *
 * Fails OPEN on an infrastructure error: a counter glitch must never take Athena
 * down mid-term for a student who is inside their budget. Real spend is still
 * recorded by the cost ledger either way.
 */
export async function reserveStudentSlot(
  db: AdminDb,
  params: { institutionId: string; userId: string; modelId?: StudentModelId },
): Promise<StudentSlotResult> {
  const def = studentModelDef(params.modelId)

  const { data, error } = await db.rpc('athena_increment_rate_limit', {
    p_institution_id: params.institutionId,
    p_user_id: params.userId,
    p_scope: STUDENT_LIMIT_SCOPE,
    p_model_id: def.id,
    p_cap: def.dailyCap,
    p_window_hours: STUDENT_RATE_LIMIT_WINDOW_HOURS,
  })

  if (error) {
    logger.error('reserveStudentSlot: increment rpc failed — failing open', error, {
      source: 'athenaCore.reserveStudentSlot',
      modelId: def.id,
    })
    return { accepted: true, modelDef: def }
  }

  // The RPC returns table rows; supabase-js surfaces them as an array.
  const row = Array.isArray(data) ? data[0] : data
  return row?.accepted ? { accepted: true, modelDef: def } : { accepted: false }
}
