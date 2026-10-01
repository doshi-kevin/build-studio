/**
 * Bridge rate limits, per user per installation (rule 10.1).
 *
 * Built on the repository's coarse in-memory limiter (src/lib/quiz/rate-limit.ts). In-memory
 * limits are per process and per Cloud Run instance, so they are not globally
 * authoritative: a user spread across several instances gets each instance's budget.
 * That is acceptable for the bridge's current methods, which cost no money. Anything
 * with a monetary cost, AI above all, must use a durable, global counter before it
 * ships (the athena_increment_rate_limit pattern).
 */
import 'server-only'
import { rateLimit } from '@/lib/quiz/rate-limit'
import {
  STUDIO_BRIDGE_CALLS_PER_MINUTE,
  STUDIO_BRIDGE_USER_CALLS_PER_MINUTE,
  STUDIO_BRIDGE_WRITES_PER_MINUTE,
} from '../limits'

const WINDOW_MS = 60_000
export const RETRY_AFTER_SECONDS = WINDOW_MS / 1000

/**
 * True if this call may proceed. Checked in order, stopping at the first refusal:
 *   1. the user's budget across every installation, so naming a made-up installation
 *      still spends it (the installation isn't even looked up yet);
 *   2. the user's budget for this installation;
 *   3. for writes, the user's write budget for this installation.
 */
export function takeBridgeCall(userId: string, installationId: string, kind: 'read' | 'write'): boolean {
  if (!rateLimit(`studio-bridge:${userId}`, STUDIO_BRIDGE_USER_CALLS_PER_MINUTE, WINDOW_MS)) return false
  const key = `studio-bridge:${userId}:${installationId}`
  if (!rateLimit(key, STUDIO_BRIDGE_CALLS_PER_MINUTE, WINDOW_MS)) return false
  return kind === 'read' || rateLimit(`${key}:write`, STUDIO_BRIDGE_WRITES_PER_MINUTE, WINDOW_MS)
}
