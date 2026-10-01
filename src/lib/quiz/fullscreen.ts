// Utility functions for managing browser fullscreen mode during quiz attempts.
// Enters fullscreen when quiz starts, exits when submitted.

import { logger } from '@/lib/logger'

/**
 * Request fullscreen on the document element.
 * Fails silently if the browser blocks the request (e.g. no user gesture).
 */
export async function enterFullscreen(): Promise<boolean> {
  try {
    const el = document.documentElement
    if (document.fullscreenElement) return true // already fullscreen

    if (el.requestFullscreen) {
      await el.requestFullscreen()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } else if ((el as any).webkitRequestFullscreen) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).webkitRequestFullscreen() // Safari
    }
    return true
  } catch (err) {
    logger.warn('[SCHOLERA WARN] Could not enter fullscreen', { error: String(err) })
    return false
  }
}

/**
 * Exit fullscreen if currently active.
 */
export async function exitFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) return

    if (document.exitFullscreen) {
      await document.exitFullscreen()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } else if ((document as any).webkitExitFullscreen) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (document as any).webkitExitFullscreen() // Safari
    }
  } catch (err) {
    logger.warn('[SCHOLERA WARN] Could not exit fullscreen', { error: String(err) })
  }
}

/**
 * Check if fullscreen is currently active.
 */
export function isFullscreen(): boolean {
  return !!document.fullscreenElement
}
