/**
 * The answer to the host's status heartbeat. Four states and nothing else, so a frame
 * learns whether it may keep running without learning why:
 *   unavailable  no viewer: hidden, Studio switched off, release gate closed, enrollment
 *                gone, or an installation that never existed (one answer for all)
 *   stale        the installation moved to another version
 *   readOnly     the viewer may read but not write
 *   available    everything as normal
 */
import type { StudioViewer } from '../context'
import type { FrameStatus } from '../runtime/protocol'

export function frameStatusFor(viewer: StudioViewer | null, expectedVersionId: string): FrameStatus {
  if (!viewer) return 'unavailable'
  if (viewer.versionId !== expectedVersionId) return 'stale'
  return viewer.writable ? 'available' : 'readOnly'
}
