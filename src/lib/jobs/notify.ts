import 'server-only'

import { logger } from '@/lib/logger'
import type { BackgroundJobRow } from './types'

/**
 * Called when a job reaches a terminal state (done/failed/partial).
 *
 * The compact `summary` is already written on the job row, so a client
 * subscribed to Realtime sees the completion immediately (the "open client"
 * path). The user-facing "away" nudge — a durable notification + Athena
 * narration — is wired in Slice 4 (there is no notifications table yet). This
 * function is that seam; for now it logs so completions are observable.
 */
export async function notifyJobComplete(
  job: Pick<BackgroundJobRow, 'id' | 'type' | 'status' | 'section_id'>,
): Promise<void> {
  logger.info('jobs.notifyJobComplete: job reached terminal state', {
    jobId: job.id,
    type: job.type,
    status: job.status,
    sectionId: job.section_id,
  })
}
