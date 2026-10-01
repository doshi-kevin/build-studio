// Utility for checking and requesting camera permissions.
// Used before quiz start to ensure webcam access is granted.

import { logger } from '@/lib/logger'

/** Check current camera permission state without prompting the user. */
export async function checkCameraPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    if (!navigator.permissions) return 'prompt'
    const result = await navigator.permissions.query({ name: 'camera' as PermissionName })
    return result.state as 'granted' | 'denied' | 'prompt'
  } catch {
    // Some browsers don't support querying camera permission
    return 'prompt'
  }
}

/** Request camera access and return the MediaStream, or null with an error message. */
export async function requestCameraAccess(): Promise<{
  stream: MediaStream | null
  error?: string
}> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { stream: null, error: 'Camera not supported in this browser' }
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    })

    return { stream }
  } catch (err) {
    const message =
      err instanceof DOMException
        ? err.name === 'NotAllowedError'
          ? 'Camera permission denied'
          : err.name === 'NotFoundError'
            ? 'No camera found'
            : `Camera error: ${err.message}`
        : 'Failed to access camera'

    logger.warn('[SCHOLERA WARN] Camera access failed', { error: message })
    return { stream: null, error: message }
  }
}

/** Stop all tracks on a MediaStream (releases the camera). */
export function stopMediaStream(stream: MediaStream | null) {
  if (!stream) return
  stream.getTracks().forEach((track) => track.stop())
}
