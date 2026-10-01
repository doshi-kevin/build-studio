// Observability helpers for the broadcast layer. Every connection state
// transition, replay, dedup hit, and dropped-spoof attempt flows through
// these so production logs surface degradation without drowning in noise.
//
// The intentional design: emit at info/warn levels (not debug) because in
// production we want to see these in our log aggregator (Datadog/equivalent),
// but keep the volume low — there's at most one event per state change
// per client, not per broadcast event.

import { logger } from '@/lib/logger'
import type { ConnectionStatus } from './use-room-channel'

interface Context {
  roomId: string
  status?: ConnectionStatus
  attempt?: number
  delayMs?: number
  replaySize?: number
  dropReason?: string
  authorId?: string
}

export function logChannelStatus(roomId: string, status: ConnectionStatus, extra?: Context) {
  const ctx = { roomId, status, ...extra }
  if (status === 'live') {
    logger.info('lc.channel.subscribed', ctx)
  } else if (status === 'reconnecting' || status === 'replaying') {
    logger.warn('lc.channel.transition', ctx)
  } else if (status === 'closed') {
    logger.warn('lc.channel.closed', ctx)
  } else {
    logger.debug('lc.channel.connecting', ctx)
  }
}

export function logReplay(roomId: string, replaySize: number) {
  if (replaySize === 0) {
    logger.debug('lc.replay.empty', { roomId })
  } else if (replaySize > 50) {
    // Large replays mean the client was disconnected for a while. Useful
    // signal for diagnosing widespread connectivity issues.
    logger.warn('lc.replay.large', { roomId, replaySize })
  } else {
    logger.info('lc.replay.applied', { roomId, replaySize })
  }
}

export function logDedupHit(roomId: string, seq: number) {
  logger.debug('lc.dedup.hit', { roomId, seq })
}

export function logSpoofRejected(roomId: string, reason: string) {
  // Spoof rejection is genuinely interesting — it's either a bug in our
  // own code or a malicious client. Always log.
  logger.warn('lc.spoof.rejected', { roomId, dropReason: reason })
}
