/**
 * Roll a stream of proctoring events into the summary the professor reads. Pure and
 * shared so quiz and assignment paths flag "suspicious" identically. Thresholds match
 * the quiz summary (multiple_paste_events >= 3, frequent_tab_switches >= 10, etc.).
 */

import type { ProctoringEvent, ProctoringSummary } from '@/lib/validations/proctoring'

export function computeProctoringSummary(
  events: ProctoringEvent[],
  opts: {
    /** Plain-typing tally summed from the batches' keystroke_count column. */
    keystrokeCount: number
    /** Number of stored violation snapshots. */
    snapshotCount: number
    /** Whether webcam proctoring was on (so 0 snapshots => camera denied). */
    videoEnabled: boolean
    /** Epoch ms the assessment started, to turn event offsets into wall-clock times. */
    startedAtMs: number
  },
): ProctoringSummary {
  let totalKeystrokes = opts.keystrokeCount
  let copyCount = 0
  let pasteCount = 0
  let cutCount = 0
  let tabSwitchCount = 0
  let multipleFaceCount = 0
  let phoneDetectedCount = 0
  let fullscreenExitCount = 0

  for (const e of events) {
    switch (e.type) {
      case 'kd': totalKeystrokes++; break // modifier combos / special keys
      case 'cp': copyCount++; break
      case 'ps': pasteCount++; break
      case 'ct': cutCount++; break
      case 'bl': tabSwitchCount++; break
      case 'mf': multipleFaceCount++; break
      case 'ph': phoneDetectedCount++; break
      case 'fx': fullscreenExitCount++; break
    }
  }

  // Video on but no snapshot ever stored => the camera stream never started. Zero
  // face/phone detections alone does NOT mean denied (a clean student has those at 0).
  const webcamDenied = opts.videoEnabled && opts.snapshotCount === 0

  const suspiciousFlags: string[] = []
  if (pasteCount >= 3) suspiciousFlags.push('multiple_paste_events')
  if (tabSwitchCount >= 10) suspiciousFlags.push('frequent_tab_switches')
  if (copyCount >= 5) suspiciousFlags.push('excessive_copying')
  if (multipleFaceCount >= 1) suspiciousFlags.push('multiple_faces_detected')
  if (phoneDetectedCount >= 1) suspiciousFlags.push('phone_detected')
  if (webcamDenied) suspiciousFlags.push('camera_denied')
  if (fullscreenExitCount >= 1) suspiciousFlags.push('fullscreen_exit')

  const sorted = [...events].sort((a, b) => a.t - b.t)
  return {
    totalKeystrokes,
    copyCount,
    pasteCount,
    cutCount,
    tabSwitchCount,
    suspiciousFlags,
    eventCount: events.length,
    firstEventAt: sorted.length ? new Date(opts.startedAtMs + sorted[0].t).toISOString() : null,
    lastEventAt: sorted.length ? new Date(opts.startedAtMs + sorted[sorted.length - 1].t).toISOString() : null,
    multipleFaceCount,
    phoneDetectedCount,
    snapshotCount: opts.snapshotCount,
    webcamDenied,
    fullscreenExitCount,
  }
}
